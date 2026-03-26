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
//   z13    — весь маршрут (ключевой зум для мобилок, maxNativeZoom=13 оффлайн)
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

function getTilesAlongRoute(points) {
  if (!points.length) return [];
  const pts = points.filter(s => s.lat && s.lng);
  if (!pts.length) return [];
  const urls = new Set();

  // z5 — обзор всей страны, маршрут виден целиком
  for (let i = 0; i < pts.length; i++)
    _addTilesWithPadding(urls, lng2tile(pts[i].lng, 5), lat2tile(pts[i].lat, 5), 5, 1);
  for (let i = 0; i < pts.length - 1; i++)
    _bresenhamLine(lng2tile(pts[i].lng, 5), lat2tile(pts[i].lat, 5),
                   lng2tile(pts[i+1].lng, 5), lat2tile(pts[i+1].lat, 5), urls, 5, 1);

  // z8 — обзор дня (вся Россия → регион)
  for (let i = 0; i < pts.length; i++)
    _addTilesWithPadding(urls, lng2tile(pts[i].lng, 8), lat2tile(pts[i].lat, 8), 8, 2);
  for (let i = 0; i < pts.length - 1; i++)
    _bresenhamLine(lng2tile(pts[i].lng, 8), lat2tile(pts[i].lat, 8),
                   lng2tile(pts[i+1].lng, 8), lat2tile(pts[i+1].lat, 8), urls, 8, 1);

  // z11 — основной рабочий зум (виден маршрут + окрестности), весь коридор
  for (let i = 0; i < pts.length; i++)
    _addTilesWithPadding(urls, lng2tile(pts[i].lng, 11), lat2tile(pts[i].lat, 11), 11, 3);
  for (let i = 0; i < pts.length - 1; i++)
    _bresenhamLine(lng2tile(pts[i].lng, 11), lat2tile(pts[i].lat, 11),
                   lng2tile(pts[i+1].lng, 11), lat2tile(pts[i+1].lat, 11), urls, 11, 1);

  // z12 — средний план, весь маршрут (заполняет дыру между z11 и z13)
  for (let i = 0; i < pts.length; i++)
    _addTilesWithPadding(urls, lng2tile(pts[i].lng, 12), lat2tile(pts[i].lat, 12), 12, 2);
  for (let i = 0; i < pts.length - 1; i++)
    _bresenhamLine(lng2tile(pts[i].lng, 12), lat2tile(pts[i].lat, 12),
                   lng2tile(pts[i+1].lng, 12), lat2tile(pts[i+1].lat, 12), urls, 12, 1);

  // z13 — весь маршрут (ключевой уровень для мобилок, maxNativeZoom offline = 13)
  // padding 2 вокруг точек + Bresenham с padding 1 вдоль всей трассы
  for (let i = 0; i < pts.length; i++)
    _addTilesWithPadding(urls, lng2tile(pts[i].lng, 13), lat2tile(pts[i].lat, 13), 13, 2);
  for (let i = 0; i < pts.length - 1; i++)
    _bresenhamLine(lng2tile(pts[i].lng, 13), lat2tile(pts[i].lat, 13),
                   lng2tile(pts[i+1].lng, 13), lat2tile(pts[i+1].lat, 13), urls, 13, 1);

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

  const tiles = getTilesAlongRoute(allPoints);
  // Debug breakdown by zoom
  const byZoom = {};
  tiles.forEach(u => { const z = u.split('/')[3]; byZoom[z] = (byZoom[z]||0)+1; });
  console.log(`[tiles] Day ${dayNum}: ${tiles.length} total`, byZoom);
  showToast && showToast(`📥 Загрузка карты: ${tiles.length} тайлов…`);

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
