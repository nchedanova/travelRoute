// ── SERVICE WORKER · Дорожный журнал ───────────────────────────────────────────
const APP_VERSION   = '2.8.0';
const APP_BUILD     = 66;
// CACHE_STATIC включает build — при каждом бампе старый кэш автоматически удаляется
const CACHE_STATIC  = 'travel-static-v' + APP_VERSION.replace(/\./g,'-') + '-b' + APP_BUILD;
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
  './js/import.js',
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
    caches.open(CACHE_STATIC).then(cache => {
      // Use cache:'reload' to bypass any intermediate caches (including old SW).
      // This ensures the new SW always fetches fresh files from the network.
      return Promise.all(PRECACHE.map(url => {
        return fetch(new Request(url, { cache: 'reload' }))
          .then(resp => { if (resp.ok) return cache.put(url, resp.clone()); })
          .catch(() => {}); // non-critical if one file fails
      }));
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => {
        // Delete all old static caches + any unknown caches
        const keep = [CACHE_STATIC, CACHE_TILES, CACHE_FONTS];
        if (!keep.includes(k)) return caches.delete(k);
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
      url.hostname.includes('firebasestorage.googleapis.com') ||
      url.hostname.includes('open-meteo.com') ||
      url.hostname.includes('nominatim.openstreetmap.org') ||
      url.hostname.includes('routing.openstreetmap.de') ||
      url.hostname.includes('router.project-osrm.org')) {
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

async function tileStrategy(request) {
  const cache     = await caches.open(CACHE_TILES);
  const canonical = normalizeTileUrl(request.url);
  const cacheKey  = canonical !== request.url ? new Request(canonical) : request;

  // Cache hit (canonical URL — strips a/b/c subdomain)
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Network fetch — store under canonical URL
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(cacheKey, response.clone());
    return response;
  } catch {
    // Offline + not cached → transparent 1×1 px PNG
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
// Uses ignoreSearch:true so ?v=68 matches cached ./js/app.js from install.
// CRITICAL: background cache.put uses NORMALIZED url (no query string) so it
// OVERWRITES the install entry. Without this, install writes key "app.js" and
// background writes key "app.js?v=68" — two entries, ignoreSearch always finds
// the stale install one first → infinite stale loop.
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  // ignoreSearch lets versioned ?v=N URLs hit unversioned precache entries
  const cached = await cache.match(request, { ignoreSearch: true });
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      // Normalize: strip query string so we overwrite the precache entry
      var normalUrl = new URL(request.url);
      normalUrl.search = '';
      cache.put(normalUrl.href, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || (await fetchPromise) || new Response('Offline', { status: 503 });
}

// ── MESSAGE: prefetch tiles along route ───────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (e.data?.type === 'GET_VERSION') {
    // Must reply on e.ports[0] — that's the MessageChannel port client is listening on
    if (e.ports && e.ports[0]) {
      e.ports[0].postMessage({ type: 'SW_VERSION', build: APP_BUILD, version: APP_VERSION });
    }
    return;
  }
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
