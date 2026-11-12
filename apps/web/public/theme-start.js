// This script runs before the React bundle and under the hosting CSP.
(() => {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  let preference;
  try {
    preference = localStorage.getItem('vidyalayaa.theme.guest');
    const authUrl = document.currentScript.dataset.authUrl;
    let session;
    if (authUrl) {
      const project = new URL(authUrl).hostname.split('.')[0];
      session = JSON.parse(localStorage.getItem(`sb-${project}-auth-token`) || 'null');
    }
    // Use the persisted auth session, since a tab's previous identity can be stale.
    const owner = session?.access_token && session?.refresh_token && session?.user?.id;
    if (owner) {
      const cached = localStorage.getItem(`vidyalayaa.theme.${owner}`);
      preference = ['light', 'dark', 'system'].includes(cached)
        ? cached
        : session.user.user_metadata?.vidyalayaa_theme;
    }
  } catch {
    // The device preference also works with storage disabled.
  }
  document.documentElement.dataset.theme =
    preference === 'dark' || (preference !== 'light' && systemDark) ? 'dark' : 'light';
})();
