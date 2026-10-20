import { api } from './auth';
export async function enablePush(
  options: { requestPermission?: boolean; isCurrent?: () => boolean } = {},
) {
  if (!('serviceWorker' in navigator) || !('Notification' in window))
    throw new Error('This browser does not support notifications.');
  const env = import.meta.env;
  if (!env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_VAPID_KEY)
    throw new Error('Your school has not configured browser push notifications.');
  const permission =
    options.requestPermission === false
      ? Notification.permission
      : await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error('Allow notifications in your browser settings to enable school alerts.');
  const [{ initializeApp, getApps }, { getMessaging, getToken, isSupported }] = await Promise.all([
    import('@firebase/app'),
    import('@firebase/messaging'),
  ]);
  if (!(await isSupported()))
    throw new Error('Push notifications are unavailable in this browser.');
  const app =
    getApps()[0] ||
    initializeApp({
      apiKey: env.VITE_FIREBASE_API_KEY,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    });
  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
  await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(app), {
    vapidKey: env.VITE_FIREBASE_VAPID_KEY,
    serviceWorkerRegistration: registration,
  });
  if (!token) throw new Error('A notification token could not be registered.');
  if (options.isCurrent && !options.isCurrent()) return false;
  await api('/push-tokens', { method: 'POST', body: JSON.stringify({ token, platform: 'WEB' }) });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  sessionStorage.setItem(
    'vidyalayaa.push_hash',
    Array.from(new Uint8Array(digest))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(''),
  );
  return true;
}

// The provider endpoint is invalidated even if the API is temporarily unavailable.
export async function disablePush() {
  const token_hash = sessionStorage.getItem('vidyalayaa.push_hash');
  try {
    if (token_hash)
      await api('/push-tokens', { method: 'DELETE', body: JSON.stringify({ token_hash }) });
  } finally {
    sessionStorage.removeItem('vidyalayaa.push_hash');
    if (import.meta.env.VITE_FIREBASE_API_KEY) {
      const [{ getApps }, { getMessaging, deleteToken, isSupported }] = await Promise.all([
        import('@firebase/app'),
        import('@firebase/messaging'),
      ]);
      if (getApps().length && (await isSupported())) await deleteToken(getMessaging(getApps()[0]));
    }
  }
}
