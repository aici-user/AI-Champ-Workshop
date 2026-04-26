/**
 * AI Champ — Service Worker
 * Caches static assets for faster load; API calls always go to network.
 */

const CACHE_NAME   = 'aichamp-v1';
const STATIC_CACHE = 'aichamp-static-v1';

// Assets to pre-cache on install
const PRE_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,700&family=Open+Sans:wght@300;400;500;600&display=swap',
];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(PRE_CACHE).catch(() => {
        // Non-fatal — some external CDN assets may fail during install
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== STATIC_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for API, cache-first for static assets
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Always use network for API calls — never serve OTP from cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Network-first for HTML pages
  if (request.headers.get('accept') && request.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('/')))
    );
    return;
  }

  // Cache-first for everything else (images, fonts, CSS, JS)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, clone));
        return res;
      });
    })
  );
});
