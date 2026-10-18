import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@vidyalayaa/contracts';
const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = !!url && !!key && !url.includes('YOUR_') && !key.includes('YOUR_');
export const supabase = configured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : null;
const base = import.meta.env.VITE_API_URL || '';
export class HttpError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let selectedSchool = sessionStorage.getItem('vidyalayaa.school') || '';
export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestInit = {},
  refresh = true,
): Promise<T> {
  if (!supabase)
    throw new HttpError('SETUP_REQUIRED', 503, 'Connect Supabase and the API to use this feature.');
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers = new Headers(options.headers);
  if (session) headers.set('Authorization', `Bearer ${session.access_token}`);
  if (selectedSchool) headers.set('X-School-Id', selectedSchool);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${base}/api/v1${path}`, { ...options, headers });
  if (response.status === 401 && refresh) {
    const result = await supabase.auth.refreshSession();
    if (result.data.session) return api(path, options, false);
    await supabase.auth.signOut();
    throw new HttpError('UNAUTHENTICATED', 401, 'Your session expired. Sign in again.');
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok)
    throw new HttpError(
      body.error?.code || 'REQUEST_FAILED',
      response.status,
      body.error?.message || 'The request failed.',
    );
  return body as T;
}
interface Auth {
  session: Session | null;
  loading: boolean;
  me?: Me;
  error: Error | null;
  school: string;
  setSchool: (school: string) => void;
  logout: () => Promise<void>;
}
const Context = createContext<Auth>({
  session: null,
  loading: true,
  error: null,
  school: '',
  setSchool: () => {},
  logout: async () => {},
});
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient(),
    [session, setSession] = useState<Session | null>(null),
    [initial, setInitial] = useState(configured),
    [school, updateSchool] = useState(selectedSchool);
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setInitial(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        queryClient.clear();
        selectedSchool = '';
        sessionStorage.removeItem('vidyalayaa.school');
        updateSchool('');
      }
    });
    return () => data.subscription.unsubscribe();
  }, [queryClient]);
  const me = useQuery({
    queryKey: ['me', session?.user.id, school],
    queryFn: () => api<Me>('/me'),
    enabled: !!session,
    retry: false,
    staleTime: 30000,
  });
  const setSchool = (value: string) => {
    selectedSchool = value;
    sessionStorage.setItem('vidyalayaa.school', value);
    queryClient.clear();
    updateSchool(value);
  };
  const logout = async () => {
    if (supabase) {
      try {
        const token_hash = sessionStorage.getItem('vidyalayaa.push_hash');
        if (token_hash)
          await api('/push-tokens', { method: 'DELETE', body: JSON.stringify({ token_hash }) });
      } catch {
        /* logout continues */
      }
      await supabase.auth.signOut();
    }
    queryClient.clear();
    for (const k of Object.keys(sessionStorage))
      if (k.startsWith('vidyalayaa.')) sessionStorage.removeItem(k);
  };
  return (
    <Context.Provider
      value={{
        session,
        loading: initial || (!!session && me.isLoading),
        me: me.data,
        error: me.error,
        school: me.data?.school?.school_id || school,
        setSchool,
        logout,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const useAuth = () => useContext(Context);
export function usePermission(code: string) {
  return !!useAuth().me?.school?.permissions.includes(code);
}

export async function downloadReport(url: string) {
  if (!supabase) throw new Error('Sign in first.');
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers = new Headers();
  if (session) headers.set('Authorization', `Bearer ${session.access_token}`);
  if (selectedSchool) headers.set('X-School-Id', selectedSchool);
  const response = await fetch(`${base}/api/v1${url}`, { headers });
  if (!response.ok)
    throw new Error('The download expired or access changed. Open the report again.');
  const blob = await response.blob(),
    object = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = object;
  a.download = 'vidyalayaa-report.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(object), 1000);
}
