// ── SERVICE WORKER · Дорожный журнал ───────────────────────────────────────────
const CACHE_STATIC  = 'travel-static-v65';
const CACHE_TILES   = 'travel-tiles-v2';
const CACHE_FONTS   = 'travel-fonts-v1';

// Static assets to precache on install
const PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/data.js',
  './js/storage.js',
  './js/map.js',
  './js/render.js',
  './js/app.js',
  './js/gps.js',
  './js/chat.js',
  './js/notes.js',
  './js/offline.js',
  './js/gpx.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

// ── INSTALL ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_STATIC).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => {
        if (k !== CACHE_STATIC && k !== CACHE_TILES && k !== CACHE_FONTS) return caches.delete(k);
      }))
    )
  );
  self.clients.claim();
});

// ── FETCH ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 1) Map tiles → cache-first (offline maps!)
  if (url.hostname.includes('tile.openstreetmap.org') ||
      url.hostname.includes('tiles.wmflabs.org') ||
      url.hostname.includes('tile.thunderforest.com')) {
    e.respondWith(tileStrategy(e.request));
    return;
  }

  // 2) Google Fonts / CDN fonts → cache-first
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    e.respondWith(cacheFirst(e.request, CACHE_FONTS));
    return;
  }

  // 3) Leaflet CDN → cache-first
  if (url.hostname.includes('cdnjs.cloudflare.com') && url.pathname.includes('leaflet')) {
    e.respondWith(cacheFirst(e.request, CACHE_STATIC));
    return;
  }

  // 4) Firebase / GitHub API / external APIs → network only (no cache)
  if (url.hostname.includes('firebase') ||
      url.hostname.includes('gstatic.com/firebasejs') ||
      url.hostname.includes('identitytoolkit.googleapis.com') ||
      url.hostname.includes('securetoken.googleapis.com') ||
      url.hostname.includes('api.github.com') ||
      url.hostname.includes('gist.githubusercontent.com') ||
      url.hostname.includes('firebasestorage.googleapis.com')) {
    return; // default browser fetch
  }

  // 5) Own static files → stale-while-revalidate
  if (url.origin === location.origin) {
    e.respondWith(staleWhileRevalidate(e.request, CACHE_STATIC));
    return;
  }
});

// ── STRATEGIES ────────────────────────────────────────────────────────────────

// Tiles: cache-first, store forever (until cache is cleared)
// Normalize a/b/c.tile.openstreetmap.org → tile.openstreetmap.org
// Leaflet uses random subdomains for load balancing; we cache under canonical URL
function normalizeTileUrl(url) {
  return url.replace(/^https:\/\/[abc]\.tile\.openstreetmap\.org\//, 'https://tile.openstreetmap.org/');
}

// Minimum zoom level we realistically cache along the route
const TILE_FALLBACK_MIN_ZOOM = 5;

// Parse zoom/x/y from a canonical tile URL
function parseTileCoords(url) {
  const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/);
  return m ? { z: +m[1], x: +m[2], y: +m[3] } : null;
}

// Build canonical tile URL from coords
function tileUrl(z, x, y) {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

async function tileStrategy(request) {
  const cache     = await caches.open(CACHE_TILES);
  const canonical = normalizeTileUrl(request.url);
  const cacheKey  = canonical !== request.url ? new Request(canonical) : request;

  // 1. Exact cache hit (canonical URL)
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 2. Try network (we are online)
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Store under canonical URL so prefetch + live requests share the same key
      cache.put(cacheKey, response.clone());
    }
    return response;
  } catch {
    // 3. Offline — try lower-zoom fallback tiles (overzoom)
    // Walk down from requested zoom to TILE_FALLBACK_MIN_ZOOM looking for any cached tile
    const coords = parseTileCoords(canonical);
    if (coords) {
      for (let z = coords.z - 1; z >= TILE_FALLBACK_MIN_ZOOM; z--) {
        const diff = coords.z - z;
        const scale = Math.pow(2, diff);
        const fx = Math.floor(coords.x / scale);
        const fy = Math.floor(coords.y / scale);
        const fallbackReq = new Request(tileUrl(z, fx, fy));
        const fallback = await cache.match(fallbackReq);
        if (fallback) return fallback;
      }
    }

    // 4. Nothing found — transparent 1×1 px PNG
    return new Response(
      Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}

// Generic cache-first
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('', { status: 503 });
  }
}

// Stale-while-revalidate: return cached immediately, update in background
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || (await fetchPromise) || new Response('Offline', { status: 503 });
}

// ── MESSAGE: prefetch tiles along route ───────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'PREFETCH_TILES') {
    prefetchTiles(e.data.tiles, e.data.clientId);
  }
  if (e.data?.type === 'CLEAR_TILE_CACHE') {
    caches.delete(CACHE_TILES);
  }
});

async function prefetchTiles(tileUrls, clientId) {
  const cache = await caches.open(CACHE_TILES);
  let done = 0;
  const total = tileUrls.length;

  for (const url of tileUrls) {
    try {
      const exists = await cache.match(url);
      if (!exists) {
        const resp = await fetch(url);
        if (resp.ok) await cache.put(url, resp);
        // Polite delay: don't hammer OSM servers
        await new Promise(r => setTimeout(r, 80));
      }
      done++;
      // Report progress every 20 tiles
      if (done % 20 === 0 || done === total) {
        const clients = await self.clients.matchAll();
        clients.forEach(c => c.postMessage({ type: 'PREFETCH_PROGRESS', done, total }));
      }
    } catch {
      done++;
    }
  }
  const clients = await self.clients.matchAll();
  clients.forEach(c => c.postMessage({ type: 'PREFETCH_DONE', done, total }));
}
