// ── UI STATE ──────────────────────────────────────────────────────────────────
let currentDay = 1;

function switchDay(d) {
  var prev = currentDay;
  currentDay = d;
  document.querySelectorAll('.day-tab').forEach(t =>
    t.classList.toggle('active', parseInt(t.dataset.day) === d)
  );
  document.querySelectorAll('.day-section').forEach(s =>
    s.classList.toggle('visible', parseInt(s.dataset.day) === d)
  );
  document.querySelectorAll('.day-tab').forEach(tab => {
    const day = parseInt(tab.dataset.day);
    tab.style.backgroundColor = '';
    tab.style.borderColor     = '';
    if (day === d && DAYS_DATA[day]?.color) {
      tab.style.backgroundColor = DAYS_DATA[day].color;
      tab.style.borderColor     = DAYS_DATA[day].color;
    }
  });
  switchMapDay(d);
  listenWeather(d);
  if (prev !== d) _navPush();
}

function highlightStop(id, d) {
  document.querySelectorAll('.stop-card').forEach(c => c.classList.remove('selected'));
  const card = document.getElementById('card-' + id);
  if (card) { card.classList.add('selected'); card.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
  const stop = DAYS_DATA[d]?.stops.find(s => s.id === id);
  if (stop) map.setView([stop.lat, stop.lng], 11, { animate:true });
}

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const wasOpen = sb.classList.contains('open');
  sb.classList.toggle('open');
  const btn = document.getElementById('toggleBtn');
  if (btn) btn.textContent = sb.classList.contains('open') ? '✕' : '☰';
  if (wasOpen && _currentSidebarTab === 'chat') {
    onChatTabClose && onChatTabClose();
  }
  setTimeout(() => map && map.invalidateSize(), 340);
  _navPush();
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg || '💾 Сохранено';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ── RESET ─────────────────────────────────────────────────────────────────────
let resetTargetDay = null;

function confirmReset(day) {
  resetTargetDay = day;
  document.getElementById('resetModalBody').textContent =
    `Всё фактическое время за «День ${day} · ${DAYS_DATA[day].date}» будет удалено. Это действие нельзя отменить.`;
  document.getElementById('resetModal').classList.add('show');
}

function closeModal() {
  document.getElementById('resetModal').classList.remove('show');
  resetTargetDay = null;
}

function doReset() {
  if (!resetTargetDay) return;
  const day = resetTargetDay;
  closeModal();
  snapshotForUndo(`Сброс данных дня ${day}`);
  DAYS_DATA[day].stops.forEach(s => {
    s.arrA = ''; s.depA = '';
    delete state.actuals[s.id];
  });
  DAYS_DATA[day].departA = '';
  const dep = document.getElementById('d' + day + '-depart');
  if (dep) { dep.value = ''; dep.classList.add('empty'); }
  renderStops(day);
  redrawDay(day);
  updateDayRoute(day);
  saveData();
  updateProgress();
  showToast('🗑 Данные сброшены');
}

// ── DRAG AND DROP ─────────────────────────────────────────────────────────────
let dragSrcId = null, dragSrcDay = null;

function onDragStart(e) {
  if (e.target.closest('textarea,input,.stop-note-display')) { e.preventDefault(); return; }
  dragSrcId  = this.dataset.id;
  dragSrcDay = parseInt(this.dataset.day);
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  this.classList.add('drag-over');
}
function onDragLeave() { this.classList.remove('drag-over'); }
function onDrop(e) {
  e.preventDefault();
  this.classList.remove('drag-over');
  const targetId  = this.dataset.id;
  const targetDay = parseInt(this.dataset.day);
  if (!dragSrcId || dragSrcId === targetId || dragSrcDay !== targetDay) return;
  const stops   = DAYS_DATA[targetDay].stops;
  const fromIdx = stops.findIndex(s => s.id === dragSrcId);
  const toIdx   = stops.findIndex(s => s.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  snapshotForUndo('Изменён порядок точек');
  const [moved] = stops.splice(fromIdx, 1);
  stops.splice(toIdx, 0, moved);
  renderStops(targetDay);
  redrawDay(targetDay);
  updateDayRoute(targetDay);
  saveData();
}
function onDragEnd() {
  document.querySelectorAll('.stop-card').forEach(c => c.classList.remove('dragging', 'drag-over'));
  dragSrcId = dragSrcDay = null;
}

// ── DELETE STOP ───────────────────────────────────────────────────────────────
let deleteTargetDay = null, deleteTargetId = null;

function deleteStop(day, id, e) {
  e && e.stopPropagation();
  deleteTargetDay = day;
  deleteTargetId  = id;
  const stop = DAYS_DATA[day].stops.find(s => s.id === id);
  document.getElementById('deleteStopModalBody').textContent =
    stop ? `«${stop.name}» будет удалена из маршрута.` : 'Точка будет удалена из маршрута.';
  document.getElementById('deleteStopModal').classList.add('show');
}

function closeDeleteModal() {
  document.getElementById('deleteStopModal').classList.remove('show');
  deleteTargetDay = deleteTargetId = null;
}

function doDeleteStop() {
  if (!deleteTargetDay || !deleteTargetId) return;
  const day = deleteTargetDay, id = deleteTargetId;
  closeDeleteModal();
  const delStop = DAYS_DATA[day].stops.find(s => s.id === id);
  snapshotForUndo(`Удалена точка «${delStop ? delStop.name : id}»`);
  const idx = DAYS_DATA[day].stops.findIndex(s => s.id === id);
  if (idx < 0) return;
  DAYS_DATA[day].stops.splice(idx, 1);
  delete state.actuals[id];
  renderStops(day);
  redrawDay(day);
  updateDayRoute(day);
  updateProgress();
  saveData();
  showToast('🗑 Точка удалена');
}

// ── ADD STOP / NOMINATIM ──────────────────────────────────────────────────────
let addStopDay  = null;
let newStopLat  = null, newStopLng = null;
let nominatimTimer = null;

// Split "lat, lng" paste into two fields.
// Supports: "47.261417, 39.719283"  |  "47.261417 39.719283"  |  "47.261417; 39.719283"
function splitCoordsInput(latInput, lngFieldId, displayId) {
  var val = latInput.value;
  var latPart, lngPart;

  // 1. Comma separator (most common from Google Maps copy)
  var commaIdx = val.indexOf(',');
  if (commaIdx !== -1) {
    latPart = val.slice(0, commaIdx).trim();
    lngPart = val.slice(commaIdx + 1).trim();
  }
  // 2. Semicolon separator
  else if (val.indexOf(';') !== -1) {
    var semParts = val.split(';');
    latPart = semParts[0].trim();
    lngPart = semParts[1] ? semParts[1].trim() : '';
  }
  // 3. Space separator — only if BOTH tokens look like coordinate numbers
  else {
    var spaceIdx = val.lastIndexOf(' ');
    if (spaceIdx !== -1) {
      var a = val.slice(0, spaceIdx).trim();
      var b = val.slice(spaceIdx + 1).trim();
      if (/^-?\d+\.\d+$/.test(a) && /^-?\d+\.\d+$/.test(b)) {
        latPart = a;
        lngPart = b;
      }
    }
  }

  if (!latPart || !lngPart) return;

  latInput.value = latPart;
  var lngInput = document.getElementById(lngFieldId);
  if (lngInput) {
    lngInput.value = lngPart;
    lngInput.focus();
  }
  if (displayId) _updateCoordsDisplay(displayId, latPart, lngPart);
}

// Refresh the small green "📍 lat, lng" badge shown in modals
function _updateCoordsDisplay(displayId, latVal, lngVal) {
  var lat = parseFloat(latVal), lng = parseFloat(lngVal);
  if (isNaN(lat) || isNaN(lng)) return;
  var disp = document.getElementById(displayId + '-display');
  var text = document.getElementById(displayId + '-text');
  if (disp) disp.style.display = 'block';
  if (text) text.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
}

// Called when user manually types in a lat or lng field in modals
function onManualCoordInput(latFieldId, lngFieldId, displayId) {
  var lat = parseFloat(document.getElementById(latFieldId).value);
  var lng = parseFloat(document.getElementById(lngFieldId).value);
  if (!isNaN(lat) && !isNaN(lng)) _updateCoordsDisplay(displayId, lat, lng);
}

function openAddStop(day, prefillLat, prefillLng) {
  addStopDay = day;
  newStopLat = prefillLat || null;
  newStopLng = prefillLng || null;
  ['nominatim-input','new-stop-name','new-stop-arrP','new-stop-depP','new-stop-lat','new-stop-lng']
    .forEach(id => {
      const el = document.getElementById(id);
      el.value = '';
      if (el.classList.contains('modal-input')) el.classList.remove('empty');
    });
  document.getElementById('new-stop-type').value = 'Другое';
  document.getElementById('new-stop-icon').value = TYPE_ICONS['Другое'];
  document.getElementById('nominatim-results').classList.remove('show');
  if (newStopLat && newStopLng) {
    // Pre-fill coords from map click
    document.getElementById('new-stop-lat').value = newStopLat.toFixed(6);
    document.getElementById('new-stop-lng').value = newStopLng.toFixed(6);
    document.getElementById('new-stop-coords-text').textContent =
      `${newStopLat.toFixed(5)}, ${newStopLng.toFixed(5)}`;
    document.getElementById('new-stop-coords-display').style.display = 'block';
    // Reverse geocode to suggest a name
    fetch(`https://nominatim.openstreetmap.org/reverse?lat=${newStopLat}&lon=${newStopLng}&format=json&accept-language=ru`)
      .then(r => r.json())
      .then(data => {
        const name = data.name || data.address?.road || data.display_name?.split(',')[0] || '';
        if (name) document.getElementById('new-stop-name').value = name;
      }).catch(() => {});
  } else {
    document.getElementById('new-stop-coords-display').style.display = 'none';
  }
  document.getElementById('addStopModal').classList.add('show');
  setTimeout(() => document.getElementById('new-stop-name').focus(), 100);
}

function toggleMapAddMode(day) {
  const btn = document.getElementById('mapAddBtn');
  window._mapAddMode = !window._mapAddMode;
  if (window._mapAddMode) {
    document.getElementById('map').style.cursor = 'crosshair';
    if (btn) { btn.classList.add('active'); btn.textContent = '✕ ОТМЕНА'; }
    showToast('📍 Кликни на карту чтобы добавить точку');
  } else {
    document.getElementById('map').style.cursor = '';
    if (btn) { btn.classList.remove('active'); btn.textContent = '📍 НА КАРТЕ'; }
  }
}

function closeAddStop() {
  document.getElementById('addStopModal').classList.remove('show');
  document.getElementById('nominatim-results').classList.remove('show');
  addStopDay = null;
}

function nominatimSearch(q) {
  clearTimeout(nominatimTimer);
  const res = document.getElementById('nominatim-results');
  if (!q || q.length < 3) { res.classList.remove('show'); return; }
  res.classList.add('show');
  res.innerHTML = '<div class="search-spinner">Поиск…</div>';
  nominatimTimer = setTimeout(async () => {
    try {
      const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&accept-language=ru`;
      const r    = await fetch(url, { headers: { 'Accept-Language': 'ru' } });
      const data = await r.json();
      if (!data.length) { res.innerHTML = '<div class="search-spinner">Ничего не найдено</div>'; return; }
      res.innerHTML = '';
      data.forEach(item => {
        const d    = document.createElement('div');
        d.className = 'search-result-item';
        const main = item.name || item.display_name.split(',')[0];
        const sub  = item.display_name.split(',').slice(1, 3).join(',').trim();
        d.innerHTML = `<div>${main}</div><div class="result-sub">${sub}</div>`;
        d.onclick = () => {
          newStopLat = parseFloat(item.lat);
          newStopLng = parseFloat(item.lon);
          document.getElementById('nominatim-input').value = item.display_name;
          if (!document.getElementById('new-stop-name').value)
            document.getElementById('new-stop-name').value = main;
          document.getElementById('new-stop-coords-text').textContent =
            `${newStopLat.toFixed(5)}, ${newStopLng.toFixed(5)}`;
          document.getElementById('new-stop-coords-display').style.display = 'block';
          document.getElementById('new-stop-lat').value = newStopLat.toFixed(6);
          document.getElementById('new-stop-lng').value = newStopLng.toFixed(6);
          res.classList.remove('show');
        };
        res.appendChild(d);
      });
    } catch(err) {
      res.innerHTML = '<div class="search-spinner">Ошибка поиска</div>';
    }
  }, 500);
}

// Offsets in minutes per stop type for auto-fill of departure plan time
const DEP_OFFSETS = { 'Кафе': 60, 'Заправка': 20 };

function prefillStopIcon(type) {
  const iconEl    = document.getElementById('new-stop-icon');
  const knownIcons = Object.values(TYPE_ICONS);
  if (!iconEl.value || knownIcons.includes(iconEl.value))
    iconEl.value = TYPE_ICONS[type] || '📍';
}

function prefillDepTime() {
  const type   = document.getElementById('new-stop-type').value;
  const arrVal = document.getElementById('new-stop-arrP').value.trim();
  const depEl  = document.getElementById('new-stop-depP');
  // Only prefill if depP is still empty (don't overwrite user edits)
  if (depEl.value.trim()) return;
  const offset = DEP_OFFSETS[type];
  if (!offset || arrVal.length < 5) return;
  const [h, m] = arrVal.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return;
  const total = h * 60 + m + offset;
  const rh = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const rm = String(total % 60).padStart(2, '0');
  depEl.value = `${rh}:${rm}`;
  depEl.classList.remove('empty');
}

function doAddStop() {
  const name = document.getElementById('new-stop-name').value.trim();
  if (!name) { document.getElementById('new-stop-name').focus(); return; }
  if (newStopLat === null) {
    const manLat = parseFloat(document.getElementById('new-stop-lat').value);
    const manLng = parseFloat(document.getElementById('new-stop-lng').value);
    if (isNaN(manLat) || isNaN(manLng)) {
      alert('Укажите координаты — выберите из поиска или введите вручную');
      return;
    }
    newStopLat = manLat;
    newStopLng = manLng;
  }
  const icon = document.getElementById('new-stop-icon').value.trim() || '📍';
  const type = document.getElementById('new-stop-type').value;
  const arrP = document.getElementById('new-stop-arrP').value.trim();
  const depP = document.getElementById('new-stop-depP').value.trim();
  const id   = 'd' + addStopDay + 's' + Date.now();
  const stop = { id, num:0, icon, type, name, lat:newStopLat, lng:newStopLng, arrP:arrP||'', depP:depP||'', arrA:'', depA:'' };
  const day  = addStopDay;
  snapshotForUndo('Добавлена точка');
  DAYS_DATA[day].stops.push(stop);
  closeAddStop();
  renderStops(day);
  redrawDay(day);
  updateDayRoute(day);
  updateProgress();
  saveData();
  showToast('✅ Точка добавлена');
}

// ── EDIT START POINT ──────────────────────────────────────────────────────────
let editStartDay = null, editStartLat = null, editStartLng = null;
let startSearchTimer = null;

function openEditStart(day) {
  editStartDay = day;
  const s = DAYS_DATA[day].start;
  editStartLat = s.lat; editStartLng = s.lng;
  document.getElementById('edit-start-search').value  = '';
  document.getElementById('edit-start-name').value    = s.name;
  document.getElementById('edit-start-icon').value    = s.icon;
  document.getElementById('edit-start-departP').value = DAYS_DATA[day].departP || '';
  document.getElementById('edit-start-lat').value     = s.lat || '';
  document.getElementById('edit-start-lng').value     = s.lng || '';
  document.getElementById('edit-start-results').classList.remove('show');
  document.getElementById('edit-start-coords-display').style.display = s.lat ? 'block' : 'none';
  document.getElementById('edit-start-coords-text').textContent =
    s.lat ? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}` : '';
  document.getElementById('editStartModal').classList.add('show');
  setTimeout(() => document.getElementById('edit-start-search').focus(), 100);
}

function closeEditStart() {
  document.getElementById('editStartModal').classList.remove('show');
  editStartDay = null;
}

function startNominatimSearch(q) {
  clearTimeout(startSearchTimer);
  const res = document.getElementById('edit-start-results');
  if (!q || q.length < 3) { res.classList.remove('show'); return; }
  res.classList.add('show');
  res.innerHTML = '<div class="search-spinner">Поиск…</div>';
  startSearchTimer = setTimeout(async () => {
    try {
      const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&accept-language=ru`;
      const r    = await fetch(url, { headers: { 'Accept-Language': 'ru' } });
      const data = await r.json();
      if (!data.length) { res.innerHTML = '<div class="search-spinner">Ничего не найдено</div>'; return; }
      res.innerHTML = '';
      data.forEach(item => {
        const el   = document.createElement('div');
        el.className = 'search-result-item';
        const main = item.name || item.display_name.split(',')[0];
        const sub  = item.display_name.split(',').slice(1, 3).join(',').trim();
        el.innerHTML = `<div>${main}</div><div class="result-sub">${sub}</div>`;
        el.onclick = () => {
          editStartLat = parseFloat(item.lat);
          editStartLng = parseFloat(item.lon);
          document.getElementById('edit-start-search').value = item.display_name;
          if (!document.getElementById('edit-start-name').value ||
              document.getElementById('edit-start-name').value === DAYS_DATA[editStartDay].start.name)
            document.getElementById('edit-start-name').value = main;
          document.getElementById('edit-start-lat').value = editStartLat.toFixed(6);
          document.getElementById('edit-start-lng').value = editStartLng.toFixed(6);
          document.getElementById('edit-start-coords-text').textContent =
            `${editStartLat.toFixed(5)}, ${editStartLng.toFixed(5)}`;
          document.getElementById('edit-start-coords-display').style.display = 'block';
          res.classList.remove('show');
        };
        res.appendChild(el);
      });
    } catch(err) { res.innerHTML = '<div class="search-spinner">Ошибка поиска</div>'; }
  }, 500);
}

function doEditStart() {
  const name   = document.getElementById('edit-start-name').value.trim();
  if (!name) { document.getElementById('edit-start-name').focus(); return; }
  const manLat = parseFloat(document.getElementById('edit-start-lat').value);
  const manLng = parseFloat(document.getElementById('edit-start-lng').value);
  const lat    = editStartLat || (isNaN(manLat) ? null : manLat);
  const lng    = editStartLng || (isNaN(manLng) ? null : manLng);
  if (!lat || !lng) { alert('Укажите координаты'); return; }
  const icon = document.getElementById('edit-start-icon').value.trim() || '🚗';
  const day  = editStartDay;
  DAYS_DATA[day].start   = { lat, lng, name, icon };
  DAYS_DATA[day].departP = document.getElementById('edit-start-departP').value.trim();
  closeEditStart();
  const nameEl = document.getElementById('d' + day + '-start-name');
  if (nameEl) nameEl.textContent = icon + ' ' + name;
  const planTimeEl = document.querySelector(`#day${day} .depart-row .time-pair:first-child .time-val`);
  if (planTimeEl) planTimeEl.textContent = DAYS_DATA[day].departP || '—';
  updateDayRoute(day);
  redrawDay(day);
  saveData();
  showToast('✅ Старт обновлён');
}

// ── EDITABLE DATE ─────────────────────────────────────────────────────────────
function editDayDate(day, wrapEl) {
  var current = DAYS_DATA[day].dateISO || '';
  var inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'day-date-input';
  inp.value = current;
  inp.placeholder = 'ДД.ММ.ГГГГ';
  inp.maxLength = 10;
  inp.style.color = DAYS_DATA[day].color;
  inp.style.borderBottomColor = DAYS_DATA[day].color;
  inp.style.width = '100px';
  wrapEl.replaceWith(inp);
  inp.focus(); inp.select();

  inp.oninput = function() {
    var v = inp.value.replace(/[^0-9]/g, '').slice(0, 8);
    var out = '';
    if (v.length > 0) out += v.slice(0, 2);
    if (v.length > 2) out += '.' + v.slice(2, 4);
    if (v.length > 4) out += '.' + v.slice(4, 8);
    inp.value = out;
  };

  var commit = function() {
    var val = inp.value.trim() || current;
    DAYS_DATA[day].dateISO = val;
    var newWrap = document.createElement('span');
    newWrap.className = 'day-date-wrap';
    newWrap.title = 'Нажмите для изменения даты';
    newWrap.onclick = function() { editDayDate(day, newWrap); };
    newWrap.innerHTML = '<span class="day-date-text">' + (val || 'Дата') + '</span><span class="day-date-edit-icon">✎</span>';
    inp.replaceWith(newWrap);
    renderTabs();
    saveData();
  };
  inp.onblur = commit;
  inp.onkeydown = function(e) {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') { inp.value = current; inp.blur(); }
  };
}

function editDesc(day, wrapEl) {
  var current = DAYS_DATA[day].date || '';
  var inp = document.createElement('input');
  inp.className = 'day-date-input';
  inp.value = current;
  inp.placeholder = 'Описание маршрута…';
  inp.style.color = DAYS_DATA[day].color;
  inp.style.borderBottomColor = DAYS_DATA[day].color;
  inp.style.width = '180px';
  wrapEl.replaceWith(inp);
  inp.focus(); inp.select();
  var commit = function() {
    var val = inp.value.trim();
    DAYS_DATA[day].date = val;
    var newWrap = document.createElement('span');
    newWrap.className = 'day-desc-wrap';
    newWrap.title = 'Нажмите для изменения описания';
    newWrap.onclick = function() { editDesc(day, newWrap); };
    if (val) {
      newWrap.innerHTML = '<span class="day-desc-text">' + val + '</span><span class="day-date-edit-icon">✎</span>';
    } else {
      newWrap.innerHTML = '<span class="day-desc-text" style="color:var(--muted);font-style:italic">описание</span><span class="day-date-edit-icon">✎</span>';
    }
    inp.replaceWith(newWrap);
    saveData();
  };
  inp.onblur = commit;
  inp.onkeydown = function(e) {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') { inp.value = current; inp.blur(); }
  };
}

// ── DAY OVERFLOW MENU ─────────────────────────────────────────────────────────
function toggleDayMenu(d) {
  var menu = document.getElementById('dayMenu' + d);
  if (!menu) return;
  var wasOpen = menu.classList.contains('show');
  closeDayMenus();
  if (!wasOpen) menu.classList.add('show');
}
function closeDayMenus() {
  document.querySelectorAll('.day-overflow-menu').forEach(function(m) { m.classList.remove('show'); });
}
document.addEventListener('click', function(e) {
  if (!e.target.closest('.day-overflow-wrap')) closeDayMenus();
});

// ── SWAP DAYS (drag-and-drop tabs) ────────────────────────────────────────────
var _tabDragSource = null;

function swapDays(fromDay, toDay) {
  var keys = dayKeys();
  var fromIdx = keys.indexOf(fromDay);
  var toIdx   = keys.indexOf(toDay);
  if (fromIdx < 0 || toIdx < 0) return;

  // Reorder keys array
  keys.splice(fromIdx, 1);
  keys.splice(toIdx, 0, fromDay);

  // Rebuild DAYS_DATA with new numeric keys
  var newData = {};
  keys.forEach(function(oldKey, i) {
    var newKey = i + 1;
    newData[newKey] = JSON.parse(JSON.stringify(DAYS_DATA[oldKey]));
  });

  // Clear and repopulate
  Object.keys(DAYS_DATA).forEach(function(k) { delete DAYS_DATA[k]; });
  Object.keys(newData).forEach(function(k) { DAYS_DATA[Number(k)] = newData[k]; });

  // Reassign stop IDs to avoid conflicts
  dayKeys().forEach(function(d) {
    DAYS_DATA[d].stops.forEach(function(s, i) {
      s.id = 'd' + d + 's' + (i + 1);
      s.num = i + 1;
    });
  });

  // Re-render map layers
  Object.keys(layers).forEach(function(k) {
    if (map.hasLayer(layers[k])) map.removeLayer(layers[k]);
    delete layers[k];
  });
  Object.keys(segmentLayers).forEach(function(k) { delete segmentLayers[k]; });
  dayKeys().forEach(function(d) {
    layers[d] = L.layerGroup();
    segmentLayers[d] = [];
    redrawDay(d);
  });

  renderTabs();
  renderAllDays();
  updateProgress();
  switchDay(currentDay <= dayKeys().length ? currentDay : 1);
  saveData();
  showToast('📅 Дни переставлены');
}

// ── REVERSE DAY ROUTE ─────────────────────────────────────────────────────────
function reverseDay(d) {
  var day = DAYS_DATA[d];
  if (!day) return;

  var lastStop = day.stops[day.stops.length - 1];
  if (!lastStop) { showToast('⚠ Нет точек для обратного маршрута'); return; }

  // New start = last stop of original day
  var newStart = {
    lat: lastStop.lat, lng: lastStop.lng,
    name: lastStop.name, icon: lastStop.icon || '📍'
  };

  // Collect intermediate accommodation stops (exclude last stop + any at same coords as new start)
  var accomStops = day.stops.filter(function(s) {
    if (s.type !== 'Отель' && s.type !== 'Жильё') return false;
    if (s.id === lastStop.id) return false;
    if (Math.abs(s.lat - newStart.lat) < 0.001 && Math.abs(s.lng - newStart.lng) < 0.001) return false;
    return true;
  });

  // Build reversed stops: accommodation in reverse order
  var newStops = [];
  for (var i = accomStops.length - 1; i >= 0; i--) {
    var s = accomStops[i];
    newStops.push({
      id: '', num: 0, icon: s.icon || '🛎', type: s.type,
      name: s.name, lat: s.lat, lng: s.lng,
      arrP: '', depP: '', arrA: '', depA: ''
    });
  }

  // Final destination = original start (only if not the same place as newStart)
  var startSameAsEnd = Math.abs(day.start.lat - newStart.lat) < 0.001 && Math.abs(day.start.lng - newStart.lng) < 0.001;
  if (!startSameAsEnd) {
    newStops.push({
      id: '', num: 0, icon: day.start.icon || '🚗', type: 'Другое',
      name: day.start.name, lat: day.start.lat, lng: day.start.lng,
      arrP: '', depP: '', arrA: '', depA: ''
    });
  }

  // Create new day
  var keys = dayKeys();
  var newD = Math.max.apply(null, keys) + 1;
  var colorIdx = keys.length % DAY_COLORS.length;

  // Assign IDs
  newStops.forEach(function(s, i) { s.id = 'd' + newD + 's' + (i + 1); s.num = i + 1; });

  var descParts = [newStart.name, newStops[newStops.length - 1]?.name].filter(Boolean);

  DAYS_DATA[newD] = {
    color: DAY_COLORS[colorIdx],
    dateISO: '',
    date: descParts.join(' → ') || 'Обратный маршрут',
    departP: '', departA: '',
    start: newStart,
    stops: newStops
  };

  layers[newD] = L.layerGroup();
  segmentLayers[newD] = [];
  renderTabs();
  document.getElementById('daySections').appendChild(renderDaySection(newD));
  renderStops(newD);
  updateDayRoute(newD);
  redrawDay(newD);
  switchDay(newD);
  saveData();
  showToast('↩ Обратный маршрут создан');
}

// ── ADD / DELETE DAY ──────────────────────────────────────────────────────────
function addNewDay() {
  const keys     = dayKeys();
  const newD     = Math.max(...keys) + 1;
  const colorIdx = keys.length % DAY_COLORS.length;

  // Compute next date from last day
  var lastDay = DAYS_DATA[keys[keys.length - 1]];
  var newDateISO = '';
  if (lastDay && lastDay.dateISO && typeof parseDateDMY === 'function') {
    var dt = parseDateDMY(lastDay.dateISO);
    if (dt) { dt.setDate(dt.getDate() + 1); newDateISO = fmtDateDMY(dt); }
  }

  DAYS_DATA[newD] = {
    color: DAY_COLORS[colorIdx],
    dateISO: newDateISO,
    date: '',
    departP: '', departA: '',
    start: { lat:0, lng:0, name:'Старт', icon:'🚗' },
    stops: []
  };
  layers[newD]        = L.layerGroup();
  segmentLayers[newD] = [];
  renderTabs();
  document.getElementById('daySections').appendChild(renderDaySection(newD));
  renderStops(newD);
  updateDayRoute(newD);
  switchDay(newD);
  saveData();
  showToast('📅 День добавлен');
}

let deleteDayTarget = null;
function confirmDeleteDay(d) {
  if (dayKeys().length <= 1) { showToast('Нельзя удалить последний день'); return; }
  deleteDayTarget = d;
  var label = DAYS_DATA[d].dateISO ? fmtDateFull(DAYS_DATA[d].dateISO) : ('День ' + d);
  document.getElementById('deleteDayModalBody').textContent =
    label + (DAYS_DATA[d].date ? ' · ' + DAYS_DATA[d].date : '') + ' и все его точки будут удалены.';
  document.getElementById('deleteDayModal').classList.add('show');
}
function closeDeleteDayModal() {
  document.getElementById('deleteDayModal').classList.remove('show');
  deleteDayTarget = null;
}
function doDeleteDay() {
  const d = deleteDayTarget;
  closeDeleteDayModal();
  if (!d || !DAYS_DATA[d]) return;
  snapshotForUndo(`Удалён день ${d}`);
  if (map.hasLayer(layers[d])) map.removeLayer(layers[d]);
  delete layers[d];
  segmentLayers[d] = [];
  delete DAYS_DATA[d];
  const keys       = dayKeys();
  const newCurrent = keys.includes(currentDay) ? currentDay : keys[0];
  renderTabs();
  renderAllDays();
  dayKeys().forEach(dk => redrawDay(dk));
  switchDay(newCurrent);
  saveData();
  showToast('🗑 День удалён');
}

// ── UNDO ──────────────────────────────────────────────────────────────────────
const undoStack = [];
const UNDO_LIMIT = 20;

function snapshotForUndo(label) {
  const snapshot = {
    label,
    days: Object.fromEntries(dayKeys().map(d => [d, { stops: DAYS_DATA[d].stops.map(s => ({...s})) }]))
  };
  undoStack.push(snapshot);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  document.getElementById('undoBtn').disabled = false;
}

function undoAction() {
  if (!undoStack.length) return;
  const snapshot = undoStack.pop();
  dayKeys().forEach(d => {
    if (snapshot.days[d]) DAYS_DATA[d].stops = snapshot.days[d].stops;
  });
  dayKeys().forEach(d => { renderStops(d); redrawDay(d); updateDayRoute(d); });
  updateProgress();
  saveData();
  document.getElementById('undoBtn').disabled = undoStack.length === 0;
  showToast('↩ ' + snapshot.label);
}

// ── STOP CARD DROPDOWN MENU ───────────────────────────────────────────────────
function toggleStopMenu(id, day) {
  const dd  = document.getElementById('dd-' + id);
  const btn = document.getElementById('dots-' + id);
  if (!dd || !btn) return;
  const isOpen = dd.classList.contains('open');
  closeStopMenus();
  if (!isOpen) {
    dd.classList.add('open');
    btn.classList.add('open');
  }
}

function closeStopMenus() {
  document.querySelectorAll('.stop-dropdown').forEach(d => d.classList.remove('open'));
  document.querySelectorAll('.dots-btn').forEach(b => b.classList.remove('open'));
}

// Close menu on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.dots-btn') && !e.target.closest('.stop-dropdown')) closeStopMenus();
});

// ── EDIT STOP TIME (plan only) ─────────────────────────────────────────────────
function editStopTime(id, day) {
  const s    = DAYS_DATA[day].stops.find(x => x.id === id);
  if (!s) return;
  const main = document.getElementById('stop-main-' + id);
  const tg   = document.getElementById('stop-timegrid-' + id);
  const form = document.getElementById('edit-form-' + id);
  if (!main || !tg || !form) return;

  main.style.display = 'none';
  tg.style.display   = 'none';
  form.style.display = 'block';

  // Disable drag while editing
  const card = document.getElementById('card-' + id);
  if (card) card.draggable = false;

  form.innerHTML = `
    <div class="edit-row" style="align-items:center;gap:16px;flex-wrap:wrap;">
      <div class="edit-field">
        <div class="edit-label">Приб. план</div>
        <input class="edit-input edit-input-time" id="et-arrP-${id}" value="${s.arrP}" maxlength="5"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
      ${s.depP !== undefined && s.depP !== '' ? `
      <div class="edit-field">
        <div class="edit-label">Отпр. план</div>
        <input class="edit-input edit-input-time" id="et-depP-${id}" value="${s.depP}" maxlength="5"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>` : ''}
    </div>
    <div style="font-size:9px;color:var(--muted);margin-bottom:8px;">Фактическое время остаётся без изменений</div>
    <div class="edit-actions-row">
      <button class="edit-cancel-btn" onclick="cancelStopEdit('${id}')">✕ Отмена</button>
      <button class="edit-save-btn" onclick="saveStopTime('${id}', ${day})">✓ Сохранить</button>
    </div>`;

  setTimeout(() => document.getElementById('et-arrP-' + id)?.focus(), 50);
}

function saveStopTime(id, day) {
  const s = DAYS_DATA[day].stops.find(x => x.id === id);
  if (!s) return;
  snapshotForUndo('Изменение времени точки');
  const newArr = document.getElementById('et-arrP-' + id)?.value.trim();
  const newDep = document.getElementById('et-depP-' + id)?.value.trim();
  if (newArr !== undefined) s.arrP = newArr;
  if (newDep !== undefined) s.depP = newDep;

  const arrPEl = document.getElementById('planned-arr-' + id);
  const depPEl = document.getElementById('planned-dep-' + id);
  if (arrPEl) arrPEl.textContent = s.arrP || '—';
  if (depPEl) depPEl.textContent = s.depP || '—';
  const arrIn = document.getElementById('arr-' + id);
  const depIn = document.getElementById('dep-' + id);
  if (arrIn) arrIn.placeholder = s.arrP || '--:--';
  if (depIn) depIn.placeholder = s.depP || '--:--';

  cancelStopEdit(id);
  updateProgress();
  saveData();
  showToast('✅ Время обновлено');
}

// ── TIME ARITHMETIC ───────────────────────────────────────────────────────────
function timeToMins(t) {
  if (!t || t.length < 5) return null;
  const [h, m] = t.split(':').map(Number);
  return isNaN(h) || isNaN(m) ? null : h * 60 + m;
}

function minsToTime(total) {
  const t = ((total % 1440) + 1440) % 1440;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function shiftTime(t, delta) {
  const mins = timeToMins(t);
  return mins !== null ? minsToTime(mins + delta) : t;
}

// ── EDIT DEPARTURE TIME + CASCADE RECALC ──────────────────────────────────────
function editDepartTime(day, el) {
  const current = DAYS_DATA[day].departP || '';
  const inp = document.createElement('input');
  inp.className   = 'time-val-edit';
  inp.value       = current;
  inp.maxLength   = 5;
  inp.placeholder = '--:--';
  el.replaceWith(inp);
  inp.focus(); inp.select();

  const commit = () => {
    let val = inp.value.trim();
    const digits = val.replace(/\D/g, '');
    if (digits.length === 4) val = digits.slice(0, 2) + ':' + digits.slice(2);
    else if (digits.length === 3) val = '0' + digits[0] + ':' + digits.slice(1);

    const newEl = document.createElement('div');
    newEl.className  = 'time-val time-val-editable';
    newEl.id         = 'd' + day + '-departP-display';
    newEl.title      = 'Нажмите для изменения времени выезда';
    newEl.textContent = val || '—';
    newEl.onclick    = () => editDepartTime(day, newEl);
    inp.replaceWith(newEl);

    // Always save the new departP value
    DAYS_DATA[day].departP = val;
    saveData();

    // Cascade time shift to stops only if both old and new times are valid and differ
    const oldMins = timeToMins(current);
    const newMins = timeToMins(val);
    if (oldMins !== null && newMins !== null && oldMins !== newMins) {
      const delta = newMins - oldMins;
      snapshotForUndo('Пересчёт времён · День ' + day);
      DAYS_DATA[day].stops.forEach(s => {
        if (s.arrP) { s.arrP = shiftTime(s.arrP, delta); }
        if (s.depP) { s.depP = shiftTime(s.depP, delta); }
      });
      renderStops(day);
      redrawDay(day);
      updateProgress();
      showToast('🕐 Времена пересчитаны (' + (delta > 0 ? '+' : '') + Math.round(delta/60*10)/10 + 'ч)');
    }
  };

  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => {
    // just let characters flow; applyMask needs an input event
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') { inp.value = current; inp.blur(); }
  });
  inp.addEventListener('input', () => applyMask(inp));
}

// ── INLINE STOP EDITOR ────────────────────────────────────────────────────────
// per-card edit state: stores temp lat/lng from Nominatim search
const _editStopCoords = {};
let _editStopSearchTimer = null;

function editStop(id, day) {
  const s    = DAYS_DATA[day].stops.find(x => x.id === id);
  if (!s) return;
  const main = document.getElementById('stop-main-' + id);
  const tg   = document.getElementById('stop-timegrid-' + id);
  const form = document.getElementById('edit-form-' + id);
  if (!main || !tg || !form) return;

  // Reset temp coords to current stop coords
  _editStopCoords[id] = { lat: s.lat, lng: s.lng };

  main.style.display = 'none';
  tg.style.display   = 'none';
  form.style.display = 'block';

  // Disable drag while editing so text selection works normally
  const card = document.getElementById('card-' + id);
  if (card) card.draggable = false;

  const typeOptions = ['Заправка', 'Кафе', 'Отель', 'Жильё', 'Другое']
    .map(t => `<option value="${t}" ${t === s.type ? 'selected' : ''}>${TYPE_ICONS[t] || '📍'} ${t}</option>`)
    .join('');

  form.innerHTML = `
    <div class="edit-field" style="margin-bottom:8px;">
      <div class="edit-label">Поиск нового места</div>
      <div class="search-wrap">
        <input class="edit-input edit-input-name" id="ei-search-${id}"
          type="text" placeholder="Название, адрес…"
          oninput="editStopSearch(this.value, '${id}')" autocomplete="off">
        <div class="search-results" id="ei-results-${id}"></div>
      </div>
    </div>
    <div id="ei-coords-${id}-display" style="font-size:10px;color:var(--green);margin-bottom:6px;display:${s.lat ? 'block' : 'none'};">
      📍 <span id="ei-coords-${id}-text">${s.lat ? s.lat.toFixed(5) + ', ' + s.lng.toFixed(5) : ''}</span>
    </div>
    <div class="edit-row">
      <div class="edit-field">
        <div class="edit-label">Иконка</div>
        <input class="edit-input edit-input-icon" id="ei-icon-${id}" value="${s.icon}" maxlength="4">
      </div>
      <div class="edit-field" style="flex:1;">
        <div class="edit-label">Название</div>
        <input class="edit-input edit-input-name" id="ei-name-${id}" value="${s.name}">
      </div>
    </div>
    <div class="edit-row">
      <div class="edit-field">
        <div class="edit-label">Тип</div>
        <select class="edit-select" id="ei-type-${id}" onchange="document.getElementById('ei-icon-${id}').value=TYPE_ICONS[this.value]||'📍'">
          ${typeOptions}
        </select>
      </div>
      <div class="edit-field">
        <div class="edit-label">Приб. план</div>
        <input class="edit-input edit-input-time" id="ei-arrP-${id}" value="${s.arrP}" maxlength="5"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
      <div class="edit-field">
        <div class="edit-label">Отпр. план</div>
        <input class="edit-input edit-input-time" id="ei-depP-${id}" value="${s.depP}" maxlength="5"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
    </div>
    <div class="edit-row">
      <div class="edit-field edit-field-grow">
        <div class="edit-label">Широта (lat)</div>
        <input class="edit-input edit-input-coord" id="ei-lat-${id}" type="text" inputmode="decimal"
          value="${s.lat ? s.lat.toFixed(6) : ''}" placeholder="55.7965"
          oninput="splitCoordsInput(this,'ei-lng-${id}','ei-coords-${id}');onManualCoordInput('ei-lat-${id}','ei-lng-${id}','ei-coords-${id}')">
      </div>
      <div class="edit-field edit-field-grow">
        <div class="edit-label">Долгота (lng)</div>
        <input class="edit-input edit-input-coord" id="ei-lng-${id}" type="text" inputmode="decimal"
          value="${s.lng ? s.lng.toFixed(6) : ''}" placeholder="37.9475"
          oninput="onManualCoordInput('ei-lat-${id}','ei-lng-${id}','ei-coords-${id}')">
      </div>
    </div>
    <div class="edit-actions-row">
      <button class="edit-cancel-btn" onclick="cancelStopEdit('${id}')">✕ Отмена</button>
      <button class="edit-save-btn" onclick="saveStopEdit('${id}', ${day})">✓ Сохранить</button>
    </div>`;

  setTimeout(() => document.getElementById('ei-search-' + id)?.focus(), 50);
}

function editStopSearch(q, id) {
  clearTimeout(_editStopSearchTimer);
  const res = document.getElementById('ei-results-' + id);
  if (!res) return;
  if (!q || q.length < 3) { res.classList.remove('show'); return; }
  res.classList.add('show');
  res.innerHTML = '<div class="search-spinner">Поиск…</div>';
  _editStopSearchTimer = setTimeout(async () => {
    try {
      const url  = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&accept-language=ru`;
      const r    = await fetch(url, { headers: { 'Accept-Language': 'ru' } });
      const data = await r.json();
      if (!data.length) { res.innerHTML = '<div class="search-spinner">Ничего не найдено</div>'; return; }
      res.innerHTML = '';
      data.forEach(item => {
        const el   = document.createElement('div');
        el.className = 'search-result-item';
        const main = item.name || item.display_name.split(',')[0];
        const sub  = item.display_name.split(',').slice(1, 3).join(',').trim();
        el.innerHTML = `<div>${main}</div><div class="result-sub">${sub}</div>`;
        el.onclick = () => {
          const lat = parseFloat(item.lat), lng = parseFloat(item.lon);
          _editStopCoords[id] = { lat, lng };
          // Pre-fill name if still the old value
          const nameEl = document.getElementById('ei-name-' + id);
          if (nameEl && (!nameEl.value || nameEl.value === nameEl.dataset.orig)) {
            nameEl.value = main;
          }
          document.getElementById('ei-search-' + id).value = item.display_name;
          document.getElementById('ei-coords-' + id + '-text').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
          document.getElementById('ei-coords-' + id + '-display').style.display = 'block';
          res.classList.remove('show');
        };
        res.appendChild(el);
      });
    } catch(err) { res.innerHTML = '<div class="search-spinner">Ошибка поиска</div>'; }
  }, 500);
}

function cancelStopEdit(id) {
  const main = document.getElementById('stop-main-' + id);
  const tg   = document.getElementById('stop-timegrid-' + id);
  const form = document.getElementById('edit-form-' + id);
  if (main) main.style.display = '';
  if (tg)   tg.style.display   = '';
  if (form) form.style.display  = 'none';
  // Re-enable drag
  const card = document.getElementById('card-' + id);
  if (card) card.draggable = true;
}

function saveStopEdit(id, day) {
  const s = DAYS_DATA[day].stops.find(x => x.id === id);
  if (!s) return;
  const newName = document.getElementById('ei-name-' + id)?.value.trim();
  if (!newName) { document.getElementById('ei-name-' + id)?.focus(); return; }

  snapshotForUndo('Редактирование точки');
  s.icon = document.getElementById('ei-icon-' + id)?.value.trim() || s.icon;
  s.name = newName;
  s.type = document.getElementById('ei-type-' + id)?.value || s.type;
  s.arrP = document.getElementById('ei-arrP-' + id)?.value.trim() || '';
  s.depP = document.getElementById('ei-depP-' + id)?.value.trim() || '';

  // Update coordinates: prefer search result, fall back to manual lat/lng fields
  const coords = _editStopCoords[id];
  if (coords && coords.lat && coords.lng) {
    s.lat = coords.lat;
    s.lng = coords.lng;
    delete _editStopCoords[id];
  } else {
    const manLat = parseFloat(document.getElementById('ei-lat-' + id)?.value);
    const manLng = parseFloat(document.getElementById('ei-lng-' + id)?.value);
    if (!isNaN(manLat) && !isNaN(manLng)) {
      s.lat = manLat;
      s.lng = manLng;
    }
  }

  // Update display in-place without full re-render (keeps actual time inputs intact)
  const iconEl  = document.getElementById('stop-icon-disp-' + id);
  const nameEl  = document.getElementById('stop-name-disp-' + id);
  const typeEl  = document.getElementById('stop-type-disp-' + id);
  const arrPEl  = document.getElementById('planned-arr-' + id);
  const depPEl  = document.getElementById('planned-dep-' + id);
  if (iconEl) iconEl.textContent = s.icon;
  if (nameEl) nameEl.textContent = s.name;
  if (typeEl) typeEl.textContent = s.type;
  if (arrPEl) arrPEl.textContent = s.arrP || '—';
  if (depPEl) depPEl.textContent = s.depP || '—';

  // Also update actual input placeholders
  const arrIn = document.getElementById('arr-' + id);
  const depIn = document.getElementById('dep-' + id);
  if (arrIn) arrIn.placeholder = s.arrP || '--:--';
  if (depIn) depIn.placeholder = s.depP || '--:--';

  cancelStopEdit(id);
  redrawDay(day);
  updateProgress();
  saveData();
  showToast('✅ Точка обновлена');
}

// ── NAVIGATION / SHARE DAY ────────────────────────────────────────────────────
function openShareDay(day) {
  const data   = DAYS_DATA[day];
  const points = [
    { lat: data.start.lat, lng: data.start.lng, name: data.start.name },
    ...data.stops.map(s => ({ lat: s.lat, lng: s.lng, name: s.name }))
  ];

  // Yandex Maps — unlimited waypoints via rtext
  const rtext = points.map(p => `${p.lat},${p.lng}`).join('~');
  const yandexUrl = `https://yandex.ru/maps/?rtext=${rtext}&rtt=auto`;

  // Google Maps — max 10 waypoints in URL (stops 0 and last are origin/dest, rest are via)
  const pts10 = points.slice(0, 10);
  const gPath = pts10.map(p => `${p.lat},${p.lng}`).join('/');
  const googleUrl = `https://www.google.com/maps/dir/${gPath}/`;

  // Text list
  const textList = points.map((p, i) =>
    (i === 0 ? '🚗 Старт: ' : `${i}. `) + p.name + ` (${p.lat.toFixed(5)}, ${p.lng.toFixed(5)})`
  ).join('\n');

  const modal = document.getElementById('shareModal');
  document.getElementById('share-day-title').textContent = `День ${day} · ${data.date} · ${data.start.name} → ${points[points.length-1].name}`;

  document.getElementById('share-yandex-link').href = yandexUrl;
  document.getElementById('share-yandex-sub').textContent = yandexUrl.slice(0, 60) + '…';
  document.getElementById('share-google-link').href = googleUrl;
  document.getElementById('share-google-sub').textContent = googleUrl.slice(0, 60) + '…';

  // Store text for copy
  modal.dataset.textList = textList;
  modal.classList.add('show');
}

function closeShareModal() {
  document.getElementById('shareModal').classList.remove('show');
}

function copyShareText() {
  const modal = document.getElementById('shareModal');
  const text  = modal.dataset.textList || '';
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-coords-btn');
    btn.textContent = '✓ Скопировано!';
    btn.classList.add('copy-ok');
    setTimeout(() => { btn.textContent = '📋 Копировать координаты'; btn.classList.remove('copy-ok'); }, 2000);
  });
}

// ── WEATHER (Open-Meteo + Firebase sync) ─────────────────────────────────────
var _weatherCache = {};
var _weatherRef = null;
var _weatherDay = null;

var _wmoEmoji = {
  0:['\u2600\uFE0F','\uD83C\uDF19'],  1:['\uD83C\uDF24\uFE0F','\uD83C\uDF19'],
  2:['\u26C5','\u2601\uFE0F'],         3:['\u2601\uFE0F','\u2601\uFE0F'],
  45:['\uD83C\uDF2B\uFE0F','\uD83C\uDF2B\uFE0F'], 48:['\uD83C\uDF2B\uFE0F','\uD83C\uDF2B\uFE0F'],
  51:['\uD83C\uDF26\uFE0F','\uD83C\uDF27\uFE0F'], 53:['\uD83C\uDF26\uFE0F','\uD83C\uDF27\uFE0F'],
  55:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'], 56:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'],
  57:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'],
  61:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'], 63:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'],
  65:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'],
  66:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'], 67:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'],
  71:['\uD83C\uDF28\uFE0F','\uD83C\uDF28\uFE0F'], 73:['\uD83C\uDF28\uFE0F','\uD83C\uDF28\uFE0F'],
  75:['\u2744\uFE0F','\u2744\uFE0F'],  77:['\uD83C\uDF28\uFE0F','\uD83C\uDF28\uFE0F'],
  80:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'], 81:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'],
  82:['\uD83C\uDF27\uFE0F','\uD83C\uDF27\uFE0F'],
  85:['\uD83C\uDF28\uFE0F','\uD83C\uDF28\uFE0F'], 86:['\uD83C\uDF28\uFE0F','\uD83C\uDF28\uFE0F'],
  95:['\u26C8\uFE0F','\u26C8\uFE0F'],  96:['\u26C8\uFE0F','\u26C8\uFE0F'],
  99:['\u26C8\uFE0F','\u26C8\uFE0F']
};

function _wmoIcon(code, isDay) {
  var e = _wmoEmoji[code] || _wmoEmoji[0];
  if (!e) return '\u2601\uFE0F';
  return isDay ? e[0] : e[1];
}

function _wmoDesc(code) {
  if (code === 0) return 'ясно';
  if (code <= 3) return 'облачно';
  if (code <= 48) return 'туман';
  if (code <= 57) return 'морось';
  if (code <= 67) return 'дождь';
  if (code <= 77) return 'снег';
  if (code <= 82) return 'ливень';
  if (code <= 86) return 'снегопад';
  return 'гроза';
}

function _getWeatherDb() {
  if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) {
    return firebase.database();
  }
  return null;
}

function listenWeather(day) {
  if (_weatherRef && _weatherDay !== null) {
    _weatherRef.off('value');
  }
  _weatherDay = day;
  var db = _getWeatherDb();
  if (!db) return;
  _weatherRef = db.ref('weather/' + day);
  _weatherRef.on('value', function(snap) {
    var val = snap.val();
    if (!val || !val.points) return;
    var pts = val.points;
    Object.keys(pts).forEach(function(id) {
      _weatherCache[id] = pts[id];
      _renderWeather(id);
    });
  });
}

async function fetchDayWeather(day) {
  var data = DAYS_DATA[day];
  if (!data) return;

  var points = [];
  if (data.start && data.start.lat && data.start.lng) {
    points.push({ id: 'd' + day + '-start', lat: data.start.lat, lng: data.start.lng,
                  time: data.departP || '08:00' });
  }
  data.stops.forEach(function(s) {
    if (s.lat && s.lng) {
      points.push({ id: s.id, lat: s.lat, lng: s.lng, time: s.arrP || '12:00' });
    }
  });
  if (!points.length) return;

  showToast && showToast('\uD83C\uDF24\uFE0F Загрузка погоды\u2026');

  var lats = points.map(function(p) { return p.lat; }).join(',');
  var lngs = points.map(function(p) { return p.lng; }).join(',');

  try {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lats +
      '&longitude=' + lngs +
      '&hourly=temperature_2m,weather_code,wind_speed_10m,precipitation,is_day' +
      '&timezone=auto&forecast_days=2';
    var resp = await fetch(url);
    var json = await resp.json();
    var results = Array.isArray(json) ? json : [json];

    var fbPoints = {};

    points.forEach(function(pt, i) {
      var fc = results[i];
      if (!fc || !fc.hourly) return;

      var parts = pt.time.split(':');
      var targetMin = (parseInt(parts[0]) || 12) * 60 + (parseInt(parts[1]) || 0);
      var bestIdx = 0, bestDiff = 99999;

      fc.hourly.time.forEach(function(t, j) {
        var h = parseInt(t.substring(11, 13)) || 0;
        var diff = Math.abs(h * 60 - targetMin);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = j; }
      });

      var temp = Math.round(fc.hourly.temperature_2m[bestIdx]);
      var code = fc.hourly.weather_code[bestIdx] || 0;
      var windKmh = fc.hourly.wind_speed_10m[bestIdx] || 0;
      var wind = Math.round(windKmh * 10 / 36);
      var precip = fc.hourly.precipitation[bestIdx] || 0;
      var isDay = fc.hourly.is_day[bestIdx];
      var emoji = _wmoIcon(code, isDay);
      var timeStr = fc.hourly.time[bestIdx].substring(11, 16);
      var tempStr = (temp > 0 ? '+' : '') + temp + '\u00B0';
      var precipStr = precip > 0 ? (precip.toFixed(1) + ' \u043C\u043C') : '\u0431\u0435\u0437 \u043E\u0441\u0430\u0434\u043A\u043E\u0432';
      var desc = _wmoDesc(code);

      var w = { tempStr: tempStr, emoji: emoji, wind: wind,
                precipStr: precipStr, desc: desc, timeStr: timeStr };
      _weatherCache[pt.id] = w;
      fbPoints[pt.id] = w;
      _renderWeather(pt.id);
    });

    var db = _getWeatherDb();
    if (db) {
      db.ref('weather/' + day).set({ ts: Date.now(), points: fbPoints });
    }

    showToast && showToast('\u2705 \u041F\u043E\u0433\u043E\u0434\u0430 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0430');
  } catch(e) {
    console.error('[weather]', e);
    showToast && showToast('\u26A0 \u041E\u0448\u0438\u0431\u043A\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u043F\u043E\u0433\u043E\u0434\u044B');
  }
}

function toggleWeatherStrip(id) {
  var strip = document.getElementById('ws-' + id);
  if (!strip) return;
  strip.style.display = strip.style.display === 'flex' ? 'none' : 'flex';
}

function _renderWeather(id) {
  var w = _weatherCache[id];
  if (!w) return;

  var badge = document.getElementById('wb-' + id);
  var strip = document.getElementById('ws-' + id);
  if (!badge) return;

  badge.textContent = w.tempStr + ' ' + w.emoji;
  badge.style.display = '';

  if (strip) {
    strip.innerHTML =
      '<span style="font-size:14px">' + w.emoji + '</span>' +
      '<span class="weather-strip-temp">' + w.tempStr + 'C</span>' +
      '<span class="weather-strip-detail">\u0432\u0435\u0442\u0435\u0440 ' + w.wind + ' \u043C/\u0441</span>' +
      '<span class="weather-strip-detail">\u00B7 ' + w.precipStr + '</span>' +
      '<span class="weather-strip-time">' + w.timeStr + '</span>';
    strip.style.display = 'none';
  }
}

function _reapplyDayWeather(day) {
  var startId = 'd' + day + '-start';
  if (_weatherCache[startId]) _renderWeather(startId);
  var data = DAYS_DATA[day];
  if (!data) return;
  data.stops.forEach(function(s) {
    if (_weatherCache[s.id]) _renderWeather(s.id);
  });
}


// ── INIT ──────────────────────────────────────────────────────────────────────
initMap();
dayKeys().forEach(d => redrawDay(d));
layers[currentDay].addTo(map);
renderTabs();
renderAllDays();
updateProgress();
loadState().then(() => startPolling());

// Fix 4: scroll active time input into view when mobile keyboard opens
document.addEventListener('focusin', e => {
  if (!e.target.matches('input.time-in, input#new-stop-arrP, input#new-stop-depP')) return;
  if (window.innerWidth > 700) return;
  const sidebar = document.getElementById('sidebar');
  // wait for keyboard animation (~300ms)
  setTimeout(() => {
    e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 320);
});

setTimeout(() => {
  const d = DAYS_DATA[currentDay];
  if (d) {
    const coords = [[d.start.lat, d.start.lng], ...d.stops.map(s => [s.lat, s.lng])].filter(p => p[0] && p[1]);
    if (coords.length) map.fitBounds(L.latLngBounds(coords), { padding:[40,40] });
  }
  refreshSegments();
}, 150);

// Показать настройки при первом открытии только если не задан ни токен, ни gist ID
// (если gist пришёл из URL — зритель, модал не нужен)
// Автооткрытие модала убрано — владелец настраивает через кнопку ⚙

// ── SIDEBAR TABS ───────────────────────────────────────────────────────────────
let _currentSidebarTab = 'route';

// Открыть сайдбар на таб чата из кнопки в шапке
function openChatFromHeader() {
  const sb = document.getElementById('sidebar');
  if (!sb.classList.contains('open')) {
    sb.classList.add('open');
    const btn = document.getElementById('toggleBtn');
    if (btn) btn.textContent = '✕';
    setTimeout(() => map && map.invalidateSize(), 340);
  }
  switchSidebarTab('chat');
}

// Скрыть вкладку Заметки для читателей
function initSidebarTabs() {
  if (typeof isViewer === 'function' && isViewer()) {
    const notesTab = document.getElementById('tabNotes');
    if (notesTab) notesTab.style.display = 'none';
    document.querySelectorAll('.admin-only-el').forEach(function(el) { el.style.display = 'none'; });
    var undoEl = document.getElementById('undoBtn');
    if (undoEl) undoEl.style.display = 'none';
  }
}

function switchSidebarTab(tab) {
  var prev = _currentSidebarTab;
  _currentSidebarTab = tab;
  ['route','notes','chat'].forEach(t => {
    const btn   = document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1));
    const panel = document.getElementById('tabPanel' + t.charAt(0).toUpperCase() + t.slice(1));
    const active = t === tab;
    if (btn)   btn.classList.toggle('active', active);
    if (panel) panel.style.display = active ? '' : 'none';
  });
  if (tab === 'chat')  { onChatTabOpen && onChatTabOpen(); }
  if (tab === 'notes') { onNotesTabOpen && onNotesTabOpen(); }
  if (tab !== 'chat')  { onChatTabClose && onChatTabClose(); }
  if (prev !== tab) _navPush();
}

// ── STOP NOTE TOGGLE ───────────────────────────────────────────────────────────
function toggleStopNote(stopId) {
  const wrap = document.getElementById('stop-note-wrap-' + stopId);
  if (!wrap) return;
  const visible = wrap.style.display !== 'none';
  if (visible) {
    wrap.style.display = 'none';
    return;
  }
  // Opening — decide whether to show edit or preview
  wrap.style.display = 'block';
  const edit = document.getElementById('stop-note-edit-' + stopId);
  const preview = document.getElementById('stop-note-preview-' + stopId);
  const hasPreviewContent = preview && preview.textContent.trim();
  if (hasPreviewContent) {
    // Has saved content → show preview (click on it opens edit)
    if (edit) edit.style.display = 'none';
    if (preview) preview.style.display = 'block';
  } else {
    // Empty → show edit
    if (edit) edit.style.display = 'flex';
    if (preview) preview.style.display = 'none';
    const ta = document.getElementById('stop-note-' + stopId);
    if (ta) { autoResizeNote(ta); setTimeout(() => ta.focus(), 50); }
  }
}

// ── DEMO: подгрузить заметки к точкам из localStorage при старте ───────────────
if (typeof isDemoMode === 'function' && isDemoMode()) {
  document.addEventListener('DOMContentLoaded', () => {
    if (typeof loadDemoStopNotes === 'function') loadDemoStopNotes();
  });
}

// ── AUTO RESIZE HELPERS ────────────────────────────────────────────────────────
function autoResizeChatInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// Close chat context menu and emoji picker on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#chatMsgMenu')) closeMsgMenu && closeMsgMenu();
  if (!e.target.closest('#emojiPicker') && !e.target.closest('.chat-emoji-btn')) closeEmojiPicker && closeEmojiPicker();
});

// ── CHANGELOG / WHAT'S NEW ───────────────────────────────────────────────────
var APP_VERSION = '2.4.0';
var APP_BUILD   = 65;
console.log('%c🧭 Дорожный журнал v' + APP_VERSION + ' (build ' + APP_BUILD + ')', 'color:#f5a623;font-weight:bold;font-size:13px;');
var CHANGELOG_MAX_SHOW = 2;

var APP_CHANGELOG = [
  { ver: '2.4.0', date: '25.03.2026', items: [
    '↓ Импорт маршрута из Яндекс Карт, Google Maps, 2GIS, OsmAnd',
    'Вставь ссылку на маршрут — точки добавятся автоматически',
    'Reverse geocoding: координаты превращаются в читаемые названия',
    'Фикс: время старта пустого дня теперь сохраняется'
  ]},
  { ver: '2.3.0', date: '23.03.2026', items: [
    '\uD83C\uDF24 Погода на каждой точке маршрута (Open-Meteo)',
    '\u2601\uFE0F Погода синхронизируется через Firebase — один нажал, все видят',
    '\uD83D\uDDFA\uFE0F Оптимизация скачивания карты — в 3-5\u00D7 меньше тайлов',
    '\uD83D\uDDD1 Кнопка «Удалить кэш карты» в навигаторе',
    '\uD83D\uDC41 Читатель: скрыты ненужные кнопки (скачать карту, координаты, отмена)'
  ]},
  { ver: '2.2.0', date: '22.03.2026', items: [
    '📷 Мультивыбор фото (до 10 в одном сообщении)',
    '📋 Вставка фото из буфера (Ctrl+V / Вставить)',
    'Фото в заметках к точкам и вкладке «Заметки»',
    '🖼 Галерея: свайп/стрелки между фото, кнопка «Назад» закрывает',
    '👁 Кто прочитал — тап по галочкам показывает имена',
    '🔐 Firebase Anonymous Auth — серверный uid',
    '💬 Личные сообщения — приватные чаты между участниками'
  ]},
  { ver: '2.1.1', date: '22.03.2026', items: [
    'Офлайн: стартовая точка из кэша (не Москва) для админа',
    'Дата в сайдбаре всегда ДД.ММ.ГГГГ',
    'Кнопки Навигатор/··· подсвечиваются акцентным цветом',
    'Карта читателя обновляется при свопе дней админом',
    'Убрано мелькание «День 1» при обновлении страницы'
  ]},
  { ver: '2.1.0', date: '21.03.2026', items: [
    'Ссылки в заметках к точкам теперь кликабельные',
    'Drag-and-drop: перетаскивай дни для изменения порядка',
    '↩ Обратный маршрут — создаёт обратный день с отелями/жильём',
    'Даты вместо номеров дней, описание маршрута'
  ]},
  { ver: '2.0.0', date: '21.03.2026', items: [
    'Новая иконка — глобус с машинкой',
    'Шторка sidebar ↕',
    'Кнопка «назад» ходит по вкладкам',
    '«Что нового» — этот экран'
  ]}
];

function showChangelog() {
  var body = document.getElementById('changelogBody');
  if (!body) return;
  var html = '';
  var entries = APP_CHANGELOG.slice(0, CHANGELOG_MAX_SHOW);
  entries.forEach(function(entry) {
    html += '<div class="changelog-ver">v' + entry.ver + ' — ' + entry.date + '</div>';
    entry.items.forEach(function(item) {
      html += '<div class="changelog-item">' + item + '</div>';
    });
  });
  body.innerHTML = html;
  document.getElementById('changelogModal').classList.add('show');
}

function closeChangelog() {
  document.getElementById('changelogModal').classList.remove('show');
  try { localStorage.setItem('changelog_seen', APP_VERSION); } catch(e) {}
}

// Show on load if new version
setTimeout(function() {
  try {
    var seen = localStorage.getItem('changelog_seen');
    if (seen !== APP_VERSION) showChangelog();
  } catch(e) {}
}, 800);

// Start weather listener for initial day once Firebase is available
setTimeout(function() { listenWeather(currentDay); }, 1500);

// ── NAVIGATION HISTORY (back button / swipe-back) ────────────────────────────
var _navFromHistory = false;

function _navState() {
  var sb = document.getElementById('sidebar');
  return { tab: _currentSidebarTab, open: sb ? sb.classList.contains('open') : false, day: currentDay };
}

function _navPush() {
  if (_navFromHistory) return;
  history.pushState(_navState(), '');
}

function _navRestore(state) {
  if (!state) return;
  _navFromHistory = true;

  // Suppress transitions during programmatic state restore
  document.body.classList.add('nav-restoring');

  var sb  = document.getElementById('sidebar');
  var btn = document.getElementById('toggleBtn');

  // Restore sidebar open/close
  if (state.open && !sb.classList.contains('open')) {
    sb.classList.add('open');
    if (btn) btn.textContent = '✕';
  } else if (!state.open && sb.classList.contains('open')) {
    sb.classList.remove('open');
    if (btn) btn.textContent = '☰';
    if (_currentSidebarTab === 'chat') onChatTabClose && onChatTabClose();
  }

  // Restore tab
  if (state.tab && state.tab !== _currentSidebarTab) {
    switchSidebarTab(state.tab);
  }

  // Restore day
  if (state.day && state.day !== currentDay) {
    switchDay(state.day);
  }

  _navFromHistory = false;
  requestAnimationFrame(function() { document.body.classList.remove('nav-restoring'); });
  setTimeout(function() { map && map.invalidateSize(); }, 340);
}

// popstate handled in chat.js (photo viewer priority, then delegates to _navRestore)

// Set initial state so first "back" doesn't exit immediately
history.replaceState(_navState(), '');

// ── SHEET DRAG (mobile: resize sidebar / map split) ──────────────────────────
(function() {
  const handle  = document.getElementById('sheetHandle');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  const SNAPS    = [25, 55, 85];
  let currentVh  = 55;
  let dragging   = false;
  let startY     = 0;
  let startVh    = 55;

  function isMobile() { return window.innerWidth <= 700; }

  function setHeight(vh) {
    currentVh = Math.max(15, Math.min(90, vh));
    sidebar.style.setProperty('--sheet-h', currentVh + 'vh');
  }

  function nearest(vh) {
    return SNAPS.reduce((a, b) => Math.abs(b - vh) < Math.abs(a - vh) ? b : a);
  }

  function snapTo(vh) {
    sidebar.classList.remove('dragging');
    sidebar.classList.add('snapping');
    setHeight(vh);
    setTimeout(() => {
      sidebar.classList.remove('snapping');
      if (typeof map !== 'undefined' && map) map.invalidateSize();
    }, 280);
  }

  handle.addEventListener('pointerdown', function(e) {
    if (!isMobile()) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    startY   = e.clientY;
    startVh  = currentVh;
    sidebar.classList.add('dragging');
    handle.classList.add('dragging');
  });

  handle.addEventListener('pointermove', function(e) {
    if (!dragging) return;
    var dy = e.clientY - startY;
    var dvh = (dy / window.innerHeight) * 100;
    setHeight(startVh + dvh);
    if (typeof map !== 'undefined' && map) map.invalidateSize();
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    snapTo(nearest(currentVh));
  }

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Reset variable on desktop resize
  window.addEventListener('resize', function() {
    if (!isMobile()) {
      sidebar.style.removeProperty('--sheet-h');
      currentVh = 55;
    }
  });
})();
