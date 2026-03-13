// ── MAP ───────────────────────────────────────────────────────────────────────
let map;
const layers        = {};
const segmentLayers = {};

// ── OSRM ROUTING ──────────────────────────────────────────────────────────────
const OSRM_CACHE_KEY = 'travel_route_cache';
const OSRM_DELAY_MS  = 650; // задержка между запросами (публичный OSRM ~600ms)

// Кэш маршрутов: ключ = "lat1,lng1|lat2,lng2" → массив [lat,lng]
// Загружается из localStorage при старте → линии сразу по дорогам без OSRM-запроса
const _routeCache = (() => {
  try { return JSON.parse(localStorage.getItem(OSRM_CACHE_KEY) || '{}'); }
  catch { return {}; }
})();

// Отложенное сохранение: не дёргаем localStorage на каждый сегмент
let _cacheSaveTimer = null;
function _persistCache() {
  clearTimeout(_cacheSaveTimer);
  _cacheSaveTimer = setTimeout(() => {
    try { localStorage.setItem(OSRM_CACHE_KEY, JSON.stringify(_routeCache)); }
    catch (e) {
      // localStorage переполнен — чистим половину старых записей
      if (e.name === 'QuotaExceededError') {
        const keys = Object.keys(_routeCache);
        keys.slice(0, Math.floor(keys.length / 2)).forEach(k => delete _routeCache[k]);
        try { localStorage.setItem(OSRM_CACHE_KEY, JSON.stringify(_routeCache)); } catch {}
      }
    }
  }, 500);
}

// Очередь запросов: предотвращает rate-limit на публичном OSRM
const _fetchQueue = [];
let   _queueBusy  = false;

async function _drainQueue() {
  if (_queueBusy) return;
  _queueBusy = true;
  while (_fetchQueue.length > 0) {
    const { from, to, resolve, reject } = _fetchQueue.shift();
    try { resolve(await _osrmFetch(from, to)); }
    catch (e) { reject(e); }
    if (_fetchQueue.length > 0) {
      await new Promise(r => setTimeout(r, OSRM_DELAY_MS));
    }
  }
  _queueBusy = false;
}

async function _osrmFetch(from, to) {
  const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`;
  if (_routeCache[key]) return _routeCache[key];

  const url = `https://router.project-osrm.org/route/v1/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?overview=full&geometries=geojson`;

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
      _persistCache(); // сохраняем в localStorage для следующей сессии
      return coords;
    } catch (_) {
      if (attempt === 2) return null;
      await new Promise(res => setTimeout(res, 600));
    }
  }
  return null;
}

function fetchRoadSegment(from, to) {
  const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`;
  // Мгновенный ответ из кэша — без добавления в очередь
  if (_routeCache[key]) return Promise.resolve(_routeCache[key]);

  return new Promise((resolve, reject) => {
    _fetchQueue.push({ from, to, resolve, reject });
    _drainQueue();
  });
}

function initMap() {
  map = L.map('map', { center:[51.5, 39.5], zoom:5, zoomControl:true, attributionControl:false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
  map.zoomControl.setPosition('topright');

  // тап/клик по карте — закрываем пилл
  map.on('click', () => closePill());
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

  // Стартовый маркер
  const startM = L.marker([data.start.lat, data.start.lng], { icon: makeStartIcon(data.start.icon, color) });
  group.addLayer(startM);

  // Сегменты маршрута по дорогам (OSRM)
  const allPoints = [
    { lat: data.start.lat, lng: data.start.lng, done: true },
    ...data.stops.map(s => ({ lat: s.lat, lng: s.lng, id: s.id, done: false }))
  ];
  if (!segmentLayers[d]) segmentLayers[d] = [];

  for (let i = 0; i < allPoints.length - 1; i++) {
    const from = allPoints[i], to = allPoints[i + 1];
    // Сразу добавляем прямую линию как placeholder
    const seg = L.polyline(
      [[from.lat, from.lng], [to.lat, to.lng]],
      { color, weight:3, opacity:0.2, lineCap:'round', lineJoin:'round', dashArray:'6 6' }
    );
    group.addLayer(seg);
    segmentLayers[d].push({ seg, fromId: from.id || null, toId: to.id });

    // Асинхронно заменяем на маршрут по дорогам.
    // Проверяем group.hasLayer(seg): если до ответа вызвали redrawDay()
    // и clearLayers(), seg уже отвязан от карты — обновлять его бессмысленно.
    fetchRoadSegment(from, to).then(coords => {
      if (!coords || !group.hasLayer(seg)) return;
      seg.setLatLngs(coords);
    }).catch(() => { /* оставляем прямую линию */ });
  }

  // Маркеры остановок
  data.stops.forEach(s => {
    const marker = L.marker([s.lat, s.lng], { icon: makeIcon(s.icon, color) });
    marker.on('click', e => {
      L.DomEvent.stopPropagation(e);
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
  dayKeys().forEach(n => {
    if (n === d) {
      layers[n] && layers[n].addTo(map);
    } else {
      layers[n] && map.hasLayer(layers[n]) && map.removeLayer(layers[n]);
    }
  });
  const data = DAYS_DATA[d];
  if (!data) return;
  const pts = [[data.start.lat, data.start.lng], ...data.stops.map(s => [s.lat, s.lng])].filter(p => p[0] && p[1]);
  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding:[40,40] });
}

// ── SEGMENT HIGHLIGHT (заполненные = яркие) ───────────────────────────────────
function refreshSegments() {
  dayKeys().forEach(d => {
    if (!segmentLayers[d]) return;
    segmentLayers[d].forEach(({ seg, fromId, toId }) => {
      const toArrEl     = document.getElementById('arr-' + toId);
      const toArrFilled = !!(toArrEl && toArrEl.value && toArrEl.value.length >= 4);
      const toStop      = DAYS_DATA[d]?.stops.find(s => s.id === toId);
      const toDepEl     = document.getElementById('dep-' + toId);
      const toDepFilled = toStop && toStop.depP
        ? !!(toDepEl && toDepEl.value && toDepEl.value.length >= 4)
        : true;

      let fromDone = false;
      if (!fromId) {
        fromDone = true;
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

      if (fromDone && toArrFilled && toDepFilled) {
        seg.setStyle({ opacity:0.9, weight:4, dashArray:null });
      } else {
        seg.setStyle({ opacity:0.5, weight:3, dashArray:'6 6' });
      }
    });
  });
}
