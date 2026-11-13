/* Haze Tracker service worker: offline app shell + background PSI checks. */
importScripts('lib.js');

const CACHE = 'haze-tracker-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'lib.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/badge-96.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first so updates show up immediately; fall back to the cache when offline.
// NEA API requests are cross-origin and are not intercepted.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./')))
  );
});

function showAlert(alert) {
  return self.registration.showNotification(alert.title, {
    body: alert.body,
    tag: alert.tag,
    renotify: true,
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    data: { url: './' }
  });
}

// Chrome on Android fires this for installed apps, roughly hourly at best (the browser decides).
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'psi-check') {
    event.waitUntil(Haze.runCheck(Haze.idbStore, showAlert).catch(() => {}));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL('./', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) if ('focus' in w) return w.focus();
      return self.clients.openWindow(target);
    })
  );
});
