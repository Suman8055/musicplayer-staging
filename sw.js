// MusicPlayer SvelteKit Service Worker
// Rewritten for SvelteKit SPA static adapter.
// Key differences from original sw.js:
//   1. SPA fallback: any navigation request → serve /musicplayer/index.html
//   2. Cache-first for /_app/immutable/ (content-hashed, never changes)
//   3. Network-first for API calls (streaming URLs must be fresh)

const BASE  = self.registration.scope.replace(/\/$/, '');
const CACHE = 'mbx-sk-v5.2.0-2303da0';

// Shell files — updated after build when hashed _app filenames are known
const SHELL = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/sw.js',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png',
  BASE + '/apple-touch-icon.png',
  BASE + '/_app/immutable/entry/start.Bfj4jwzy.js',
  BASE + '/_app/immutable/chunks/BrzQk6aK.js',
  BASE + '/_app/immutable/chunks/BSw_KR7x.js',
  BASE + '/_app/immutable/chunks/C6MFgNCR.js',
  BASE + '/_app/immutable/entry/app.Be50Zr4O.js',
  BASE + '/_app/immutable/chunks/CmsKOCeN.js',
  BASE + '/_app/immutable/chunks/-In5gsl0.js',
  BASE + '/_app/immutable/nodes/0.CorkbS5-.js',
  BASE + '/_app/immutable/chunks/CByg84qE.js',
  BASE + '/_app/immutable/assets/0.BdWKE3eZ.css',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'GET_VERSION') {
    e.source?.postMessage({ type: 'SW_VERSION', version: CACHE });
  }
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // external: don't intercept

  // Cache-first: immutable hashed bundles (_app/immutable/)
  if (url.pathname.includes('/_app/immutable/')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // SPA fallback: any navigation request → index.html
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => res.ok ? res : caches.match(BASE + '/index.html'))
        .catch(() => caches.match(BASE + '/index.html'))
    );
    return;
  }

  // Static assets: cache-first with network fallback
  if (/\.(png|jpg|jpeg|svg|woff2|ico)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }))
    );
    return;
  }

  // Default: network-first (API calls, sw.js itself)
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
