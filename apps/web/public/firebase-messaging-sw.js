/* First-party service worker. No database/auth/device secrets or external scripts. */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  const n = payload.notification || payload.data?.notification || {};
  event.waitUntil(
    self.registration.showNotification(n.title || 'Vidyalayaa', {
      body: n.body || 'A school update is available.',
      tag: payload.data?.delivery_id || undefined,
      data: { url: '/' },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.startsWith(self.location.origin));
      return existing ? existing.focus() : self.clients.openWindow('/');
    }),
  );
});
