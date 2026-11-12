import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, updateOwnAccount, useAuth } from './auth';

export const themeModes = {
  light: 'Light Mode',
  dark: 'Dark Mode',
  system: 'System Default',
} as const;
export type ThemeMode = keyof typeof themeModes;
const metadataKey = 'vidyalayaa_theme';
const deviceTheme = window.matchMedia('(prefers-color-scheme: dark)');
const accountThemeKey = (owner: string | undefined) => ['account-theme', owner];

function validMode(value: unknown): ThemeMode | undefined {
  return value === 'light' || value === 'dark' || value === 'system' ? value : undefined;
}

function readTheme(key: string) {
  try {
    return validMode(localStorage.getItem(key));
  } catch {
    return undefined;
  }
}

function cacheTheme(key: string, mode: ThemeMode) {
  try {
    localStorage.setItem(key, mode);
  } catch {
    // The current selection and the account setting still work without storage.
  }
}

function subscribeToDeviceTheme(update: () => void) {
  deviceTheme.addEventListener('change', update);
  return () => deviceTheme.removeEventListener('change', update);
}

const ThemeContext = createContext<{
  mode: ThemeMode;
  saving: boolean;
  selectMode: (mode: ThemeMode) => void;
} | null>(null);

export function useTheme() {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('Theme controls require the theme provider.');
  return theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const initializing = !session && loading;
  const owner = session?.user.id;
  const storageKey = `vidyalayaa.theme.${owner || 'guest'}`;
  const client = useQueryClient();
  const [guestMode, setGuestMode] = useState<ThemeMode>();
  const preference = useQuery({
    queryKey: accountThemeKey(owner),
    enabled: !!session,
    retry: false,
    queryFn: async () => {
      const result = session && (await supabase?.auth.getUser(session.access_token));
      if (!result || result.error || !result.data.user || result.data.user.id !== owner)
        throw new Error('The account appearance could not be loaded.');
      return validMode(result.data.user.user_metadata?.[metadataKey]) || 'system';
    },
  });
  const update = useMutation({
    mutationFn: ({ owner, mode }: { owner: string; mode: ThemeMode }) =>
      updateOwnAccount(owner, { data: { [metadataKey]: mode } }),
    onSuccess: async (_user, { owner, mode }) => {
      const queryKey = accountThemeKey(owner);
      await client.cancelQueries({ queryKey, exact: true });
      cacheTheme(`vidyalayaa.theme.${owner}`, mode);
      client.setQueryData(queryKey, mode);
    },
  });
  const saving = update.isPending && update.variables?.owner === owner;
  const optimistic = saving ? update.variables?.mode : undefined;
  const mode =
    optimistic ??
    preference.data ??
    (!owner ? guestMode : undefined) ??
    readTheme(storageKey) ??
    validMode(session?.user.user_metadata?.[metadataKey]) ??
    'system';
  const systemDark = useSyncExternalStore(subscribeToDeviceTheme, () => deviceTheme.matches);
  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    if (owner && preference.data) cacheTheme(storageKey, preference.data);
  }, [owner, preference.data, storageKey]);

  useLayoutEffect(() => {
    if (initializing) return;
    const root = document.documentElement;
    if (root.dataset.theme === resolved) return;
    root.dataset.themeTransition = '';
    root.dataset.theme = resolved;
    const timer = window.setTimeout(() => delete root.dataset.themeTransition, 180);
    return () => {
      window.clearTimeout(timer);
      delete root.dataset.themeTransition;
    };
  }, [initializing, resolved]);

  return (
    <ThemeContext.Provider
      value={{
        mode,
        saving: initializing || saving,
        selectMode: (next) => {
          if (initializing || saving || next === mode) return;
          if (owner) {
            update.mutate({ owner, mode: next });
          } else {
            cacheTheme(storageKey, next);
            setGuestMode(next);
          }
        },
      }}
    >
      {children}
      {update.isError && update.variables?.owner === owner && (
        <p className="theme-save-error" role="alert">
          Your appearance preference could not be saved. Try selecting it again.
        </p>
      )}
    </ThemeContext.Provider>
  );
}
