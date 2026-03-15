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
    .forEach(id => {
      const el = document.getElementById(id);
      el.value = '';
      if (el.classList.contains('modal-input')) el.classList.remove('empty');
    });
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

    // Calculate delta and cascade
    const oldMins = timeToMins(current);
    const newMins = timeToMins(val);
    if (oldMins !== null && newMins !== null && oldMins !== newMins) {
      const delta = newMins - oldMins;
      snapshotForUndo('Пересчёт времён · День ' + day);
      DAYS_DATA[day].departP = val;
      DAYS_DATA[day].stops.forEach(s => {
        if (s.arrP) { s.arrP = shiftTime(s.arrP, delta); }
        if (s.depP) { s.depP = shiftTime(s.depP, delta); }
      });
      renderStops(day);
      redrawDay(day);
      updateProgress();
      saveData();
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
function editStop(id, day) {
  const s    = DAYS_DATA[day].stops.find(x => x.id === id);
  if (!s) return;
  const main = document.getElementById('stop-main-' + id);
  const tg   = document.getElementById('stop-timegrid-' + id);
  const form = document.getElementById('edit-form-' + id);
  if (!main || !tg || !form) return;

  main.style.display = 'none';
  tg.style.display   = 'none';
  form.style.display = 'block';

  const typeOptions = ['Заправка', 'Кафе', 'Отель', 'Жильё', 'Другое']
    .map(t => `<option value="${t}" ${t === s.type ? 'selected' : ''}>${TYPE_ICONS[t] || '📍'} ${t}</option>`)
    .join('');

  form.innerHTML = `
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
    <div class="edit-actions-row">
      <button class="edit-cancel-btn" onclick="cancelStopEdit('${id}')">✕ Отмена</button>
      <button class="edit-save-btn" onclick="saveStopEdit('${id}', ${day})">✓ Сохранить</button>
    </div>`;

  // Auto-focus name
  setTimeout(() => document.getElementById('ei-name-' + id)?.focus(), 50);
}

function cancelStopEdit(id) {
  const main = document.getElementById('stop-main-' + id);
  const tg   = document.getElementById('stop-timegrid-' + id);
  const form = document.getElementById('edit-form-' + id);
  if (main) main.style.display = '';
  if (tg)   tg.style.display   = '';
  if (form) form.style.display  = 'none';
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

  // 2GIS — only supports single destination, so we link to first stop
  const twoGisUrl = `https://2gis.ru/routeSearch/rsType/car/to/${points[points.length-1].lng},${points[points.length-1].lat}`;

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
  document.getElementById('share-2gis-link').href = twoGisUrl;

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
  const d = DAYS_DATA[1];
  if (d) {
    const coords = [[d.start.lat, d.start.lng], ...d.stops.map(s => [s.lat, s.lng])];
    if (coords.length) map.fitBounds(L.latLngBounds(coords), { padding:[40,40] });
  }
  refreshSegments();
}, 150);

// Показать настройки при первом открытии только если не задан ни токен, ни gist ID
// (если gist пришёл из URL — зритель, модал не нужен)
// Автооткрытие модала убрано — владелец настраивает через кнопку ⚙
