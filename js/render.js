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

function fillOnTime(el) {
  if (el.value) return;
  var id = el.id;
  var planEl;
  if (id.match(/^arr-/)) planEl = document.getElementById('planned-' + id);
  else if (id.match(/^dep-/)) planEl = document.getElementById('planned-' + id);
  else {
    var m = id.match(/^d(\d+)-depart$/);
    if (m) planEl = document.getElementById('d' + m[1] + '-departP-display');
  }
  if (!planEl) return;
  var t = planEl.textContent.trim();
  if (!t || t === '—' || t === '--:--') return;
  el.value = t;
  el.classList.remove('empty');
  applyMask(el);
  saveData();
}

function _parseTime(s) {
  if (!s || typeof s !== 'string') return null;
  var p = s.split(':');
  if (p.length !== 2) return null;
  var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function _fmtTime(totalMin) {
  totalMin = ((totalMin % 1440) + 1440) % 1440;
  var h = Math.floor(totalMin / 60), m = totalMin % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function autoFillTimes(day) {
  if (!isAdmin()) return;
  var data = DAYS_DATA[day];
  if (!data) return;
  var profile = data.walkMode ? 'foot' : 'driving';
  var stops = data.stops;
  var changed = false;

  for (var i = 0; i < stops.length; i++) {
    if (stops[i].arrP) continue;
    var prev, prevDep;
    if (i === 0) {
      prev = data.start;
      prevDep = _parseTime(data.departP);
    } else {
      prev = stops[i - 1];
      prevDep = _parseTime(stops[i - 1].depP) || _parseTime(stops[i - 1].arrP);
    }
    if (prevDep == null) continue;
    var dur = getSegmentDuration(prev, stops[i], profile);
    if (dur == null) {
      if (typeof _fetchDuration === 'function') {
        var _day = day;
        _fetchDuration(prev, stops[i], profile, function() { autoFillTimes(_day); });
      }
      continue;
    }
    var arrMin = prevDep + Math.round(dur / 60);
    stops[i].arrP = _fmtTime(arrMin);
    changed = true;

    var planEl = document.getElementById('planned-arr-' + stops[i].id);
    if (planEl) planEl.textContent = stops[i].arrP;
    var inp = document.getElementById('arr-' + stops[i].id);
    if (inp && !inp.value) inp.placeholder = stops[i].arrP;
  }
  if (changed) {
    updateProgress();
    saveData();
  }
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
    if (fill) {
      fill.style.width = pct + '%';
      var dc = DAYS_DATA[day].color || '#f5a623';
      fill.style.background = 'linear-gradient(90deg,' + dc + ',' + dc + '99)';
    }
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
  // Update travel time + km for each day
  dayKeys().forEach(d => updateTravelStats(d));
}

// ── TRAVEL STATS (В ПУТИ) ─────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function updateTravelStats(d) {
  const data = DAYS_DATA[d];
  if (!data) return;

  // ── Time: departP → arrP of last stop ────────────────
  const timeEl = document.getElementById('d' + d + '-travel-time');
  const kmEl   = document.getElementById('d' + d + '-travel-km');
  if (!timeEl || !kmEl) return;

  const depMins = (function() {
    const t = data.departP;
    if (!t || t.length < 5) return null;
    const [h, m] = t.split(':').map(Number);
    return isNaN(h) ? null : h * 60 + m;
  })();

  const lastStop = data.stops[data.stops.length - 1];
  const arrMins = (function() {
    const t = lastStop?.arrP;
    if (!t || t.length < 5) return null;
    const [h, m] = t.split(':').map(Number);
    return isNaN(h) ? null : h * 60 + m;
  })();

  if (depMins !== null && arrMins !== null) {
    let diff = arrMins - depMins;
    if (diff < 0) diff += 1440; // crosses midnight
    const h = Math.floor(diff / 60), m = diff % 60;
    timeEl.textContent = h > 0 ? (m > 0 ? h + 'ч ' + m + 'м' : h + 'ч') : m + 'м';
  } else {
    timeEl.textContent = '—';
  }

  // ── Distance: sum of haversine segments ──────────────
  const pts = [
    { lat: data.start.lat, lng: data.start.lng },
    ...data.stops.map(s => ({ lat: s.lat, lng: s.lng }))
  ];
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i-1].lat && pts[i].lat) km += haversineKm(pts[i-1].lat, pts[i-1].lng, pts[i].lat, pts[i].lng);
  }
  const kmStr = km > 0 ? '~' + Math.round(km) + ' км' : '';
  kmEl.textContent = kmStr ? 'В ПУТИ · ' + kmStr : 'В ПУТИ';
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
            type="text" inputmode="numeric" maxlength="5" value="${s.depA || ''}" placeholder="${s.depP || '--:--'}"
            autocomplete="off"
            ${isAdmin() ? `oninput="applyMask(this)" onblur="padTime(this)" ondblclick="fillOnTime(this)"` : `readonly style="pointer-events:none;border-style:solid;"`}>
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
    ${isAdmin() ? `<div class="drag-handle" title="Перетащить">⠿</div>` : ''}
    ${isAdmin() ? `<button class="dots-btn" id="dots-${s.id}" onclick="toggleStopMenu('${s.id}', ${day}); event.stopPropagation();">···</button>` : ''}
    <div class="stop-dropdown" id="dd-${s.id}">
      ${isAdmin() ? `
      <button class="stop-dropdown-item" onclick="closeStopMenus(); editStop('${s.id}', ${day});"><span class="di-icon">✎</span> Редактировать</button>
      <button class="stop-dropdown-item" onclick="closeStopMenus(); editStopTime('${s.id}', ${day});"><span class="di-icon">⏱</span> Изменить время</button>
      <button class="stop-dropdown-item" onclick="closeStopMenus(); addStopNote('${s.id}', ${day});"><span class="di-icon">📝</span> Добавить заметку</button>
      <div class="stop-dropdown-divider"></div>
      <button class="stop-dropdown-item danger" onclick="closeStopMenus(); deleteStop(${day}, '${s.id}');"><span class="di-icon">×</span> Удалить точку</button>` : ''}
    </div>
    <div class="stop-main" id="stop-main-${s.id}">
      <div class="stop-num">${s.num}</div>
      <div class="stop-info">
        <div class="stop-name">
          <span class="stop-icon" id="stop-icon-disp-${s.id}">${s.icon}</span>
          <span class="stop-name-text" id="stop-name-disp-${s.id}">${s.name}</span>
          <span class="stop-type" id="stop-type-disp-${s.id}">${s.type}</span>
          <span class="weather-badge" id="wb-${s.id}" style="display:none" onclick="event.stopPropagation();toggleWeatherStrip('${s.id}')"></span>
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
              type="text" inputmode="numeric" maxlength="5" value="${s.arrA || ''}" placeholder="${s.arrP || '--:--'}"
              autocomplete="off"
              ${isAdmin() ? `oninput="applyMask(this)" onblur="padTime(this)" ondblclick="fillOnTime(this)"` : `readonly style="pointer-events:none;border-style:solid;"`}>
          </div>
        </div>
      </div>
      ${depBlock}
    </div>
    <div class="weather-strip" id="ws-${s.id}" style="display:none" onclick="event.stopPropagation();toggleWeatherStrip('${s.id}')"></div>
    <div class="stop-edit-form" id="edit-form-${s.id}" style="display:none;"></div>
    ${(function(){
      var notes = s.notes || [];
      var _e = typeof _escN==='function' ? _escN : function(x){return x;};
      var _l = typeof _linkifyN==='function' ? _linkifyN : _e;
      var eyeOn = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      var eyeOff = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
      var admin = typeof isAdmin==='function' && isAdmin();
      var visibleNotes = admin ? notes : notes.filter(function(n){return n.public;});
      if (!visibleNotes.length && !admin) return '';
      var html = '<div class="stop-notes-wrap" id="stop-notes-wrap-'+s.id+'" ontouchstart="event.stopPropagation()" ontouchmove="event.stopPropagation()" onmousedown="event.stopPropagation()">';
      notes.forEach(function(n, i){
        var hasContent = n.text || (n.images && n.images.length);
        if (!admin && !n.public) return;
        if (admin) {
          html += '<div class="stop-note-item" id="stop-note-item-'+s.id+'-'+i+'">';
          html += '<div class="stop-note-edit" id="stop-note-edit-'+s.id+'-'+i+'" style="display:'+(hasContent?'none':'block')+'">';
          html += '<div class="stop-note-bubble">';
          html += '<textarea class="stop-note-input" id="stop-note-'+s.id+'-'+i+'" placeholder="Заметка к точке…" style="touch-action:auto" oninput="autoResizeNote(this)" onfocus="var c=this.closest(\'.stop-card\');if(c)c.draggable=false" ontouchstart="event.stopPropagation()" ontouchmove="event.stopPropagation()" onmousedown="event.stopPropagation()">'+_e(n.text||'')+'</textarea>';
          html += '<div class="note-images-inline" id="stop-note-edit-images-'+s.id+'-'+i+'">';
          if (n.images && n.images.length) n.images.forEach(function(url,j){
            html += '<div class="note-img-thumb-wrap"><img src="'+_e(url)+'" class="note-img-thumb" onclick="event.stopPropagation();openChatPhoto(this)" alt=""><button class="pending-thumb-remove" onclick="event.stopPropagation();removePendingStopImage(\''+s.id+'\','+i+','+j+')">×</button></div>';
          });
          html += '</div>';
          html += '<div class="stop-note-toolbar">';
          html += '<button class="note-vis-btn '+(n.public?'note-vis-on':'')+'" onmousedown="event.preventDefault()" onclick="toggleNotePublic(\''+s.id+'\','+i+','+day+')" title="'+(n.public?'Видна читателю':'Скрыта от читателя')+'">'+(n.public?eyeOn:eyeOff)+'</button>';
          html += '<button class="stop-note-photo-btn" onmousedown="event.preventDefault()" onclick="triggerStopNotePhoto(\''+s.id+'\','+day+','+i+')" title="Добавить фото">📷</button>';
          html += '<div style="flex:1"></div>';
          html += '<button class="stop-note-del-btn" onmousedown="event.preventDefault()" onclick="deleteStopNote(\''+s.id+'\','+day+','+i+')" title="Удалить заметку">×</button>';
          html += '<button class="stop-note-save-btn" onmousedown="event.preventDefault()" onclick="commitStopNote(\''+s.id+'\','+day+','+i+')" title="Сохранить">✓</button>';
          html += '</div></div></div>';
          if (hasContent) {
            html += '<div class="stop-note-display" id="stop-note-preview-'+s.id+'-'+i+'" style="cursor:pointer" onclick="openStopNoteEdit(\''+s.id+'\','+i+')" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()">';
            html += '<div class="stop-note-display-inner"><div id="stop-note-text-'+s.id+'-'+i+'">'+_l(n.text||'').replace(/\n/g,'<br>')+'</div>';
            html += '<div class="note-images-inline" id="stop-note-images-'+s.id+'-'+i+'">';
            if (n.images && n.images.length) n.images.forEach(function(url){
              html += '<div class="note-img-thumb-wrap"><img src="'+_e(url)+'" class="note-img-thumb" onclick="event.stopPropagation();openChatPhoto(this)" alt=""></div>';
            });
            html += '</div></div>';
            html += '<button class="note-vis-btn '+(n.public?'note-vis-on':'')+'" onclick="event.stopPropagation();toggleNotePublic(\''+s.id+'\','+i+','+day+')" title="'+(n.public?'Видна читателю':'Скрыта от читателя')+'">'+(n.public?eyeOn:eyeOff)+'</button>';
            html += '</div>';
          }
          html += '</div>';
        } else {
          html += '<div class="stop-note-item">';
          html += '<div class="stop-note-display stop-note-readonly">';
          html += '<div class="stop-note-display-inner"><div>'+_l(n.text||'').replace(/\n/g,'<br>')+'</div>';
          html += '<div class="note-images-inline">';
          if (n.images && n.images.length) n.images.forEach(function(url){
            html += '<div class="note-img-thumb-wrap"><img src="'+_e(url)+'" class="note-img-thumb" onclick="event.stopPropagation();openChatPhoto(this)" alt=""></div>';
          });
          html += '</div></div></div></div>';
        }
      });
      html += '</div>';
      return html;
    })()}`;

  if (typeof isAdmin === 'function' && isAdmin()) {
    div.addEventListener('dragstart', onDragStart);
    div.addEventListener('dragover',  onDragOver);
    div.addEventListener('dragleave', onDragLeave);
    div.addEventListener('drop',      onDrop);
    div.addEventListener('dragend',   onDragEnd);
  } else {
    div.draggable = false;
  }
  return div;
}

function renderStops(day) {
  const container = document.getElementById('d' + day + '-stops');
  container.innerHTML = '';
  DAYS_DATA[day].stops.forEach((s, i) => { s.num = i + 1; });
  DAYS_DATA[day].stops.forEach(s => container.appendChild(makeStopCard(s, day)));
  const cntEl = document.getElementById('d' + day + '-stop-count');
  if (cntEl) cntEl.textContent = DAYS_DATA[day].stops.length;
  if (typeof _reapplyDayWeather === 'function') _reapplyDayWeather(day);
}

// ── DAY SECTION ───────────────────────────────────────────────────────────────
function renderDaySection(d) {
  const data    = DAYS_DATA[d];
  const sec     = document.createElement('div');
  sec.className  = 'day-section' + (d === currentDay ? ' visible' : '');
  sec.dataset.day = d;
  sec.id          = 'day' + d;

  sec.innerHTML = `
    <div class="day-header" style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
      <div style="flex:1;min-width:0">
        <div class="day-label" style="color:${data.color};">
          <span class="day-date-wrap" ${isAdmin() ? `onclick="editDayDate(${d}, this)" title="Нажмите для изменения даты"` : ''}>
            <span class="day-date-text">${data.dateISO || 'Дата'}</span>
            ${isAdmin() ? `<span class="day-date-edit-icon">✎</span>` : ''}
          </span>
          ${data.date ? ` · <span class="day-desc-wrap" ${isAdmin() ? `onclick="editDesc(${d}, this)" title="Нажмите для изменения описания"` : ''}>
            <span class="day-desc-text">${data.date}</span>
            ${isAdmin() ? `<span class="day-date-edit-icon">✎</span>` : ''}
          </span>` : (isAdmin() ? ` · <span class="day-desc-wrap" onclick="editDesc(${d}, this)" title="Добавить описание"><span class="day-desc-text" style="color:var(--muted);font-style:italic">описание</span><span class="day-date-edit-icon">✎</span></span>` : '')}
        </div>
        <div class="day-route" id="d${d}-route"></div>
      </div>
      <button class="nav-day-btn" onclick="openShareDay(${d})" title="Открыть маршрут в навигаторе">🗺️ НАВИГАТОР</button>
      <div class="day-overflow-wrap" style="position:relative">
        <button class="nav-day-btn" onclick="toggleDayMenu(${d})" title="Ещё">···</button>
        <div class="day-overflow-menu" id="dayMenu${d}">
          ${isAdmin() ? `
          <button onclick="reverseDay(${d});closeDayMenus()">↩ Обратный маршрут</button>
          <button onclick="confirmDeleteDay(${d});closeDayMenus()" style="color:var(--red)">✕ Удалить день</button>
          <button onclick="confirmReset(${d});closeDayMenus()">⟳ Сбросить факт</button>` : ''}
          <button onclick="fetchDayWeather(${d});closeDayMenus()">🌤 Погода</button>
          ${isAdmin() ? `<div class="day-overflow-divider"></div>
          <div class="day-mode-row">
            <div class="day-mode-group" id="dayVisRow${d}">
              <div class="day-mode-label">ЧИТАТЕЛЬ</div>
              <div class="day-mode-pills">
                <button class="day-mode-pill ${!data.hidden ? 'active' : ''}" onclick="setDayVisibility(${d},true)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
                <button class="day-mode-pill ${data.hidden ? 'active' : ''}" onclick="setDayVisibility(${d},false)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button>
              </div>
            </div>
            <div class="day-mode-group" id="dayModeRow${d}">
              <div class="day-mode-label">РЕЖИМ</div>
              <div class="day-mode-pills">
                <button class="day-mode-pill ${!data.walkMode ? 'active' : ''}" onclick="setDayMode(${d},'auto')">🚗</button>
                <button class="day-mode-pill ${data.walkMode ? 'active' : ''}" onclick="setDayMode(${d},'walk')">🚶</button>
              </div>
            </div>
          </div>
          <div class="day-overflow-divider"></div>
          <button class="day-overflow-import" onclick="closeDayMenus();openImportModal(${d})">↓ Импорт из карт</button>` : ''}
        </div>
      </div>
    </div>
    <div class="depart-row">
      <div class="depart-icon" id="d${d}-depart-icon">${data.walkMode ? '🚶' : '🚗'}</div>
      <div class="depart-label" style="${isAdmin() ? 'cursor:pointer' : ''}"
           ${isAdmin() ? `onclick="openEditStart(${d})" title="Изменить точку старта"` : ''}>
        <span id="d${d}-start-name">${data.start.icon} ${data.start.name}</span>
        ${isAdmin() ? `<span style="font-size:9px;color:var(--border)">✎</span>` : ''}
      </div>
      <span class="weather-badge" id="wb-d${d}-start" style="display:none" onclick="event.stopPropagation();toggleWeatherStrip('d${d}-start')"></span>
      <div class="depart-times">
        <div class="time-pair">
          <div class="time-label">план</div>
          <div class="${isAdmin() ? 'time-val time-val-editable' : 'time-val'}" id="d${d}-departP-display"
               ${isAdmin() ? `onclick="editDepartTime(${d}, this)" title="Нажмите для изменения времени выезда"` : ''}>${data.departP || '—'}</div>
        </div>
        <div class="time-sep">→</div>
        <div class="time-pair">
          <div class="time-label">факт</div>
          <input class="time-in ${data.departA ? '' : 'empty'}" id="d${d}-depart"
            type="text" inputmode="numeric" maxlength="5" value="${data.departA || ''}" placeholder="--:--"
            autocomplete="off"
            ${isAdmin() ? `oninput="applyMask(this)" onblur="padTime(this)" ondblclick="fillOnTime(this)"` : `readonly style="pointer-events:none;border-style:solid;"`}>
        </div>
      </div>
    </div>
    <div class="weather-strip" id="ws-d${d}-start" style="display:none" onclick="toggleWeatherStrip('d${d}-start')"></div>
    <div class="day-progress">
      <div class="progress-label"><span>Прогресс</span><span id="d${d}-pct">0%</span></div>
      <div class="progress-bar"><div class="progress-fill" id="d${d}-fill"></div></div>
    </div>
    <div class="stats-row">
      <div class="stat-box"><div class="stat-val" id="d${d}-stop-count">${data.stops.length}</div><div class="stat-key">ОСТАНОВОК</div></div>
      <div class="stat-box"><div class="stat-val" id="d${d}-travel-time" style="font-size:13px;">—</div><div class="stat-key" id="d${d}-travel-km" style="letter-spacing:0.06em;">В ПУТИ</div></div>
      <div class="stat-box"><div class="stat-val" id="d${d}-delta-val">—</div><div class="stat-key">ОТКЛОНЕНИЕ</div></div>
    </div>
    <div id="d${d}-stops"></div>
    ${isAdmin() ? `
    <div style="display:flex;gap:8px;padding:8px 16px 4px;">
      <button class="add-stop-btn" style="flex:1;" onclick="openAddStop(${d})">＋ ДОБАВИТЬ ТОЧКУ</button>
      <button class="add-stop-btn" id="mapAddBtn" style="flex:1;"
        onclick="toggleMapAddMode(${d})" title="Кликни на карте чтобы добавить точку">📍 НА КАРТЕ</button>
    </div>` : ''}
  `;
  return sec;
}

function renderAllDays() {
  const container = document.getElementById('daySections');
  container.innerHTML = '';
  var admin = typeof isAdmin === 'function' && isAdmin();
  dayKeys().forEach(d => {
    if (!admin && DAYS_DATA[d].hidden) return;
    container.appendChild(renderDaySection(d));
    renderStops(d);
    updateDayRoute(d);
    updateTravelStats(d);
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
const _MONTHS_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const _MONTHS_FULL  = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

function fmtDateShort(s) {
  if (!s) return '?';
  var d, m;
  if (s.indexOf('-') > -1) { var p = s.split('-'); d = parseInt(p[2]); m = parseInt(p[1]); }
  else if (s.indexOf('.') > -1) { var p = s.split('.'); d = parseInt(p[0]); m = parseInt(p[1]); }
  else return s;
  if (isNaN(d) || isNaN(m)) return s;
  return d + ' ' + (_MONTHS_SHORT[m - 1] || '');
}
function fmtDateFull(s) {
  if (!s) return '';
  var d, m;
  if (s.indexOf('-') > -1) { var p = s.split('-'); d = parseInt(p[2]); m = parseInt(p[1]); }
  else if (s.indexOf('.') > -1) { var p = s.split('.'); d = parseInt(p[0]); m = parseInt(p[1]); }
  else return s;
  if (isNaN(d) || isNaN(m)) return s;
  return d + ' ' + (_MONTHS_FULL[m - 1] || '');
}
function parseDateDMY(s) {
  if (!s) return null;
  var p = s.split('.'); if (p.length < 3) return null;
  return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
}
function fmtDateDMY(d) {
  var dd = String(d.getDate()).padStart(2, '0');
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  return dd + '.' + mm + '.' + d.getFullYear();
}

function renderTabs() {
  // Пересчитать цвета по позиции: каждый следующий день — другой цвет
  var _colorsChanged = false;
  dayKeys().forEach(function(d, i) {
    var newColor = DAY_COLORS[i % DAY_COLORS.length];
    if (DAYS_DATA[d].color !== newColor) { DAYS_DATA[d].color = newColor; _colorsChanged = true; }
  });
  if (_colorsChanged && typeof redrawDay === 'function') {
    dayKeys().forEach(function(d) { redrawDay(d); });
  }
  const tabsEl = document.getElementById('dayTabs');
  tabsEl.innerHTML = '';
  var admin = typeof isAdmin === 'function' && isAdmin();
  dayKeys().forEach(d => {
    const data = DAYS_DATA[d];
    // Читатель не видит скрытые дни
    if (!admin && data.hidden) return;
    const btn  = document.createElement('button');
    btn.className  = 'day-tab' + (d === currentDay ? ' active' : '') + (data.hidden ? ' day-hidden' : '');
    btn.dataset.day = d;
    btn.textContent = data.dateISO ? fmtDateShort(data.dateISO) : ('День ' + d);
    btn.onclick = () => switchDay(d);
    btn.style.setProperty('--dc', data.color);
    if (d === currentDay && !data.hidden) {
      btn.style.color           = data.color;
      btn.style.borderColor     = data.color;
      btn.style.backgroundColor = data.color + '1f';
    }
    // Drag-and-drop for day tabs
    if (admin) {
      btn.draggable = true;
      btn.addEventListener('dragstart', function(e) {
        e.dataTransfer.setData('text/plain', String(d));
        btn.classList.add('tab-dragging');
        _tabDragSource = d;
      });
      btn.addEventListener('dragover', function(e) {
        e.preventDefault();
        btn.classList.add('tab-drag-over');
      });
      btn.addEventListener('dragleave', function() {
        btn.classList.remove('tab-drag-over');
      });
      btn.addEventListener('drop', function(e) {
        e.preventDefault();
        btn.classList.remove('tab-drag-over');
        var from = _tabDragSource;
        var to   = d;
        if (from && from !== to) swapDays(from, to);
      });
      btn.addEventListener('dragend', function() {
        btn.classList.remove('tab-dragging');
        document.querySelectorAll('.day-tab').forEach(t => t.classList.remove('tab-drag-over'));
      });
    }
    tabsEl.appendChild(btn);
  });
  if (admin) {
    const addBtn = document.createElement('button');
    addBtn.className  = 'day-tab-add';
    addBtn.textContent = '＋ день';
    addBtn.onclick    = addNewDay;
    tabsEl.appendChild(addBtn);
  }
}
