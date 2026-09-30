// Caches the app shell so PixelForge Pro opens offline. Bump CACHE when files change.
const CACHE = 'pixelforge-v1';
const SHELL = ['./', 'index.html', 'style.css', 'script.js', 'manifest.json', 'assets/icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== CACHE).map((x) => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => { if (e.request.method === 'GET') e.respondWith(fetch(e.request).catch(() => caches.match(e.request))); });