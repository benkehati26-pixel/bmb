/* BMB work log – service worker: offline app shell. AI calls (api.anthropic.com) are never cached. */
const VERSION = 'bmb-v1.1.0';
const SHELL = [
  './', './index.html', './style.css', './app.js', './excel.js', './vendor/exceljs.min.js', './manifest.webmanifest',
  './icons/logo.svg', './icons/favicon-32.png', './icons/icon-192.png', './icons/icon-512.png',
  './icons/apple-touch-icon.png', './icons/maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'api.anthropic.com') return; // network only

  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !isFont) return;

  // Stale-while-revalidate: instant from cache, refresh in background.
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) ||
        (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      const network = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
