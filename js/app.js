// ── UI STATE ──────────────────────────────────────────────────────────────────
let currentDay = 1;

function switchDay(d) {
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
  sb.classList.toggle('open');
  const btn = document.getElementById('toggleBtn');
  if (btn) btn.textContent = sb.classList.contains('open') ? '✕' : '☰';
  setTimeout(() => map && map.invalidateSize(), 340);
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

function openAddStop(day) {
  addStopDay = day;
  newStopLat = newStopLng = null;
  ['nominatim-input','new-stop-name','new-stop-arrP','new-stop-depP','new-stop-lat','new-stop-lng']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('new-stop-type').value = 'Другое';
  document.getElementById('new-stop-icon').value = TYPE_ICONS['Другое'];
  document.getElementById('nominatim-results').classList.remove('show');
  document.getElementById('new-stop-coords-display').style.display = 'none';
  document.getElementById('addStopModal').classList.add('show');
  setTimeout(() => document.getElementById('nominatim-input').focus(), 100);
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

function prefillStopIcon(type) {
  const iconEl    = document.getElementById('new-stop-icon');
  const knownIcons = Object.values(TYPE_ICONS);
  if (!iconEl.value || knownIcons.includes(iconEl.value))
    iconEl.value = TYPE_ICONS[type] || '📍';
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
function editDate(day, wrapEl) {
  const current = DAYS_DATA[day].date;
  const inp     = document.createElement('input');
  inp.className = 'day-date-input';
  inp.value     = current;
  inp.style.color           = DAYS_DATA[day].color;
  inp.style.borderBottomColor = DAYS_DATA[day].color;
  wrapEl.replaceWith(inp);
  inp.focus(); inp.select();
  const commit = () => {
    const val    = inp.value.trim() || current;
    DAYS_DATA[day].date = val;
    const newWrap = document.createElement('span');
    newWrap.className = 'day-date-wrap';
    newWrap.title    = 'Нажмите для изменения даты';
    newWrap.onclick  = () => editDate(day, newWrap);
    newWrap.innerHTML = `<span class="day-date-text">${val}</span><span class="day-date-edit-icon">✎</span>`;
    inp.replaceWith(newWrap);
    renderTabs();
    saveData();
  };
  inp.onblur   = commit;
  inp.onkeydown = e => {
    if (e.key === 'Enter')  inp.blur();
    if (e.key === 'Escape') { inp.value = current; inp.blur(); }
  };
}

// ── ADD / DELETE DAY ──────────────────────────────────────────────────────────
function addNewDay() {
  const keys     = dayKeys();
  const newD     = Math.max(...keys) + 1;
  const colorIdx = keys.length % DAY_COLORS.length;
  DAYS_DATA[newD] = {
    color: DAY_COLORS[colorIdx],
    date: 'Дата',
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
  document.getElementById('deleteDayModalBody').textContent =
    `День ${d} · ${DAYS_DATA[d].date} и все его точки будут удалены.`;
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

// ── INIT ──────────────────────────────────────────────────────────────────────
initMap();
dayKeys().forEach(d => redrawDay(d));
layers[currentDay].addTo(map);
renderTabs();
renderAllDays();
updateProgress();
loadState().then(() => startPolling(30000));

setTimeout(() => {
  const d = DAYS_DATA[1];
  if (d) {
    const coords = [[d.start.lat, d.start.lng], ...d.stops.map(s => [s.lat, s.lng])];
    if (coords.length) map.fitBounds(L.latLngBounds(coords), { padding:[40,40] });
  }
  refreshSegments();
}, 150);

// Показать настройки при первом открытии только если не задан ни токен, ни gist ID
// (если gist пришёл из URL — зритель, модал не нужен)
if (!localStorage.getItem('travel_gist_token') && !localStorage.getItem('travel_gist_id')) {
  setTimeout(openCloudSettings, 600);
}
