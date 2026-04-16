// ── UI STATE ──────────────────────────────────────────────────────────────────
let currentDay = 1;
let _currentSidebarTab = 'route';

// ── BLUR-THEN-CLICK GUARD ────────────────────────────────────────────────────
// Prevents accidental tap on underlying element right after time input commits
var _blurJustCommitted = false;
document.addEventListener('click', function(e) {
  if (!_blurJustCommitted) return;
  // Allow clicks only on real interactive controls (button, input, a, select)
  var t = e.target.closest('button,input,a,select');
  if (t) return;
  e.stopImmediatePropagation(); e.preventDefault();
}, true);
function _markBlurCommit() {
  _blurJustCommitted = true;
  setTimeout(function() { _blurJustCommitted = false; }, 500);
}

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
    tab.style.color           = '';
    if (day === d && DAYS_DATA[day]?.color) {
      tab.style.color           = DAYS_DATA[day].color;
      tab.style.borderColor     = DAYS_DATA[day].color;
      tab.style.backgroundColor = DAYS_DATA[day].color + '1f';
    }
  });
  switchMapDay(d);
  listenWeather(d);
  // Update Еду/Иду button label based on day mode
  var _btn = document.getElementById('drivingBtn');
  if (_btn && !_btn.classList.contains('active')) {
    _btn.innerHTML = DAYS_DATA[d]?.walkMode ? '🚶 Иду' : '🚗 Еду';
  }
  // Обновить иконку GPS-маркера (🚗/🚶) при смене дня — без этого залипает
  if (typeof refreshGpsMarkerIcon === 'function') refreshGpsMarkerIcon();
  if (typeof _routeHintShownIds !== 'undefined') _routeHintShownIds = {};
  if (prev !== d) _navPush();
}

var _inlineAddOpen = false; // true пока открыта форма добавления новой точки

function highlightStop(id, d) {
  document.querySelectorAll('.stop-card').forEach(c => {
    c.classList.remove('selected');
    c.style.borderLeftColor = '';
    c.style.background = '';
    var num = c.querySelector('.stop-num');
    if (num) { num.style.background = ''; }
  });
  const card = document.getElementById('card-' + id);
  const color = DAYS_DATA[d]?.color || '#f5a623';
  if (card) {
    card.classList.add('selected');
    card.style.borderLeftColor = color;
    card.style.background = color + '0f';
    var num = card.querySelector('.stop-num');
    if (num) num.style.background = color;
    card.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
  // Не двигаем карту когда открыта форма добавления новой точки
  if (_inlineAddOpen) return;
  const stop = DAYS_DATA[d]?.stops.find(s => s.id === id);
  if (!stop) return;
  const isWalk = !!(DAYS_DATA[d] && DAYS_DATA[d].walkMode);
  const targetZoom = isWalk ? 16 : 11;
  const currentZoom = map.getZoom();
  if (currentZoom >= targetZoom) {
    map.panTo([stop.lat, stop.lng], { animate: true });
  } else {
    map.setView([stop.lat, stop.lng], targetZoom, { animate: true });
  }
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
  showToast('🗑️ Данные сброшены');
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
  showToast('🗑️ Точка удалена');
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
  if (disp) disp.style.display = displayId.startsWith('ei-coords') ? 'flex' : 'block';
  if (text) text.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
}

// Called when user manually types in a lat or lng field in modals
function onManualCoordInput(latFieldId, lngFieldId, displayId, stopId) {
  var lat = parseFloat(document.getElementById(latFieldId).value);
  var lng = parseFloat(document.getElementById(lngFieldId).value);
  if (!isNaN(lat) && !isNaN(lng)) {
    _updateCoordsDisplay(displayId, lat, lng);
    // Синхронизируем _editStopCoords чтобы saveStopEdit взял ручной ввод,
    // а не исходные координаты точки (которые записываются при открытии формы)
    if (stopId && typeof _editStopCoords !== 'undefined') {
      _editStopCoords[stopId] = { lat: lat, lng: lng };
    }
  }
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
  document.getElementById('new-stop-type-container').innerHTML = _buildTypeDropdownHTML('new-stop-type', 'Другое');
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

// ── ГЕОЛОКАЦИЯ — «Использовать моё местоположение» ────────────────────────────
function _useCurrentLocation(onSuccess) {
  // Если GPS-маркер уже активен — берём его позицию без запроса
  if (typeof _gpsMarker !== 'undefined' && _gpsMarker) {
    var ll = _gpsMarker.getLatLng();
    fetch('https://nominatim.openstreetmap.org/reverse?lat=' + ll.lat + '&lon=' + ll.lng + '&format=json&accept-language=ru')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var name = d.name || (d.address && (d.address.road || d.address.village || d.address.town || d.address.city)) || '';
        onSuccess({ lat: ll.lat, lng: ll.lng, name: name, display: d.display_name || '' });
      })
      .catch(function() { onSuccess({ lat: ll.lat, lng: ll.lng, name: '', display: '' }); });
    return;
  }
  if (!navigator.geolocation) { showToast('GPS недоступен в браузере'); return; }
  showToast('📡 Определяю местоположение…');
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude, lng = pos.coords.longitude;
    fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json&accept-language=ru')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var name = d.name || (d.address && (d.address.road || d.address.village || d.address.town || d.address.city)) || '';
        onSuccess({ lat: lat, lng: lng, name: name, display: d.display_name || '' });
      })
      .catch(function() { onSuccess({ lat: lat, lng: lng, name: '', display: '' }); });
  }, function(err) { showToast('⚠️ Нет доступа к GPS'); }, { enableHighAccuracy: true, timeout: 10000 });
}

// Для модалки «Новая точка»
function useCurrentLocationForModal() {
  _useCurrentLocation(function(loc) {
    newStopLat = loc.lat; newStopLng = loc.lng;
    if (loc.display) document.getElementById('nominatim-input').value = loc.display;
    if (loc.name)    document.getElementById('new-stop-name').value   = loc.name;
    document.getElementById('new-stop-lat').value = loc.lat.toFixed(6);
    document.getElementById('new-stop-lng').value = loc.lng.toFixed(6);
    document.getElementById('new-stop-coords-text').textContent = loc.lat.toFixed(5) + ', ' + loc.lng.toFixed(5);
    document.getElementById('new-stop-coords-display').style.display = 'block';
    if (typeof resumeGpsFollow === 'function') resumeGpsFollow();
  });
}

// Для модалки «Точка старта»
function useCurrentLocationForStart() {
  _useCurrentLocation(function(loc) {
    editStartLat = loc.lat; editStartLng = loc.lng;
    if (loc.display) document.getElementById('edit-start-search').value = loc.display;
    if (loc.name)    document.getElementById('edit-start-name').value   = loc.name;
    document.getElementById('edit-start-lat').value = loc.lat.toFixed(6);
    document.getElementById('edit-start-lng').value = loc.lng.toFixed(6);
    document.getElementById('edit-start-coords-text').textContent = loc.lat.toFixed(5) + ', ' + loc.lng.toFixed(5);
    document.getElementById('edit-start-coords-display').style.display = 'flex';
    if (typeof resumeGpsFollow === 'function') resumeGpsFollow();
  });
}

// Для инлайн-формы редактирования точки
function useCurrentLocationForEdit(id) {
  _useCurrentLocation(function(loc) {
    _editStopCoords[id] = { lat: loc.lat, lng: loc.lng };
    if (loc.display) { var s = document.getElementById('ei-search-' + id); if (s) s.value = loc.display; }
    if (loc.name)    { var n = document.getElementById('ei-name-'   + id); if (n && !n.value) n.value = loc.name; }
    var latEl = document.getElementById('ei-lat-' + id);
    var lngEl = document.getElementById('ei-lng-' + id);
    var txtEl = document.getElementById('ei-coords-' + id + '-text');
    var dspEl = document.getElementById('ei-coords-' + id + '-display');
    if (latEl) latEl.value = loc.lat.toFixed(6);
    if (lngEl) lngEl.value = loc.lng.toFixed(6);
    if (txtEl) txtEl.textContent = loc.lat.toFixed(5) + ', ' + loc.lng.toFixed(5);
    if (dspEl) dspEl.style.display = 'flex';
    if (typeof resumeGpsFollow === 'function') resumeGpsFollow();
  });
}

// Для инлайн-формы добавления точки
function useCurrentLocationForAdd(afterId) {
  _useCurrentLocation(function(loc) {
    _inlineAddCoords[afterId] = { lat: loc.lat, lng: loc.lng };
    if (loc.display) { var s = document.getElementById('ia-search-' + afterId); if (s) s.value = loc.display; }
    if (loc.name)    { var n = document.getElementById('ia-name-'   + afterId); if (n && !n.value) n.value = loc.name; }
    var latEl = document.getElementById('ia-lat-' + afterId);
    var lngEl = document.getElementById('ia-lng-' + afterId);
    var txtEl = document.getElementById('ia-coords-' + afterId + '-text');
    var dspEl = document.getElementById('ia-coords-' + afterId + '-display');
    if (latEl) latEl.value = loc.lat.toFixed(6);
    if (lngEl) lngEl.value = loc.lng.toFixed(6);
    if (txtEl) txtEl.textContent = loc.lat.toFixed(5) + ', ' + loc.lng.toFixed(5);
    if (dspEl) dspEl.style.display = 'block';
    if (typeof resumeGpsFollow === 'function') resumeGpsFollow();
  });
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
// DEP_OFFSETS defined in config.js

// ── TYPE DROPDOWN (custom select) ─────────────────────────────────────────────
var _typeKeys = Object.keys(TYPE_ICONS);

function _buildTypeDropdownHTML(inputId, selectedType) {
  var sel = selectedType || 'Другое';
  var icon = TYPE_ICONS[sel] || '📍';
  var items = _typeKeys.map(function(t) {
    var active = t === sel;
    return '<div class="type-dropdown-item' + (active ? ' active' : '') + '" data-type="' + t + '" onmousedown="event.preventDefault()" onclick="_selectTypeItem(\'' + inputId + '\',\'' + t + '\')">'
      + '<span class="type-dropdown-icon">' + (TYPE_ICONS[t] || '📍') + '</span>'
      + '<span>' + t + '</span>'
      + (active ? '<span class="type-dropdown-check">✓</span>' : '')
      + '</div>';
  }).join('');
  return '<input type="hidden" id="' + inputId + '" value="' + sel + '">'
    + '<div class="type-dropdown" id="' + inputId + '-dd">'
    + '<div class="type-dropdown-btn" onclick="_toggleTypeDropdown(\'' + inputId + '\')">'
    + '<span class="type-dropdown-icon" id="' + inputId + '-icon">' + icon + '</span>'
    + '<span class="type-dropdown-label" id="' + inputId + '-label">' + sel + '</span>'
    + '<span class="type-dropdown-arrow" id="' + inputId + '-arrow">▾</span>'
    + '</div>'
    + '<div class="type-dropdown-menu" id="' + inputId + '-menu">' + items + '</div>'
    + '</div>';
}

function _toggleTypeDropdown(inputId) {
  var menu = document.getElementById(inputId + '-menu');
  var btn = menu.previousElementSibling;
  var isOpen = menu.classList.contains('show');
  _closeAllTypeDropdowns();
  if (!isOpen) {
    menu.classList.add('show');
    btn.classList.add('open');
    document.getElementById(inputId + '-arrow').textContent = '▴';
  }
}

function _closeAllTypeDropdowns() {
  document.querySelectorAll('.type-dropdown-menu.show').forEach(function(m) {
    m.classList.remove('show');
    m.previousElementSibling.classList.remove('open');
    var arrowId = m.id.replace('-menu', '-arrow');
    var arrow = document.getElementById(arrowId);
    if (arrow) arrow.textContent = '▾';
  });
}

function _selectTypeItem(inputId, type) {
  var input = document.getElementById(inputId);
  input.value = type;
  document.getElementById(inputId + '-icon').textContent = TYPE_ICONS[type] || '📍';
  document.getElementById(inputId + '-label').textContent = type;
  // Update active state
  var menu = document.getElementById(inputId + '-menu');
  menu.querySelectorAll('.type-dropdown-item').forEach(function(item) {
    var isActive = item.dataset.type === type;
    item.classList.toggle('active', isActive);
    var check = item.querySelector('.type-dropdown-check');
    if (isActive && !check) {
      item.insertAdjacentHTML('beforeend', '<span class="type-dropdown-check">✓</span>');
    } else if (!isActive && check) {
      check.remove();
    }
  });
  _closeAllTypeDropdowns();
  // Fire callbacks
  if (inputId === 'new-stop-type') {
    prefillStopIcon(type);
    prefillDepTime();
  } else if (inputId.startsWith('ei-type-')) {
    var stopId = inputId.replace('ei-type-', '');
    var iconEl = document.getElementById('ei-icon-' + stopId);
    if (iconEl) iconEl.value = TYPE_ICONS[type] || '📍';
  } else if (inputId.startsWith('ia-type-')) {
    var iaStopId = inputId.replace('ia-type-', '');
    var iaIconEl = document.getElementById('ia-icon-' + iaStopId);
    if (iaIconEl) iaIconEl.value = TYPE_ICONS[type] || '📍';
  }
}

// Close dropdown on click outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.type-dropdown')) _closeAllTypeDropdowns();
});

// ── ICON PICKER ───────────────────────────────────────────────────────────────
function openIconPicker(inputId, typeInputId) {
  var existing = document.getElementById('iconPickerInline');
  if (existing && existing.dataset.forInput === inputId) {
    _closeIconPicker(); return;
  }
  _closeIconPicker();

  var inputEl = document.getElementById(inputId);
  if (!inputEl) return;

  var formEl = inputEl.closest('.stop-edit-form') || inputEl.closest('.modal');
  if (!formEl) return;

  var type = typeInputId ? (document.getElementById(typeInputId) || {}).value : null;
  var icons;
  if (!type) {
    var startFirst = (ICON_SETS['Отель'] || []).concat(ICON_SETS['Жильё'] || []);
    var rest = [];
    Object.keys(ICON_SETS).forEach(function(k) {
      if (k !== 'Отель' && k !== 'Жильё') rest = rest.concat(ICON_SETS[k]);
    });
    icons = startFirst.concat(rest).filter(function(v, i, a) { return a.indexOf(v) === i; });
  } else {
    icons = ICON_SETS[type] || ICON_SETS['Другое'];
  }

  var current = inputEl.value;
  var picker = document.createElement('div');
  picker.id = 'iconPickerInline';
  picker.className = 'icon-picker-stop';
  picker.dataset.forInput = inputId;
  picker.innerHTML = icons.map(function(ic) {
    var sel = ic === current ? ' ip-sel' : '';
    return '<button class="icon-pick-stop-btn' + sel + '" onmousedown="event.preventDefault()" onclick="selectIconFromPicker(\'' + inputId + '\',\'' + ic + '\')">' + ic + '</button>';
  }).join('');

  // Строка «свой / поиск» — занимает всю ширину
  var customRow = document.createElement('div');
  customRow.className = 'ip-custom-row';
  customRow.style.cssText = 'grid-column:1/-1;border-top:1px solid var(--border);margin-top:3px;padding-top:3px;';
  customRow.innerHTML =
    '<div style="display:flex;align-items:center;gap:4px;padding:0 2px">'
    + '<span style="font-size:9px;color:var(--muted);white-space:nowrap;letter-spacing:0.04em">Свой или поиск:</span>'
    + '<input id="ipCustomInput" class="edit-input" type="text" maxlength="40" placeholder="🚗 или автомойка"'
    + ' style="flex:1;height:26px;font-size:13px;padding:0 6px;min-width:0"'
    + ' autocomplete="nope" oninput="_ipCustomInput(this,\'' + inputId + '\')"'
    + ' onmousedown="event.stopPropagation()">'
    + '</div>'
    + '<div id="ipSearchResults" style="display:none;flex-wrap:wrap;gap:1px;padding:2px 2px 0"></div>';
  picker.appendChild(customRow);

  // Позиция: bottom иконки относительно formEl
  var inputRect = inputEl.getBoundingClientRect();
  var formRect  = formEl.getBoundingClientRect();
  picker.style.top = (inputRect.bottom - formRect.top + 4) + 'px';

  // Left/right: выровнять по референсному инпуту (поиск / имя)
  var refId = inputId
    .replace('ia-icon-', 'ia-search-')
    .replace('ei-icon-', 'ei-search-')
    .replace('edit-start-icon', 'edit-start-search')
    .replace('new-stop-icon', 'new-stop-name');
  var refEl  = document.getElementById(refId) || inputEl;
  var refRect = refEl.getBoundingClientRect();
  picker.style.left  = (refRect.left  - formRect.left)  + 'px';
  picker.style.right = (formRect.right - refRect.right) + 'px';

  // Колонки: ширина референса минус padding пикера минус скроллбар
  var cols = Math.max(1, Math.floor((refRect.width - 10 - 4) / 34));
  picker.style.gridTemplateColumns = 'repeat(' + cols + ',34px)';
  picker.style.display = 'grid';
  // Динамическая высота: если ≤2 строк — без скролла, иначе ограничиваем 2 строками
  var rows = Math.ceil(icons.length / cols);
  var btnRow = 33; // 32px кнопка + 1px gap
  var pickerPad = 10; // 5px top + 5px bottom
  var customRowH = 42; // строка поиска
  if (rows <= 2) {
    picker.style.maxHeight = 'none';
    picker.style.overflowY = 'visible';
  } else {
    picker.style.maxHeight = (2 * btnRow + pickerPad + customRowH) + 'px';
    picker.style.overflowY = 'auto';
  }

  formEl.appendChild(picker);

  setTimeout(function() {
    document.addEventListener('click', _iconPickerOutsideClick);
  }, 0);
}

function _ipCustomInput(el, inputId) {
  var val = el.value.trim();
  if (!val) {
    var sr = document.getElementById('ipSearchResults');
    if (sr) sr.style.display = 'none';
    return;
  }
  // Определяем: эмодзи (unicode >= U+1F300) или текстовый запрос
  var isEmoji = /\p{Emoji}/u.test(val) && !/^[a-zA-Zа-яА-Я0-9\s]+$/.test(val);
  if (isEmoji) {
    selectIconFromPicker(inputId, val);
    return;
  }
  // Текстовый поиск по словарю
  var results = typeof searchEmoji === 'function' ? searchEmoji(val) : [];
  var sr = document.getElementById('ipSearchResults');
  if (!sr) return;
  if (!results.length) {
    sr.style.display = 'none';
    return;
  }
  sr.style.display = 'flex';
  sr.innerHTML = results.map(function(ic) {
    return '<button class="icon-pick-stop-btn" onmousedown="event.preventDefault()" onclick="selectIconFromPicker(\'' + inputId + '\',\'' + ic + '\')">' + ic + '</button>';
  }).join('');
  // Доскроллить пикер к результатам
  var picker2 = document.getElementById('iconPickerInline');
  if (picker2) picker2.scrollTop = picker2.scrollHeight;
}

function selectIconFromPicker(inputId, icon) {
  var el = document.getElementById(inputId);
  if (el) el.value = icon;
  _closeIconPicker();
}

function _closeIconPicker() {
  var existing = document.getElementById('iconPickerInline');
  if (existing) existing.remove();
  document.removeEventListener('click', _iconPickerOutsideClick);
}

function _iconPickerOutsideClick(e) {
  var picker = document.getElementById('iconPickerInline');
  if (!picker) return;
  if (picker.contains(e.target)) return;
  if (e.target.id === picker.dataset.forInput) return;
  _closeIconPicker();
}

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
  const stop = { id, num:0, icon, type, name, lat:newStopLat, lng:newStopLng, arrP:arrP||'', depP:depP||'', arrA:'', depA:'', notes:[] };
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
  autoFillTimes(day);
  // Auto-fetch weather for the new stop (delay for DOM readiness on mobile PWA)
  setTimeout(function() { fetchStopWeather(day, id); }, 500);
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
  var coordDisp = document.getElementById('edit-start-coords-display');
  coordDisp.style.display = s.lat ? 'flex' : 'none';
  document.getElementById('edit-start-coords-text').textContent =
    s.lat ? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}` : '';
  document.getElementById('editStartModal').classList.add('show');
  setTimeout(() => document.getElementById('edit-start-search').focus(), 100);
}

function closeEditStart() {
  document.getElementById('editStartModal').classList.remove('show');
  editStartDay = null;
}

function _onEditStartManualCoord() {
  var lat = parseFloat(document.getElementById('edit-start-lat').value);
  var lng = parseFloat(document.getElementById('edit-start-lng').value);
  if (!isNaN(lat) && !isNaN(lng)) {
    editStartLat = lat; editStartLng = lng;
    document.getElementById('edit-start-coords-text').textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
    document.getElementById('edit-start-coords-display').style.display = 'flex';
  }
}

function enterMapPickModeForEditStart() {
  _mapPickIsEdit = false;
  _mapPickIsEditStart = true;
  // Закрываем модалку чтобы карта была видна
  document.getElementById('editStartModal').classList.remove('show');
  enterMapPickMode('__start__', editStartDay);
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
          document.getElementById('edit-start-coords-display').style.display = 'flex';
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
  // Ручной ввод имеет приоритет над Nominatim-переменной (та может быть устаревшей
  // если пользователь выбрал результат, а потом исправил координаты руками)
  const lat = (!isNaN(manLat) ? manLat : null) || editStartLat;
  const lng = (!isNaN(manLng) ? manLng : null) || editStartLng;
  if (!lat || !lng) { alert('Укажите координаты'); return; }
  const icon = document.getElementById('edit-start-icon').value.trim() || '🚗';
  const day  = editStartDay;
  const oldDepartP = DAYS_DATA[day].departP || '';
  DAYS_DATA[day].start   = { lat, lng, name, icon };
  DAYS_DATA[day].departP = document.getElementById('edit-start-departP').value.trim();
  closeEditStart();
  const nameEl = document.getElementById('d' + day + '-start-name');
  if (nameEl) nameEl.textContent = icon + ' ' + name;
  const planTimeEl = document.querySelector(`#day${day} .depart-row .time-pair:first-child .time-val`);
  if (planTimeEl) planTimeEl.textContent = DAYS_DATA[day].departP || '—';
  updateDayRoute(day);
  redrawDay(day);
  // Если время старта изменилось — сдвигаем все plan-времена точек на дельту.
  // Если у точки arrP пустой (не задан) — autoFillTimes заполнит его с нуля.
  const oldMins = typeof timeToMins === 'function' ? timeToMins(oldDepartP) : null;
  const newMins = typeof timeToMins === 'function' ? timeToMins(DAYS_DATA[day].departP) : null;
  if (oldMins !== null && newMins !== null && oldMins !== newMins) {
    const delta = newMins - oldMins;
    DAYS_DATA[day].stops.forEach(function(s) {
      if (s.arrP) s.arrP = shiftTime(s.arrP, delta);
      if (s.depP) s.depP = shiftTime(s.depP, delta);
    });
    renderStops(day);
    updateProgress();
  } else if (typeof autoFillTimes === 'function') {
    autoFillTimes(day);
  }
  saveData();
  showToast('✅ Старт обновлён');
  if (typeof fetchStartWeather === 'function') fetchStartWeather(day);
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
    newWrap.innerHTML = '<span class="day-date-text">' + (val || 'Дата') + '</span><span class="day-date-edit-icon">✏️</span>';
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
      newWrap.innerHTML = '<span class="day-desc-text">' + val + '</span><span class="day-date-edit-icon">✏️</span>';
    } else {
      newWrap.innerHTML = '<span class="day-desc-text" style="color:var(--muted);font-style:italic">описание</span><span class="day-date-edit-icon">✏️</span>';
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


// ── DAY ICON PICKER ────────────────────────────────────────────────────────────
var _DAY_ICONS = ['🏠','🏡','🏕️','⛺','🌴','🏖️','🏔️','⛰️','🗺️','🌅','🌄',
                  '✈️','🚂','🚗','🚌','🛳️','🚀','🎡','🎪','🏛️','🌿','🎯'];

function editDayIcon(d, triggerEl) {
  document.removeEventListener('click', _dayIconOutside);
  var existing = document.getElementById('dayIconPickerInline');
  if (existing) {
    existing.remove();
    if (existing.dataset.forDay === String(d)) return;
  }

  var current = DAYS_DATA[d] && DAYS_DATA[d].icon || '';
  var picker = document.createElement('div');
  picker.id = 'dayIconPickerInline';
  picker.className = 'day-icon-picker';
  picker.dataset.forDay = String(d);

  var btns = _DAY_ICONS.map(function(ic) {
    return '<button class="icon-pick-stop-btn' + (ic === current ? ' ip-sel' : '') +
           '" onmousedown="event.preventDefault()" onclick="selectDayIcon(' + d + ',\'' + ic + '\')">' + ic + '</button>';
  }).join('');

  var customRow =
    '<div class="dip-custom-row">' +
      '<input id="dipCustom" class="edit-input" type="text" maxlength="4" placeholder="Свой…"' +
      ' style="width:60px;height:28px;font-size:14px;font-family:\'JetBrains Mono\',monospace;text-align:center;padding:0 6px"' +
      ' onmousedown="event.stopPropagation()"' +
      ' oninput="if(this.value.trim())selectDayIcon(' + d + ',this.value.trim())">' +
      '<button class="dip-clear-btn" onmousedown="event.preventDefault()" onclick="selectDayIcon(' + d + ',\'\')">Убрать иконку</button>' +
    '</div>';

  picker.innerHTML = btns + customRow;

  document.body.appendChild(picker);
  var tr = triggerEl.getBoundingClientRect();
  var pw = picker.offsetWidth || 220;
  var top  = tr.bottom + window.scrollY + 4;
  var left = Math.max(4, Math.min(tr.left + window.scrollX, window.innerWidth - pw - 4));
  picker.style.top  = top  + 'px';
  picker.style.left = left + 'px';

  setTimeout(function() {
    document.addEventListener('click', _dayIconOutside);
  }, 0);
}

function _dayIconOutside(e) {
  var p = document.getElementById('dayIconPickerInline');
  if (p && !p.contains(e.target)) {
    p.remove();
    document.removeEventListener('click', _dayIconOutside);
  }
}

function selectDayIcon(d, icon) {
  if (!DAYS_DATA[d]) return;
  DAYS_DATA[d].icon = icon;
  var iconEl = document.getElementById('d' + d + '-day-icon');
  if (iconEl) iconEl.textContent = icon || '📅';
  renderTabs();
  saveData();
  document.removeEventListener('click', _dayIconOutside);
  var p = document.getElementById('dayIconPickerInline');
  if (p) p.remove();
}
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
  switchDay(dayKeys().includes(currentDay) ? currentDay : dayKeys()[0] || 1);
  // Обновляем хэши чтобы ближайший pollCloud не счёл это внешним изменением
  if (typeof _buildGeoHash === 'function') {
    _lastGeoHash    = _buildGeoHash();
    _lastViewerHash = _buildViewerHash();
  }
  saveData();
  showToast('📅 Дни переставлены');
}

// ── ARCHIVE ────────────────────────────────────────────────────────────────────
function archiveDay(d) {
  if (!isAdmin()) return;
  var keys = dayKeys().filter(function(k) { return !DAYS_DATA[k].archived; });
  if (keys.length <= 1) { showToast('Нельзя архивировать последний активный день'); return; }
  snapshotForUndo('Архивирование дня');
  DAYS_DATA[d].archived = true;
  // Если текущий день архивируется — переключиться
  if (currentDay === d) {
    var next = keys.find(function(k) { return k !== d; });
    if (next) switchDay(next);
  }
  renderTabs();
  renderAllDays();
  renderArchiveBtn();
  saveData();
  showToast('📦 День убран в архив');
}

function restoreDay(d) {
  if (!isAdmin()) return;
  snapshotForUndo('Восстановление из архива');
  delete DAYS_DATA[d].archived;
  if (!layers[d]) { layers[d] = L.layerGroup(); segmentLayers[d] = []; }
  redrawDay(d);
  renderTabs();
  renderAllDays();
  renderArchiveBtn();
  toggleArchive(); // close dropdown
  saveData();
  showToast('↩ День восстановлен');
}

function renderArchiveBtn() {
  var wrap = document.getElementById('archiveWrap');
  var countEl = document.getElementById('archiveCount');
  var dropdown = document.getElementById('archiveDropdown');
  if (!wrap || !isAdmin()) return;
  var archived = dayKeys().filter(function(d) { return DAYS_DATA[d].archived; });
  wrap.style.display = archived.length ? '' : 'none';
  if (countEl) countEl.textContent = archived.length;
  if (!dropdown) return;
  if (!archived.length) {
    dropdown.innerHTML = '<div class="archive-empty">Архив пуст</div>';
    return;
  }
  dropdown.innerHTML = archived.map(function(d) {
    var data = DAYS_DATA[d];
    var date = data.dateISO || _dayLabel(d);
    var title = data.date || '';
    return '<div class="archive-item">'
      + '<div class="archive-item-info">'
      + '<div class="archive-item-date">' + date + '</div>'
      + (title ? '<div class="archive-item-title">' + _escHtml(title) + '</div>' : '')
      + '</div>'
      + '<button class="archive-restore-btn" onmousedown="event.preventDefault()" onclick="restoreDay(' + d + ')" title="Восстановить">↩</button>'
      + '</div>';
  }).join('');
}

function toggleArchive() {
  var dd = document.getElementById('archiveDropdown');
  var btn = document.getElementById('archiveBtn');
  if (!dd || !btn) return;
  var isOpen = dd.classList.contains('show');
  closeDayMenus();
  if (isOpen) { dd.classList.remove('show'); document.removeEventListener('click', _archiveOutsideClick); return; }
  renderArchiveBtn();
  // Position below button, clamped to screen
  var rect = btn.getBoundingClientRect();
  var ddW = 240; // min-width
  dd.style.top = (rect.bottom + 4) + 'px';
  dd.style.left = 'auto';
  // Align right edge to button right, but don't go off left edge
  var rightOffset = window.innerWidth - rect.right;
  if (rightOffset < 0) rightOffset = 4;
  if (window.innerWidth - rightOffset < ddW) rightOffset = Math.max(4, window.innerWidth - ddW - 4);
  dd.style.right = rightOffset + 'px';
  dd.classList.add('show');
  setTimeout(function() {
    document.addEventListener('click', _archiveOutsideClick);
  }, 0);
}

function _archiveOutsideClick(e) {
  if (e.target.closest('#archiveWrap')) return;
  var dd = document.getElementById('archiveDropdown');
  if (dd) dd.classList.remove('show');
  document.removeEventListener('click', _archiveOutsideClick);
}

// ── REVERSE DAY ROUTE ─────────────────────────────────────────────────────────
var _reverseDayTarget = null;

function reverseDay(d) {
  var day = DAYS_DATA[d];
  if (!day) return;
  if (!day.stops || !day.stops.length) { showToast('⚠ Нет точек для обратного маршрута'); return; }
  _reverseDayTarget = d;

  // Список для попапа: все точки в обратном порядке + оригинальный старт в конце
  // Порядок = порядок нового маршрута (первый пункт станет start нового дня)
  var reversed = day.stops.slice().reverse(); // последняя стоп → первая
  var points = reversed.map(function(s) {
    return { icon: s.icon || '📍', name: s.name, id: s.id, isOrigStop: true };
  });
  // Оригинальный старт = финишная точка нового маршрута
  var startSameAsLast = day.stops.length &&
    Math.abs(day.start.lat - day.stops[day.stops.length-1].lat) < 0.001 &&
    Math.abs(day.start.lng - day.stops[day.stops.length-1].lng) < 0.001;
  if (!startSameAsLast) {
    points.push({ icon: day.start.icon || '🚗', name: day.start.name, id: '__start__', isOrigStop: false });
  }

  var html = points.map(function(p, i) {
    var checked = (i === 0 || i === points.length - 1) ? 'checked' : '';
    var badge = i === 0 ? '<span class="rev-badge">старт</span>'
               : i === points.length - 1 ? '<span class="rev-badge">финиш</span>' : '';
    return '<label class="rev-item"><input type="checkbox" class="rev-cb" data-idx="' + i + '" ' + checked + '>' +
           '<span class="rev-icon">' + p.icon + '</span>' +
           '<span class="rev-name">' + (p.name || '—') + '</span>' + badge + '</label>';
  }).join('');

  document.getElementById('reverseDayList').innerHTML = html;
  // Сохраняем points-данные для doReverseDay
  document.getElementById('reverseDayList').dataset.points = JSON.stringify(points);
  document.getElementById('reverseDayModal').classList.add('show');
}

function closeReverseDayModal() {
  document.getElementById('reverseDayModal').classList.remove('show');
  _reverseDayTarget = null;
}

function doReverseDay() {
  var d = _reverseDayTarget;
  if (d === null) return;
  var day = DAYS_DATA[d];
  if (!day) return;

  var list   = document.getElementById('reverseDayList');
  var points = JSON.parse(list.dataset.points || '[]');
  var cbs    = list.querySelectorAll('.rev-cb');
  var selected = [];
  cbs.forEach(function(cb, i) { if (cb.checked && points[i]) selected.push(points[i]); });

  if (selected.length < 1) { showToast('⚠ Выберите хотя бы одну точку'); return; }

  // Первый выбранный = start нового дня
  var firstSel = selected[0];
  var origStop = firstSel.isOrigStop ? day.stops.find(function(s) { return s.id === firstSel.id; }) : null;
  var newStart = origStop
    ? { lat: origStop.lat, lng: origStop.lng, name: origStop.name, icon: origStop.icon || '📍' }
    : { lat: day.start.lat, lng: day.start.lng, name: day.start.name, icon: day.start.icon || '🚗' };

  // Остальные = stops
  var newStops = [];
  for (var i = 1; i < selected.length; i++) {
    var sel = selected[i];
    var src = sel.isOrigStop ? day.stops.find(function(s) { return s.id === sel.id; }) : null;
    if (!src && !sel.isOrigStop) {
      // Оригинальный старт
      newStops.push({ id: '', num: 0, icon: day.start.icon || '🚗', type: 'Другое',
        name: day.start.name, lat: day.start.lat, lng: day.start.lng,
        arrP: '', depP: '', arrA: '', depA: '', notes: [] });
    } else if (src) {
      newStops.push({ id: '', num: 0, icon: src.icon || '📍', type: src.type || 'Другое',
        name: src.name, lat: src.lat, lng: src.lng,
        arrP: '', depP: '', arrA: '', depA: '', notes: [] });
    }
  }

  var keys = dayKeys();
  var newD = Math.max.apply(null, keys) + 1;
  var colorIdx = keys.filter(function(k) { return !DAYS_DATA[k].archived; }).length % DAY_COLORS.length;

  newStops.forEach(function(s, i) { s.id = 'd' + newD + 's' + (i + 1); s.num = i + 1; });

  var descParts = [newStart.name, newStops.length ? newStops[newStops.length-1].name : ''].filter(Boolean);
  DAYS_DATA[newD] = {
    color: DAY_COLORS[colorIdx], dateISO: '',
    date: descParts.join(' → ') || 'Обратный маршрут',
    departP: '', departA: '', start: newStart, stops: newStops
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
  closeReverseDayModal();
  showToast('↩ Обратный маршрут создан');
}

// ── ADD / DELETE DAY ──────────────────────────────────────────────────────────
// ── DAY TRANSPORT MODE ───────────────────────────────────────────────────────
function setDayMode(day, mode) {
  var data = DAYS_DATA[day];
  if (!data) return;

  data.walkMode = (mode === 'walk');

  // Flush stale OSRM requests so new profile (foot/driving) applies instantly
  if (typeof _flushQueue === 'function') _flushQueue();

  // Update depart icon in sidebar
  var departIcon = document.getElementById('d' + day + '-depart-icon');
  if (departIcon) departIcon.textContent = data.walkMode ? '🚶' : '🚗';

  // Update start marker emoji on map (if start has lat/lng)
  // Redraw resets the marker — just redraw the day
  redrawDay(day);

  // Update mode pill UI
  var row = document.getElementById('dayModeRow' + day);
  if (row) {
    row.querySelectorAll('.day-mode-pill').forEach(function(btn) {
      btn.className = 'day-mode-pill';
    });
    var activeBtn = row.querySelector(data.walkMode ? '.day-mode-pill:last-child' : '.day-mode-pill:first-child');
    if (activeBtn) activeBtn.className = 'day-mode-pill active';
  }

  // Refresh Еду/Иду button
  var _btn = document.getElementById('drivingBtn');
  if (_btn && !_btn.classList.contains('active')) {
    _btn.innerHTML = data.walkMode ? '🚶 Иду' : '🚗 Еду';
  }
  saveData();
  showToast(data.walkMode ? '🚶 Режим: пешком' : '🚗 Режим: авто');
}

function setDayVisibility(day, visible) {
  var data = DAYS_DATA[day];
  if (!data) return;
  data.hidden = !visible;
  renderTabs();
  // Обновить пиллы в меню
  var row = document.getElementById('dayVisRow' + day);
  if (row) {
    row.querySelectorAll('.day-mode-pill').forEach(function(btn) { btn.className = 'day-mode-pill'; });
    var activeBtn = row.querySelector(visible ? '.day-mode-pill:first-child' : '.day-mode-pill:last-child');
    if (activeBtn) activeBtn.className = 'day-mode-pill active';
  }
  saveData();
  showToast(visible ? '👁 День виден читателю' : '🔒 День скрыт от читателя');
}

function addNewDay() {
  const keys     = dayKeys();
  const newD     = Math.max(...keys) + 1;
  const activeKeys = keys.filter(function(k) { return !DAYS_DATA[k].archived; });
  const colorIdx = activeKeys.length % DAY_COLORS.length;

  DAYS_DATA[newD] = {
    color: DAY_COLORS[colorIdx],
    dateISO: '',
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


// Порядковый номер дня среди активных (не архивных) для отображения
function _dayDisplayNum(d) {
  var activeKeys = dayKeys().filter(function(k) { return !DAYS_DATA[k].archived; }).sort(function(a,b){return a-b;});
  var idx = activeKeys.indexOf(d);
  return idx >= 0 ? (idx + 1) : null;
}
function _dayLabel(d) {
  var data = DAYS_DATA[d];
  if (data && data.dateISO) return data.dateISO;
  var num = _dayDisplayNum(d);
  return num ? ('День ' + num) : ('День ' + d);
}

let deleteDayTarget = null;
function confirmDeleteDay(d) {
  var activeKeys = dayKeys().filter(function(k) { return !DAYS_DATA[k].archived; });
  if (activeKeys.length <= 1) { showToast('Нельзя удалить последний активный день'); return; }
  deleteDayTarget = d;
  var label = DAYS_DATA[d].dateISO ? fmtDateFull(DAYS_DATA[d].dateISO) : _dayLabel(d);
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
  const activeKeys = keys.filter(function(k) { return !DAYS_DATA[k].archived; });
  const newCurrent = activeKeys.includes(currentDay) ? currentDay : (activeKeys[0] || keys[0]);
  renderTabs();
  renderAllDays();
  dayKeys().forEach(dk => { if (!DAYS_DATA[dk].archived) redrawDay(dk); });
  switchDay(newCurrent);
  saveData();
  showToast('🗑️ День удалён');
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
          inputmode="numeric" oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
      ${`
      <div class="edit-field">
        <div class="edit-label">Отпр. план</div>
        <input class="edit-input edit-input-time" id="et-depP-${id}" value="${s.depP}" maxlength="5"
          inputmode="numeric" oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>`}
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
  const depBlkST = document.getElementById('dep-block-' + id);
  if (depBlkST) depBlkST.style.display = (s.depP || s.depA) ? '' : 'none';
  const arrIn = document.getElementById('arr-' + id);
  const depIn = document.getElementById('dep-' + id);
  if (arrIn) arrIn.placeholder = s.arrP || '--:--';
  if (depIn) depIn.placeholder = s.depP || '--:--';

  cancelStopEdit(id);
  updateProgress();
  saveData();
  // Cascade: пересчитать все точки ниже через OSRM
  if (typeof cascadeAutoFillFrom === 'function') cascadeAutoFillFrom(day, id);
  autoFillTimes(day); // всегда: заполнить arrP самой точки если она последняя/единственная
  showToast('✅ Время обновлено');
  // Re-fetch weather for this stop with updated plan time
  fetchStopWeather(day, id);
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
  inp.inputMode   = 'numeric';
  inp.placeholder = '--:--';
  el.replaceWith(inp);
  inp.focus(); inp.select();

  let _committed = false;
  const commit = () => {
    if (_committed) return;
    _committed = true;

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

    // Save only if changed
    _markBlurCommit();
    if (val === current) { return; }
    DAYS_DATA[day].departP = val;

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

    saveData();
    // Re-fetch weather after all times are finalized (delayed to not interfere with DOM)
    setTimeout(function() { fetchDayWeather(day); }, 300);
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
// Экранирование для HTML-атрибутов value="..." в шаблонах
function _escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;'); }
let _editStopSearchTimer = null;
let _editDragGeoTimer = null;

// Обратное геокодирование после перетаскивания маркера (Nominatim, 1 req/dragend с debounce 800ms)
async function _reverseGeoForEditMarker(id, lat, lng) {
  try {
    var url = 'https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json&accept-language=ru';
    var r = await fetch(url, { headers: { 'Accept-Language': 'ru' } });
    var data = await r.json();
    if (!data || data.error) return;
    var name = data.name || (data.address && (data.address.road || data.address.village || data.address.town || data.address.city)) || '';
    if (!name) return;
    var nameEl = document.getElementById('ei-name-' + id);
    if (nameEl) nameEl.value = name;
    var searchEl = document.getElementById('ei-search-' + id);
    if (searchEl) searchEl.value = data.display_name ? data.display_name.split(',').slice(0,2).join(',') : name;
  } catch(e) { /* нет сети — тихо */ }
}

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

  // Hide ··· menu while editing
  var dotsBtn = document.getElementById('dots-' + id);
  if (dotsBtn) dotsBtn.style.display = 'none';

  // Disable drag while editing so text selection works normally
  const card = document.getElementById('card-' + id);
  if (card) card.draggable = false;

  form.innerHTML = `
    <div class="edit-field" style="margin-bottom:6px;width:100%">
      <div class="edit-label">Поиск нового места</div>
      <div class="search-wrap" style="width:100%;position:relative;">
        <input class="edit-input" style="width:100%;padding-right:28px;" id="ei-search-${id}"
          type="text" autocomplete="nope" placeholder="Название, адрес…"
          oninput="editStopSearch(this.value, '${id}')" autocomplete="nope">
        <span style="position:absolute;right:7px;top:50%;transform:translateY(-50%);font-size:15px;cursor:pointer;line-height:1;"
          onclick="enterMapPickModeForEdit('${id}', ${day})" title="Выбрать на карте">📍</span>
        <div class="search-results" id="ei-results-${id}"></div>
      </div>
    </div>
    <button class="geo-loc-btn" onclick="useCurrentLocationForEdit('${id}')" onmousedown="event.preventDefault()">
      <span class="geo-loc-dot"></span>Моё местоположение
    </button>
    <div id="ei-coords-${id}-display" style="display:${s.lat ? 'flex' : 'none'};align-items:center;justify-content:space-between;padding:4px 8px;background:var(--bg);border-radius:5px;border:1px solid var(--border);margin-bottom:8px;font-size:11px;">
      <span style="color:var(--muted);">📍 <span id="ei-coords-${id}-text">${s.lat ? s.lat.toFixed(5) + ', ' + s.lng.toFixed(5) : ''}</span></span>
      <span style="color:var(--muted);font-size:10px;">💡 Или перетащите маркер</span>
    </div>
    <div style="display:grid;grid-template-columns:48px 1fr;gap:8px;margin-bottom:8px;">
      <div class="edit-field">
        <div class="edit-label">Иконка</div>
        <input class="edit-input" style="width:100%;text-align:center;font-size:16px;padding:0 4px;cursor:pointer" id="ei-icon-${id}" value="${_escHtml(s.icon)}" maxlength="4" readonly onclick="openIconPicker('ei-icon-${id}','ei-type-${id}')">
      </div>
      <div class="edit-field">
        <div class="edit-label">Название</div>
        <input class="edit-input" style="width:100%" id="ei-name-${id}" value="${_escHtml(s.name)}" autocomplete="nope">
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
      <div class="edit-field" style="min-width:0">
        <div class="edit-label">Тип</div>
        <div id="ei-type-container-${id}">${_buildTypeDropdownHTML('ei-type-' + id, s.type)}</div>
      </div>
      <div class="edit-field" style="min-width:0">
        <div class="edit-label">Приб. план</div>
        <input class="edit-input" style="width:100%" id="ei-arrP-${id}" value="${s.arrP}" maxlength="5" autocomplete="nope"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
      <div class="edit-field" style="min-width:0">
        <div class="edit-label">Отпр. план</div>
        <input class="edit-input" style="width:100%" id="ei-depP-${id}" value="${s.depP}" maxlength="5" autocomplete="nope"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
    </div>
    <div class="edit-row">
      <div class="edit-field edit-field-grow">
        <div class="edit-label">Широта (lat)</div>
        <input class="edit-input edit-input-coord" id="ei-lat-${id}" type="text" inputmode="decimal"
          value="${s.lat ? s.lat.toFixed(6) : ''}" placeholder="55.7965"
          oninput="splitCoordsInput(this,'ei-lng-${id}','ei-coords-${id}');onManualCoordInput('ei-lat-${id}','ei-lng-${id}','ei-coords-${id}','${id}')">
      </div>
      <div class="edit-field edit-field-grow">
        <div class="edit-label">Долгота (lng)</div>
        <input class="edit-input edit-input-coord" id="ei-lng-${id}" type="text" inputmode="decimal"
          value="${s.lng ? s.lng.toFixed(6) : ''}" placeholder="37.9475"
          oninput="onManualCoordInput('ei-lat-${id}','ei-lng-${id}','ei-coords-${id}','${id}')">
      </div>
    </div>
    <div class="edit-actions-row">
      <button class="edit-cancel-btn" onclick="cancelStopEdit('${id}')">✕ Отмена</button>
      <button class="edit-save-btn" onclick="saveStopEdit('${id}', ${day})">✓ Сохранить</button>
    </div>`;

  setTimeout(() => document.getElementById('ei-search-' + id)?.focus(), 50);

  // Ставим draggable маркер на карте для визуального перемещения точки
  if (typeof setEditDragMarker === 'function') {
    setEditDragMarker(id, s.lat, s.lng, s.icon, DAYS_DATA[day].color, function(lat, lng) {
      _editStopCoords[id] = { lat: lat, lng: lng };
      // Обновляем отображение координат в форме
      var coordDisp = document.getElementById('ei-coords-' + id + '-display');
      var coordText = document.getElementById('ei-coords-' + id + '-text');
      var latInp    = document.getElementById('ei-lat-' + id);
      var lngInp    = document.getElementById('ei-lng-' + id);
      if (coordText) coordText.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
      if (coordDisp) coordDisp.style.display = 'flex';
      if (latInp)    latInp.value  = lat.toFixed(6);
      if (lngInp)    lngInp.value  = lng.toFixed(6);
      clearTimeout(_editDragGeoTimer);
      _editDragGeoTimer = setTimeout(function() {
        _reverseGeoForEditMarker(id, lat, lng);
      }, 800);
    });
  }
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
          document.getElementById('ei-coords-' + id + '-display').style.display = 'flex';
          res.classList.remove('show');
        };
        res.appendChild(el);
      });
    } catch(err) { res.innerHTML = '<div class="search-spinner">Ошибка поиска</div>'; }
  }, 500);
}

function cancelStopEdit(id) {
  if (typeof removeEditDragMarker === 'function') removeEditDragMarker();
  clearTimeout(_editDragGeoTimer);
  const main = document.getElementById('stop-main-' + id);
  const tg   = document.getElementById('stop-timegrid-' + id);
  const form = document.getElementById('edit-form-' + id);
  if (main) main.style.display = '';
  if (tg)   tg.style.display   = '';
  if (form) form.style.display  = 'none';
  var dotsBtn = document.getElementById('dots-' + id);
  if (dotsBtn) dotsBtn.style.display = '';
  // Re-enable drag
  const card = document.getElementById('card-' + id);
  if (card) card.draggable = true;
}

// ── INLINE ADD STOP ───────────────────────────────────────────────────────────
var _inlineAddCoords = {};
var _inlineAddSearchTimer = null;

function openInlineAddStop(afterId, day) {
  _inlineAddOpen = true;
  // Close any other open add/edit forms first
  document.querySelectorAll('[id^="add-form-"]').forEach(function(f) {
    if (f.id !== 'add-form-' + afterId) { f.style.display = 'none'; f.innerHTML = ''; }
  });

  var s     = DAYS_DATA[day].stops.find(function(x) { return x.id === afterId; });
  var idx   = DAYS_DATA[day].stops.findIndex(function(x) { return x.id === afterId; });
  var isFirst = idx === 0;
  var newNum  = idx + 2; // будет вставлена после текущей → номер idx+2

  _inlineAddCoords[afterId] = null;

  var form = document.getElementById('add-form-' + afterId);
  var dotsBtn = document.getElementById('dots-' + afterId);
  if (!form) return;
  if (dotsBtn) dotsBtn.style.display = 'none';

  var saveLabel = isFirst
    ? '✓ Сохранить'
    : '✓ Сохранить → точка ' + newNum;

  form.style.display = 'block';
  form.innerHTML = `
    <div class="edit-field" style="margin-bottom:8px;width:100%">
      <div class="edit-label">Поиск нового места</div>
      <div class="search-wrap" style="width:100%;position:relative;">
        <input class="edit-input" style="width:100%;padding-right:28px;" id="ia-search-${afterId}"
          type="text" autocomplete="nope" placeholder="Название, адрес…"
          oninput="inlineAddSearch(this.value, '${afterId}')" autocomplete="nope">
        <span style="position:absolute;right:7px;top:50%;transform:translateY(-50%);font-size:15px;cursor:pointer;line-height:1;"
          onclick="enterMapPickMode('${afterId}', ${day})" title="Выбрать на карте">📍</span>
        <div class="search-results" id="ia-results-${afterId}"></div>
      </div>
    </div>
    <button class="geo-loc-btn" onclick="useCurrentLocationForAdd('${afterId}')" onmousedown="event.preventDefault()">
      <span class="geo-loc-dot"></span>Моё местоположение
    </button>
    <div id="ia-coords-${afterId}-display" style="font-size:10px;color:var(--green);margin-bottom:6px;display:none;">
      📍 <span id="ia-coords-${afterId}-text"></span>
    </div>
    <div style="display:grid;grid-template-columns:48px 1fr;gap:8px;margin-bottom:8px;">
      <div class="edit-field">
        <div class="edit-label">Иконка</div>
        <input class="edit-input" style="width:100%;text-align:center;font-size:16px;padding:0 4px;cursor:pointer" id="ia-icon-${afterId}" value="📍" maxlength="4" readonly onclick="openIconPicker('ia-icon-${afterId}','ia-type-${afterId}')">
      </div>
      <div class="edit-field">
        <div class="edit-label">Название</div>
        <input class="edit-input" style="width:100%" id="ia-name-${afterId}" placeholder="Название точки" autocomplete="nope">
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
      <div class="edit-field" style="min-width:0">
        <div class="edit-label">Тип</div>
        <div id="ia-type-container-${afterId}">${_buildTypeDropdownHTML('ia-type-' + afterId, 'Другое')}</div>
      </div>
      <div class="edit-field" style="min-width:0">
        <div class="edit-label">Приб. план</div>
        <input class="edit-input" style="width:100%" id="ia-arrP-${afterId}" maxlength="5" autocomplete="nope"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
      <div class="edit-field" style="min-width:0">
        <div class="edit-label">Отпр. план</div>
        <input class="edit-input" style="width:100%" id="ia-depP-${afterId}" maxlength="5"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
    </div>
    <div class="edit-row">
      <div class="edit-field edit-field-grow">
        <div class="edit-label">Широта (lat)</div>
        <input class="edit-input edit-input-coord" id="ia-lat-${afterId}" type="text" inputmode="decimal"
          placeholder="55.7965"
          oninput="splitCoordsInput(this,'ia-lng-${afterId}','ia-coords-${afterId}');_inlineAddManualCoord('${afterId}')">
      </div>
      <div class="edit-field edit-field-grow">
        <div class="edit-label">Долгота (lng)</div>
        <input class="edit-input edit-input-coord" id="ia-lng-${afterId}" type="text" inputmode="decimal"
          placeholder="37.9475"
          oninput="_inlineAddManualCoord('${afterId}')">
      </div>
    </div>
    <div style="font-size:9px;color:var(--green);margin:4px 0 8px;">⚡ Пустые времена — OSRM заполнит автоматически</div>
    <div class="edit-actions-row">
      <button class="edit-cancel-btn" onclick="cancelInlineAddStop('${afterId}')">✕ Отмена</button>
      <button class="edit-save-btn" onclick="doInlineAddStop('${afterId}', ${day}, ${isFirst})">${saveLabel}</button>
    </div>`;

  setTimeout(function() { document.getElementById('ia-search-' + afterId)?.focus(); }, 50);
}

function _inlineAddManualCoord(afterId) {
  var lat = parseFloat(document.getElementById('ia-lat-' + afterId)?.value);
  var lng = parseFloat(document.getElementById('ia-lng-' + afterId)?.value);
  if (!isNaN(lat) && !isNaN(lng)) {
    _inlineAddCoords[afterId] = { lat: lat, lng: lng };
    var disp = document.getElementById('ia-coords-' + afterId + '-display');
    var txt  = document.getElementById('ia-coords-' + afterId + '-text');
    if (disp) disp.style.display = 'block';
    if (txt)  txt.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
  }
}

function inlineAddSearch(q, afterId) {
  clearTimeout(_inlineAddSearchTimer);
  var res = document.getElementById('ia-results-' + afterId);
  if (!res) return;
  if (!q || q.length < 3) { res.classList.remove('show'); return; }
  res.classList.add('show');
  res.innerHTML = '<div class="search-spinner">Поиск…</div>';
  _inlineAddSearchTimer = setTimeout(async function() {
    try {
      var url  = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=5&accept-language=ru';
      var r    = await fetch(url, { headers: { 'Accept-Language': 'ru' } });
      var data = await r.json();
      if (!data.length) { res.innerHTML = '<div class="search-spinner">Ничего не найдено</div>'; return; }
      res.innerHTML = '';
      data.forEach(function(item) {
        var el   = document.createElement('div');
        el.className = 'search-result-item';
        var main = item.name || item.display_name.split(',')[0];
        var sub  = item.display_name.split(',').slice(1, 3).join(',').trim();
        el.innerHTML = '<div>' + main + '</div><div class="result-sub">' + sub + '</div>';
        el.onclick = function() {
          var lat = parseFloat(item.lat), lng = parseFloat(item.lon);
          _inlineAddCoords[afterId] = { lat: lat, lng: lng };
          var nameEl = document.getElementById('ia-name-' + afterId);
          if (nameEl && !nameEl.value) nameEl.value = main;
          document.getElementById('ia-search-' + afterId).value = item.display_name;
          document.getElementById('ia-coords-' + afterId + '-text').textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
          document.getElementById('ia-coords-' + afterId + '-display').style.display = 'block';
          var latInp = document.getElementById('ia-lat-' + afterId);
          var lngInp = document.getElementById('ia-lng-' + afterId);
          if (latInp) latInp.value = lat.toFixed(6);
          if (lngInp) lngInp.value = lng.toFixed(6);
          res.classList.remove('show');
        };
        res.appendChild(el);
      });
    } catch(err) { res.innerHTML = '<div class="search-spinner">Ошибка поиска</div>'; }
  }, 500);
}

function openInlineAddFirstStop(day) {
  _inlineAddOpen = true;
  var container = document.getElementById('d' + day + '-stops');
  if (!container) return;
  var fakeId = '__first__' + day;
  _inlineAddCoords[fakeId] = null;
  container.innerHTML = '<div id="add-form-' + fakeId + '" class="stop-edit-form" style="display:block"></div>';
  var form = document.getElementById('add-form-' + fakeId);
  form.innerHTML = `
    <div class="edit-field" style="margin-bottom:6px;width:100%">
      <div class="edit-label">Поиск нового места</div>
      <div class="search-wrap" style="width:100%;position:relative;">
        <input class="edit-input" style="width:100%;padding-right:28px;" id="ia-search-${fakeId}"
          type="text" placeholder="Название, адрес…"
          oninput="inlineAddSearch(this.value, '${fakeId}')" autocomplete="nope">
        <span style="position:absolute;right:7px;top:50%;transform:translateY(-50%);font-size:15px;cursor:pointer;line-height:1;"
          onclick="enterMapPickMode('${fakeId}', ${day})" title="Выбрать на карте">📍</span>
        <div class="search-results" id="ia-results-${fakeId}"></div>
      </div>
    </div>
    <button class="geo-loc-btn" onclick="useCurrentLocationForAdd('${fakeId}')" onmousedown="event.preventDefault()">
      <span class="geo-loc-dot"></span>Моё местоположение
    </button>
    <div id="ia-coords-${fakeId}-display" style="display:none;align-items:center;justify-content:space-between;padding:4px 8px;background:var(--bg);border-radius:5px;border:1px solid var(--border);margin-bottom:8px;font-size:11px;">
      <span style="color:var(--muted);">📍 <span id="ia-coords-${fakeId}-text"></span></span>
      <span style="color:var(--muted);font-size:10px;">💡 Или перетащите маркер</span>
    </div>
    <div style="display:grid;grid-template-columns:48px 1fr;gap:8px;margin-bottom:8px;">
      <div class="edit-field">
        <div class="edit-label">Иконка</div>
        <input class="edit-input" style="width:100%;text-align:center;font-size:16px;padding:0 4px;cursor:pointer" id="ia-icon-${fakeId}" value="📍" maxlength="4" readonly onclick="openIconPicker('ia-icon-${fakeId}','ia-type-${fakeId}')">
      </div>
      <div class="edit-field">
        <div class="edit-label">Название</div>
        <input class="edit-input" style="width:100%" id="ia-name-${fakeId}" placeholder="Название точки" autocomplete="nope">
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
      <div class="edit-field" style="min-width:0">
        <div class="edit-label">Тип</div>
        <div id="ia-type-container-${fakeId}">${_buildTypeDropdownHTML('ia-type-' + fakeId, 'Другое')}</div>
      </div>
      <div class="edit-field" style="min-width:0">
        <div class="edit-label">Приб. план</div>
        <input class="edit-input" style="width:100%" id="ia-arrP-${fakeId}" maxlength="5"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
      <div class="edit-field" style="min-width:0">
        <div class="edit-label">Отпр. план</div>
        <input class="edit-input" style="width:100%" id="ia-depP-${fakeId}" maxlength="5"
          oninput="applyMask(this)" onblur="padTime(this)" placeholder="--:--">
      </div>
    </div>
    <div class="edit-row">
      <div class="edit-field edit-field-grow">
        <div class="edit-label">Широта (lat)</div>
        <input class="edit-input edit-input-coord" id="ia-lat-${fakeId}" type="text" inputmode="decimal"
          placeholder="55.7965"
          oninput="splitCoordsInput(this,'ia-lng-${fakeId}','ia-coords-${fakeId}');_inlineAddManualCoord('${fakeId}')">
      </div>
      <div class="edit-field edit-field-grow">
        <div class="edit-label">Долгота (lng)</div>
        <input class="edit-input edit-input-coord" id="ia-lng-${fakeId}" type="text" inputmode="decimal"
          placeholder="37.9475"
          oninput="_inlineAddManualCoord('${fakeId}')">
      </div>
    </div>
    <div style="font-size:9px;color:var(--green);margin:4px 0 8px;">⚡ Пустые времена — OSRM заполнит автоматически</div>
    <div class="edit-actions-row">
      <button class="edit-cancel-btn" onclick="renderStops(${day})">✕ Отмена</button>
      <button class="edit-save-btn" onclick="doInlineAddFirstStop('${fakeId}', ${day})">✓ Сохранить</button>
    </div>`;
  setTimeout(function() { document.getElementById('ia-search-' + fakeId)?.focus(); }, 50);
}

function doInlineAddFirstStop(fakeId, day) {
  _inlineAddOpen = false;
  var name = document.getElementById('ia-name-' + fakeId)?.value.trim();
  if (!name) { document.getElementById('ia-name-' + fakeId)?.focus(); return; }
  var coords = _inlineAddCoords[fakeId];
  if (!coords) {
    var manLat = parseFloat(document.getElementById('ia-lat-' + fakeId)?.value);
    var manLng = parseFloat(document.getElementById('ia-lng-' + fakeId)?.value);
    if (isNaN(manLat) || isNaN(manLng)) { showToast('⚠️ Укажите координаты'); return; }
    coords = { lat: manLat, lng: manLng };
  }
  var icon = document.getElementById('ia-icon-' + fakeId)?.value.trim() || '📍';
  var type = document.getElementById('ia-type-' + fakeId)?.value || 'Другое';
  var arrP = document.getElementById('ia-arrP-' + fakeId)?.value.trim() || '';
  var depP = document.getElementById('ia-depP-' + fakeId)?.value.trim() || '';
  var id   = 'd' + day + 's' + Date.now();
  var stop = { id: id, num: 1, icon: icon, type: type, name: name,
               lat: coords.lat, lng: coords.lng,
               arrP: arrP, depP: depP, arrA: '', depA: '', notes: [] };
  snapshotForUndo('Добавлена первая точка');
  DAYS_DATA[day].stops.splice(0, 0, stop);
  delete _inlineAddCoords[fakeId];
  renderStops(day);
  redrawDay(day);
  updateDayRoute(day);
  updateProgress();
  saveData();
  showToast('✅ Точка добавлена');
  autoFillTimes(day);
  setTimeout(function() { fetchStopWeather(day, id); }, 500);
}

function cancelInlineAddStop(afterId) {
  _inlineAddOpen = false;
  var form    = document.getElementById('add-form-' + afterId);
  var dotsBtn = document.getElementById('dots-' + afterId);
  if (form)    { form.style.display = 'none'; form.innerHTML = ''; }
  if (dotsBtn) dotsBtn.style.display = '';
  delete _inlineAddCoords[afterId];
  exitMapPickMode();
}

function doInlineAddStop(afterId, day, isFirst) {
  _inlineAddOpen = false;
  var name = document.getElementById('ia-name-' + afterId)?.value.trim();
  if (!name) { document.getElementById('ia-name-' + afterId)?.focus(); return; }

  var coords = _inlineAddCoords[afterId];
  if (!coords) {
    var manLat = parseFloat(document.getElementById('ia-lat-' + afterId)?.value);
    var manLng = parseFloat(document.getElementById('ia-lng-' + afterId)?.value);
    if (isNaN(manLat) || isNaN(manLng)) {
      showToast('⚠️ Укажите координаты');
      return;
    }
    coords = { lat: manLat, lng: manLng };
  }

  var icon  = document.getElementById('ia-icon-' + afterId)?.value.trim() || '📍';
  var type  = document.getElementById('ia-type-' + afterId)?.value || 'Другое';
  var arrP  = document.getElementById('ia-arrP-' + afterId)?.value.trim() || '';
  var depP  = document.getElementById('ia-depP-' + afterId)?.value.trim() || '';
  var stops = DAYS_DATA[day].stops;
  var afterIdx = stops.findIndex(function(x) { return x.id === afterId; });
  var id    = 'd' + day + 's' + Date.now();
  var stop  = { id: id, num: 0, icon: icon, type: type, name: name,
                lat: coords.lat, lng: coords.lng,
                arrP: arrP, depP: depP, arrA: '', depA: '', notes: [] };

  snapshotForUndo('Добавлена точка');

  if (isFirst) {
    // Показываем попап ДО / ПОСЛЕ
    _pendingInlineStop = { stop: stop, afterId: afterId, day: day, afterIdx: afterIdx };
    _showInsertPopup(afterId, day);
    return;
  }

  // Все остальные точки — вставить ПОСЛЕ
  stops.splice(afterIdx + 1, 0, stop);
  _finalizeInlineAdd(afterId, day, id);
}

var _pendingInlineStop = null;

function _showInsertPopup(afterId, day) {
  var existing = document.getElementById('insert-popup-' + afterId);
  if (existing) existing.remove();
  var form = document.getElementById('add-form-' + afterId);
  if (!form) return;
  var popup = document.createElement('div');
  popup.id = 'insert-popup-' + afterId;
  popup.className = 'insert-popup-overlay';
  popup.innerHTML =
    '<div class="insert-popup">' +
      '<div class="insert-popup-title">Куда вставить точку?</div>' +
      '<div class="insert-popup-sub">Это первая точка маршрута</div>' +
      '<div class="insert-popup-btns">' +
        '<button class="insert-btn insert-btn-before" onclick="_doInsert(\'' + afterId + '\', ' + day + ', true)">↑ До неё</button>' +
        '<button class="insert-btn insert-btn-after"  onclick="_doInsert(\'' + afterId + '\', ' + day + ', false)">↓ После неё</button>' +
      '</div>' +
    '</div>';
  form.appendChild(popup);
}

function _doInsert(afterId, day, insertBefore) {
  var p = _pendingInlineStop;
  if (!p) return;
  var stops = DAYS_DATA[day].stops;
  if (insertBefore) {
    stops.splice(p.afterIdx, 0, p.stop);
  } else {
    stops.splice(p.afterIdx + 1, 0, p.stop);
  }
  _pendingInlineStop = null;
  _finalizeInlineAdd(afterId, day, p.stop.id);
}

function _finalizeInlineAdd(afterId, day, newId) {
  cancelInlineAddStop(afterId);
  renderStops(day);
  redrawDay(day);
  updateDayRoute(day);
  updateProgress();
  saveData();
  showToast('✅ Точка добавлена');
  var stops  = DAYS_DATA[day].stops;
  var newIdx = stops.findIndex(function(x) { return x.id === newId; });
  var prevId = newIdx > 0 ? stops[newIdx - 1].id : null;
  // Cascade: сбрасываем arrP только у точек ПОСЛЕ новой.
  // Если newId уже имеет arrP (задан вручную) — каскад начинается от него,
  // чтобы OSRM не перезаписал вручную введённое значение.
  var newStop = stops[newIdx];
  if (newStop && newStop.arrP) {
    cascadeAutoFillFrom(day, newId);
  } else if (prevId && typeof cascadeAutoFillFrom === 'function') {
    cascadeAutoFillFrom(day, prevId);
  } else {
    autoFillTimes(day);
  }
  setTimeout(function() { fetchStopWeather(day, newId); }, 500);
}

// ── MAP PICK MODE ─────────────────────────────────────────────────────────────
var _mapPickAfterIdGlobal = null;
var _mapPickDayGlobal     = null;
var _mapPickIsEdit        = false;
var _mapPickIsEditStart   = false;

function enterMapPickModeForEdit(id, day) {
  _mapPickIsEdit = true;
  enterMapPickMode(id, day);
}

function enterMapPickMode(afterId, day) {
  _mapPickAfterIdGlobal = afterId;
  _mapPickDayGlobal     = day;

  // Hide sidebar content, show banner
  var sidebar = document.getElementById('sidebar');
  var isMobileView = window.innerWidth <= 700;
  if (isMobileView && sidebar) {
    // Убираем фокус чтобы клавиатура опустилась до скрытия сайдбара
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    window._pickModeSidebarWasOpen = sidebar.classList.contains('open');
    sidebar.classList.remove('open');
    var btn = document.getElementById('toggleBtn');
    if (btn) btn.textContent = '☰';
    // Даём клавиатуре закрыться перед invalidateSize
    setTimeout(function() {
      if (typeof map !== 'undefined' && map) map.invalidateSize();
    }, 350);
  } else if (sidebar) {
    sidebar.classList.add('pick-mode-hidden');
  }

  // Move banner inside #map so it overlays only the map
  var mapEl  = document.getElementById('map');
  var banner = document.getElementById('mapPickBanner');
  if (banner && mapEl && banner.parentElement !== mapEl) mapEl.appendChild(banner);
  if (banner) banner.style.display = 'flex';

  // Switch map cursor and register one-shot click
  if (typeof map !== 'undefined' && map) {
    map.getContainer().style.cursor = 'crosshair';
    map.doubleClickZoom.disable();
    map.once('click', _onMapPickClick);
    // Сдвигаем zoom-контрол чтобы не перекрывался баннером
    var zoomCtrl = map.getContainer().querySelector('.leaflet-top.leaflet-right');
    if (zoomCtrl) zoomCtrl.style.marginTop = '40px';
  }
}

function exitMapPickMode() {
  _mapPickAfterIdGlobal = null;
  _mapPickDayGlobal     = null;
  _mapPickIsEditStart   = false;

  var sidebar = document.getElementById('sidebar');
  var isMobileView = window.innerWidth <= 700;
  if (isMobileView && sidebar) {
    if (window._pickModeSidebarWasOpen !== false) {
      sidebar.classList.add('open');
      var btn = document.getElementById('toggleBtn');
      if (btn) btn.textContent = '✕';
    }
    if (typeof map !== 'undefined' && map) map.invalidateSize();
  } else if (sidebar) {
    sidebar.classList.remove('pick-mode-hidden');
  }
  window._pickModeSidebarWasOpen = undefined;

  var banner = document.getElementById('mapPickBanner');
  if (banner) banner.style.display = 'none';

  if (typeof map !== 'undefined' && map) {
    map.getContainer().style.cursor = '';
    map.doubleClickZoom.enable();
    map.off('click', _onMapPickClick);
    var zoomCtrl = map.getContainer().querySelector('.leaflet-top.leaflet-right');
    if (zoomCtrl) zoomCtrl.style.marginTop = '';
  }
}

// Escape на десктопе выходит из режима выбора
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && _mapPickAfterIdGlobal) {
    exitMapPickMode();
  }
});

function _onMapPickClick(e) {
  L.DomEvent.stopPropagation(e);
  var id          = _mapPickAfterIdGlobal;
  var isEdit      = _mapPickIsEdit;
  var isEditStart = _mapPickIsEditStart;
  _mapPickIsEdit      = false;
  _mapPickIsEditStart = false;
  exitMapPickMode();
  if (!id) return;

  var lat = e.latlng.lat, lng = e.latlng.lng;

  if (isEditStart) {
    editStartLat = lat; editStartLng = lng;
    document.getElementById('edit-start-lat').value  = lat.toFixed(6);
    document.getElementById('edit-start-lng').value  = lng.toFixed(6);
    document.getElementById('edit-start-coords-text').textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
    document.getElementById('edit-start-coords-display').style.display = 'flex';
    document.getElementById('editStartModal').classList.add('show');
    clearTimeout(_editDragGeoTimer);
    _editDragGeoTimer = setTimeout(function() {
      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json&accept-language=ru')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data || data.error) return;
          var name = data.name || (data.address && (data.address.road || data.address.village || data.address.town || data.address.city)) || '';
          var nameEl = document.getElementById('edit-start-name');
          if (nameEl && !nameEl.value && name) nameEl.value = name;
          var searchEl = document.getElementById('edit-start-search');
          if (searchEl) searchEl.value = data.display_name ? data.display_name.split(',').slice(0,2).join(',') : name;
        }).catch(function() {});
    }, 800);
    return;
  }

  if (isEdit) {
    // Режим редактирования точки
    _editStopCoords[id] = { lat: lat, lng: lng };
    var coordDisp = document.getElementById('ei-coords-' + id + '-display');
    var coordText = document.getElementById('ei-coords-' + id + '-text');
    var latInp    = document.getElementById('ei-lat-' + id);
    var lngInp    = document.getElementById('ei-lng-' + id);
    if (coordText) coordText.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
    if (coordDisp) coordDisp.style.display = 'flex';
    if (latInp)    latInp.value  = lat.toFixed(6);
    if (lngInp)    lngInp.value  = lng.toFixed(6);
    clearTimeout(_editDragGeoTimer);
    _editDragGeoTimer = setTimeout(function() { _reverseGeoForEditMarker(id, lat, lng); }, 800);
  } else {
    // Режим добавления точки
    _inlineAddCoords[id] = { lat: lat, lng: lng };
    var coordDisp = document.getElementById('ia-coords-' + id + '-display');
    var coordText = document.getElementById('ia-coords-' + id + '-text');
    var latInp    = document.getElementById('ia-lat-' + id);
    var lngInp    = document.getElementById('ia-lng-' + id);
    if (coordText) coordText.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
    if (coordDisp) coordDisp.style.display = 'block';
    if (latInp)    latInp.value  = lat.toFixed(6);
    if (lngInp)    lngInp.value  = lng.toFixed(6);
    clearTimeout(_editDragGeoTimer);
    _editDragGeoTimer = setTimeout(function() {
      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json&accept-language=ru')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data || data.error) return;
          var name = data.name || (data.address && (data.address.road || data.address.village || data.address.town || data.address.city)) || '';
          var nameEl = document.getElementById('ia-name-' + id);
          if (nameEl && !nameEl.value && name) nameEl.value = name;
          var searchEl = document.getElementById('ia-search-' + id);
          if (searchEl) searchEl.value = data.display_name ? data.display_name.split(',').slice(0, 2).join(',') : name;
        }).catch(function() {});
    }, 800);
  }
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
  const depBlkEl = document.getElementById('dep-block-' + id);
  if (depBlkEl) depBlkEl.style.display = (s.depP || s.depA) ? '' : 'none';

  // Also update actual input placeholders
  const arrIn = document.getElementById('arr-' + id);
  const depIn = document.getElementById('dep-' + id);
  if (arrIn) arrIn.placeholder = s.arrP || '--:--';
  if (depIn) depIn.placeholder = s.depP || '--:--';

  cancelStopEdit(id);
  redrawDay(day);
  updateProgress();
  saveData();
  if (typeof cascadeAutoFillFrom === 'function') cascadeAutoFillFrom(day, id);
  autoFillTimes(day); // всегда: заполнить arrP самой точки если она последняя/единственная
  showToast('✅ Точка обновлена');
  // Re-fetch weather if time or coords changed
  fetchStopWeather(day, id);
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
  document.getElementById('share-day-title').textContent =
    `День ${day} · ${data.date} · ${data.start.name}` +
    (points.length > 1 ? ` → ${points[points.length-1].name}` : '');

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

// Fetch weather for a single stop (after adding stop or changing plan time)
async function fetchStopWeather(day, stopId) {
  var data = DAYS_DATA[day];
  if (!data) return;
  var s = data.stops.find(function(x) { return x.id === stopId; });
  if (!s || !s.lat || !s.lng) return;
  var dateISO = data.dateISO || '';
  var time = s.arrP || '12:00';
  try {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + s.lat +
      '&longitude=' + s.lng +
      '&hourly=temperature_2m,weather_code,wind_speed_10m,precipitation,is_day' +
      '&timezone=auto&forecast_days=2';
    var resp = await fetch(url);
    var json = await resp.json();
    if (!json || !json.hourly) return;
    var parts = time.split(':');
    var targetMin = (parseInt(parts[0]) || 12) * 60 + (parseInt(parts[1]) || 0);
    var bestIdx = 0, bestDiff = 99999;
    json.hourly.time.forEach(function(t, j) {
      var h = parseInt(t.substring(11, 13)) || 0;
      var diff = Math.abs(h * 60 - targetMin);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = j; }
    });
    var temp = Math.round(json.hourly.temperature_2m[bestIdx]);
    var code = json.hourly.weather_code[bestIdx] || 0;
    var windKmh = json.hourly.wind_speed_10m[bestIdx] || 0;
    var wind = Math.round(windKmh * 10 / 36);
    var precip = json.hourly.precipitation[bestIdx] || 0;
    var isDay = json.hourly.is_day[bestIdx];
    var emoji = _wmoIcon(code, isDay);
    var timeStr = json.hourly.time[bestIdx].substring(11, 16);
    var tempStr = (temp > 0 ? '+' : '') + temp + '\u00B0';
    var precipStr = precip > 0 ? (precip.toFixed(1) + ' мм') : 'без осадков';
    var desc = _wmoDesc(code);
    var w = { tempStr: tempStr, emoji: emoji, wind: wind,
              precipStr: precipStr, desc: desc, timeStr: timeStr };
    _weatherCache[stopId] = w;
    _renderWeather(stopId);
    var db = _getWeatherDb();
    if (db) {
      db.ref('weather/' + day + '/points/' + stopId).set(w);
    }
  } catch(e) {
    console.error('[weather] single stop', e);
  }
}

// Fetch weather for start point (after changing departP time)
async function fetchStartWeather(day) {
  var data = DAYS_DATA[day];
  if (!data || !data.start || !data.start.lat || !data.start.lng) return;
  var startId = 'd' + day + '-start';
  var time = data.departP || '08:00';
  try {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + data.start.lat +
      '&longitude=' + data.start.lng +
      '&hourly=temperature_2m,weather_code,wind_speed_10m,precipitation,is_day' +
      '&timezone=auto&forecast_days=2';
    var resp = await fetch(url);
    var json = await resp.json();
    if (!json || !json.hourly) return;
    var parts = time.split(':');
    var targetMin = (parseInt(parts[0]) || 8) * 60 + (parseInt(parts[1]) || 0);
    var bestIdx = 0, bestDiff = 99999;
    json.hourly.time.forEach(function(t, j) {
      var h = parseInt(t.substring(11, 13)) || 0;
      var diff = Math.abs(h * 60 - targetMin);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = j; }
    });
    var temp = Math.round(json.hourly.temperature_2m[bestIdx]);
    var code = json.hourly.weather_code[bestIdx] || 0;
    var windKmh = json.hourly.wind_speed_10m[bestIdx] || 0;
    var wind = Math.round(windKmh * 10 / 36);
    var precip = json.hourly.precipitation[bestIdx] || 0;
    var isDay = json.hourly.is_day[bestIdx];
    var emoji = _wmoIcon(code, isDay);
    var timeStr = json.hourly.time[bestIdx].substring(11, 16);
    var tempStr = (temp > 0 ? '+' : '') + temp + '\u00B0';
    var precipStr = precip > 0 ? (precip.toFixed(1) + ' мм') : 'без осадков';
    var desc = _wmoDesc(code);
    var w = { tempStr: tempStr, emoji: emoji, wind: wind,
              precipStr: precipStr, desc: desc, timeStr: timeStr };
    _weatherCache[startId] = w;
    _renderWeather(startId);
    var db = _getWeatherDb();
    if (db) {
      db.ref('weather/' + day + '/points/' + startId).set(w);
    }
  } catch(e) {
    console.error('[weather] start point', e);
  }
}


// ── INIT ──────────────────────────────────────────────────────────────────────
initMap();
// OSRM НЕ включаем здесь — init рисует только placeholder (прямые линии).
// loadState() — единственная точка включения OSRM и авторитетной перерисовки.
// Это исключает гонку: init ставит OSRM в очередь → loadState пересоздаёт слои
// → колбэки init'а ссылаются на уничтоженные полилинии → линии не обновляются.
dayKeys().forEach(d => redrawDay(d));
layers[currentDay].addTo(map);
renderTabs();
renderAllDays();
updateProgress();
loadState().then(() => startPolling());

// Fix 4: scroll active time input into view when mobile/tablet keyboard opens
document.addEventListener('focusin', e => {
  if (!e.target.matches('input.time-in, input#new-stop-arrP, input#new-stop-depP, input.edit-input-time')) return;
  // Detect touch device (covers tablets too) instead of width check
  var isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isTouch) return;
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
// (declaration moved to top — see UI STATE section)

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
// toggleStopNote removed — replaced by addStopNote + notes[] in notes.js

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
var APP_VERSION = '2.8.0';
var APP_BUILD   = 48;
console.log('%c🧭 Дорожный журнал v' + APP_VERSION + ' (build ' + APP_BUILD + ')', 'color:#f5a623;font-weight:bold;font-size:13px;');
var CHANGELOG_MAX_SHOW = 2;

var APP_CHANGELOG = [
  { ver: '2.8.0 b33', date: '13.04.2026', items: [
    '❤️ Реакции читателей на заметки к точкам — пикер эмодзи, хранение в Firebase',
    '🗑️ Удаление заметки к точке теперь требует подтверждения (попап)',
    '📷 Фото заметок к точкам хранятся в Firebase — Gist больше не переполняется',
    '🔧 Исправлен drag-and-drop точек маршрута',
    '🔧 Обновление времён точек при изменении времени старта',
    '🔧 Поллинг не сбрасывает форму добавления/редактирования точки',
    '🔧 Скроллбар в инпуте заметки — в тему оформления'
  ]},
  { ver: '2.8.0 b20', date: '12.04.2026', items: [
    '☁️ Фикс критической ошибки синхронизации: GitHub Gist обрезал JSON >1 МБ',
    '📦 Функция «В архив» — убрать завершённый день, восстановить позже',
    '🔧 Сжатие фото в заметках уменьшено (800px/0.65) чтобы не выходить за лимит Gist'
  ]},
  { ver: '2.8.0 b6', date: '10.04.2026', items: [
    '🔔 Подсказки по маршруту: за 1 км до Заправки, Кафе, Магазина, Другое — тост с прогресс-баром',
    '🚗 Только для автомобильного режима, только когда активна кнопка «Еду»'
  ]},
  { ver: '2.8.0 b5', date: '10.04.2026', items: [
    '📍 Кнопка выбора на карте прямо в поле поиска при редактировании точки',
    '✏️ Форма редактирования: координаты и подсказка объединены в одну строку',
    '🗺️ Map pick mode теперь работает и в форме редактирования, и при добавлении'
  ]},
  { ver: '2.8.0', date: '10.04.2026', items: [
    '🗺️ Перетаскивание точки прямо на карте при редактировании',
    '⏱ OSRM авторасчёт времени после импорта из карт',
    '⛽ Авто-заполнение план.отправления для Заправки (+20м) и Кафе (+1ч)',
    '🔁 Каскадный пересчёт времён всех точек ниже при ручном изменении',
    '➕ Добавление точки из меню ··· с вставкой в нужное место маршрута',
    '🎨 Новая тема «Тайга» — прусский синий с зелёным акцентом'
  ]},
  { ver: '2.7.0', date: '04.04.2026', items: [
    '📝 Несколько заметок к каждой точке маршрута',
    '👁 Переключатель видимости заметки для читателя',
    '🔒 Заметки скрыты от читателя по умолчанию',
    '👁 Скрытие дней маршрута от читателя (··· → Читатель: видит/скрыт)',
    '⚡ Фикс мигания сайдбара у читателя при изменении приватных заметок',
    '🔧 Фикс прямых линий маршрута у читателя/демо при обновлении страницы',
    '🔧 Фикс зависания старой версии после деплоя (staleWhileRevalidate)',
    '🔧 Фикс пустого сайдбара после удаления первого дня'
  ]},
  { ver: '2.6.0', date: '29.03.2026', items: [
    '🗓 Импорт в новый день больше не проставляет дату автоматически — выбирай сам',
    '⚡ Устранено мигание страницы при первом открытии',
    '🚶 Демо: пешеходный день по Ургюпу — кофе, базар, смотровая, скальные грибы, винодельня'
  ]},
  { ver: '2.5.0', date: '27.03.2026', items: [
    '🌤 Погода отображается для каждой точки маршрута согласно времени прибытия',
    '🚶 Пеший режим дня — переключатель авто/пешком в меню ···',
    '🗺 На карте иконка маркера меняется: 🚗 авто или 🚶 пешком',
    '↺ Кнопка «Обновить сейчас» в настройках облака',
    '📍 Версия приложения видна в настройках облака',
    '🚶 GPS-маркер и кнопка «Иду/Еду» учитывают режим дня',
    '↩ Кнопка «Отмена» (Ctrl+Z) — отменяет последнее изменение маршрута',
    '🗺 Умное скачивание карты: зум и плотность тайлов зависят от длины маршрута',
    '📐 Толщина линии маршрута адаптируется к масштабу карты',
    '📦 Офлайн-тайлы кешируются по реальной дороге OSRM, а не по прямой'
  ]},
  { ver: '2.4.0', date: '25.03.2026', items: [
    '↓ Импорт маршрута из Яндекс Карт, Google Maps, 2GIS, OsmAnd',
    'Вставь ссылку — точки и названия добавятся автоматически',
    'Редактирование имён и типов точек перед добавлением',
    'Фикс: время старта пустого дня теперь сохраняется'
  ]},
  { ver: '2.3.0', date: '23.03.2026', items: [
    '🌤 Погода на каждой точке маршрута (Open-Meteo)',
    '☁️ Погода синхронизируется через Firebase — один нажал, все видят',
    '🔑 Авторизация через Google — одно имя на всех устройствах',
    '🗺️ Оптимизация скачивания карты — в 3-5× меньше тайлов',
    '🗑️ Кнопка «Удалить кэш карты» в навигаторе',
    '👁 Читатель: скрыты ненужные кнопки'
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

// Show on load if new version — только для Админа и Демо
setTimeout(function() {
  if (!isAdmin()) return;
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
