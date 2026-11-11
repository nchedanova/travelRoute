// ── MAP ───────────────────────────────────────────────────────────────────────
let map;
const layers        = {};
const segmentLayers = {};

// ── OSRM ROUTING ──────────────────────────────────────────────────────────────
const OSRM_CACHE_KEY = 'travel_route_cache_v2';
const OSRM_DELAY_MS = 1050;
let osrmRequestQueue = Promise.resolve();
let osrmNextRequestAt = 0;
let osrmRetryAt = 0;

function fetchOsrm(url) {
  const request = osrmRequestQueue.then(async () => {
    if (Date.now() < osrmRetryAt) return null;
    const wait = osrmNextRequestAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    osrmNextRequestAt = Date.now() + OSRM_DELAY_MS;
    const response = await fetch(url);
    if (response.status === 429) {
      const retry = response.headers.get('Retry-After');
      const delay = Number(retry) * 1000 || Date.parse(retry) - Date.now() || 0;
      osrmRetryAt = Date.now() + Math.max(60000, delay);
      return null;
    }
    return response;
  });
  osrmRequestQueue = request.catch(() => {});
  return request;
}

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

function getSegmentDuration(from, to, profile) {  profile = profile || 'driving';
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
const drivingSteps = new Map();
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
    const { from, to, profile, withSteps, resolve, reject } = _fetchQueue.shift();
    try { resolve(await _osrmFetch(from, to, profile, withSteps)); }
    catch (e) { reject(e); }
  }
  _queueBusy = false;
}

async function _osrmFetch(from, to, profile, withSteps = false) {
  profile = profile || 'driving';
  const key = `${profile}|${from.lat},${from.lng}|${to.lat},${to.lng}`;
  if (_routeCache[key] && (!withSteps || drivingSteps.has(key))) return _routeCache[key];

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
  if (withSteps) url += '&steps=true';

  // Повторяем только сетевые ошибки обычного маршрута.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchOsrm(url);
      if (!r?.ok) return null;
      const data = await r.json();
      if (data.code !== 'Ok' || !data.routes?.length) return null;
      const coords = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      if (withSteps) drivingSteps.set(key, data.routes[0].legs?.flatMap(leg => leg.steps || []) || []);
      _routeCache[key] = coords;
      if (data.routes[0].duration != null) _durationCache[key] = data.routes[0].duration;
      _persistCache(); // сохраняем в localStorage для следующей сессии
      return coords;
    } catch (_) {
      if (withSteps || attempt === 2) return null;
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

function fetchRoadSegment(from, to, profile, withSteps = false) {
  profile = profile || 'driving';
  const key = `${profile}|${from.lat},${from.lng}|${to.lat},${to.lng}`;
  // Мгновенный ответ из кэша — без добавления в очередь
  if (_routeCache[key] && (!withSteps || drivingSteps.has(key))) return Promise.resolve(_routeCache[key]);
  // Не отправляем OSRM пока не загружены реальные данные
  if (!_routeLoadingEnabled) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    _fetchQueue.push({ from, to, profile, withSteps, resolve, reject });
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
    var r = await fetchOsrm(url);
    if (!r?.ok) return;
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
  map = L.map('map', { center:[51.5, 39.5], zoom:5, zoomControl:true, attributionControl:false,
    rotate:true, bearing:0, rotateControl:false, touchRotate:false, shiftKeyRotate:false, pitchDrag:false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

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
  function updateGpsMarkerScale() {
    const progress = Math.max(0, Math.min(1, (map.getZoom() - 11) / 5));
    const scale = (20 + 6 * progress) / 26;
    map.getContainer().style.setProperty('--gps-marker-scale', scale);
  }
  map.on('zoomend', function() {
    updateGpsMarkerScale();
    refreshSegments();
  });
  updateGpsMarkerScale();

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

function makeIcon(emoji, color, size = 34, active = false, num = 0, type = null) {
  const bg = hexRgba(color, 0.7, 0.45);
  const ring = active
    ? `<div style="position:absolute;inset:-8px;border-radius:50%;border:1.5px solid ${hexRgba(color,0.5)};background:${hexRgba(color,0.1)};animation:pillPulse 1.6s ease-in-out infinite;"></div>` : '';
  const badge = num > 0
    ? `<div style="position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#111;border:1.5px solid rgba(255,255,255,0.25);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;color:#fff;font-family:var(--font-ui);line-height:1;z-index:1;">${num}</div>` : '';
  const html = `<div style="position:relative;width:${size}px;height:${size}px;">
    ${ring}
    <div style="
      position:relative;width:${size}px;height:${size}px;
      border-radius:50% 50% 50% 0;transform:rotate(-45deg);
      background:${bg};border:2px solid rgba(255,255,255,0.18);
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 12px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.4);">
      <span class="map-point-glyph" style="transform:rotate(45deg);font-size:22px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.9));">${pointIconMarkup(emoji, type)}</span>
    </div>
    ${badge}
  </div>`;
  const pad = active ? 8 : 0;
  return L.divIcon({ html, className:'', iconSize:[size+pad*2,size+pad*2], iconAnchor:[size/2+pad,size+pad] });
}

function makeStartIcon(emoji, color, recorded = false) {
  const bg = hexRgba(color, 0.7, 0.45);
  const html = `<div style="
    width:38px;height:38px;border-radius:50%;
    background:${bg};border:2px solid rgba(255,255,255,0.18);
    display:flex;align-items:center;justify-content:center;
    font-size:22px;box-shadow:0 2px 12px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.4);
    filter:drop-shadow(0 1px 3px rgba(0,0,0,0.9));"><span class="map-point-glyph">${recorded ? startPointIconMarkup(emoji, true) : pointIconMarkup(emoji)}</span></div>`;
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

  return `<div class="pill-name">${pointIconMarkup(s.icon, s.type)} ${s.name}</div>
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
  const _numOpen = DAYS_DATA[d] ? DAYS_DATA[d].stops.findIndex(x => x.id === s.id) + 1 : 0;
  marker.setIcon(makeIcon(s.icon, color, 34, true, _numOpen, s.type));

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
    const _numClose = DAYS_DATA[d] ? DAYS_DATA[d].stops.findIndex(x => x.id === s.id) + 1 : 0;
    marker.setIcon(makeIcon(s.icon, color, 34, false, _numClose, s.type));
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
const walkTrackLines = {};
const WALK_DASH_STYLE = {weight:3, lineCap:'round', lineJoin:'round', dashArray:'8 5'};
const WALK_TRACK_PALETTES = {
  '#f5a623': ['#ffba91', '#f5a623', '#ff7066'],
  '#00ced1': ['#92f5d9', '#00ced1', '#61aaff'],
  '#a78bfa': ['#e7b5ff', '#a78bfa', '#f68ac8'],
  '#34d399': ['#c4ef85', '#34d399', '#42d8da'],
  '#fa8072': ['#ffc899', '#fa8072', '#ff639e'],
  '#ced23a': ['#ffdc79', '#ced23a', '#8ae26c'],
  '#00bfff': ['#8ff2fa', '#00bfff', '#958bff'],
  '#cc5500': ['#ffc28e', '#f58c36', '#f96859']
};

function refreshWalkTrackLine(day) {
  const track = walkTrackLines[day];
  if (track) drawWalkTrack(track, DAYS_DATA[day].walkReview.segments, DAYS_DATA[day].color);
}

function drawWalkTrack(group, tracks, dayColor) {
  group.clearLayers();
  const legs = tracks.filter(segment => segment.length > 1).map(segment => {
    const points = segment.map(point => L.latLng(point));
    return points.slice(1).map((end, i) => ({
      start: points[i], end, meters: points[i].distanceTo(end)
    })).filter(leg => leg.meters > 0);
  });
  const total = legs.flat().reduce((sum, leg) => sum + leg.meters, 0);
  if (!total) return;

  const color = /^#[\da-f]{6}$/i.test(dayColor) ? dayColor : '#f5a623';
  const palette = WALK_TRACK_PALETTES[color.toLowerCase()] || ['#ffffff', color, color];
  const channels = palette.map(hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)));
  const shade = progress => {
    const interval = progress < .5 ? 0 : 1;
    const fraction = progress * 2 - interval;
    return 'rgb(' + channels[interval].map((channel, i) =>
      Math.round(channel + (channels[interval + 1][i] - channel) * fraction)).join(',') + ')';
  };
  const arrowSpacing = 400;
  let nextArrow = total < arrowSpacing ? total / 2 : arrowSpacing;
  let distance = 0;
  for (const segment of legs) {
    let chunk = [];
    let previousBand = -1;
    for (const {start, end, meters} of segment) {
      const band = Math.min(15, Math.floor((distance + meters / 2) / total * 16));
      if (band !== previousBand) {
        if (chunk.length) L.polyline(chunk, {...WALK_DASH_STYLE, color: shade(previousBand / 15), interactive: false}).addTo(group);
        chunk = [start];
        previousBand = band;
      }
      chunk.push(end);
      while (nextArrow <= distance + meters) {
        const fraction = (nextArrow - distance) / meters;
        const point = [start.lat + (end.lat - start.lat) * fraction, start.lng + (end.lng - start.lng) * fraction];
        const from = map.project(start, 16);
        const to = map.project(end, 16);
        const angle = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
        const icon = L.divIcon({
          className: 'walk-track-arrow',
          iconSize: [12, 12], iconAnchor: [6, 6],
          html: '<svg viewBox="0 0 12 12" aria-hidden="true" style="transform:rotate(' + angle +
            'deg);color:' + shade(band / 15) + '"><path d="M2 6h8m-4-4 4 4-4 4"/></svg>'
        });
        L.marker(point, {icon, interactive: false, keyboard: false, zIndexOffset: -500}).addTo(group);
        nextArrow += arrowSpacing;
      }
      distance += meters;
    }
    if (chunk.length) L.polyline(chunk, {...WALK_DASH_STYLE, color: shade(previousBand / 15), interactive: false}).addTo(group);
  }
}

function drawDay(d) {
  const data = DAYS_DATA[d];
  if (!data) return;
  const color = data.color;
  const group = layers[d];
  if (!group) return;
  const reviewTrack = data.walkReview;

  // Стартовый маркер — иконка зависит от режима дня (авто/пешком)
  const startEmoji = reviewTrack ? data.start.icon : (data.walkMode ? '🚶' : (data.start.icon || '🚗'));
  const startM = L.marker([data.start.lat, data.start.lng], { icon: makeStartIcon(startEmoji, color, !!reviewTrack) });
  if (!reviewTrack || data.start.lat || data.start.lng) group.addLayer(startM);

  // Сегменты маршрута по дорогам (OSRM)
  const allPoints = [
    { lat: data.start.lat, lng: data.start.lng, done: true },
    ...data.stops.map(s => ({ lat: s.lat, lng: s.lng, id: s.id, done: false }))
  ];
  if (!segmentLayers[d]) segmentLayers[d] = [];

  if (reviewTrack && reviewTrack.phase !== 'ready') {
    const tracks = reviewTrack.segments ?? [
      allPoints.filter(p => p.lat || p.lng).map(p => [p.lat, p.lng])
    ];
    const track = L.layerGroup().addTo(group);
    drawWalkTrack(track, tracks, color);
    walkTrackLines[d] = track;
  }

  for (let i = 0; !reviewTrack && i < allPoints.length - 1; i++) {
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
        ? { ...WALK_DASH_STYLE, color, opacity:0.3 }
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
        if (!isWalk) extendAutoRouteView(d, coords);
        refreshSegments();
        if (typeof autoFillTimes === 'function') autoFillTimes(d);
        if (typeof updateTravelStats === 'function') updateTravelStats(d);
        if (typeof updateRouteProgress === 'function') updateRouteProgress(d);
      }).catch(() => {});
    }
    // Кешированный случай: redrawDay вызовет refreshSegments() после drawDay — стили применятся там
  }

  // Маркеры остановок
  data.stops.forEach((s, idx) => {
    const marker = L.marker([s.lat, s.lng], { icon: makeIcon(s.icon, color, 34, false, idx + 1, s.type) });
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
    // Архивные дни никогда не показываются на карте
    if (DAYS_DATA[n]?.archived) {
      layers[n] && map.hasLayer(layers[n]) && map.removeLayer(layers[n]);
      return;
    }
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
  fitDayMap(d);
}

let autoRouteView = null;

function fitDayMap(id, initial = false) {
  const day = DAYS_DATA[id];
  if (!day) return;
  autoRouteView = null;
  const route = day.walkReview
    ? (day.walkReview.segments || []).flat()
    : getDayRouteCoords(id).map(point => [point.lat, point.lng]);
  const points = [[day.start.lat, day.start.lng], ...day.stops.map(s => [s.lat, s.lng]),
    ...route].filter(([lat, lng]) =>
    Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0));
  if (!points.length || (points.length === 1 && !day.walkMode && !initial)) return;
  // Startup can fit the cached day and then the selected day in quick succession.
  const options = {padding: [40, 40], animate: false, maxZoom: day.walkMode ? 17 : 14};
  map.fitBounds(L.latLngBounds(points), options);
  if (!day.walkMode) autoRouteView = {id, center: map.getCenter(), zoom: map.getZoom()};
}

function extendAutoRouteView(id, coords) {
  if (id !== currentDay || autoRouteView?.id !== id || map.getZoom() !== autoRouteView.zoom ||
      !map.getCenter().equals(autoRouteView.center)) return;
  const visible = map.getBounds();
  if (coords.some(point => !visible.contains(point))) fitDayMap(id);
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

// ── ROUTE DISTANCE ────────────────────────────────────────────────────────────
// Возвращает фактическое расстояние по маршруту в км для одного дня.
// Берёт координаты из _routeCache (реальные дороги/тропы от OSRM).
// Если сегмент ещё не загружен — fallback на haversine для этого сегмента.
function getDayRouteKm(d, stopCount) {
  var data = DAYS_DATA[d];
  if (!data) return 0;
  const recording = data.walkReview;
  if (recording && stopCount === undefined) {
    if (Number.isFinite(recording.meters) && recording.meters >= 0) return recording.meters / 1000;
    let recordedKm = 0;
    for (const segment of recording.segments || []) {
      for (let i = 1; i < segment.length; i++) {
        recordedKm += _haversineKmPts(...segment[i - 1], ...segment[i]);
      }
    }
    return recordedKm;
  }
  var profile = data.walkMode ? 'foot' : 'driving';
  var pts = [{ lat: data.start.lat, lng: data.start.lng }];
  data.stops.slice(0, stopCount ?? data.stops.length).forEach(function(s) {
    pts.push({ lat: s.lat, lng: s.lng });
  });

  var totalKm = 0;
  for (var i = 0; i < pts.length - 1; i++) {
    var from = pts[i], to = pts[i + 1];
    if (!from.lat || !to.lat) continue;
    var key = profile + '|' + from.lat + ',' + from.lng + '|' + to.lat + ',' + to.lng;
    var cached = _routeCache[key];
    if (cached && cached.length > 1) {
      // Суммируем длину полилинии
      for (var j = 1; j < cached.length; j++) {
        totalKm += _haversineKmPts(cached[j-1][0], cached[j-1][1], cached[j][0], cached[j][1]);
      }
    } else {
      // Сегмент ещё не загружен — haversine как приближение
      totalKm += _haversineKmPts(from.lat, from.lng, to.lat, to.lng);
    }
  }
  return totalKm;
}

function _haversineKmPts(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
          Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── DRAGGABLE EDIT MARKER ──────────────────────────────────────────────────────
var _editDragMarker = null;

function setEditDragMarker(stopId, lat, lng, icon, color, onDragEnd) {
  removeEditDragMarker();
  if (!map || !lat || !lng) return;
  var dragIcon = makeIcon(icon || '📍', color || '#f5a623', 38, true);
  _editDragMarker = L.marker([lat, lng], {
    icon: dragIcon,
    draggable: true,
    autoPan: true,
    autoPanPadding: [60, 60]
  });
  _editDragMarker.addTo(map);
  _editDragMarker.on('dragend', function(e) {
    var pos = e.target.getLatLng();
    if (typeof onDragEnd === 'function') onDragEnd(pos.lat, pos.lng);
  });
  // Панорамируем к точке если вне зоны видимости
  if (!map.getBounds().contains([lat, lng])) {
    map.panTo([lat, lng]);
  }
}

function removeEditDragMarker() {
  if (_editDragMarker) {
    if (map) map.removeLayer(_editDragMarker);
    _editDragMarker = null;
  }
}
