const CACHE = 'plankton-shell-v1';
const SHELL = ['/offline.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const MAX_STATIC_BYTES = 2 * 1024 * 1024;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('plankton-shell-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { payload = { body: event.data?.text() ?? 'A Plankton position is approaching its estimated liquidation level.' }; }
  const title = typeof payload.title === 'string' ? payload.title : 'Plankton liquidation warning';
  const body = typeof payload.body === 'string' ? payload.body : 'A position may be close to its estimated liquidation level.';
  const tag = typeof payload.tag === 'string' ? payload.tag : 'plankton-liquidation';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: typeof payload.url === 'string' && payload.url.startsWith('/') && !payload.url.startsWith('//') ? payload.url : '/trade' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const candidate = new URL(event.notification.data?.url ?? '/trade', self.location.origin);
  const target = (candidate.origin === self.location.origin ? candidate : new URL('/trade', self.location.origin)).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.navigate(target).then(() => existing.focus());
    return clients.openWindow(target);
  }));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put('/', response.clone()).catch(() => {});
      }
      return response;
    }).catch(async () => (await caches.match('/')) || (await caches.match('/offline.html'))));
    return;
  }

  // Cache only small, same-origin app assets. Never cache API data, account state, or video loops.
  if (!['script', 'style', 'font', 'image'].includes(request.destination) || /\.(mp4|webm)(?:$|\?)/i.test(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(request);
    const fresh = fetch(request).then(async (response) => {
      const size = Number(response.headers.get('content-length') || 0);
      if (response.ok && (!size || size <= MAX_STATIC_BYTES)) await cache.put(request, response.clone());
      return response;
    }).catch(() => cached || Response.error());
    return cached || fresh;
  }));
});
