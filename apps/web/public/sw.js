/* Vidyalayaa Service Worker - PWA & Push Notifications */
const CACHE_NAME = 'vidyalayaa-pwa-v1';
const PRECACHE_URLS = ['/', '/index.html', '/favicon.ico', '/manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {})),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        }),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Vite modules must come from the development server so React uses one module graph.
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/auth') ||
    /^\/(?:src\/|node_modules\/|@)/.test(url.pathname)
  ) {
    return;
  }

  // Stale-while-revalidate for local assets, network-first for navigation
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const toCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, toCache));
        }
        return networkResponse;
      }).catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});

/* FCM Push Notifications */
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
      icon: '/icon-192.png',
      badge: '/notification-badge.png',
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
