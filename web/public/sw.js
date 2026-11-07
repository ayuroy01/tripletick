// Caches the app shell only. API responses hold customer data, so they're never stored.
const CACHE = 'tripletick-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/hooks')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit ?? caches.match('/'))));
});

self.addEventListener('push', (e) => {
  const { title, url } = e.data?.json() ?? { title: 'Triple Tick', url: '/' };
  e.waitUntil(self.registration.showNotification(title, { icon: '/icon-192.png', badge: '/icon-192.png', data: { url } }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data?.url ?? '/'));
});
