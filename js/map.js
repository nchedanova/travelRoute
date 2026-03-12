// ── MAP ───────────────────────────────────────────────────────────────────────
let map;
const layers        = {};
const segmentLayers = {};

function initMap() {
  map = L.map('map', { center:[51.5, 39.5], zoom:5, zoomControl:true, attributionControl:false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
  map.zoomControl.setPosition('topright');

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

function makeIcon(emoji, color, size = 34) {
  const bg = hexRgba(color, 0.7, 0.45);
  const html = `<div style="
    width:${size}px;height:${size}px;
    border-radius:50% 50% 50% 0;transform:rotate(-45deg);
    background:${bg};border:2px solid rgba(255,255,255,0.18);
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 12px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.4);">
    <span style="transform:rotate(45deg);font-size:${Math.round(size*0.44)}px;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.9));">${emoji}</span>
  </div>`;
  return L.divIcon({ html, className:'', iconSize:[size,size], iconAnchor:[size/2,size], popupAnchor:[0,-size] });
}

function makeStartIcon(emoji, color) {
  const bg = hexRgba(color, 0.7, 0.45);
  const html = `<div style="
    width:38px;height:38px;border-radius:50%;
    background:${bg};border:2px solid rgba(255,255,255,0.18);
    display:flex;align-items:center;justify-content:center;
    font-size:17px;box-shadow:0 2px 12px rgba(0,0,0,0.8), 0 0 0 1px rgba(0,0,0,0.4);
    filter:drop-shadow(0 1px 3px rgba(0,0,0,0.9));">${emoji}</div>`;
  return L.divIcon({ html, className:'', iconSize:[38,38], iconAnchor:[19,19], popupAnchor:[0,-22] });
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
  startM.bindPopup(`<div class="popup-inner">
    <div class="popup-name">${data.start.icon} <b>${data.start.name}</b></div>
    <div class="popup-row"><span>Начало маршрута</span></div>
  </div>`);
  group.addLayer(startM);

  // Сегменты маршрута
  const allPoints = [
    { lat: data.start.lat, lng: data.start.lng, done: true },
    ...data.stops.map(s => ({ lat: s.lat, lng: s.lng, id: s.id, done: false }))
  ];
  for (let i = 0; i < allPoints.length - 1; i++) {
    const from = allPoints[i], to = allPoints[i + 1];
    const seg = L.polyline(
      [[from.lat, from.lng], [to.lat, to.lng]],
      { color, weight:3, opacity:0.2, lineCap:'round', lineJoin:'round', dashArray:'6 6' }
    );
    group.addLayer(seg);
    if (!segmentLayers[d]) segmentLayers[d] = [];
    segmentLayers[d].push({ seg, fromId: from.id || null, toId: to.id });
  }

  // Маркеры остановок
  data.stops.forEach(s => {
    const marker = L.marker([s.lat, s.lng], { icon: makeIcon(s.icon, color) });
    marker.bindPopup('<div class="popup-inner"></div>');
    marker.on('popupopen', () => {
      const arrEl = document.getElementById('arr-' + s.id);
      const depEl = document.getElementById('dep-' + s.id);
      const arrA  = (arrEl && arrEl.value) || s.arrA || '—';
      const depA  = (depEl && depEl.value) || s.depA || '—';
      const depRows = s.depP
        ? `<div class="popup-row"><span>Отпр. план</span><span>${s.depP}</span></div>
           <div class="popup-row"><span>Отпр. факт</span><span>${depA}</span></div>`
        : '';
      marker.getPopup().setContent(`<div class="popup-inner">
        <div class="popup-name">${s.icon} <b>${s.name}</b></div>
        <div class="popup-row"><span>Тип</span><span>${s.type}</span></div>
        <div class="popup-row"><span>Приб. план</span><span>${s.arrP || '—'}</span></div>
        <div class="popup-row"><span>Приб. факт</span><span>${arrA}</span></div>
        ${depRows}
      </div>`);
    });
    marker.on('click', () => highlightStop(s.id, d));
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
