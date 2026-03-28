// ── OFFLINE MODULE ─────────────────────────────────────────────────────────────
// IndexedDB буфер для GPS-трека, оффлайн-сообщений чата, очереди push-уведомлений.
// Синхронизация с Firebase при появлении сети.

const DB_NAME    = 'travel_offline';
const DB_VERSION = 1;
let _offlineDb   = null;

// ── INIT ───────────────────────────────────────────────────────────────────────
function initOfflineDb() {
  return new Promise((resolve, reject) => {
    if (_offlineDb) { resolve(_offlineDb); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('gps_track'))  db.createObjectStore('gps_track',  { keyPath: 'ts' });
      if (!db.objectStoreNames.contains('chat_queue')) db.createObjectStore('chat_queue', { keyPath: 'ts' });
    };
    req.onsuccess = e => { _offlineDb = e.target.result; resolve(_offlineDb); };
    req.onerror   = e => { console.error('IndexedDB error', e); reject(e); };
  });
}

// ── GPS TRACK ─────────────────────────────────────────────────────────────────
// Записываем каждую GPS-точку в IndexedDB (всегда, независимо от сети)
async function saveGpsPoint(point) {
  try {
    const db = await initOfflineDb();
    const tx = db.transaction('gps_track', 'readwrite');
    tx.objectStore('gps_track').put(point);
  } catch(e) { console.warn('saveGpsPoint error', e); }
}

// Получить весь трек (для GPX-экспорта)
async function getGpsTrack() {
  try {
    const db = await initOfflineDb();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction('gps_track', 'readonly');
      const req = tx.objectStore('gps_track').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  } catch { return []; }
}

// Очистить трек (после экспорта или при новом дне)
async function clearGpsTrack() {
  try {
    const db = await initOfflineDb();
    const tx = db.transaction('gps_track', 'readwrite');
    tx.objectStore('gps_track').clear();
  } catch(e) { console.warn('clearGpsTrack error', e); }
}

// ── OFFLINE GPS → FIREBASE SYNC ───────────────────────────────────────────────
let _gpsOnline = navigator.onLine;
let _gpsPendingBuffer = []; // точки накопленные без сети

function bufferGpsForSync(point) {
  if (navigator.onLine) return false; // сеть есть, пишем напрямую
  _gpsPendingBuffer.push(point);
  return true; // буферизировано
}

async function flushGpsBuffer() {
  if (!_gpsPendingBuffer.length) return;
  if (typeof firebase === 'undefined' || !firebase.apps.length) return;
  const db = firebase.database();
  const updates = {};
  _gpsPendingBuffer.forEach(p => {
    const key = db.ref('gps_history').push().key;
    updates['gps_history/' + key] = p;
  });
  try {
    await db.ref().update(updates);
    console.log(`[offline] Synced ${_gpsPendingBuffer.length} GPS points`);
    _gpsPendingBuffer = [];
  } catch(e) {
    console.warn('[offline] GPS sync failed, will retry', e);
  }
}

// ── CHAT OFFLINE QUEUE ────────────────────────────────────────────────────────
async function queueChatMessage(msg) {
  try {
    const db = await initOfflineDb();
    const tx = db.transaction('chat_queue', 'readwrite');
    tx.objectStore('chat_queue').put(msg);
  } catch(e) { console.warn('queueChatMessage error', e); }
}

async function flushChatQueue() {
  try {
    const db = await initOfflineDb();
    const tx  = db.transaction('chat_queue', 'readonly');
    const req = tx.objectStore('chat_queue').getAll();
    const msgs = await new Promise((res, rej) => { req.onsuccess = () => res(req.result || []); req.onerror = rej; });
    if (!msgs.length) return;

    if (typeof firebase === 'undefined' || !firebase.apps.length) return;
    const chatRef = firebase.database().ref('chat');
    for (const msg of msgs) {
      await chatRef.push().set({ name: msg.name, role: msg.role, text: msg.text, ts: msg.ts });
    }
    // Очищаем очередь
    const txClear = db.transaction('chat_queue', 'readwrite');
    txClear.objectStore('chat_queue').clear();
    console.log(`[offline] Synced ${msgs.length} chat messages`);
  } catch(e) {
    console.warn('[offline] Chat sync failed', e);
  }
}

// ── NETWORK LISTENERS ─────────────────────────────────────────────────────────
function initOfflineSync() {
  initOfflineDb();

  window.addEventListener('online', () => {
    console.log('[offline] Back online — syncing...');
    showToast && showToast('🔄 Сеть появилась, синхронизация…');
    flushGpsBuffer();
    flushChatQueue();
  });

  window.addEventListener('offline', () => {
    console.log('[offline] Went offline');
    showToast && showToast('📴 Нет сети — данные сохраняются локально');
  });
}

// ── TILE PREFETCH HELPER ──────────────────────────────────────────────────────
// Вычисляет номера тайлов вдоль маршрута и просит SW скачать их

function lng2tile(lng, zoom) { return Math.floor((lng + 180) / 360 * Math.pow(2, zoom)); }
function lat2tile(lat, zoom) {
  return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
}

// Стратегия кэширования тайлов:
//   z5,z8  — весь маршрут (обзор страны/дня)
//   z11    — весь маршрут, узкий коридор (основной рабочий зум)
//   z13,z14 — весь маршрут (z13 широкий обзор, z14 детали по трассе)
//   z15    — только вокруг точек остановок (навигация на месте)
// z14 вдоль всей линии убран — слишком много тайлов без реальной пользы

function _addTilesWithPadding(urls, tx, ty, zoom, pad) {
  for (let dx = -pad; dx <= pad; dx++) {
    for (let dy = -pad; dy <= pad; dy++) {
      urls.add(`https://tile.openstreetmap.org/${zoom}/${tx + dx}/${ty + dy}.png`);
    }
  }
}

function _bresenhamLine(ax, ay, bx, by, urls, zoom, pad) {
  let dx = Math.abs(bx - ax), dy = Math.abs(by - ay);
  let sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
  let err = dx - dy, cx = ax, cy = ay;
  while (true) {
    _addTilesWithPadding(urls, cx, cy, zoom, pad);
    if (cx === bx && cy === by) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 <  dx) { err += dx; cy += sy; }
  }
}

// Haversine distance in km (for route length estimation)
function _haversineKm(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getTilesAlongRoute(points, isWalk, routeCoords) {
  if (!points.length) return [];
  const pts = points.filter(s => s.lat && s.lng);
  if (!pts.length) return [];
  const urls = new Set();

  // Dense road coords from OSRM cache (if available)
  // These trace the actual road — no bresenham needed, just tile padding around each point
  const road = (routeCoords && routeCoords.length > 1) ? routeCoords : null;

  // Estimate total route distance
  var totalKm = 0;
  for (var k = 0; k < pts.length - 1; k++)
    totalKm += _haversineKm(pts[k].lat, pts[k].lng, pts[k+1].lat, pts[k+1].lng);

  // Helper: add tiles along road (OSRM coords) or fallback to bresenham between stops
  function _addRouteZoom(z, padPts, padLine) {
    // Always add tiles around stop points with padPts
    for (let i = 0; i < pts.length; i++)
      _addTilesWithPadding(urls, lng2tile(pts[i].lng, z), lat2tile(pts[i].lat, z), z, padPts);

    if (road) {
      // Dense road coords: just add pad around each point (no bresenham — already dense)
      for (let i = 0; i < road.length; i++)
        _addTilesWithPadding(urls, lng2tile(road[i].lng, z), lat2tile(road[i].lat, z), z, padLine);
    } else {
      // Fallback: straight bresenham between stop points
      for (let i = 0; i < pts.length - 1; i++)
        _bresenhamLine(lng2tile(pts[i].lng, z), lat2tile(pts[i].lat, z),
                       lng2tile(pts[i+1].lng, z), lat2tile(pts[i+1].lat, z), urls, z, padLine);
    }
  }

  if (isWalk) {
    // ── Walk mode: z13-z18 along entire route ──
    for (let wz = 13; wz <= 18; wz++)
      _addRouteZoom(wz, 2, 1);

  } else {
    // ── Auto mode ──

    if (totalKm >= 550) {
      // Long route (>550 km): z6-z14 route, z16-z17 points
      _addRouteZoom(6, 1, 1);
      _addRouteZoom(7, 1, 1);
      _addRouteZoom(8, 2, 1);
      _addRouteZoom(9, 2, 1);
      _addRouteZoom(10, 2, 1);
      _addRouteZoom(11, 3, 1);
      _addRouteZoom(12, 2, 1);
      _addRouteZoom(13, 2, 1);
      _addRouteZoom(14, 2, 1);
    } else {
      // Short route (<550 km): z8-z15 route, z16-z17 points
      _addRouteZoom(8, 2, 1);
      _addRouteZoom(9, 2, 1);
      _addRouteZoom(10, 2, 1);
      _addRouteZoom(11, 3, 1);
      _addRouteZoom(12, 2, 1);
      _addRouteZoom(13, 2, 1);
      _addRouteZoom(14, 2, 1);
      _addRouteZoom(15, 2, 1);
    }

    // z16, z17 — вокруг точек остановок (навигация на месте)
    for (let i = 0; i < pts.length; i++)
      _addTilesWithPadding(urls, lng2tile(pts[i].lng, 16), lat2tile(pts[i].lat, 16), 16, 3);
    for (let i = 0; i < pts.length; i++)
      _addTilesWithPadding(urls, lng2tile(pts[i].lng, 17), lat2tile(pts[i].lat, 17), 17, 2);
  }

  return [...urls];
}

async function prefetchRouteTiles(dayNum) {
  if (!navigator.serviceWorker) {
    showToast && showToast('⚠ Service Worker не поддерживается');
    return;
  }
  // Ждём пока SW будет готов (на первом визите controller = null)
  let sw = navigator.serviceWorker.controller;
  if (!sw) {
    showToast && showToast('⏳ Ждём Service Worker…');
    const reg = await navigator.serviceWorker.ready;
    sw = reg.active;
    if (!sw) { showToast && showToast('⚠ Service Worker не активен, перезагрузите страницу'); return; }
  }
  const day = typeof DAYS_DATA !== 'undefined' ? DAYS_DATA[dayNum] : null;
  if (!day) return;

  const allPoints = [];
  if (day.start?.lat) allPoints.push(day.start);
  day.stops.forEach(s => { if (s.lat && s.lng) allPoints.push(s); });

  // Get dense road coordinates from OSRM cache (traces actual road, not straight lines)
  const routeCoords = (typeof getDayRouteCoords === 'function') ? getDayRouteCoords(dayNum) : [];

  const tiles = getTilesAlongRoute(allPoints, !!day.walkMode, routeCoords);
  // Debug breakdown by zoom
  const byZoom = {};
  tiles.forEach(u => { const z = u.split('/')[3]; byZoom[z] = (byZoom[z]||0)+1; });
  console.log(`[tiles] Day ${dayNum}: ${tiles.length} total`, byZoom);
  showToast && showToast(`📥 Загрузка карты: ${tiles.length} тайлов…`);
  window._tilePrefetching = true;

  sw.postMessage({ type: 'PREFETCH_TILES', tiles });
}

// Listen for progress from SW
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'PREFETCH_PROGRESS') {
      const pct = Math.round(e.data.done / e.data.total * 100);
      const msg = `📥 Карта: ${pct}% (${e.data.done}/${e.data.total})`;
      setSyncStatus && setSyncStatus(msg, 'var(--amber)');
      // Обновляем toast каждые 25%
      if (pct % 25 === 0) showToast && showToast(msg);
    }
    if (e.data?.type === 'PREFETCH_DONE') {
      window._tilePrefetching = false;
      setSyncStatus && setSyncStatus('✅ Карта загружена', 'var(--green)');
      showToast && showToast(`✅ Карта сохранена! (${e.data.done} тайлов)`);
      setTimeout(() => setSyncStatus && setSyncStatus('☁ ок', 'var(--muted)'), 5000);
    }
  });
}

async function clearTileCache() {
  if (!navigator.serviceWorker?.controller) {
    showToast && showToast('⚠ Service Worker не активен');
    return;
  }
  navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_TILE_CACHE' });
  showToast && showToast('🗑 Кэш карты очищен');
}
