// Service Worker: hält alle Dateien der App im Cache, damit sie offline läuft.
// VERSION wird beim Veröffentlichen durch die Commit-ID ersetzt (siehe .github/workflows/pages.yml).
// Neue Datei im Projekt? In ASSETS eintragen – der Test tests/site.test.mjs prüft das.

const VERSION = '__BUILD__';
const CACHE = `ga-trainer-${VERSION}`;

const ASSETS = [
  './',
  'index.html',
  'app.js',
  'core.js',
  'tools.js',
  'config.js',
  'pwa.js',
  'data.json',
  'styles.css',
  'fonts.css',
  'manifest.webmanifest',
  'vendor/lit-html/lit-html.js',
  'fonts/barlow-latin-400-normal.woff2',
  'fonts/barlow-latin-400-italic.woff2',
  'fonts/barlow-latin-500-normal.woff2',
  'fonts/barlow-latin-600-normal.woff2',
  'fonts/barlow-condensed-latin-500-normal.woff2',
  'fonts/barlow-condensed-latin-600-normal.woff2',
  'fonts/barlow-condensed-latin-700-normal.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'impressum.html',
  'datenschutz.html',
  'lizenzen.html',
  'legal.css',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('ga-trainer-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ignoreSearch: "index.html?x" and "./" hit the same entry; the hash never reaches the network.
    const cached = await cache.match(request, { ignoreSearch: true })
      ?? (request.mode === 'navigate' ? await cache.match('index.html') : undefined);
    if (cached) return cached;
    try {
      return await fetch(request);
    } catch {
      return request.mode === 'navigate' ? cache.match('index.html') : Response.error();
    }
  })());
});
