const CACHE = 'prompt-to-pan-web-v1';
const FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './chat.js',
  './demo-data.js',
  './manifest.webmanifest',
  './fonts/SpaceMono-Bold.woff2',
  './fonts/Satisfy-Regular.woff2'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('prompt-to-pan-web-') && key !== CACHE).map(key => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(async response => {
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(event.request, response.clone());
    }
    return response;
  }).catch(() => caches.match(event.request)));
});