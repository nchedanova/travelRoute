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

function getTilesAlongRoute(stops, zooms, paddingTiles) {
  if (!stops.length) return [];
  paddingTiles = paddingTiles || 2;
  const urls = new Set();
  const points = stops.filter(s => s.lat && s.lng);

  for (const zoom of zooms) {
    // Get bounding tiles for each pair of consecutive points
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const tx = lng2tile(p.lng, zoom);
      const ty = lat2tile(p.lat, zoom);
      // Add padding around each point
      for (let dx = -paddingTiles; dx <= paddingTiles; dx++) {
        for (let dy = -paddingTiles; dy <= paddingTiles; dy++) {
          urls.add(`https://tile.openstreetmap.org/${zoom}/${tx + dx}/${ty + dy}.png`);
        }
      }
    }

    // Fill gaps between consecutive points
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const ax = lng2tile(a.lng, zoom), ay = lat2tile(a.lat, zoom);
      const bx = lng2tile(b.lng, zoom), by = lat2tile(b.lat, zoom);
      const minX = Math.min(ax, bx) - 1, maxX = Math.max(ax, bx) + 1;
      const minY = Math.min(ay, by) - 1, maxY = Math.max(ay, by) + 1;
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          urls.add(`https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`);
        }
      }
    }
  }
  return [...urls];
}

function prefetchRouteTiles(dayNum) {
  if (!navigator.serviceWorker?.controller) {
    showToast && showToast('⚠ Service Worker не активен');
    return;
  }
  const day = typeof DAYS_DATA !== 'undefined' ? DAYS_DATA[dayNum] : null;
  if (!day) return;

  const allPoints = [];
  if (day.start?.lat) allPoints.push(day.start);
  day.stops.forEach(s => { if (s.lat && s.lng) allPoints.push(s); });

  const tiles = getTilesAlongRoute(allPoints, [8, 10, 12, 14], 2);
  console.log(`[tiles] Prefetching ${tiles.length} tiles for day ${dayNum}`);
  showToast && showToast(`📥 Загрузка карты: ${tiles.length} тайлов…`);

  navigator.serviceWorker.controller.postMessage({
    type: 'PREFETCH_TILES',
    tiles
  });
}

// Listen for progress from SW
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'PREFETCH_PROGRESS') {
      const pct = Math.round(e.data.done / e.data.total * 100);
      setSyncStatus && setSyncStatus(`📥 карта: ${pct}%`, 'var(--amber)');
    }
    if (e.data?.type === 'PREFETCH_DONE') {
      setSyncStatus && setSyncStatus('📥 карта загружена', 'var(--green)');
      showToast && showToast(`✅ Карта сохранена (${e.data.done} тайлов)`);
      setTimeout(() => setSyncStatus && setSyncStatus('☁ ок', 'var(--muted)'), 3000);
    }
  });
}
