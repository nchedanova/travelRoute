// ── MAP ───────────────────────────────────────────────────────────────────────
let map;
const layers        = {};
const segmentLayers = {};

// ── OSRM ROUTING ──────────────────────────────────────────────────────────────
const OSRM_CACHE_KEY = 'travel_route_cache_v2';
const OSRM_DELAY_MS  = 650; // задержка между запросами (публичный OSRM ~600ms)

// Кэш маршрутов: ключ = "profile|lat1,lng1|lat2,lng2" → массив [lat,lng]
// Загружается из localStorage при старте → линии сразу по дорогам без OSRM-запроса
const _routeCache = (() => {
  try {
    var raw = JSON.parse(localStorage.getItem(OSRM_CACHE_KEY) || '{}');
    Object.keys(raw).forEach(k => { if (!/^(driving|foot)\|/.test(k)) delete raw[k]; });
    return raw;
  }
  catch(e) { console.warn('[routeCache] Failed to load:', e); return {}; }
})();

const OSRM_DURATION_KEY = 'travel_duration_cache_v1';

const _durationCache = (() => {
  try {
    var raw = JSON.parse(localStorage.getItem(OSRM_DURATION_KEY) || '{}');
    Object.keys(raw).forEach(k => { if (!/^(driving|foot)\|/.test(k)) delete raw[k]; });
    return raw;
  }
  catch(e) { return {}; }
})();

function getSegmentDuration(from, to, profile) {
  profile = profile || 'driving';
  var key = profile + '|' + from.lat + ',' + from.lng + '|' + to.lat + ',' + to.lng;
  return _durationCache[key] != null ? _durationCache[key] : null;
}

let _cacheSaveTimer = null;
function _persistCache() {
  clearTimeout(_cacheSaveTimer);
  _cacheSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(OSRM_CACHE_KEY, JSON.stringify(_routeCache));
      localStorage.setItem(OSRM_DURATION_KEY, JSON.stringify(_durationCache));
    }
    catch (e) {
      if (e.name === 'QuotaExceededError') {
        const keys = Object.keys(_routeCache);
        keys.slice(0, Math.floor(keys.length / 2)).forEach(k => { delete _routeCache[k]; delete _durationCache[k]; });
        try {
          localStorage.setItem(OSRM_CACHE_KEY, JSON.stringify(_routeCache));
          localStorage.setItem(OSRM_DURATION_KEY, JSON.stringify(_durationCache));
        } catch {}
      }
    }
  }, 300);
}

// Страховка: при уходе со страницы сохраняем немедленно (SW auto-reload, ручной F5)
window.addEventListener('beforeunload', function() {
  clearTimeout(_cacheSaveTimer);
  try {
    localStorage.setItem(OSRM_CACHE_KEY, JSON.stringify(_routeCache));
    localStorage.setItem(OSRM_DURATION_KEY, JSON.stringify(_durationCache));
  } catch {}
});


// Очередь запросов: предотвращает rate-limit на публичном OSRM
const _fetchQueue = [];
let   _queueBusy  = false;

function _flushQueue() {
  while (_fetchQueue.length > 0) {
    const item = _fetchQueue.shift();
    item.reject(new Error('flushed'));
  }
  _durQueue.length = 0;
}

async function _drainQueue() {
  if (_queueBusy) return;
  _queueBusy = true;
  while (_fetchQueue.length > 0) {
    const { from, to, profile, resolve, reject } = _fetchQueue.shift();
    try { resolve(await _osrmFetch(from, to, profile)); }
    catch (e) { reject(e); }
    if (_fetchQueue.length > 0) {
      await new Promise(r => setTimeout(r, OSRM_DELAY_MS));
    }
  }
  _queueBusy = false;
}

async function _osrmFetch(from, to, profile) {
  profile = profile || 'driving';
  const key = `${profile}|${from.lat},${from.lng}|${to.lat},${to.lng}`;
  if (_routeCache[key]) return _routeCache[key];

  // router.project-osrm.org only supports driving profile.
  // For foot routing we use routing.openstreetmap.de which supports all profiles.
  let url;
  if (profile === 'foot') {
    url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?overview=full&geometries=geojson`;
  } else {
    url = `https://router.project-osrm.org/route/v1/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?overview=full&geometries=geojson`;
  }

  // До 3 попыток при ошибке / rate-limit
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
        continue;
      }
      if (!r.ok) return null;
      const data = await r.json();
      if (data.code !== 'Ok' || !data.routes?.length) return null;
      const coords = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      _routeCache[key] = coords;
      if (data.routes[0].duration != null) _durationCache[key] = data.routes[0].duration;
      _persistCache(); // сохраняем в localStorage для следующей сессии
      return coords;
    } catch (_) {
      if (attempt === 2) return null;
      await new Promise(res => setTimeout(res, 600));
    }
  }
  return null;
}

// Флаг: OSRM-запросы разрешены только после загрузки реальных данных.
// Без этого init-рендер demo-данных (5 дней × 7+ сегм.) отправляет ~35 запросов,
// их геометрия (особенно длинные маршруты) переполняет localStorage-квоту.
let _routeLoadingEnabled = false;
function enableRouteLoading() { _routeLoadingEnabled = true; }

function fetchRoadSegment(from, to, profile) {
  profile = profile || 'driving';
  const key = `${profile}|${from.lat},${from.lng}|${to.lat},${to.lng}`;
  // Мгновенный ответ из кэша — без добавления в очередь
  if (_routeCache[key]) return Promise.resolve(_routeCache[key]);
  // Не отправляем OSRM пока не загружены реальные данные
  if (!_routeLoadingEnabled) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    _fetchQueue.push({ from, to, profile, resolve, reject });
    _drainQueue();
  });
}

var _durQueue = [];
var _durBusy = false;

async function _drainDurQueue() {
  if (_durBusy) return;
  _durBusy = true;
  while (_durQueue.length > 0) {
    var item = _durQueue.shift();
    try { await _fetchDurationSingle(item.from, item.to, item.profile); } catch(_) {}
    if (item.cb) item.cb();
    if (_durQueue.length > 0) await new Promise(function(r) { setTimeout(r, OSRM_DELAY_MS); });
  }
  _durBusy = false;
}

async function _fetchDurationSingle(from, to, profile) {
  profile = profile || 'driving';
  var key = profile + '|' + from.lat + ',' + from.lng + '|' + to.lat + ',' + to.lng;
  if (_durationCache[key] != null) return;
  var url;
  if (profile === 'foot') {
    url = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/' +
      from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat + '?overview=false';
  } else {
    url = 'https://router.project-osrm.org/route/v1/driving/' +
      from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat + '?overview=false';
  }
  try {
    var r = await fetch(url);
    if (!r.ok) return;
    var data = await r.json();
    if (data.code !== 'Ok' || !data.routes?.length) return;
    _durationCache[key] = data.routes[0].duration;
    _persistCache();
  } catch (_) {}
}

function _fetchDuration(from, to, profile, cb) {
  _durQueue.push({ from: from, to: to, profile: profile, cb: cb });
  _drainDurQueue();
}

function initMap() {
  map = L.map('map', { center:[51.5, 39.5], zoom:5, zoomControl:true, attributionControl:false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

  // Offline: cap zoom to highest fully-cached level.
  // Both walk and auto now cache z18 (walk: route, auto: around stops).
  function _getOfflineMaxZoom() { return 18; }
  window.addEventListener('offline', function() {
    var maxZ = _getOfflineMaxZoom();
    map.setMaxZoom(maxZ);
    if (map.getZoom() > maxZ) map.setZoom(maxZ);
  });
  window.addEventListener('online', function() {
    map.setMaxZoom(19);
  });
  map.zoomControl.setPosition('topright');

  // Zoom-adaptive segment style: refresh on zoom change
  map.on('zoomend', function() { refreshSegments(); });

  // тап/клик по карте — закрываем пилл или добавляем точку
  // Firefox: marker click bubbles to map even after stopPropagation on divIcon,
  // so we suppress the map click for a short window after any marker click
  let _suppressMapClick = false;
  map.on('click', (e) => {
    if (_suppressMapClick) return;
    if (window._mapAddMode) {
      window._mapAddMode = false;
      document.getElementById('map').style.cursor = '';
      const mapAddBtn = document.getElementById('mapAddBtn');
      if (mapAddBtn) { mapAddBtn.classList.remove('active'); mapAddBtn.textContent = '📍 НА КАРТЕ'; }
      openAddStop(currentDay, e.latlng.lat, e.latlng.lng);
      return;
    }
    closePill();
  });
  // при движении карты — перепозиционируем пилл
  map.on('move', () => {
    if (_activeStop) _positionPill(_activeMarker.getLatLng());
  });

  dayKeys().forEach(d => {
    if (!layers[d])        layers[d]        = L.layerGroup();
    if (!segmentLayers[d]) segmentLayers[d] = [];
  });
}

// ── ICON HELPERS ──────────────────────────────────────────────────────────────
function hexRgba(hex, a, darken = 1) {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * darken);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * darken);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * darken);
  return `rgba(${r},${g},${b},${a})`;
}

function makeIcon(emoji, color, size = 34, active = false) {
  const bg = hexRgba(color, 0.7, 0.45);
  const ring = active
    ? `<div style="position:absolute;inset:-8px;border-radius:50%;border:1.5px solid ${hexRgba(color,0.5)};background:${hexRgba(color,0.1)};animation:pillPulse 1.6s ease-in-out infinite;"></div>` : '';
  const html = `<div style="position:relative;width:${size}px;height:${size}px;">
    ${ring}
    <div style="
      position:relative;width:${size}px;height:${size}px;
      border-radius:50% 50% 50% 0;transform:rotate(-45deg);
      background:${bg};border:2px solid rgba(255,255,255,0.18);
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 12px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.4);">
      <span style="transform:rotate(45deg);font-size:${Math.round(size*0.44)}px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.9));">${emoji}</span>
    </div>
  </div>`;
  const pad = active ? 8 : 0;
  return L.divIcon({ html, className:'', iconSize:[size+pad*2,size+pad*2], iconAnchor:[size/2+pad,size+pad] });
}

function makeStartIcon(emoji, color) {
  const bg = hexRgba(color, 0.7, 0.45);
  const html = `<div style="
    width:38px;height:38px;border-radius:50%;
    background:${bg};border:2px solid rgba(255,255,255,0.18);
    display:flex;align-items:center;justify-content:center;
    font-size:17px;box-shadow:0 2px 12px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.4);
    filter:drop-shadow(0 1px 3px rgba(0,0,0,0.9));">${emoji}</div>`;
  return L.divIcon({ html, className:'', iconSize:[38,38], iconAnchor:[19,19] });
}

// ── PILL POPUP ─────────────────────────────────────────────────────────────────
let _pillEl       = null;   // DOM-элемент пилла
let _activeMarker = null;   // текущий открытый маркер
let _activeStop   = null;   // его данные {s, d, color, marker}

function _getOrCreatePill() {
  if (!_pillEl) {
    _pillEl = document.createElement('div');
    _pillEl.className = 'map-pill-popup';
    _pillEl.style.display = 'none';
    document.getElementById('map').appendChild(_pillEl);
    // клик по пиллу — не закрываем
    _pillEl.addEventListener('click', e => e.stopPropagation());
  }
  return _pillEl;
}

function _pillContent(s, d) {
  const arrEl  = document.getElementById('arr-' + s.id);
  const depEl  = document.getElementById('dep-' + s.id);
  const arrA   = (arrEl && arrEl.value) || s.arrA || '';
  const depA   = (depEl && depEl.value) || s.depA || '';

  function timeBlock(label, plan, fact) {
    const hasFact = fact && fact.length >= 4;
    const hasPlan = plan && plan.length >= 4;
    let factClass = 'pill-fact-no';
    if (hasFact && hasPlan) {
      const [ph,pm] = plan.split(':').map(Number);
      const [fh,fm] = fact.split(':').map(Number);
      factClass = (fh*60+fm) <= (ph*60+pm) ? 'pill-fact-ok' : 'pill-fact-late';
    }
    return `<div class="pill-time-block">
      <div class="pill-time-label">${label}</div>
      <div class="pill-time-plan">${hasPlan ? plan : '—'}</div>
      <div class="pill-time-fact ${factClass}">${hasFact ? fact : '—'}</div>
    </div>`;
  }

  const depBlock = s.depP !== undefined && s.depP !== ''
    ? `<div class="pill-divider"></div>${timeBlock('ОТПР', s.depP, depA)}`
    : '';

  return `<div class="pill-name">${s.icon} ${s.name}</div>
    <div class="pill-times">
      ${timeBlock('ПРИБ', s.arrP, arrA)}
      ${depBlock}
    </div>`;
}

function openPill(marker, s, d, color) {
  // закрываем предыдущий
  closePill(false);

  _activeStop   = { s, d, color, marker };
  _activeMarker = marker;

  // активная иконка с кольцом
  marker.setIcon(makeIcon(s.icon, color, 34, true));

  const pill = _getOrCreatePill();
  pill.innerHTML = _pillContent(s, d);

  _positionPill(marker.getLatLng());
  pill.style.display = 'block';
  // небольшой reflow для transition
  requestAnimationFrame(() => pill.classList.add('pill-visible'));
}

function closePill(resetIcon = true) {
  if (_activeStop && resetIcon) {
    const { s, d, color, marker } = _activeStop;
    marker.setIcon(makeIcon(s.icon, color, 34, false));
  }
  if (_pillEl) {
    _pillEl.classList.remove('pill-visible');
    _pillEl.style.display = 'none';
  }
  _activeStop   = null;
  _activeMarker = null;
}

function _positionPill(latlng) {
  if (!_pillEl) return;
  const pt = map.latLngToContainerPoint(latlng);
  _pillEl.style.left      = pt.x + 'px';
  _pillEl.style.bottom    = (map.getContainer().clientHeight - pt.y + 12) + 'px';
  _pillEl.style.transform = 'translateX(-50%)';
}

function refreshPill() {
  if (!_activeStop) return;
  const { s, d } = _activeStop;
  _getOrCreatePill().innerHTML = _pillContent(s, d);
}

// ── DRAW DAY ──────────────────────────────────────────────────────────────────
function drawDay(d) {
  const data = DAYS_DATA[d];
  if (!data) return;
  const color = data.color;
  const group = layers[d];
  if (!group) return;

  // Стартовый маркер — иконка зависит от режима дня (авто/пешком)
  const startEmoji = data.walkMode ? '🚶' : (data.start.icon || '🚗');
  const startM = L.marker([data.start.lat, data.start.lng], { icon: makeStartIcon(startEmoji, color) });
  group.addLayer(startM);

  // Сегменты маршрута по дорогам (OSRM)
  const allPoints = [
    { lat: data.start.lat, lng: data.start.lng, done: true },
    ...data.stops.map(s => ({ lat: s.lat, lng: s.lng, id: s.id, done: false }))
  ];
  if (!segmentLayers[d]) segmentLayers[d] = [];

  for (let i = 0; i < allPoints.length - 1; i++) {
    const from = allPoints[i], to = allPoints[i + 1];
    const isWalk = !!data.walkMode;
    const profile = isWalk ? 'foot' : 'driving';
    const cacheKey = `${profile}|${from.lat},${from.lng}|${to.lat},${to.lng}`;
    // Если маршрут уже в кэше — рисуем сразу по дорогам (без прямой-placeholder).
    // Иначе — прямая как placeholder, потом async заменяем.
    const cachedCoords = _routeCache[cacheKey];
    const initialLatLngs = cachedCoords && cachedCoords.length
      ? cachedCoords
      : [[from.lat, from.lng], [to.lat, to.lng]];

    let segOutline = null;
    if (!isWalk) {
      segOutline = L.polyline(initialLatLngs,
        { color:'#ffffff', weight:5, opacity:0.08, lineCap:'round', lineJoin:'round' }
      );
      group.addLayer(segOutline);
    }
    const seg = L.polyline(initialLatLngs,
      isWalk
        ? { color, weight:3, opacity:0.3, lineCap:'round', lineJoin:'round', dashArray:'8 5' }
        : { color, weight:3, opacity:0.55, lineCap:'round', lineJoin:'round', dashArray:'6 4' }
    );
    group.addLayer(seg);
    segmentLayers[d].push({ seg, segOutline: segOutline || null, fromId: from.id || null, toId: to.id });

    if (!cachedCoords) {
      // Нет в кэше — запрашиваем OSRM и заменяем прямую когда ответит
      fetchRoadSegment(from, to, profile).then(coords => {
        if (!coords || !group.hasLayer(seg)) return;
        seg.setLatLngs(coords);
        if (segOutline && group.hasLayer(segOutline)) segOutline.setLatLngs(coords);
        refreshSegments();
        if (typeof autoFillTimes === 'function') autoFillTimes(d);
      }).catch(() => {});
    }
    // Кешированный случай: redrawDay вызовет refreshSegments() после drawDay — стили применятся там
  }

  // Маркеры остановок
  data.stops.forEach(s => {
    const marker = L.marker([s.lat, s.lng], { icon: makeIcon(s.icon, color) });
    marker.on('click', e => {
      L.DomEvent.stopPropagation(e);
      // Suppress the map click that Firefox fires right after marker click
      _suppressMapClick = true;
      setTimeout(() => { _suppressMapClick = false; }, 50);
      if (_activeStop && _activeStop.s.id === s.id) { closePill(); return; }
      openPill(marker, s, d, color);
      highlightStop(s.id, d);
    });
    group.addLayer(marker);
  });
}

function redrawDay(d) {
  if (!layers[d]) {
    layers[d]        = L.layerGroup();
    segmentLayers[d] = [];
  } else {
    layers[d].clearLayers();
    segmentLayers[d] = [];
  }
  drawDay(d);
  refreshSegments();
}

function switchMapDay(d) {
  var viewer = typeof isViewer === 'function' && isViewer();
  dayKeys().forEach(n => {
    // Читатель не видит скрытые дни на карте
    if (n === d && !(viewer && DAYS_DATA[n]?.hidden)) {
      layers[n] && layers[n].addTo(map);
    } else {
      layers[n] && map.hasLayer(layers[n]) && map.removeLayer(layers[n]);
    }
  });
  const data = DAYS_DATA[d];
  if (!data) return;
  if (viewer && data.hidden) return;
  const pts = [[data.start.lat, data.start.lng], ...data.stops.map(s => [s.lat, s.lng])].filter(p => p[0] && p[1]);
  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding:[40,40] });
}

// ── SEGMENT HIGHLIGHT (заполненные = яркие) ───────────────────────────────────
// Return dense road coordinates for a day from OSRM cache
// Falls back to straight lines for segments not yet cached
function getDayRouteCoords(dayNum) {
  var data = DAYS_DATA[dayNum];
  if (!data) return [];
  var profile = data.walkMode ? 'foot' : 'driving';
  var allPts = [{ lat: data.start.lat, lng: data.start.lng }];
  data.stops.forEach(function(s) { if (s.lat && s.lng) allPts.push({ lat: s.lat, lng: s.lng }); });

  var result = [];
  for (var i = 0; i < allPts.length - 1; i++) {
    var from = allPts[i], to = allPts[i + 1];
    var key = profile + '|' + from.lat + ',' + from.lng + '|' + to.lat + ',' + to.lng;
    var cached = _routeCache[key];
    if (cached && cached.length > 0) {
      // OSRM coords are [lat, lng] arrays — convert to {lat, lng}
      cached.forEach(function(c) { result.push({ lat: c[0], lng: c[1] }); });
    } else {
      // Fallback: straight line
      result.push(from);
      result.push(to);
    }
  }
  return result;
}

function refreshSegments() {
  var z = map ? map.getZoom() : 10;
  var close = z >= 13;  // street-level

  dayKeys().forEach(d => {
    if (!segmentLayers[d]) return;
    segmentLayers[d].forEach(({ seg, segOutline, fromId, toId }) => {
      const toArrEl     = document.getElementById('arr-' + toId);
      const toArrFilled = !!(toArrEl && toArrEl.value && toArrEl.value.length >= 4);
      const toStop      = DAYS_DATA[d]?.stops.find(s => s.id === toId);
      const toDepEl     = document.getElementById('dep-' + toId);
      const toDepFilled = toStop && toStop.depP
        ? !!(toDepEl && toDepEl.value && toDepEl.value.length >= 4)
        : true;

      let fromDone = false;
      if (!fromId) {
        const departEl = document.getElementById('d' + d + '-depart');
        fromDone = !!(departEl && departEl.value && departEl.value.length >= 4);
      } else {
        const fromStop    = DAYS_DATA[d]?.stops.find(s => s.id === fromId);
        const fromArrEl   = document.getElementById('arr-' + fromId);
        const fromArrFilled = !!(fromArrEl && fromArrEl.value && fromArrEl.value.length >= 4);
        if (fromStop && fromStop.depP) {
          const fromDepEl   = document.getElementById('dep-' + fromId);
          const fromDepFilled = !!(fromDepEl && fromDepEl.value && fromDepEl.value.length >= 4);
          fromDone = fromArrFilled && fromDepFilled;
        } else {
          fromDone = fromArrFilled;
        }
      }

      const dayData = DAYS_DATA[d];
      const isWalk  = !!(dayData && dayData.walkMode);
      if (fromDone && toArrFilled && toDepFilled) {
        // Completed segment
        if (isWalk) {
          seg.setStyle({ color: dayData ? dayData.color : '#888', opacity:0.85, weight: close ? 5 : 3, dashArray:'8 5' });
        } else {
          seg.setStyle({ color: dayData ? dayData.color : undefined, opacity:0.85, weight: close ? 4 : 3, dashArray:null });
          if (segOutline) segOutline.setStyle({ opacity:0.1, weight: close ? 7 : 5 });
        }
      } else {
        // Pending segment
        if (isWalk) {
          seg.setStyle({ color: dayData ? dayData.color : '#888', opacity:0.5, weight: close ? 5 : 3, dashArray:'8 5' });
        } else {
          var w = close ? 5 : 3;
          var dash = close ? '10 6' : '6 4';
          seg.setStyle({ color: dayData ? dayData.color : undefined, opacity:0.55, weight: w, dashArray: dash });
          if (segOutline) segOutline.setStyle({ opacity:0.08, weight: close ? 8 : 5 });
        }
      }
    });
  });
}
