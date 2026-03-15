// ── TIME UTILS ────────────────────────────────────────────────────────────────
function timeDelta(planned, actual) {
  if (!planned || !actual || planned.length < 4 || actual.length < 4) return null;
  const [ph, pm] = planned.split(':').map(Number);
  const [ah, am] = actual.split(':').map(Number);
  if (isNaN(ph) || isNaN(pm) || isNaN(ah) || isNaN(am)) return null;
  return (ah * 60 + am) - (ph * 60 + pm);
}

function fmtDelta(d) {
  if (d === null) return null;
  const abs  = Math.abs(d);
  const sign = d >= 0 ? '+' : '−';
  const h    = Math.floor(abs / 60), m = abs % 60;
  return h > 0 ? `${sign}${h}ч ${m}м` : `${sign}${m}м`;
}

// ── TIME MASK ─────────────────────────────────────────────────────────────────
function applyMask(el) {
  const oldVal = el.value;
  // Firefox can return null for selectionStart — fall back to end of string
  const pos    = (el.selectionStart != null) ? el.selectionStart : oldVal.length;
  const digitsBeforeCursor = oldVal.slice(0, pos).replace(/[^0-9]/g, '').length;
  let digits    = oldVal.replace(/[^0-9]/g, '').slice(0, 4);
  let formatted = digits.length >= 3 ? digits.slice(0, 2) + ':' + digits.slice(2) : digits;
  el.value = formatted;
  el.classList.toggle('empty', !formatted);
  let digitCount = 0, newPos = formatted.length;
  if (digitsBeforeCursor > 0) {
    for (let i = 0; i < formatted.length; i++) {
      if (/[0-9]/.test(formatted[i])) digitCount++;
      if (digitCount === digitsBeforeCursor) { newPos = i + 1; break; }
    }
  }
  // Synchronous call works in both Chrome and Firefox
  try { el.setSelectionRange(newPos, newPos); } catch(e) {}
  if (formatted.length === 5) updateProgress();
}

function padTime(el) {
  const val = el.value.trim();
  if (!val) { saveData(); return; }
  const digits = val.replace(/[^0-9]/g, '');
  let padded = val;
  if (digits.length === 3) padded = '0' + digits[0] + ':' + digits.slice(1);
  if (/^\d:\d\d$/.test(val)) padded = '0' + val;
  el.value = padded;
  el.classList.toggle('empty', !padded);
  saveData();
}

// ── PROGRESS + DELTAS ─────────────────────────────────────────────────────────
function updateProgress() {
  dayKeys().forEach(day => {
    const stops = DAYS_DATA[day].stops;
    let filled = 0, lastDelta = null;
    stops.forEach(s => {
      if (s.arrA && s.arrA.length >= 4) filled++;
      const dArr = timeDelta(s.arrP, s.arrA);
      if (dArr !== null) lastDelta = dArr;
      const dDep = timeDelta(s.depP, s.depA);
      if (dDep !== null) lastDelta = dDep;
    });
    const pct   = Math.round((filled / (stops.length || 1)) * 100);
    const fill  = document.getElementById('d' + day + '-fill');
    const pctEl = document.getElementById('d' + day + '-pct');
    if (fill)  fill.style.width  = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';

    const dEl = document.getElementById('d' + day + '-delta-val');
    if (dEl) {
      if (lastDelta === null) {
        dEl.textContent = '—';
        dEl.style.color = '';
      } else {
        dEl.textContent = lastDelta === 0 ? '±0м' : fmtDelta(lastDelta);
        dEl.style.color = lastDelta > 0 ? 'var(--red)' : lastDelta < 0 ? 'var(--green)' : 'var(--muted)';
      }
    }

    stops.forEach(s => {
      const aEl  = document.getElementById('arr-' + s.id);
      const dEl2 = document.getElementById('delta-arr-' + s.id);
      if (aEl) {
        const val   = aEl.value;
        const delta = timeDelta(s.arrP, val);
        aEl.classList.remove('empty', 'ontime', 'late');
        if (!val) aEl.classList.add('empty');
        else if (delta !== null) aEl.classList.add(delta <= 0 ? 'ontime' : 'late');
        if (dEl2) {
          if (delta !== null) {
            dEl2.textContent = fmtDelta(delta);
            dEl2.className   = 'delta-badge ' + (delta <= 0 ? 'ontime' : 'late');
          } else {
            dEl2.textContent = '→';
            dEl2.className   = 'delta-badge hidden';
          }
        }
      }

      const depEl = document.getElementById('dep-' + s.id);
      const dEl3  = document.getElementById('delta-dep-' + s.id);
      if (depEl) {
        const val   = depEl.value;
        const delta = timeDelta(s.depP, val);
        depEl.classList.remove('empty', 'ontime', 'late');
        if (!val) depEl.classList.add('empty');
        else if (delta !== null) depEl.classList.add(delta <= 0 ? 'ontime' : 'late');
        if (dEl3) {
          if (delta !== null) {
            dEl3.textContent = fmtDelta(delta);
            dEl3.className   = 'delta-badge ' + (delta <= 0 ? 'ontime' : 'late');
          } else {
            dEl3.textContent = '→';
            dEl3.className   = 'delta-badge hidden';
          }
        }
      }
    });
  });
  refreshSegments();
}

// ── STOP CARD ─────────────────────────────────────────────────────────────────
function makeStopCard(s, day) {
  const hasDepart = s.depP !== undefined && s.depP !== '';
  const depBlock  = hasDepart ? `
    <div class="time-block">
      <div class="time-block-label">Отправление</div>
      <div class="time-inputs">
        <div class="time-input-wrap">
          <div class="time-mini-label">план</div>
          <div class="planned-time" id="planned-dep-${s.id}">${s.depP}</div>
        </div>
        <div class="delta-wrap">
          <span class="delta-badge hidden" id="delta-dep-${s.id}">→</span>
        </div>
        <div class="time-input-wrap">
          <div class="time-mini-label">факт</div>
          <input class="time-in ${s.depA ? '' : 'empty'}" id="dep-${s.id}"
            type="text" maxlength="5" value="${s.depA || ''}" placeholder="${s.depP || '--:--'}"
            autocomplete="off" oninput="applyMask(this)" onblur="padTime(this)">
        </div>
      </div>
    </div>` : `<div></div>`;

  const div = document.createElement('div');
  div.className  = 'stop-card';
  div.id         = 'card-' + s.id;
  div.draggable  = true;
  div.dataset.id  = s.id;
  div.dataset.day = day;

  div.addEventListener('click', e => {
    if (e.target.closest('input,button,.drag-handle,.stop-dropdown')) return;
    highlightStop(s.id, day);
  });

  div.innerHTML = `
    <div class="drag-handle" title="Перетащить">⠿</div>
    <button class="dots-btn" id="dots-${s.id}" onclick="toggleStopMenu('${s.id}', ${day}); event.stopPropagation();">···</button>
    <div class="stop-dropdown" id="dd-${s.id}">
      <button class="stop-dropdown-item" onclick="closeStopMenus(); editStop('${s.id}', ${day});"><span class="di-icon">✎</span> Редактировать</button>
      <button class="stop-dropdown-item" onclick="closeStopMenus(); editStopTime('${s.id}', ${day});"><span class="di-icon">⏱</span> Изменить время</button>
      <div class="stop-dropdown-divider"></div>
      <button class="stop-dropdown-item danger" onclick="closeStopMenus(); deleteStop(${day}, '${s.id}');"><span class="di-icon">×</span> Удалить точку</button>
    </div>
    <div class="stop-main" id="stop-main-${s.id}">
      <div class="stop-num">${s.num}</div>
      <div class="stop-info">
        <div class="stop-name">
          <span class="stop-icon" id="stop-icon-disp-${s.id}">${s.icon}</span>
          <span class="stop-name-text" id="stop-name-disp-${s.id}">${s.name}</span>
          <span class="stop-type" id="stop-type-disp-${s.id}">${s.type}</span>
        </div>
      </div>
    </div>
    <div class="time-grid" id="stop-timegrid-${s.id}">
      <div class="time-block">
        <div class="time-block-label">Прибытие</div>
        <div class="time-inputs">
          <div class="time-input-wrap">
            <div class="time-mini-label">план</div>
            <div class="planned-time" id="planned-arr-${s.id}">${s.arrP || '—'}</div>
          </div>
          <div class="delta-wrap">
            <span class="delta-badge hidden" id="delta-arr-${s.id}">→</span>
          </div>
          <div class="time-input-wrap">
            <div class="time-mini-label">факт</div>
            <input class="time-in ${s.arrA ? '' : 'empty'}" id="arr-${s.id}"
              type="text" maxlength="5" value="${s.arrA || ''}" placeholder="${s.arrP || '--:--'}"
              autocomplete="off" oninput="applyMask(this)" onblur="padTime(this)">
          </div>
        </div>
      </div>
      ${depBlock}
    </div>
    <div class="stop-edit-form" id="edit-form-${s.id}" style="display:none;"></div>`;

  div.querySelector('.delete-stop-btn').addEventListener('click', e => {
    e.stopPropagation();
    const btn = e.currentTarget;
    deleteStop(parseInt(btn.dataset.delDay), btn.dataset.delId, e);
  });

  div.addEventListener('dragstart', onDragStart);
  div.addEventListener('dragover',  onDragOver);
  div.addEventListener('dragleave', onDragLeave);
  div.addEventListener('drop',      onDrop);
  div.addEventListener('dragend',   onDragEnd);
  return div;
}

function renderStops(day) {
  const container = document.getElementById('d' + day + '-stops');
  container.innerHTML = '';
  DAYS_DATA[day].stops.forEach((s, i) => { s.num = i + 1; });
  DAYS_DATA[day].stops.forEach(s => container.appendChild(makeStopCard(s, day)));
  const cntEl = document.getElementById('d' + day + '-stop-count');
  if (cntEl) cntEl.textContent = DAYS_DATA[day].stops.length;
}

// ── DAY SECTION ───────────────────────────────────────────────────────────────
function renderDaySection(d) {
  const data    = DAYS_DATA[d];
  const ordinal = DAY_ORDINALS[d - 1] || `${d}-й`;
  const sec     = document.createElement('div');
  sec.className  = 'day-section' + (d === currentDay ? ' visible' : '');
  sec.dataset.day = d;
  sec.id          = 'day' + d;

  sec.innerHTML = `
    <div class="day-header" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
      <div style="flex:1;min-width:0">
        <div class="day-label" style="color:${data.color};">
          День ${ordinal} ·
          <span class="day-date-wrap" onclick="editDate(${d}, this)" title="Нажмите для изменения даты">
            <span class="day-date-text">${data.date}</span>
            <span class="day-date-edit-icon">✎</span>
          </span>
        </div>
        <div class="day-route" id="d${d}-route"></div>
      </div>
      <button class="nav-day-btn" onclick="openShareDay(${d})" title="Открыть маршрут в навигаторе">🗺 НАВИГАТОР</button>
      <button class="delete-day-btn" onclick="confirmDeleteDay(${d})" title="Удалить день">✕ ДЕНЬ</button>
      <button class="reset-btn" onclick="confirmReset(${d})">⟳ СБРОС</button>
    </div>
    <div class="depart-row">
      <div class="depart-icon">🚗</div>
      <div class="depart-label" style="cursor:pointer;display:flex;align-items:center;gap:4px;"
           onclick="openEditStart(${d})" title="Изменить точку старта">
        <span id="d${d}-start-name">${data.start.icon} ${data.start.name}</span>
        <span style="font-size:9px;color:var(--border)">✎</span>
      </div>
      <div class="depart-times">
        <div class="time-pair">
          <div class="time-label">план</div>
          <div class="time-val time-val-editable" id="d${d}-departP-display"
               onclick="editDepartTime(${d}, this)"
               title="Нажмите для изменения времени выезда">${data.departP || '—'}</div>
        </div>
        <div class="time-sep">→</div>
        <div class="time-pair">
          <div class="time-label">факт</div>
          <input class="time-in ${data.departA ? '' : 'empty'}" id="d${d}-depart"
            type="text" maxlength="5" value="${data.departA || ''}" placeholder="--:--"
            autocomplete="off" oninput="applyMask(this)" onblur="padTime(this)">
        </div>
      </div>
    </div>
    <div class="day-progress">
      <div class="progress-label"><span>Прогресс</span><span id="d${d}-pct">0%</span></div>
      <div class="progress-bar"><div class="progress-fill" id="d${d}-fill"></div></div>
    </div>
    <div class="stats-row">
      <div class="stat-box"><div class="stat-val" id="d${d}-stop-count">${data.stops.length}</div><div class="stat-key">ОСТАНОВОК</div></div>
      <div class="stat-box"><div class="stat-val">—</div><div class="stat-key">В ПУТИ</div></div>
      <div class="stat-box"><div class="stat-val" id="d${d}-delta-val">—</div><div class="stat-key">ОТКЛОНЕНИЕ</div></div>
    </div>
    <div id="d${d}-stops"></div>
    <button class="add-stop-btn" onclick="openAddStop(${d})">＋ ДОБАВИТЬ ТОЧКУ</button>
  `;
  return sec;
}

function renderAllDays() {
  const container = document.getElementById('daySections');
  container.innerHTML = '';
  dayKeys().forEach(d => {
    container.appendChild(renderDaySection(d));
    renderStops(d);
    updateDayRoute(d);
  });
}

function updateDayRoute(d) {
  const el = document.getElementById('d' + d + '-route');
  if (!el) return;
  const data = DAYS_DATA[d];
  const last = data.stops[data.stops.length - 1];
  el.textContent = data.start.name + (last ? ' → ' + last.name : '');
}

// ── TABS ──────────────────────────────────────────────────────────────────────
function renderTabs() {
  const tabsEl = document.getElementById('dayTabs');
  tabsEl.innerHTML = '';
  dayKeys().forEach(d => {
    const data = DAYS_DATA[d];
    const btn  = document.createElement('button');
    btn.className  = 'day-tab' + (d === currentDay ? ' active' : '');
    btn.dataset.day = d;
    btn.textContent = `День ${d} · ${data.date.split(' ')[0]} ${data.date.split(' ')[1]?.slice(0, 3) || ''}`;
    btn.onclick = () => switchDay(d);
    if (d === currentDay) {
      btn.style.backgroundColor = data.color;
      btn.style.borderColor     = data.color;
    }
    tabsEl.appendChild(btn);
  });
  const addBtn = document.createElement('button');
  addBtn.className  = 'day-tab-add';
  addBtn.textContent = '＋ день';
  addBtn.onclick    = addNewDay;
  tabsEl.appendChild(addBtn);
}
