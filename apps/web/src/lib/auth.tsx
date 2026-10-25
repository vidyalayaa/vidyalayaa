import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createClient, type Session, type User } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '@vidyalayaa/contracts';
import { clearDrafts, suspendDrafts, resumeDrafts, discardDraftCheckpoint } from './drafts';
import { safeReturnTo } from './auth-return';
const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_ANON_KEY;
// Capture callback parameters before the router mounts. The setup page completes
// either an invitation's token fragment or a password recovery's PKCE code explicitly.
const setupURL = new URL(window.location.href);
const isSetupCallback = setupURL.pathname === '/auth/callback';
const isGoogleCallback = setupURL.pathname === '/auth/google/callback';
const googleReturnKey = 'vidyalayaa.oauth.returnTo';
const googleReturnTo = isGoogleCallback
  ? safeReturnTo(sessionStorage.getItem(googleReturnKey))
  : '/';
if (isGoogleCallback) sessionStorage.removeItem(googleReturnKey);
export const configured = !!url && !!key && !url.includes('YOUR_') && !key.includes('YOUR_');
export const supabase = configured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: !isSetupCallback && !isGoogleCallback,
        flowType: 'pkce',
      },
    })
  : null;
export async function startGoogleSignIn(returnTo: string | null) {
  if (!supabase) throw new Error('Connect your workspace before signing in.');
  // The provider can be enabled in Supabase without rebuilding the website.
  // Only the public Auth settings and public anon key are used here.
  const response = await fetch(`${url}/auth/v1/settings`, {
    headers: { apikey: key },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Could not start Google sign-in. Please try again.');
  const settings = await response.json();
  if (settings.external?.google !== true)
    throw new Error(
      'Google sign-in is not available yet. Use email and password or contact your administrator.',
    );
  sessionStorage.setItem(googleReturnKey, safeReturnTo(returnTo));
  const result = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + '/auth/google/callback',
      scopes: 'openid email profile',
      queryParams: { prompt: 'select_account' },
    },
  });
  if (result.error) {
    sessionStorage.removeItem(googleReturnKey);
    throw new Error('Could not start Google sign-in. Please try again.');
  }
}
let googleCompletion: Promise<string> | undefined;
export function completeGoogleSignIn() {
  return (googleCompletion ??= (async () => {
    const code = setupURL.searchParams.get('code');
    const flowId = setupURL.searchParams.get('sb_flow_id');
    const fragment = new URLSearchParams(setupURL.hash.slice(1));
    const rejected = ['error', 'error_code', 'error_description'].some(
      (name) => setupURL.searchParams.has(name) || fragment.has(name),
    );
    // A Google callback never opens the password setup form. Consume PKCE once
    // and remove provider codes/errors from the URL before doing network work.
    if (isGoogleCallback) window.history.replaceState(window.history.state, '', setupURL.pathname);
    if (!supabase || !isGoogleCallback || rejected || !code)
      throw new Error('Google sign-in was cancelled or could not be completed. Please try again.');
    const result = await supabase.auth.exchangeCodeForSession(
      code,
      flowId ? { flowId } : undefined,
    );
    if (result.error || !result.data.session)
      throw new Error(
        'This Google sign-in link has expired or is invalid. Start again from the login page.',
      );
    const verified = await supabase.auth.getUser(result.data.session.access_token);
    if (
      verified.error ||
      !verified.data.user ||
      verified.data.user.id !== result.data.session.user.id
    )
      throw new Error('We could not verify your Google sign-in. Please try again.');
    return googleReturnTo;
  })());
}
export async function getSignInFactor(force = false) {
  if (!supabase) throw new Error('Sign in to continue.');
  const result = await supabase.auth.mfa.listFactors();
  if (result.error) throw new Error('Could not check account security. Please sign in again.');
  const factor = result.data.totp.find((factor) => factor.status === 'verified');
  if (!factor) return '';
  const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assurance.error || !assurance.data.currentLevel)
    throw new Error('Could not check account security. Please sign in again.');
  return assurance.data.currentLevel === 'aal2' && !force ? '' : factor.id;
}
let setupCompletion: Promise<Pick<User, 'id' | 'email'>> | undefined;
export function completePasswordSetup() {
  // React StrictMode can mount the page twice. A single-use link is consumed once.
  return (setupCompletion ??= (async () => {
    const fragment = new URLSearchParams(setupURL.hash.slice(1));
    const query = setupURL.searchParams;
    const code = query.get('code');
    const flowId = query.get('sb_flow_id');
    const access_token = fragment.get('access_token');
    const refresh_token = fragment.get('refresh_token');
    const type = fragment.get('type');
    const rejected = ['error', 'error_code', 'error_description'].some(
      (name) => fragment.has(name) || query.has(name),
    );
    const implicitSetup =
      (type === 'invite' || type === 'recovery') && !!access_token && !!refresh_token;
    // Remove credentials and provider error text from browser history, including
    // rejected links. They must not appear in screenshots or copied addresses.
    setupURL.hash = '';
    setupURL.search = '';
    if (isSetupCallback) window.history.replaceState(window.history.state, '', setupURL.pathname);
    if (!supabase || !isSetupCallback || rejected || (!code && !implicitSetup)) {
      throw new Error(
        'This setup link has expired, has already been used, or is invalid. Request a new setup link.',
      );
    }
    const result = code
      ? await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined)
      : await supabase.auth.setSession({
          access_token: access_token!,
          refresh_token: refresh_token!,
        });
    if (result.error || !result.data.session) {
      throw new Error(
        'We could not verify this setup link. Request a new link and open it in the same browser.',
      );
    }
    const verified = await supabase.auth.getUser(result.data.session.access_token);
    if (
      verified.error ||
      !verified.data.user ||
      verified.data.user.id !== result.data.session.user.id
    ) {
      throw new Error('We could not verify your account. Request a new setup link.');
    }
    return { id: verified.data.user.id, email: verified.data.user.email };
  })());
}
const base = import.meta.env.VITE_API_URL || '';
export class HttpError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
  }
}
let selectedSchool = sessionStorage.getItem('vidyalayaa.school') || '';
let reauthenticationSchool: { owner: string; school: string } | undefined;
let intentionalSignOut = false;
export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestInit = {},
  refresh = true,
  responseType: 'json' | 'blob' = 'json',
): Promise<T> {
  if (!supabase)
    throw new HttpError('SETUP_REQUIRED', 503, 'Connect Supabase and the API to use this feature.');
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const requestSchool = selectedSchool;
  const headers = new Headers(options.headers);
  if (session) headers.set('Authorization', `Bearer ${session.access_token}`);
  if (requestSchool) headers.set('X-School-Id', requestSchool);
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const response = await fetch(`${base}/api/v1${path}`, { ...options, headers });
  const latest = await supabase.auth.getSession();
  if (
    selectedSchool !== requestSchool ||
    (latest.data.session?.user.id !== session?.user.id && response.status !== 401)
  )
    throw new HttpError(
      'CONTEXT_CHANGED',
      409,
      'Your account or school changed. Reopen this page.',
    );
  if (response.status === 401 && refresh) {
    const failure = await response
      .clone()
      .json()
      .catch(() => ({}));
    if (failure.error?.code === 'SESSION_ENDED') {
      await supabase.auth.signOut({ scope: 'local' });
      throw new HttpError('SESSION_ENDED', 401, 'This login session has ended. Sign in again.');
    }
    const current = await supabase.auth.getSession();
    if (
      (current.data.session && current.data.session.user.id !== session?.user.id) ||
      (selectedSchool !== requestSchool && current.data.session)
    )
      throw new HttpError(
        'CONTEXT_CHANGED',
        409,
        'Your account or school changed. Reopen this page.',
      );
    if (session) {
      suspendDrafts(session.user.id);
      reauthenticationSchool = { owner: session.user.id, school: requestSchool };
    }
    const result = await supabase.auth.refreshSession();
    if (result.data.session) {
      if (result.data.session.user.id !== session?.user.id || selectedSchool !== requestSchool)
        throw new HttpError(
          'CONTEXT_CHANGED',
          409,
          'Your account or school changed. Reopen this page.',
        );
      discardDraftCheckpoint();
      reauthenticationSchool = undefined;
      return api(path, options, false, responseType);
    }
    await supabase.auth.signOut({ scope: 'local' });
    throw new HttpError('UNAUTHENTICATED', 401, 'Your session expired. Sign in again.');
  }
  if (response.status === 204) return undefined as T;
  if (response.ok && responseType === 'blob') {
    const blob = await response.blob();
    const current = await supabase.auth.getSession();
    if (selectedSchool !== requestSchool || current.data.session?.user.id !== session?.user.id)
      throw new HttpError(
        'CONTEXT_CHANGED',
        409,
        'Your account or school changed. Download again from the current school.',
      );
    return blob as T;
  }
  const body = await response.json();
  if (
    !response.ok &&
    ['MFA_STEP_UP_REQUIRED', 'MFA_ENROLLMENT_REQUIRED'].includes(body.error?.code)
  )
    window.dispatchEvent(
      new CustomEvent('vidyalayaa:step-up', {
        detail: { enroll: body.error.code === 'MFA_ENROLLMENT_REQUIRED' },
      }),
    );
  if (!response.ok)
    throw new HttpError(
      body.error?.code || 'REQUEST_FAILED',
      response.status,
      body.error?.message || 'The request failed.',
      body.error?.issues || body.error?.details,
      body.request_id ||
        body.error?.request_id ||
        response.headers.get('X-Request-Id') ||
        undefined,
    );
  return body as T;
}
interface Auth {
  session: Session | null;
  loading: boolean;
  me?: Me;
  error: Error | null;
  refetch: () => void;
  school: string;
  setSchool: (school: string) => void;
  logout: () => Promise<void>;
}
const Context = createContext<Auth>({
  session: null,
  loading: true,
  error: null,
  refetch: () => {},
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
    const applySession = (next: Session | null) => {
      const owner = next?.user.id || '';
      const previousOwner = sessionStorage.getItem('vidyalayaa.identity');
      if (!owner && previousOwner && !intentionalSignOut) {
        suspendDrafts(previousOwner);
        reauthenticationSchool ??= { owner: previousOwner, school: selectedSchool };
      }
      if (sessionStorage.getItem('vidyalayaa.identity') !== owner) {
        clearDrafts(true);
        queryClient.clear();
        for (const name of Object.keys(sessionStorage))
          if (name.startsWith('vidyalayaa.')) sessionStorage.removeItem(name);
        selectedSchool = '';
        updateSchool('');
        if (owner) {
          resumeDrafts(owner);
          if (reauthenticationSchool?.owner === owner) {
            selectedSchool = reauthenticationSchool.school;
            sessionStorage.setItem('vidyalayaa.school', selectedSchool);
            updateSchool(selectedSchool);
          }
          reauthenticationSchool = undefined;
          sessionStorage.setItem('vidyalayaa.identity', owner);
        }
      }
      setSession(next);
    };
    supabase.auth.getSession().then(({ data }) => {
      applySession(data.session);
      setInitial(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      applySession(next);
      if (!next) {
        queryClient.clear();
        selectedSchool = '';
        sessionStorage.removeItem('vidyalayaa.school');
        updateSchool('');
      } else {
        queryClient.invalidateQueries({ queryKey: ['me'] });
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
    refetchInterval: 60000,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (
      !session ||
      !me.data?.school ||
      !me.data.school.permissions.includes('notifications.push') ||
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted'
    )
      return;
    let current = true;
    const refresh = () => {
      if (document.visibilityState === 'visible' && navigator.onLine)
        import('./push')
          .then((m) => m.enablePush({ requestPermission: false, isCurrent: () => current }))
          .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 15 * 60 * 1000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [session?.user.id, me.data?.school?.school_id, me.data?.school?.role]);
  const setSchool = (value: string) => {
    clearDrafts();
    selectedSchool = value;
    sessionStorage.setItem('vidyalayaa.school', value);
    queryClient.clear();
    updateSchool(value);
  };
  const logout = async () => {
    clearDrafts();
    reauthenticationSchool = undefined;
    if (supabase) {
      try {
        await (await import('./push')).disablePush();
      } catch {
        /* logout continues */
      }
      intentionalSignOut = true;
      try {
        const result = await supabase.auth.signOut({ scope: 'local' });
        if (result.error) throw result.error;
      } finally {
        intentionalSignOut = false;
      }
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
        refetch: () => {
          me.refetch();
        },
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

export async function downloadReport(url: string, filename = 'vidyalayaa-report.pdf') {
  if (!/^\/((reports|materials)\/[0-9a-f-]+\/file|exports\/[0-9a-f-]+\/files\/\d+)\?/.test(url))
    throw new Error('The download address is invalid.');
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
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(object), 1000);
}
