async function setupOfflineWorker() {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = registration?.installing || registration?.waiting || registration?.active;
    const offlineWorkerUrl = new URL('/sw.js', location.origin).href;
    if (import.meta.env.PROD) {
      // A registered push worker already owns this scope.
      if (!worker || worker.scriptURL === offlineWorkerUrl)
        await navigator.serviceWorker.register('/sw.js');
      return;
    }

    // Remove a production worker left behind by an older localhost session.
    if (!registration || worker?.scriptURL !== offlineWorkerUrl) return;

    const controlled = navigator.serviceWorker.controller?.scriptURL === offlineWorkerUrl;
    const removed = await registration.unregister();
    await caches.delete('vidyalayaa-pwa-v1').catch(() => {});
    const reloadKey = 'vidyalayaa.devOfflineWorkerReloaded';
    if (removed && controlled && !sessionStorage.getItem(reloadKey)) {
      sessionStorage.setItem(reloadKey, 'true');
      location.reload();
    }
  } catch {
    // Online use does not depend on the service worker.
  }
}

if ('serviceWorker' in navigator) {
  if (document.readyState === 'complete') void setupOfflineWorker();
  else window.addEventListener('load', setupOfflineWorker, { once: true });
}
