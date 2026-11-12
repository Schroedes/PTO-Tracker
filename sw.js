// Offline support: serve the app shell from cache and refresh it in the background.
// Google Fonts (Roboto + Material Symbols) are cached at runtime so icons work offline too.
const CACHE = 'pto-tracker-v6';
const FONT_CACHE = 'pto-tracker-fonts-v1';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'pto.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isFont = FONT_HOSTS.includes(url.hostname);
  if (url.origin !== location.origin && !isFont) return;
  const cacheName = isFont ? FONT_CACHE : CACHE;
  e.respondWith(caches.open(cacheName).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: !isFont });
    const network = fetch(e.request).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
