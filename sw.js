// ReturnLink service worker
// Strategy:
//  - Precache app shell (HTML, manifest, icons)
//  - Network-first for /api/* (so live data wins when online, cache when offline)
//  - Cache-first for Google Fonts (rarely change)
//  - Stale-while-revalidate for everything else same-origin

const VERSION = 'rl-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;
const FONT_CACHE = `${VERSION}-fonts`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

// ----- Install: precache shell -----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ----- Activate: clean up old caches -----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ----- Fetch: route by request type -----
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests (POST/PUT/DELETE pass through)
  if (req.method !== 'GET') return;

  // API requests: network-first, fall back to cache
  if (url.pathname.startsWith('/api/') || url.hostname.includes('railway.app') || url.hostname.includes('up.railway')) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  // Netlify functions: network only (don't cache mutations or AI calls)
  if (url.pathname.startsWith('/.netlify/functions/')) {
    return; // let browser handle directly
  }

  // Google Fonts: cache-first, long-lived
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // Same-origin shell assets: stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }
});

// ----- Strategies -----

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // No cache + no network: return a JSON error so the frontend can fall back
    return new Response(
      JSON.stringify({ offline: true, error: 'no cached response' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    return new Response('', { status: 503 });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

// ----- Allow page to trigger immediate update -----
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
