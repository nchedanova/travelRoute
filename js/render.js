// ── NOTE IMAGE HELPERS (глобалы — notes.js добавляет _resolveNoteImg поверх) ──
// Обратная совместимость: data: строки рендерятся напрямую, fb: — через data-fbref
function _noteImgTag(ref, extraAttrs) {
  var a = extraAttrs || '';
  if (!ref) return '';
  if (ref.startsWith('fb:')) {
    return '<img data-fbref="' + ref.replace(/"/g, '&quot;') + '" src="" class="note-img-thumb loading"' + a + ' alt="">';
  }
  return '<img src="' + ref.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;') + '" class="note-img-thumb" onload="if(this.parentElement)this.parentElement.classList.add(&quot;img-loaded&quot;)"' + a + ' alt="">';
}
// Резолвит все img[data-fbref] внутри el; _resolveNoteImg определяется в notes.js
function _resolveImgsInEl(el) {
  if (!el) return;
  el.querySelectorAll('img[data-fbref]').forEach(function(img) {
    if (typeof _resolveNoteImg === 'function') _resolveNoteImg(img.dataset.fbref, img);
  });
  // data: или http: — уже загружены, ставим img-loaded сразу
  el.querySelectorAll('img.note-img-thumb:not([data-fbref])').forEach(function(img) {
    if (img.complete && img.naturalWidth && img.parentElement) img.parentElement.classList.add('img-loaded');
  });
}
// Резолвит все img[data-fbref] на всей странице — вызывается после готовности Firebase
function _resolveAllNoteImgs() {
  if (typeof _resolveNoteImg !== 'function') return;
  document.querySelectorAll('img[data-fbref]').forEach(function(img) {
    _resolveNoteImg(img.dataset.fbref, img);
  });
}

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
  const prev = el.dataset.prevVal ?? el.defaultValue ?? '';
  const val = el.value.trim();
  if (typeof _markBlurCommit === 'function') _markBlurCommit();
  const digits = val.replace(/[^0-9]/g, '');
  let padded = val;
  if (digits.length === 3) padded = '0' + digits[0] + ':' + digits.slice(1);
  if (/^\d:\d\d$/.test(val)) padded = '0' + val;
  el.value = padded;
  el.classList.toggle('empty', !padded);
  saveActualTimeEdit(el, prev);
}

function saveActualTimeEdit(el, previousTime) {
  if (el.value === previousTime) return;
  snapshotForUndo('Изменено фактическое время', el.id, previousTime);
  el.dataset.prevVal = el.value;
  updateProgress();
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
  saveActualTimeEdit(el, '');
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
  if (!data || data.walkReview) return;
  var profile = data.walkMode ? 'foot' : 'driving';
  var stops = data.stops;
  var changed = false;

  for (var i = 0; i < stops.length; i++) {
    var s = stops[i];
    // ── Заполняем arrP если пусто ──────────────────────────────────────────
    if (!s.arrP) {
      var prev, prevDep;
      if (i === 0) {
        prev    = data.start;
        prevDep = _parseTime(data.departP);
      } else {
        prev    = stops[i - 1];
        prevDep = _parseTime(stops[i - 1].depP) || _parseTime(stops[i - 1].arrP);
      }
      if (prevDep != null) {
        var dur = getSegmentDuration(prev, s, profile);
        if (dur == null) {
          if (typeof _fetchDuration === 'function') {
            var _day = day;
            _fetchDuration(prev, s, profile, function() { autoFillTimes(_day); });
          }
          continue;
        }
        var arrMin = prevDep + Math.round(dur / 60);
        s.arrP = _fmtTime(arrMin);
        changed = true;
        var planEl = document.getElementById('planned-arr-' + s.id);
        if (planEl) planEl.textContent = s.arrP;
        var arrInp = document.getElementById('arr-' + s.id);
        if (arrInp && !arrInp.value) arrInp.placeholder = s.arrP;
      }
    }
    // ── Заполняем depP для типов со стоянкой (Заправка/Кафе) если пусто ──
    if (s.arrP && !s.depP && typeof DEP_OFFSETS !== 'undefined') {
      var offset = DEP_OFFSETS[s.type];
      if (offset) {
        var arrMins = _parseTime(s.arrP);
        if (arrMins != null) {
          s.depP = _fmtTime(arrMins + offset);
          changed = true;
          var depPlanEl = document.getElementById('planned-dep-' + s.id);
          if (depPlanEl) { depPlanEl.textContent = s.depP; var depBlk = document.getElementById('dep-block-' + s.id); if (depBlk) depBlk.style.display = ''; }
          var depInp = document.getElementById('dep-' + s.id);
          if (depInp && !depInp.value) depInp.placeholder = s.depP;
        }
      }
    }
  }
  if (changed) {
    updateProgress();
    saveData();
  }
}

// Сбросить arrP у всех точек НИЖЕ stopId и пересчитать через autoFillTimes.
// Используется при ручном изменении план.времени чтобы каскадно обновить
// последующие точки. depP сбрасывается только для типов с авто-offset (не
// трогаем вручную выставленное время отправления для прочих типов).
function cascadeAutoFillFrom(day, stopId) {
  if (!isAdmin()) return;
  var data = DAYS_DATA[day];
  if (!data || data.walkReview) return;
  var idx = data.stops.findIndex(function(x) { return x.id === stopId; });
  if (idx < 0) return;
  var changed = false;
  for (var i = idx + 1; i < data.stops.length; i++) {
    var s = data.stops[i];
    s.arrP = '';
    // Сбрасываем depP только для типов, у которых он был авто-вычислен
    if (typeof DEP_OFFSETS !== 'undefined' && DEP_OFFSETS[s.type]) {
      s.depP = '';
    }
    changed = true;
  }
  if (changed) {
    // Обновляем DOM немедленно чтобы не было старых значений пока OSRM отвечает
    data.stops.forEach(function(s, i) {
      if (i <= idx) return;
      var planEl = document.getElementById('planned-arr-' + s.id);
      if (planEl) planEl.textContent = '—';
      var depPlanEl = document.getElementById('planned-dep-' + s.id);
      if (depPlanEl && !s.depP) { depPlanEl.textContent = '—'; var depBlk = document.getElementById('dep-block-' + s.id); if (depBlk && !s.depA) depBlk.style.display = 'none'; }
    });
    autoFillTimes(day);
  }
}

// ── PROGRESS + DELTAS ─────────────────────────────────────────────────────────
function reachedRouteStopCount(stops) {
  return stops.findLastIndex(stop => _parseTime(stop.arrA) !== null || _parseTime(stop.depA) !== null) + 1;
}

function updateRouteProgress(day, gpsFraction) {
  if (!Number.isFinite(gpsFraction)) gpsFraction = typeof routeDriveFraction === 'function' ? routeDriveFraction(day) : 0;
  const fill = document.getElementById('d' + day + '-fill');
  if (!fill) return;
  const data = DAYS_DATA[day];
  const reached = reachedRouteStopCount(data.stops);
  const totalKm = getDayRouteKm(day);
  const markedKm = data.walkReview ? totalKm : reached ? getDayRouteKm(day, reached) : 0;
  const fraction = Math.max(gpsFraction, totalKm ? markedKm / totalKm : reached / (data.stops.length || 1));
  const km = totalKm * fraction;
  fill.parentElement.style.setProperty('--route-progress', (fraction * 100) + '%');
  const color = data.color || '#f5a623';
  fill.style.background = 'linear-gradient(90deg,' + color + ',' + color + '99)';
  document.getElementById('d' + day + '-pct').textContent = km.toLocaleString('ru', {maximumFractionDigits: 1}) + ' км';
}

function updateProgress() {
  dayKeys().forEach(day => {
    const stops = DAYS_DATA[day].stops;
    let lastDelta = null;
    stops.forEach(s => {
      const dArr = timeDelta(s.arrP, s.arrA);
      if (dArr !== null) lastDelta = dArr;
      const dDep = timeDelta(s.depP, s.depA);
      if (dDep !== null) lastDelta = dDep;
    });
    updateRouteProgress(day);

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

  // ── Distance: фактическое по маршруту из OSRM кэша, fallback haversine ──
  var km = (typeof getDayRouteKm === 'function') ? getDayRouteKm(d) : 0;
  if (!km && !data.walkReview) {
    const pts2 = [
      { lat: data.start.lat, lng: data.start.lng },
      ...data.stops.map(s => ({ lat: s.lat, lng: s.lng }))
    ];
    let hkm = 0;
    for (let i = 1; i < pts2.length; i++) {
      if (pts2[i-1].lat && pts2[i].lat) hkm += haversineKm(pts2[i-1].lat, pts2[i-1].lng, pts2[i].lat, pts2[i].lng);
    }
    km = hkm;
  }
  let kmStr = '';
  if (km > 0) {
    if (data.walkMode && km < 10) {
      const m = Math.round(km * 1000);
      kmStr = m >= 1000 ? (Math.round(km * 10) / 10) + ' км' : m + ' м';
    } else {
      kmStr = Math.round(km) + ' км';
    }
  }
  kmEl.textContent = kmStr ? 'В ПУТИ · ' + kmStr : 'В ПУТИ';
}

// ── STOP CARD ─────────────────────────────────────────────────────────────────
function makeStopCard(s, day) {
  const depBlock  = `
    <div class="time-block" id="dep-block-${s.id}"${(!s.depP && !s.depA) ? ' style="display:none"' : ''}>
      <div class="time-block-label">Отправление</div>
      <div class="time-inputs">
        <div class="time-input-wrap">
          <div class="time-mini-label">план</div>
          <div class="planned-time" id="planned-dep-${s.id}">${s.depP || '—'}</div>
        </div>
        <div class="delta-wrap">
          <span class="delta-badge hidden" id="delta-dep-${s.id}">→</span>
        </div>
        <div class="time-input-wrap">
          <div class="time-mini-label">факт</div>
          <input class="time-in ${s.depA ? '' : 'empty'}" id="dep-${s.id}"
            type="text" inputmode="numeric" maxlength="5" value="${s.depA || ''}" placeholder="${s.depP || '--:--'}"
            autocomplete="nope"
            ${isAdmin() ? `onfocus="this.dataset.prevVal=this.value" oninput="applyMask(this)" onblur="padTime(this)" ondblclick="fillOnTime(this)"` : `readonly style="pointer-events:none;border-style:solid;"`}>
        </div>
      </div>
    </div>`;

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
    <div class="stop-dropdown" id="dd-${s.id}">
      ${isAdmin() ? `
      <button class="stop-dropdown-item new-stop" onclick="closeStopMenus(); openInlineAddStop('${s.id}', ${day});">${dayActionIcon('plus')} Добавить точку</button>
      <div class="stop-dropdown-divider"></div>
      <button class="stop-dropdown-item" onclick="closeStopMenus(); editStop('${s.id}', ${day});">${dayActionIcon('edit')} Редактировать</button>
      <button class="stop-dropdown-item" onclick="closeStopMenus(); editStopTime('${s.id}', ${day});">${dayActionIcon('clock')} Изменить время</button>
      <button class="stop-dropdown-item" onclick="closeStopMenus(); addStopNote('${s.id}', ${day});">${dayActionIcon('note')} Добавить заметку</button>
      <div class="stop-dropdown-divider"></div>
      <button class="stop-dropdown-item danger" onclick="closeStopMenus(); deleteStop(${day}, '${s.id}');">${dayActionIcon('delete')} Удалить точку</button>` : ''}
    </div>
    <div class="stop-main" id="stop-main-${s.id}">
      <div class="stop-num">${s.num}</div>
      <div class="stop-info">
        <div class="stop-name">
          <span class="stop-icon" id="stop-icon-disp-${s.id}">${pointIconMarkup(s.icon, s.type)}</span>
          <span class="stop-name-text" id="stop-name-disp-${s.id}">${s.name}</span>
          <span class="stop-type" id="stop-type-disp-${s.id}">${s.type}</span>
          <span class="weather-badge" id="wb-${s.id}" style="display:none" onclick="event.stopPropagation();toggleWeatherStrip('${s.id}')"></span>
        </div>
      </div>
      ${isAdmin() ? `<button class="dots-btn" id="dots-${s.id}" aria-label="Действия с точкой" onclick="toggleStopMenu('${s.id}', ${day}); event.stopPropagation();">${dayActionIcon('dots')}</button>` : ''}
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
              autocomplete="nope"
              ${isAdmin() ? `onfocus="this.dataset.prevVal=this.value" oninput="applyMask(this)" onblur="padTime(this)" ondblclick="fillOnTime(this)"` : `readonly style="pointer-events:none;border-style:solid;"`}>
          </div>
        </div>
      </div>
      ${depBlock}
    </div>
    <div class="weather-strip" id="ws-${s.id}" style="display:none" onclick="event.stopPropagation();toggleWeatherStrip('${s.id}')"></div>
    <div class="stop-edit-form" id="edit-form-${s.id}" style="display:none;"></div>
    <div class="stop-edit-form" id="add-form-${s.id}" style="display:none;"></div>
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
          html += '<button type="button" class="stop-note-close-btn" onmousedown="event.preventDefault()" onclick="cancelStopNoteEdit(\''+s.id+'\','+day+','+i+')" title="Закрыть без сохранения" aria-label="Закрыть заметку без сохранения">'+dayActionIcon('close')+'</button>';
          html += '<textarea class="stop-note-input" id="stop-note-'+s.id+'-'+i+'" placeholder="Заметка к точке…" style="touch-action:auto" oninput="autoResizeNote(this)" onfocus="var c=this.closest(\'.stop-card\');if(c)c.draggable=false" ontouchstart="event.stopPropagation()" ontouchmove="event.stopPropagation()" onmousedown="event.stopPropagation()">'+_e(n.text||'')+'</textarea>';
          html += '<div class="note-images-inline" id="stop-note-edit-images-'+s.id+'-'+i+'">';
          if (n.images && n.images.length) n.images.forEach(function(url,j){
            html += '<div class="note-img-thumb-wrap">'+_noteImgTag(url,' onclick="event.stopPropagation();openChatPhoto(this)"')+'<button class="pending-thumb-remove" onclick="event.stopPropagation();removePendingStopImage(\''+s.id+'\','+i+','+j+')">×</button></div>';
          });
          html += '</div>';
          html += '<div class="stop-note-toolbar">';
          html += '<button class="note-vis-btn '+(n.public?'note-vis-on':'')+'" onmousedown="event.preventDefault()" onclick="toggleNotePublic(\''+s.id+'\','+i+','+day+')" title="'+(n.public?'Видна читателю':'Скрыта от читателя')+'">'+(n.public?eyeOn:eyeOff)+'</button>';
          html += '<button class="stop-note-photo-btn" onmousedown="event.preventDefault()" onclick="triggerStopNotePhoto(\''+s.id+'\','+day+','+i+')" title="Добавить фото">'+dayActionIcon('camera')+'</button>';
          var _hasOfflineImgs = n.images && n.images.some(function(r){return r&&r.startsWith('data:');});
          var _offChk = (_hasOfflineImgs || (typeof _pendingStopOffline !== 'undefined' && _pendingStopOffline[s.id+'-'+i])) ? ' checked' : '';
          var _offHintStyle = _offChk ? '' : 'display:none';
          html += '<label class="stop-note-offline-label"><input type="checkbox" role="switch" onchange="setStopNoteOffline(\''+s.id+'\','+i+',this.checked);var h=document.getElementById(\'offline-hint-'+s.id+'-'+i+'\');if(h)h.style.display=this.checked?\'block\':\'none\'"'+_offChk+'><span class="stop-note-offline-track" aria-hidden="true"></span><span>Фото офлайн</span></label>';
          html += '<div style="flex:1"></div>';
          html += '<button class="stop-note-del-btn" onmousedown="event.preventDefault()" onclick="deleteStopNote(\''+s.id+'\','+day+','+i+')" title="Удалить заметку" aria-label="Удалить заметку">'+dayActionIcon('delete')+'<span>Удалить</span></button>';
          html += '<button class="stop-note-save-btn" onmousedown="event.preventDefault()" onclick="commitStopNote(\''+s.id+'\','+day+','+i+')" title="Сохранить" aria-label="Сохранить заметку">'+dayActionIcon('check')+'</button>';
          html += '</div>';
          html += '<div id="offline-hint-'+s.id+'-'+i+'" class="stop-note-offline-hint" style="'+_offHintStyle+'">⚠️ Фото в Gist: 800px, сжатие. Лимит ~14 фото.</div>';
          html += '</div></div>';
          if (hasContent) {
            var _adminReact = typeof buildNoteReactHtml === 'function' ? buildNoteReactHtml(s.id, i) : null;
            html += '<div class="stop-note-display" id="stop-note-preview-'+s.id+'-'+i+'" style="cursor:pointer" onclick="openStopNoteEdit(\''+s.id+'\','+i+')" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()">';
            html += '<div class="stop-note-display-inner"><div id="stop-note-text-'+s.id+'-'+i+'">'+_l(n.text||'').replace(/\n/g,'<br>')+'</div>';
            html += '<div class="note-images-inline" id="stop-note-images-'+s.id+'-'+i+'">';
            if (n.images && n.images.length) n.images.forEach(function(url){
              html += '<div class="note-img-thumb-wrap">'+_noteImgTag(url,' onclick="event.stopPropagation();openChatPhoto(this)"')+'</div>';
            });
            html += '</div>';
            if (_adminReact) html += _adminReact.row;
            html += '</div>';
            html += '<button class="note-vis-btn '+(n.public?'note-vis-on':'')+'" onclick="event.stopPropagation();toggleNotePublic(\''+s.id+'\','+i+','+day+')" title="'+(n.public?'Видна читателю':'Скрыта от читателя')+'">'+(n.public?eyeOn:eyeOff)+'</button>';
            html += '</div>';
          }
          html += '</div>';
        } else {
          var _react = typeof buildNoteReactHtml === 'function' ? buildNoteReactHtml(s.id, i) : null;
          html += '<div class="stop-note-item">';
          html += '<div class="stop-note-display stop-note-readonly">';
          html += '<div class="stop-note-display-inner"><div>'+_l(n.text||'').replace(/\n/g,'<br>')+'</div>';
          html += '<div class="note-images-inline">';
          if (n.images && n.images.length) n.images.forEach(function(url){
            html += '<div class="note-img-thumb-wrap">'+_noteImgTag(url,' onclick="event.stopPropagation();openChatPhoto(this)"')+'</div>';
          });
          html += '</div>';
          if (_react) html += _react.row;
          html += '</div>';
          if (_react) html += _react.btn;
          html += '</div></div>';
        }
      });
      html += '</div>';
      return html;
    })()}`;

  if (typeof _resolveImgsInEl === 'function') _resolveImgsInEl(div);

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
  if (typeof discardInlinePlanTimeForDay === 'function') discardInlinePlanTimeForDay(day);
  const container = document.getElementById('d' + day + '-stops');
  container.innerHTML = '';
  DAYS_DATA[day].stops.forEach((s, i) => { s.num = i + 1; });
  if (DAYS_DATA[day].stops.length === 0 && typeof isAdmin === 'function' && isAdmin()) {
    var emptyBtn = document.createElement('div');
    emptyBtn.style.cssText = 'padding:12px 14px;';
    emptyBtn.innerHTML = '<button style="width:100%;height:34px;border-radius:6px;border:1px dashed var(--border);background:transparent;color:var(--amber);font-family:var(--font-ui);font-size:12px;cursor:pointer;" onclick="openInlineAddFirstStop(' + day + ')">＋ Добавить первую точку</button>';
    container.appendChild(emptyBtn);
  } else {
    DAYS_DATA[day].stops.forEach(s => container.appendChild(makeStopCard(s, day)));
  }
  const cntEl = document.getElementById('d' + day + '-stop-count');
  if (cntEl) cntEl.textContent = DAYS_DATA[day].stops.length;
  if (typeof _reapplyDayWeather === 'function') _reapplyDayWeather(day);
}

// ── DAY SECTION ───────────────────────────────────────────────────────────────
function dayActionIcon(name) {
  if(name === 'walk' && typeof gpsWalkerGlyph === 'function') return '<span class="day-action-icon walk-action-glyph">' + gpsWalkerGlyph(typeof walkIconStyle === 'function' ? walkIconStyle() : 'person') + '</span>';
  const paths = {
    routeLeft:'<path d="M17 21V10a4 4 0 0 0-4-4H4m5-4L4 6l5 4"/>',
    routeRight:'<path d="M7 21V10a4 4 0 0 1 4-4h9m-5-4 5 4-5 4"/>',
    routeStraight:'<path d="M12 21V4M6 10l6-6 6 6"/>',
    routeRampLeft:'<path d="M18 21V4M18 19c0-7-5-11-13-13m1 6L5 6l6-2"/>',
    routeRampRight:'<path d="M6 21V4m0 15c0-7 5-11 13-13m-1 6 1-6-6-2"/>',
    routeUturn:'<path d="M19 21V9a7 7 0 0 0-14 0v7m-3-4 3 4 4-4"/>',
    routeCircle:'<path d="M20 9a8 8 0 1 0-3 9m3-15v6h-6"/>',
    weather:'<circle cx="9" cy="8" r="3"/><path d="M9 1v1M2 8H1M3 2l1 1M15 2l-1 1M18 12a5 5 0 0 0-9-1 4 4 0 1 0-1 8h10a3.5 3.5 0 0 0 0-7Z"/>',
    reverse:'<path d="m8 3-4 4 4 4M4 7h16M16 13l4 4-4 4M20 17H4"/>',
    archive:'<path d="M4 8v12h16V8M3 3h18v5H3zM9 12h6"/>',
    import:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    reset:'<path d="M3 10a9 9 0 1 1 1 8M3 3v7h7"/>',
    delete:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    navigate:'<path d="m21 3-7 18-3-8-8-3Z"/>',
    more:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
    car:'<path d="M3 16H2v-4l4-1 3-5h7l3 6 3 1v4h-3M7 17h8M6 11h13M13 6v5"/><circle cx="5" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
    walk:'<circle cx="14" cy="4" r="2"/><path d="m7 21 3-7m6 7-2-6-3-3 2-5 3 4h4M7 12l2-4 4-1"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    edit:'<path d="m16 3 5 5-12 12-6 1 1-6Z M13 6l5 5"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    note:'<path d="M14 3H5v18h14V8ZM14 3v5h5M8 12h8M8 16h6"/>',
    map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2ZM9 3v16M15 5v16"/>',
    arrow:'<path d="M7 17 17 7M7 7h10v10"/>',
    copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    stop:'<rect x="5" y="5" width="14" height="14" rx="3"/>',
    play:'<path d="m8 5 12 7-12 7Z"/>',
    pause:'<path d="M9 5v14M15 5v14"/>',
    dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    camera:'<path d="M8 6l2-3h4l2 3h5v15H3V6Z"/><circle cx="12" cy="13" r="4"/>',
    send:'<path d="m22 2-7 20-4-9-9-4ZM11 13 22 2"/>',
    smile:'<circle cx="12" cy="12" r="9"/><path d="M8 14a4.5 4.5 0 0 0 8 0"/><circle cx="8.5" cy="9" r="1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="9" r="1" fill="currentColor" stroke="none"/>',
    bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    mute:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18M10 21h4M3 3l18 18"/>',
    pin:'<path d="m16 3 5 5-4 2-2 5-6-6 5-2ZM9 15l-6 6"/>',
    cart:'<path d="M2 3h3l3 12h11l3-8H6M9 21h.01M18 21h.01"/>',
    box:'<path d="m3 6 9-4 9 4v12l-9 4-9-4ZM3 6l9 4 9-4M12 10v12M8 4l9 4"/>',
    check:'<path d="m5 12 4 4L20 5"/>',
    reply:'<path d="m9 4-6 6 6 6M3 10h10a7 7 0 0 1 7 7v3"/>',
    undo:'<path d="m9 5-5 5 5 5M4 10h10a5 5 0 0 1 0 10h-3"/>',
    chat:'<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0ZM7 10h10M7 14h6"/>',
    palette:'<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4c-1-1 0-3 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-8Z"/><circle cx="7" cy="9" r=".8" fill="currentColor"/><circle cx="11" cy="6.5" r=".8" fill="currentColor"/><circle cx="16" cy="8" r=".8" fill="currentColor"/><circle cx="6.5" cy="14" r=".8" fill="currentColor"/>',
    settings:'<path fill="currentColor" fill-rule="evenodd" stroke="none" d="M19.43 12.98a7.2 7.2 0 0 0 0-1.96l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.8 7.8 0 0 0-1.68-.98l-.38-2.65a.5.5 0 0 0-.49-.42h-4a.5.5 0 0 0-.49.42l-.38 2.65a7.8 7.8 0 0 0-1.68.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65a7.2 7.2 0 0 0 0 1.96l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.07.73 1.68.98l.38 2.65a.5.5 0 0 0 .49.42h4a.5.5 0 0 0 .49-.42l.38-2.65a7.8 7.8 0 0 0 1.68-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
    fuel:'<path d="M4 21V4h10v17M2 21h14M4 11h10M17 5l4 4v8a2 2 0 0 1-4 0v-4h-3M18 6v4h3"/>',
    cafe:'<path d="M4 8h13v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4ZM17 9h2a3 3 0 0 1 0 6h-2M7 3v2M11 2v3M15 3v2"/>',
    hotel:'<path d="M4 22V3h16v19M9 22v-5h6v5M8 7h1M15 7h1M8 11h1M15 11h1M2 22h20"/>',
    home:'<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7"/>',
    location:'<path d="M20.5 10c0 6-8.5 12-8.5 12S3.5 16 3.5 10a8.5 8.5 0 1 1 17 0Z"/><circle cx="12" cy="10" r="3"/>'
  };
  return '<svg class="day-action-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (name === 'car' || name === 'walk' ? '2.4' : '1.7') + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
}
// Category-specific vector choices. Tokens remain stable in saved routes and publications.
const POINT_GRAPHICS = {

  coffee:["Кафе","Кофе","☕","<path/>"],
  burger:["Кафе","Бургер","🍔",'<path/>'],
  pizza:["Кафе","Пицца","🍕",'<path/>'],
  pancakes:["Кафе","Блины и завтрак","🥞",'<path/>'],
  soup:["Кафе","Суп","🍜",'<path/>'],
  sushi:["Кафе","Суши и роллы","🍣",'<path/>'],
  salad:["Кафе","Салат","🥗",'<path/>'],
  privateHouse:["Жильё","Частный дом","🏠",'<path/>'],
  gardenHouse:["Жильё","Дом с деревьями","🏡",'<path/>'],
  highRise:["Жильё","Высотки","🏙️","<path/>"],
  townhouse:["Жильё","Таунхаусы","🏘️",'<path/>'],
  woodCabin:["Жильё","Деревянный дом","🛖",'<path/>'],
  villa:["Жильё","Современный дом","🏡",'<path/>'],
  hotelBuilding:["Отель","Отель","🏨",'<path/>'],
  motel:["Отель","Мотель","🏨",'<path/>'],
  resort:["Отель","Курортный отель","🏝️",'<path/>'],
  hotelCabin:["Отель","Гостевой дом","🏡",'<path/>'],
  keycard:["Отель","Карта от номера","💳",'<path/>'],
  mapPin:["Другое","Геометка","📍",'<path/>'],
  waterfall:["Другое","Водопад","🏞️",'<path/>'],
  categoryFuel:["Заправка","Топливная колонка","⛽","<path/>"],
  categoryShop:["Магазин","Тележка","🛒","<path/>"],
  bricks:['Магазин','Стройматериалы','🧱',"<path fill=\"#d98967\" fill-opacity=\".3\" d=\"M2 4h20v16H2Z\"/><path d=\"M2 4h20v16H2ZM2 9h20M2 15h20M8 4v5M16 9v6M8 15v5\"/>"],
  hardware:['Магазин','Инструменты','🛠️',"<path stroke=\"#c6d3dc\" d=\"m4 20 9-10M15 3l-4 4 6 6 4-4-3-1V4Z\"/><path stroke=\"#e6ac65\" d=\"m3 4 4 4M3 3l3 1 2 3-2 2-3-3ZM9 10l11 11\"/>"],
  powerDrill:['Магазин','Электроинструменты','🔧',"<path fill=\"#efbd55\" fill-opacity=\".3\" d=\"M3 5h13v8h-5l-1 8H5l2-8H3Z\"/><path d=\"M3 5h13v8h-5l-1 8H5l2-8H3ZM16 7h4v4h-4M20 9h3\"/><path stroke=\"#c6d3dc\" d=\"M6 8h4\"/>"],
  paintRoller:['Магазин','Краски и отделка','🎨',"<path fill=\"#87baca\" fill-opacity=\".3\" d=\"M3 3h15v7H3Z\"/><path d=\"M3 3h15v7H3ZM18 6h3v8h-9v3\"/><path stroke=\"#e5ae72\" stroke-width=\"4\" d=\"M12 18v4\"/>"],
  fasteners:['Магазин','Крепёж','🔩',"<path d=\"m7 3 4 4-4 4-4-4ZM9 9l12 12M13 10l-3 3M16 13l-3 3M19 16l-3 3\"/><path stroke=\"#e5ae72\" d=\"M15 2h6v5h-6Z\"/>"],
  sofa:['Магазин','Диваны','🛋️',"<path fill=\"#aab8df\" fill-opacity=\".26\" d=\"M4 10V5h16v5M2 10h4v5h12v-5h4v10H2Z\"/><path d=\"M4 10V5h16v5M12 5v10M2 10h4v5h12v-5h4v10H2ZM5 20v2M19 20v2\"/>"],
  armchair:['Магазин','Кресла','🪑',"<path fill=\"#d9a484\" fill-opacity=\".25\" d=\"M6 11V3h12v8M3 10h4v6h10v-6h4v10H3Z\"/><path d=\"M6 11V3h12v8M3 10h4v6h10v-6h4v10H3ZM6 20v2M18 20v2\"/>"],
  wardrobe:['Магазин','Шкафы','🚪',"<path fill=\"#d7b17d\" fill-opacity=\".23\" d=\"M4 2h16v19H4Z\"/><path d=\"M4 2h16v19H4ZM12 2v19M6 21v1M18 21v1\"/><path stroke=\"#e8e6df\" d=\"M9 10v3M15 10v3\"/>"],
  desk:['Магазин','Столы и рабочее место','🪑',"<path fill=\"#d7b17d\" fill-opacity=\".25\" d=\"M2 8h20v4H2Z\"/><path d=\"M2 8h20v4H2ZM4 12v10M20 12v10M13 12v8h7M13 16h7\"/><path stroke=\"#d3dbe2\" d=\"M16 4h4M18 3v2\"/>"],
  furnitureBed:['Магазин','Мебель для спальни','🛏️',"<path fill=\"#9acac3\" fill-opacity=\".25\" d=\"M3 4h18v16H3Z\"/><path d=\"M3 21V4h18v17M3 16h18M7 8h4v4H7ZM14 8h4v4h-4ZM2 20h20\"/>"],
  homeLighting:['Магазин','Светильники','💡',"<path fill=\"#f2d182\" fill-opacity=\".3\" d=\"m7 3-4 10h18L17 3Z\"/><path d=\"m7 3-4 10h18L17 3ZM12 13v8M7 22h10\"/><path stroke=\"#fbe6ac\" d=\"M9 6 7 11\"/>"],
  parkLantern:['Парк','Фонарь · классический','🏮',"<path stroke=\"#c6ccd2\" d=\"M12 9v13M8 22h8M9 9h6l1-6H8ZM7 3h10M12 1v2\"/><path fill=\"#ffdc83\" stroke=\"#ffdc83\" stroke-width=\"1.4\" d=\"M10 5h4l-.4 2H10.4Z\"/>"],
  parkLanternDouble:['Парк','Фонарь · два рожка','🏮',"<path stroke=\"#c6ccd2\" d=\"M12 5v17M8 22h8M4 5h16M8 5q4-7 8 0M3 5l1 6h4l1-6M15 5l1 6h4l1-6\"/><path fill=\"#ffdc83\" stroke=\"#ffdc83\" stroke-width=\"1.4\" d=\"M5 7h2v2H5ZM17 7h2v2h-2Z\"/>"],
  parkLanternGlobe:['Парк','Фонарь · шар','💡',"<path stroke=\"#c6ccd2\" d=\"M12 12v10M8 22h8M10 12h4\"/><circle cx=\"12\" cy=\"7\" r=\"5\" fill=\"#ffe5a0\" stroke=\"#f2cf76\" stroke-width=\"2\"/><path stroke=\"#fff5d7\" stroke-width=\"1.4\" d=\"M9 6q0-2 2-2\"/>"],
  parkPath:['Парк','Извилистая дорожка','🏞️',"<path fill=\"#d6b78c\" fill-opacity=\".28\" stroke=\"#d6b78c\" stroke-width=\"2\" d=\"M10 2h4c-9 8 9 10 7 20H3C18 11 2 10 10 2Z\"/><path stroke=\"#8bcf89\" d=\"M3 4v5M1 7l2 2 2-2M21 8v6M19 12l2 2 2-2\"/>"],
  parkAlley:['Парк','Аллея','🌲',"<path stroke=\"#d6b78c\" fill=\"#d6b78c\" fill-opacity=\".2\" d=\"m11 3-5 19h12L13 3Z\"/><path fill=\"#8bcf89\" fill-opacity=\".25\" d=\"m4 3-3 7h6ZM20 3l-3 7h6ZM3 12l-3 6h6ZM21 12l-3 6h6Z\"/><path stroke=\"#c69a72\" stroke-width=\"1.8\" d=\"M4 10v3M20 10v3M3 18v4M21 18v4\"/>"],
  parkSignpost:['Парк','Парковый указатель','🪧',"<path stroke=\"#c69a72\" d=\"M12 2v20M8 22h8\"/><path fill=\"#8bcf89\" stroke=\"#8bcf89\" stroke-width=\"1.8\" d=\"M4 4h13l4 3-4 3H4Z\"/><path fill=\"#d6b78c\" stroke=\"#d6b78c\" stroke-width=\"1.8\" d=\"M20 12H7l-4 3 4 3h13Z\"/>"],
  lukoil:['Заправка','Лукойл','⛽','<rect x="1" y="1" width="22" height="22" rx="3"/>'],
  rosneft:['Заправка','Роснефть','⛽','<rect x="1" y="1" width="22" height="22" rx="3"/>'],
  gazpromneft:['Заправка','Газпромнефть','⛽','<rect x="1" y="1" width="22" height="22" rx="3"/>'],
  tatneft:['Заправка','Татнефть','⛽','<rect x="1" y="1" width="22" height="22" rx="3"/>'],
  neftmagistral:['Заправка','Нефтьмагистраль','⛽','<rect x="1" y="1" width="22" height="22" rx="3"/>'],
  shell:['Заправка','Shell','⛽','<rect x="1" y="1" width="22" height="22" rx="3"/>'],
  teboil:['Заправка','Teboil','⛽','<rect x="1" y="1" width="22" height="22" rx="3"/>'],
  charging:['Заправка','Зарядка','⚡','<path d="m13 2-8 12h6l-1 8 9-13h-6Z"/>'],
  service:['Заправка','Автосервис','🔧','<path d="M21 3a6 6 0 0 1-8 8L5 20a2 2 0 0 1-3-3l9-8a6 6 0 0 1 8-8l-4 4 4 2Z"/>'],
  parking:['Заправка','Парковка','🅿️','<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>'],
  dining:['Кафе','Ресторан','🍽️','<path d="M4 3v5a3 3 0 0 0 6 0V3M7 3v18M17 21V3c-4 3-4 9 0 9"/>'],
  bakery:['Кафе','Пекарня','🥐','<path d="m3 13 4-7 5-2 5 2 4 7-3 5-4-3h-4l-4 3ZM7 6l3 9M17 6l-3 9"/>'],
  takeaway:['Кафе','Еда с собой','🥤','<path d="M5 7h14M7 7l1 14h8l1-14M11 7l2-5h5M5 4h12"/>'],
  bag:['Магазин','Покупки','🛍️','<path d="M5 8h14l2 13H3ZM8 8V6a4 4 0 0 1 8 0v2"/>'],
  groceries:['Магазин','Продукты','🥑','<path d="M12 7c-8-6-12 6-6 13 2 2 4 0 6 0s4 2 6 0c6-7 2-19-6-13ZM12 7c0-4 2-5 5-5"/>'],
  pharmacy:['Магазин','Аптека','💊','<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 7v10M7 12h10"/>'],
  magnit:['Магазин','Магнит','🛒','<rect x="2" y="2" width="20" height="20" rx="4"/><path d="M6 17V7l6 6 6-6v10"/>'],
  pyaterochka:['Магазин','Пятёрочка','🛒','<path d="M17 6H8l-1 6h7a4 4 0 1 1-6 6M16 5q2-4 6-3-1 4-6 3Z"/>'],
  globus:['Магазин','Глобус','🛒','<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-6 5-6 13 0 18 6-5 6-13 0-18Z"/>'],
  dixy:['Магазин','Дикси','🛒','<rect x="2" y="2" width="20" height="20" rx="4"/><path d="M5 18v-3h14v3M7 15l2-8h6v8"/>'],
  metro:['Магазин','METRO','🛒','<rect x="1" y="4" width="22" height="16" rx="2"/>'],
  chizhik:['Магазин','Чижик','🐦','<path d="M4 8q2 2 4 2C9 3 17 3 19 8l3 1-2 2 1 1-2 1q-1 8-9 7l-4-2 2-1Q2 15 4 8Z"/>'],
  perekrestok:['Магазин','Перекрёсток','🛒','<path d="M12 12C2 13 2 3 8 3q5 0 4 9ZM12 12C11 2 21 2 21 8q0 5-9 4ZM12 12c10-1 10 9 4 9q-5 0-4-9ZM12 12c1 10-9 10-9 4q0-5 9-4Z"/>'],
  bed:['Отель','Ночлег','🛏️','<path d="M3 20V5M21 20V9H9v6M3 15h18M3 18h18"/><circle cx="6" cy="11" r="2"/>'],
  key:['Отель','Заселение','🔑','<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9M16 16l3-3M19 19l3-3"/>'],
  bellhop:['Отель','Ресепшен','🛎️','<path d="M3 18h18M5 15a7 7 0 0 1 14 0ZM12 8V5M10 5h4M3 21h18"/>'],
  apartment:['Жильё','Квартира','🏢','<path d="M5 21V3h14v18M9 7h1M14 7h1M9 11h1M14 11h1M10 21v-5h4v5"/>'],
  cottage:['Жильё','Загородный дом','🏡','<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7M16 5V2"/>'],
  camping:['Жильё','Кемпинг','⛺','<path d="m12 3-10 18h20ZM12 3v18M7 21l5-9 5 9"/>'],
  park:['Парк','Парк','🌳','<path d="m12 2-6 7h3l-5 6h6v7h4v-7h6l-5-6h3Z"/>'],
  tree:['Парк','Дерево','🌳','<path d="M12 14v8M8 22h8"/><path d="M7 16a4 4 0 0 1-3-7 5 5 0 0 1 8-6 5 5 0 0 1 8 6 4 4 0 0 1-3 7Z"/>'],
  leaves:['Парк','Листья','🍃','<path d="M4 20 19 5M9 15C2 15 2 5 20 3c0 13-4 17-11 12ZM10 14v-4M14 10h4"/>'],
  promenade:['Парк','Набережная','🌊','<path d="M3 3v8M11 3v8M19 3v8M3 5h16M3 9h16M2 13h20M2 17q2-2 4 0t4 0 4 0 4 0 4 0M2 21q2-2 4 0t4 0 4 0 4 0 4 0"/>'],
  bench:['Парк','Скамейка','🪑','<path d="M4 5h16v7H4ZM4 8.5h16M2 16h20M5 12v9M19 12v9"/>'],
  benchTree:['Парк','Скамейка у дерева','🌳','<path d="M2 12h12v5H2ZM1 19h14M3 19v3M12 19v3M19 11v11"/><path d="M17 12a3 3 0 0 1-2-5 4 4 0 0 1 7 0 3 3 0 0 1-2 5Z"/>'],
  benchArms:['Парк','Скамейка с подлокотниками','🪑','<path d="M5 5h14v7H5ZM5 8h14M4 16h16M4 12a2 2 0 0 0-2 2v3h20v-3a2 2 0 0 0-2-2M5 17l-1 5M19 17l1 5"/>'],
  gazebo:['Парк','Беседка · широкая крыша','🛖','<path d="m2 9 5-6h10l5 6ZM5 10v11M19 10v11M3 21h18M5 16h14M8 16v5M16 16v5"/>'],
  gazeboArch:['Парк','Беседка · арочный вход','🛖','<path d="m2 8 10-6 10 6ZM4 9v12M20 9v12M8 21v-6a4 4 0 0 1 8 0v6M2 21h20"/>'],
  picnic:['Парк','Столик для пикника','🧺','<path d="m3 7 12-4 6 4-12 4ZM2 14l12-4 3 2-12 4ZM11 17l10-4 1 2-8 4ZM7 11v9M18 9v11M4 16v5M15 19v3"/>'],
  playground:['Парк','Детская площадка','🛝','<path d="M3 21V8l5-5 5 5v13M3 8h10M3 13h6M3 17h6M13 11l6 10h3"/>'],
  bridge:['Парк','Мостик','🌉','<path d="M2 14h20M3 10q9-12 18 0M3 10v11M21 10v11M7 7v7M12 5v9M17 7v7M2 19q2-2 4 0t4 0 4 0 4 0 4 0"/>'],
  museum:['Другое','Музей','🏛️','<path d="m2 7 10-5 10 5ZM4 10v8M9 10v8M15 10v8M20 10v8M3 18h18M2 22h20"/>'],
  pool:['Другое','Бассейн','🏊','<path d="M7 15V5a2 2 0 0 1 4 0M15 15V5a2 2 0 0 1 4 0M7 7h8M7 11h8M2 17q2-2 4 0t4 0 4 0 4 0 4 0M2 21q2-2 4 0t4 0 4 0 4 0 4 0"/>'],
  beach:['Другое','Море / пляж','🏖️','<path d="M3 11a9 9 0 0 1 18 0ZM12 2c-3 3-3 6-3 9M12 2c3 3 3 6 3 9M12 11v8M3 21q5-4 10-2t8 0"/>'],
  mountains:['Другое','Горы','⛰️','<path d="m2 21 8-18 8 18ZM7 10l3 3 3-3M15 14l3-7 5 14"/>'],
  concert:['Другое','Концерт','🎤','<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8M10 6h4M10 9h4"/>']
};
const POINT_GRAPHIC_PAINT = {
  categoryShop:["#83d9ff","<defs><linearGradient id=\"real-categoryShop\" x2=\".6\" y2=\"1\"><stop stop-color=\"#527b8e\"/><stop offset=\"1\" stop-color=\"#2e4c60\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M3 6h6l7 29h24\" fill=\"none\" stroke=\"#b3cad3\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M11 11 45 9l-5 20-24 2Z\" fill=\"url(#real-categoryShop)\" /><path d=\"M16 15l25-1M18 22l22-2M24 13l2 15m8-16-1 15\" fill=\"none\" stroke=\"#c4e0ea\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><ellipse cx=\"20\" cy=\"41\" rx=\"4\" ry=\"4\" fill=\"#455b67\"/><ellipse cx=\"37\" cy=\"41\" rx=\"4\" ry=\"4\" fill=\"#455b67\"/><ellipse cx=\"19\" cy=\"40\" rx=\"1.5\" ry=\"1.5\" fill=\"#e7f0e1\"/><ellipse cx=\"36\" cy=\"40\" rx=\"1.5\" ry=\"1.5\" fill=\"#e7f0e1\"/><path d=\"m16 10 4-7 11 4 3 5Z\" fill=\"#ffd25c\" /><path d=\"m32 11 3-8 8 2-1 6Z\" fill=\"#7cda52\" /></g>"],
  categoryFuel:["#fb867b","<defs><linearGradient id=\"real-categoryFuel\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ed6d60\"/><stop offset=\"1\" stop-color=\"#a6383b\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M8 7h24v35H8Z\" fill=\"url(#real-categoryFuel)\" /><path d=\"m32 7 5 4v31h-5Z\" fill=\"#782c34\" /><path d=\"M8 7 12 2h21l-1 5Z\" fill=\"#ffaca0\" /><rect x=\"12\" y=\"10\" width=\"16\" height=\"12\" rx=\"1\" fill=\"#f2fbee\"/><rect x=\"15\" y=\"13\" width=\"10\" height=\"6\" rx=\"1\" fill=\"#2d4b5c\"/><rect x=\"13\" y=\"26\" width=\"14\" height=\"9\" rx=\"1\" fill=\"#ffdcae\"/><path d=\"M37 15h5v18q-1 5-5 0V22\" fill=\"none\" stroke=\"#506977\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m39 12 6 3-1 6-4-1Z\" fill=\"#e9efe6\" /><rect x=\"5\" y=\"42\" width=\"34\" height=\"4\" rx=\"1\" fill=\"#96a4a1\"/></g>"],
  waterfall:["#9be5dd","<defs><linearGradient id=\"real-waterfall\" x2=\".6\" y2=\"1\"><stop stop-color=\"#c2fffa\"/><stop offset=\"1\" stop-color=\"#58adc9\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 8 14 4l6 9 12-8 14 8v29H2Z\" fill=\"#7d947b\" /><path d=\"M14 7h14l-1 20q0 11 15 17H7q14-6 10-18Z\" fill=\"url(#real-waterfall)\" /><path d=\"M20 10v17m4-17v20M13 42q10-6 19 0\" fill=\"none\" stroke=\"#f7ffff\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m1 35 9-6 6 5-5 11H1ZM34 31l12 3v11H31Z\" fill=\"#547567\" /></g>"],
  mapPin:["#fb867b","<defs><linearGradient id=\"real-mapPin\" x2=\".6\" y2=\"1\"><stop stop-color=\"#f4786a\"/><stop offset=\"1\" stop-color=\"#bd343d\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M24 45C19 37 5 24 7 15Q9 0 24 1t17 14C44 25 29 40 24 45Z\" fill=\"url(#real-mapPin)\" /><ellipse cx=\"24\" cy=\"16\" rx=\"8\" ry=\"8\" fill=\"#71453f\"/><ellipse cx=\"24\" cy=\"16\" rx=\"5\" ry=\"5\" fill=\"#ffe5bf\"/><path d=\"M13 13q1-7 7-8\" fill=\"none\" stroke=\"#ffc7af\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  keycard:["#dbb9ff","<defs><linearGradient id=\"real-keycard\" x2=\".6\" y2=\"1\"><stop stop-color=\"#b1caeb\"/><stop offset=\"1\" stop-color=\"#6086b0\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M5 11 35 5l9 5-2 31-32 5-6-5Z\" fill=\"url(#real-keycard)\" /><path d=\"m5 11 31-6 6 5-32 6Z\" fill=\"#e4f3fb\" /><path d=\"m7 20 33-6v7L7 27Z\" fill=\"#2e4257\" /><rect x=\"14\" y=\"30\" width=\"10\" height=\"7\" rx=\"1\" fill=\"#ffdb92\"/><path d=\"m28 33 7-1\" fill=\"none\" stroke=\"#e2faff\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  hotelCabin:["#dbb9ff","<defs><linearGradient id=\"real-hotelCabin\" x2=\".6\" y2=\"1\"><stop stop-color=\"#f1d39f\"/><stop offset=\"1\" stop-color=\"#a0794c\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M6 23 24 10l16 12v20H6Z\" fill=\"#f8d7aa\" /><path d=\"m24 10 18 10v21l-10 3V22Z\" fill=\"#c4a178\" /><path d=\"M2 23 23 5l22 14-6 6-16-12L7 27Z\" fill=\"#7c8d66\" /><path d=\"m23 5 22 14-6 6-16-12Z\" fill=\"#974935\" /><path d=\"m6 22 17-14 17 11\" fill=\"none\" stroke=\"#feae7b\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"10\" y=\"27\" width=\"9\" height=\"9\" rx=\"1\" fill=\"#81bdcd\"/><rect x=\"23\" y=\"25\" width=\"7\" height=\"17\" rx=\"1\" fill=\"#9c633c\"/><path d=\"M14.5 28v7M11 31.5h7\" fill=\"none\" stroke=\"#ecfff8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"27\" y=\"32\" width=\"1\" height=\"2\" rx=\"0.5\" fill=\"#ffefb6\"/><path d=\"M4 41h31v3H4Z\" fill=\"#a08058\" /><rect x=\"18\" y=\"14\" width=\"11\" height=\"6\" rx=\"1\" fill=\"#7395a5\"/><path d=\"M21 15h2v1h2v-1h1v4h-1v-2h-2v2h-2Z\" fill=\"#ffffdf\" /></g>"],
  resort:["#dbb9ff","<defs><linearGradient id=\"real-resort\" x2=\".6\" y2=\"1\"><stop stop-color=\"#fff1bd\"/><stop offset=\"1\" stop-color=\"#c9ac87\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M7 7 31 3l11 6v34l-11 3-24-5Z\" fill=\"url(#real-resort)\" /><path d=\"m31 3 11 6v34l-11 3Z\" fill=\"#596781\" /><path d=\"M6 7 31 2l13 6-12 3Z\" fill=\"#dadae1\" /><rect x=\"11\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"19\" y=\"36\" width=\"10\" height=\"9\" rx=\"1\" fill=\"#49687e\"/><path d=\"M24 36v8\" fill=\"none\" stroke=\"#ede8cd\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"13\" y=\"4\" width=\"17\" height=\"7\" rx=\"1\" fill=\"#b187cf\"/><path d=\"M17 5h2v2h4V5h2v5h-2V8h-4v2h-2Z\" fill=\"#ffffe7\" /><path d=\"M1 44h46v4H1Z\" fill=\"#8bc7c0\" /><g transform=\"translate(-9 15) scale(0.6)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g></g>"],
  motel:["#dbb9ff","<defs><linearGradient id=\"real-motel\" x2=\".6\" y2=\"1\"><stop stop-color=\"#fadda9\"/><stop offset=\"1\" stop-color=\"#c2a384\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M3 20h42v22H3Z\" fill=\"url(#real-motel)\" /><path d=\"M1 17h46v6H1Z\" fill=\"#be744f\" /><rect x=\"7\" y=\"27\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"17\" y=\"27\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"27\" y=\"27\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"37\" y=\"27\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"20\" y=\"31\" width=\"7\" height=\"11\" rx=\"0\" fill=\"#5a8391\"/><rect x=\"4\" y=\"4\" width=\"11\" height=\"13\" rx=\"1\" fill=\"#92acbc\"/><path d=\"M7 7h2l1 4 1-4h2v7h-2v-3l-1 3-1-3v3H7Z\" fill=\"#ffffdd\" /><path d=\"M10 17v5\" fill=\"none\" stroke=\"#c8dddc\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  bellhop:["#ffe271","<defs><linearGradient id=\"real-bellhop\" x2=\".6\" y2=\"1\"><stop stop-color=\"#fff1a3\"/><stop offset=\"1\" stop-color=\"#bc7f28\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"24\" cy=\"40\" rx=\"21\" ry=\"4\" fill=\"#4f5f66\"/><path d=\"M5 35q0-25 19-25t19 25Z\" fill=\"url(#real-bellhop)\" /><rect x=\"20\" y=\"6\" width=\"8\" height=\"5\" rx=\"2\" fill=\"#d09e56\"/><ellipse cx=\"24\" cy=\"6\" rx=\"5\" ry=\"2\" fill=\"#ffe28b\"/><ellipse cx=\"24\" cy=\"35\" rx=\"21\" ry=\"4\" fill=\"#dab372\"/><path d=\"M12 28q1-9 7-12\" fill=\"none\" stroke=\"#ffffcd\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  key:["#ffe271","<defs><linearGradient id=\"real-key\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffef9d\"/><stop offset=\"1\" stop-color=\"#c68d3a\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"13\" cy=\"13\" rx=\"10\" ry=\"10\" fill=\"#b68739\"/><ellipse cx=\"12\" cy=\"11\" rx=\"9\" ry=\"9\" fill=\"url(#real-key)\"/><ellipse cx=\"12\" cy=\"11\" rx=\"4\" ry=\"4\" fill=\"#1f3d4f\"/><path d=\"m17 17 24 22-5 6-6-6 3-3-4-4-3 2-6-7Z\" fill=\"url(#real-key)\" /><path d=\"m19 19 17 19\" fill=\"none\" stroke=\"#ffffc5\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  hotelBuilding:["#dbb9ff","<defs><linearGradient id=\"real-hotelBuilding\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ebcba0\"/><stop offset=\"1\" stop-color=\"#ac7c52\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M7 7 31 3l11 6v34l-11 3-24-5Z\" fill=\"url(#real-hotelBuilding)\" /><path d=\"m31 3 11 6v34l-11 3Z\" fill=\"#705941\" /><path d=\"M6 7 31 2l13 6-12 3Z\" fill=\"#f3d6b0\" /><rect x=\"11\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"19\" y=\"36\" width=\"10\" height=\"9\" rx=\"1\" fill=\"#49687e\"/><path d=\"M24 36v8\" fill=\"none\" stroke=\"#ede8cd\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"11\" y=\"1\" width=\"21\" height=\"10\" rx=\"1\" fill=\"#204b63\"/><path d=\"M16 2.5h2.5v2.7h6V2.5H27v7h-2.5V7h-6v2.5H16Z\" fill=\"#ffffe7\" /></g>"],
  villa:["#b2e5d6","<defs><linearGradient id=\"real-villa\" x2=\".6\" y2=\"1\"><stop stop-color=\"#fdf9ea\"/><stop offset=\"1\" stop-color=\"#abb9b6\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M5 18 28 12l15 7v23L20 47 5 40Z\" fill=\"url(#real-villa)\" /><path d=\"M4 15 28 9l17 7v5l-25 6-16-7Z\" fill=\"#eae7ce\" /><path d=\"m20 27 25-6v21l-25 5Z\" fill=\"#b3c6be\" /><path d=\"M8 24h8v12H8ZM23 29l17-4v13l-17 4Z\" fill=\"#48879d\" /><path d=\"M31 28v12\" fill=\"none\" stroke=\"#c6e2e6\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><g transform=\"translate(-9 14) scale(0.56)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g></g>"],
  woodCabin:["#ebc287","<defs><linearGradient id=\"real-woodCabin\" x2=\".6\" y2=\"1\"><stop stop-color=\"#f9c279\"/><stop offset=\"1\" stop-color=\"#a36535\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M6 23 24 10l16 12v20H6Z\" fill=\"#d79d5b\" /><path d=\"m24 10 18 10v21l-10 3V22Z\" fill=\"#c4a178\" /><path d=\"M2 23 23 5l22 14-6 6-16-12L7 27Z\" fill=\"#587566\" /><path d=\"m23 5 22 14-6 6-16-12Z\" fill=\"#974935\" /><path d=\"m6 22 17-14 17 11\" fill=\"none\" stroke=\"#feae7b\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"10\" y=\"27\" width=\"9\" height=\"9\" rx=\"1\" fill=\"#81bdcd\"/><rect x=\"23\" y=\"25\" width=\"7\" height=\"17\" rx=\"1\" fill=\"#9c633c\"/><path d=\"M14.5 28v7M11 31.5h7\" fill=\"none\" stroke=\"#ecfff8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"27\" y=\"32\" width=\"1\" height=\"2\" rx=\"0.5\" fill=\"#ffefb6\"/><path d=\"M4 41h31v3H4Z\" fill=\"#a08058\" /><path d=\"M7 29h15M7 34h15M7 39h15\" fill=\"none\" stroke=\"#a36f3d\" stroke-width=\"1.1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  townhouse:["#cae9cc","<defs><linearGradient id=\"real-townhouse\" x2=\".6\" y2=\"1\"><stop stop-color=\"#fbd6a2\"/><stop offset=\"1\" stop-color=\"#b6875c\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"translate(17 0) scale(.66)\"><path d=\"M6 23 24 10l16 12v20H6Z\" fill=\"#ffdba8\" /><path d=\"m24 10 18 10v21l-10 3V22Z\" fill=\"#c4a178\" /><path d=\"M2 23 23 5l22 14-6 6-16-12L7 27Z\" fill=\"#68959d\" /><path d=\"m23 5 22 14-6 6-16-12Z\" fill=\"#974935\" /><path d=\"m6 22 17-14 17 11\" fill=\"none\" stroke=\"#feae7b\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"10\" y=\"27\" width=\"9\" height=\"9\" rx=\"1\" fill=\"#81bdcd\"/><rect x=\"23\" y=\"25\" width=\"7\" height=\"17\" rx=\"1\" fill=\"#9c633c\"/><path d=\"M14.5 28v7M11 31.5h7\" fill=\"none\" stroke=\"#ecfff8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"27\" y=\"32\" width=\"1\" height=\"2\" rx=\"0.5\" fill=\"#ffefb6\"/><path d=\"M4 41h31v3H4Z\" fill=\"#a08058\" /></g><g transform=\"translate(1 10) scale(.73)\"><path d=\"M6 23 24 10l16 12v20H6Z\" fill=\"#ffdba8\" /><path d=\"m24 10 18 10v21l-10 3V22Z\" fill=\"#c4a178\" /><path d=\"M2 23 23 5l22 14-6 6-16-12L7 27Z\" fill=\"#d47a4e\" /><path d=\"m23 5 22 14-6 6-16-12Z\" fill=\"#974935\" /><path d=\"m6 22 17-14 17 11\" fill=\"none\" stroke=\"#feae7b\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"10\" y=\"27\" width=\"9\" height=\"9\" rx=\"1\" fill=\"#81bdcd\"/><rect x=\"23\" y=\"25\" width=\"7\" height=\"17\" rx=\"1\" fill=\"#9c633c\"/><path d=\"M14.5 28v7M11 31.5h7\" fill=\"none\" stroke=\"#ecfff8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"27\" y=\"32\" width=\"1\" height=\"2\" rx=\"0.5\" fill=\"#ffefb6\"/><path d=\"M4 41h31v3H4Z\" fill=\"#a08058\" /></g></g>"],
  highRise:["#e1eefe","<defs><linearGradient id=\"real-highRise\" x2=\".6\" y2=\"1\"><stop stop-color=\"#9387ac\"/><stop offset=\"1\" stop-color=\"#5e5177\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"translate(0 9) scale(.76)\"><path d=\"M7 7 31 3l11 6v34l-11 3-24-5Z\" fill=\"url(#real-highRise)\" /><path d=\"m31 3 11 6v34l-11 3Z\" fill=\"#423c59\" /><path d=\"M6 7 31 2l13 6-12 3Z\" fill=\"#c4bfd0\" /><rect x=\"11\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"19\" y=\"36\" width=\"10\" height=\"9\" rx=\"1\" fill=\"#49687e\"/><path d=\"M24 36v8\" fill=\"none\" stroke=\"#ede8cd\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g><path d=\"M23 4 37 2l8 5v34l-8 4-14-5Z\" fill=\"#c8dae1\" /><path d=\"m37 2 8 5v34l-8 4Z\" fill=\"#534b69\" /><rect x=\"26\" y=\"8\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"32\" y=\"8\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"26\" y=\"14\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"32\" y=\"14\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"26\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"32\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"26\" y=\"26\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"32\" y=\"26\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"26\" y=\"32\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"32\" y=\"32\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/></g>"],
  gardenHouse:["#93edad","<defs><linearGradient id=\"real-gardenHouse\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffe6b0\"/><stop offset=\"1\" stop-color=\"#bf8e60\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"translate(-6 3) scale(0.65)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g><g transform=\"translate(25 4) scale(0.6)\"><rect x=\"21\" y=\"31\" width=\"5\" height=\"14\" rx=\"1\" fill=\"#9a693e\"/><path d=\"m24 2-12 17h6L7 31h8L4 40h40L33 30h7L30 18h6Z\" fill=\"#26754a\" /><path d=\"M24 2v36H8l12-9h-6l10-12h-6Z\" fill=\"#78be66\" /><path d=\"m24 14 7 13H25l9 10H24Z\" fill=\"#429a58\" /></g><g transform=\"translate(6 13) scale(.72)\"><path d=\"M6 23 24 10l16 12v20H6Z\" fill=\"#ffdba8\" /><path d=\"m24 10 18 10v21l-10 3V22Z\" fill=\"#c4a178\" /><path d=\"M2 23 23 5l22 14-6 6-16-12L7 27Z\" fill=\"#80a29a\" /><path d=\"m23 5 22 14-6 6-16-12Z\" fill=\"#974935\" /><path d=\"m6 22 17-14 17 11\" fill=\"none\" stroke=\"#feae7b\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"10\" y=\"27\" width=\"9\" height=\"9\" rx=\"1\" fill=\"#81bdcd\"/><rect x=\"23\" y=\"25\" width=\"7\" height=\"17\" rx=\"1\" fill=\"#9c633c\"/><path d=\"M14.5 28v7M11 31.5h7\" fill=\"none\" stroke=\"#ecfff8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"27\" y=\"32\" width=\"1\" height=\"2\" rx=\"0.5\" fill=\"#ffefb6\"/><path d=\"M4 41h31v3H4Z\" fill=\"#a08058\" /></g></g>"],
  cottage:["#93edad","<defs><linearGradient id=\"real-cottage\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffe6b0\"/><stop offset=\"1\" stop-color=\"#bf8e60\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"translate(22 5) scale(0.55)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g><g transform=\"translate(-1 8) scale(.82)\"><path d=\"M6 23 24 10l16 12v20H6Z\" fill=\"#ffdba8\" /><path d=\"m24 10 18 10v21l-10 3V22Z\" fill=\"#c4a178\" /><path d=\"M2 23 23 5l22 14-6 6-16-12L7 27Z\" fill=\"#ce784c\" /><path d=\"m23 5 22 14-6 6-16-12Z\" fill=\"#974935\" /><path d=\"m6 22 17-14 17 11\" fill=\"none\" stroke=\"#feae7b\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"10\" y=\"27\" width=\"9\" height=\"9\" rx=\"1\" fill=\"#81bdcd\"/><rect x=\"23\" y=\"25\" width=\"7\" height=\"17\" rx=\"1\" fill=\"#9c633c\"/><path d=\"M14.5 28v7M11 31.5h7\" fill=\"none\" stroke=\"#ecfff8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"27\" y=\"32\" width=\"1\" height=\"2\" rx=\"0.5\" fill=\"#ffefb6\"/><path d=\"M4 41h31v3H4Z\" fill=\"#a08058\" /></g><path d=\"M1 43h45v3H1Z\" fill=\"#649354\" /></g>"],
  privateHouse:["#7cf4c2","<defs><linearGradient id=\"real-privateHouse\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffe6b0\"/><stop offset=\"1\" stop-color=\"#bf8e60\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M6 23 24 10l16 12v20H6Z\" fill=\"#ffdba8\" /><path d=\"m24 10 18 10v21l-10 3V22Z\" fill=\"#c4a178\" /><path d=\"M2 23 23 5l22 14-6 6-16-12L7 27Z\" fill=\"#d06c47\" /><path d=\"m23 5 22 14-6 6-16-12Z\" fill=\"#974935\" /><path d=\"m6 22 17-14 17 11\" fill=\"none\" stroke=\"#feae7b\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"10\" y=\"27\" width=\"9\" height=\"9\" rx=\"1\" fill=\"#81bdcd\"/><rect x=\"23\" y=\"25\" width=\"7\" height=\"17\" rx=\"1\" fill=\"#9c633c\"/><path d=\"M14.5 28v7M11 31.5h7\" fill=\"none\" stroke=\"#ecfff8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"27\" y=\"32\" width=\"1\" height=\"2\" rx=\"0.5\" fill=\"#ffefb6\"/><path d=\"M4 41h31v3H4Z\" fill=\"#a08058\" /></g>"],
  salad:["#91cc69","<defs><linearGradient id=\"real-salad\" x2=\".6\" y2=\"1\"><stop stop-color=\"#e2f9c9\"/><stop offset=\"1\" stop-color=\"#72a871\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M4 24h40q-2 18-20 19Q8 42 4 24Z\" fill=\"url(#real-salad)\" /><ellipse cx=\"24\" cy=\"24\" rx=\"20\" ry=\"6\" fill=\"#fcffde\"/><ellipse cx=\"10\" cy=\"20\" rx=\"6\" ry=\"5\" fill=\"#b1dc6f\"/><ellipse cx=\"18\" cy=\"16\" rx=\"6\" ry=\"5\" fill=\"#85be50\"/><ellipse cx=\"27\" cy=\"18\" rx=\"6\" ry=\"5\" fill=\"#b1dc6f\"/><ellipse cx=\"37\" cy=\"21\" rx=\"6\" ry=\"5\" fill=\"#85be50\"/><ellipse cx=\"17\" cy=\"23\" rx=\"4\" ry=\"4\" fill=\"#f97c3e\"/><ellipse cx=\"31\" cy=\"23\" rx=\"4\" ry=\"4\" fill=\"#e96340\"/><path d=\"m23 15 4 4-4 3-3-3Z\" fill=\"#fff7c2\" /></g>"],
  sushi:["#ffac85","<defs><linearGradient id=\"real-sushi\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffc09e\"/><stop offset=\"1\" stop-color=\"#ec7c60\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 32 31 20l15 9-29 15Z\" fill=\"#516761\" /><path d=\"M8 23h13v9q-6 5-13 0Z\" fill=\"#2c4744\" /><ellipse cx=\"14.5\" cy=\"23\" rx=\"7\" ry=\"4\" fill=\"#fffff4\"/><ellipse cx=\"14.5\" cy=\"23\" rx=\"4\" ry=\"2.5\" fill=\"#fa966f\"/><ellipse cx=\"14.5\" cy=\"23\" rx=\"0.9\" ry=\"2\" fill=\"#7eab4c\"/><path d=\"M24 17h13v9q-6 5-13 0Z\" fill=\"#2c4744\" /><ellipse cx=\"30.5\" cy=\"17\" rx=\"7\" ry=\"4\" fill=\"#fffff4\"/><ellipse cx=\"30.5\" cy=\"17\" rx=\"4\" ry=\"2.5\" fill=\"#fa966f\"/><ellipse cx=\"30.5\" cy=\"17\" rx=\"0.9\" ry=\"2\" fill=\"#7eab4c\"/><path d=\"M25 30h13v9q-6 5-13 0Z\" fill=\"#2c4744\" /><ellipse cx=\"31.5\" cy=\"30\" rx=\"7\" ry=\"4\" fill=\"#fffff4\"/><ellipse cx=\"31.5\" cy=\"30\" rx=\"4\" ry=\"2.5\" fill=\"#fa966f\"/><ellipse cx=\"31.5\" cy=\"30\" rx=\"0.9\" ry=\"2\" fill=\"#7eab4c\"/><path d=\"m4 9 35 9m-32-5 34 9\" fill=\"none\" stroke=\"#f3c77e\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  soup:["#ffdb92","<defs><linearGradient id=\"real-soup\" x2=\".6\" y2=\"1\"><stop stop-color=\"#d2ecf3\"/><stop offset=\"1\" stop-color=\"#6eabb9\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"24\" cy=\"39\" rx=\"19\" ry=\"5\" fill=\"#c3d9d9\"/><path d=\"M4 20h40q-3 19-20 20T4 20Z\" fill=\"url(#real-soup)\" /><ellipse cx=\"24\" cy=\"20\" rx=\"21\" ry=\"7\" fill=\"#fdfff7\"/><ellipse cx=\"24\" cy=\"20\" rx=\"17\" ry=\"5\" fill=\"#f2b34d\"/><ellipse cx=\"16\" cy=\"20\" rx=\"4\" ry=\"2\" fill=\"#face75\"/><ellipse cx=\"30\" cy=\"19\" rx=\"3\" ry=\"2\" fill=\"#d47836\"/><path d=\"m22 17 3 5m-12-4 3 1m17 3 3-2\" fill=\"none\" stroke=\"#66963e\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M17 11q-4-3 0-6m10 5q-4-3 0-6\" fill=\"none\" stroke=\"#d8ede8\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  pancakes:["#edb565","<defs><linearGradient id=\"real-pancakes\" x2=\".6\" y2=\"1\"><stop stop-color=\"#f6d78a\"/><stop offset=\"1\" stop-color=\"#bb7a36\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"24\" cy=\"32\" rx=\"22\" ry=\"11\" fill=\"#8098a5\"/><ellipse cx=\"23\" cy=\"29\" rx=\"22\" ry=\"11\" fill=\"#e8eee5\"/><ellipse cx=\"23\" cy=\"29\" rx=\"17\" ry=\"7\" fill=\"#c5d6cf\"/><ellipse cx=\"24\" cy=\"31\" rx=\"16\" ry=\"6\" fill=\"#b47637\"/><ellipse cx=\"24\" cy=\"29\" rx=\"16\" ry=\"5\" fill=\"url(#real-pancakes)\"/><ellipse cx=\"24\" cy=\"26\" rx=\"16\" ry=\"6\" fill=\"#b47637\"/><ellipse cx=\"24\" cy=\"24\" rx=\"16\" ry=\"5\" fill=\"url(#real-pancakes)\"/><ellipse cx=\"24\" cy=\"21\" rx=\"16\" ry=\"6\" fill=\"#b47637\"/><ellipse cx=\"24\" cy=\"19\" rx=\"16\" ry=\"5\" fill=\"url(#real-pancakes)\"/><path d=\"M15 16q8-4 17-1l-2 4-3 13-4-1-1-12Z\" fill=\"#a56328\" /><path d=\"m20 12 9-1 3 6-10 1Z\" fill=\"#ffdf79\" /><ellipse cx=\"12\" cy=\"20\" rx=\"3\" ry=\"3\" fill=\"#b95746\"/></g>"],
  pizza:["#ffcc53","<defs><linearGradient id=\"real-pizza\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffeb78\"/><stop offset=\"1\" stop-color=\"#f9a927\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M5 6q23-6 39 12L13 45Z\" fill=\"#cf832b\" /><path d=\"M8 8q21-3 33 11L14 41Z\" fill=\"url(#real-pizza)\" /><path d=\"M5 6q23-6 39 12l-4 5Q26 8 6 12Z\" fill=\"#f1a64b\" /><ellipse cx=\"18\" cy=\"17\" rx=\"4\" ry=\"4\" fill=\"#e1512b\"/><ellipse cx=\"29\" cy=\"20\" rx=\"4\" ry=\"4\" fill=\"#d94727\"/><ellipse cx=\"18\" cy=\"30\" rx=\"4\" ry=\"4\" fill=\"#db4b29\"/><path d=\"m24 12 4 5-6 0ZM12 24l4 2-5 4Z\" fill=\"#6cac4e\" /></g>"],
  burger:["#ffb946","<defs><linearGradient id=\"real-burger\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffe472\"/><stop offset=\"1\" stop-color=\"#d27d12\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M3 23q0-19 22-19t21 19Z\" fill=\"url(#real-burger)\" /><path d=\"m12 13 3-1m7-4 3 1m8 3 3 1\" fill=\"none\" stroke=\"#ffffc1\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M2 23q5-5 10 0 5-4 11 0 6-4 12 0 6-4 11 0v5H2Z\" fill=\"#87c855\" /><path d=\"M4 27h40v5H4Z\" fill=\"#f3582f\" /><path d=\"M3 30h42v7H3Z\" fill=\"#723924\" /><path d=\"m6 28 14 8 14-8Z\" fill=\"#ffe449\" /><path d=\"M4 38h40q-2 10-20 8Q5 47 4 38Z\" fill=\"#f7a530\" /></g>"],
  takeaway:["#ffbf7c","<defs><linearGradient id=\"real-takeaway\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffda9e\"/><stop offset=\"1\" stop-color=\"#d58f52\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M9 13h29l-4 31H13Z\" fill=\"url(#real-takeaway)\" /><path d=\"M17 14h16l-3 28H19Z\" fill=\"#f8ca8b\" /><path d=\"M10 21h27l-1 13H12Z\" fill=\"#7a5f45\" /><ellipse cx=\"23\" cy=\"27\" rx=\"5\" ry=\"5\" fill=\"#dfbf95\"/><path d=\"M6 12h35v5H6ZM10 7h27l3 5H7Z\" fill=\"#3f505f\" /><path d=\"M14 9h17\" fill=\"none\" stroke=\"#919f96\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  bakery:["#ffc45c","<defs><linearGradient id=\"real-bakery\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffe57a\"/><stop offset=\"1\" stop-color=\"#cd6f1d\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"24\" cy=\"39\" rx=\"21\" ry=\"5\" fill=\"#dccaa3\"/><path d=\"M3 21q4-12 12-12 10-7 22 2 7 3 9 12l-10 10-8-5-8 1-8 5Z\" fill=\"url(#real-bakery)\" /><path d=\"m3 21 8 1 2 10-5-3ZM46 23l-10-1-1 10 6-3Z\" fill=\"#eb902e\" /><path d=\"M13 14l6 14M24 10l1 17M35 14l-5 14\" fill=\"none\" stroke=\"#c5691e\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M15 12q10-6 20 1\" fill=\"none\" stroke=\"#fffeb1\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  coffee:["#78b8c2","<defs><linearGradient id=\"real-coffee\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\".3\"><stop stop-color=\"#9dc3c8\"/><stop offset=\".35\" stop-color=\"#6d9ba8\"/><stop offset=\"1\" stop-color=\"#294f64\"/></linearGradient><radialGradient id=\"coffee-surface\"><stop stop-color=\"#8c5b35\"/><stop offset=\"1\" stop-color=\"#392417\"/></radialGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"17\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M32 17c17-3 16 19 1 18\" fill=\"none\" stroke=\"#d9ece8\" stroke-width=\"4.8\"/><path d=\"M33 17.4c13-1 12 14 1 14\" fill=\"none\" stroke=\"#f8fff7\" stroke-width=\"1.5\"/><path d=\"M9 13h26l-1 23c-.3 10-24 10-24 0Z\" fill=\"url(#real-coffee)\"/><path d=\"m13 20 .7 15c0 3 1 4 3 4\" fill=\"none\" stroke=\"#c5dcda\" stroke-width=\"1.1\" opacity=\".7\"/><ellipse cx=\"22\" cy=\"13\" rx=\"13\" ry=\"4.5\" fill=\"#f0e8d8\"/><ellipse cx=\"22\" cy=\"13\" rx=\"11\" ry=\"3\" fill=\"url(#coffee-surface)\"/><path d=\"M13 13q8-4 17-.5\" fill=\"none\" stroke=\"#cda169\" stroke-width=\".7\"/><path d=\"M19 6c-3-3 2-3 0-6m8 5c-2-2 1-3 0-5\" fill=\"none\" stroke=\"#e2ebe3\" stroke-width=\"1\" opacity=\".55\" stroke-linecap=\"round\"/><g fill=\"#d9ece8\"><circle cx=\"15\" cy=\"23\" r=\"1\"/><circle cx=\"23\" cy=\"23\" r=\"1\"/><circle cx=\"30\" cy=\"23\" r=\"1\"/><circle cx=\"18\" cy=\"30\" r=\"1\"/><circle cx=\"26\" cy=\"30\" r=\"1\"/><circle cx=\"15\" cy=\"36\" r=\"1\"/><circle cx=\"23\" cy=\"36\" r=\"1\"/><circle cx=\"30\" cy=\"36\" r=\"1\"/></g></g>"],
  leaves:["#9bf28c","<defs><linearGradient id=\"real-leaves\" x2=\".6\" y2=\"1\"><stop stop-color=\"#cdf97e\"/><stop offset=\"1\" stop-color=\"#32994b\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M5 37C0 10 17 5 42 4 43 27 29 39 5 37Z\" fill=\"url(#real-leaves)\" /><path d=\"M5 42 35 11M15 30l-3-10m11 2 9 1m-2-8-1-7\" fill=\"none\" stroke=\"#f8ffb8\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M25 39q8-13 22-12-1 18-22 12Z\" fill=\"#56bb63\" /></g>"],
  bricks:["#f1c07c","<defs><linearGradient id=\"shop-brick\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#ffb77a\"/><stop offset=\"1\" stop-color=\"#d54e2f\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"M3 29 19 22 35 29 19 36Z\" fill=\"#ffc590\" /><path d=\"M3 29v10l16 7V36Z\" fill=\"#e96f44\" /><path d=\"M19 36v10l16-7V29Z\" fill=\"#ad422b\" /><path d=\"M18 19 30 14 45 21 33 27Z\" fill=\"#ffb87a\" /><path d=\"M18 19v11l15 7V27Z\" fill=\"#e2683d\" /><path d=\"M33 27v10l12-5V21Z\" fill=\"#a23a27\" /><path d=\"M4 12 19 5 35 12 20 19Z\" fill=\"#ffd9a4\" /><path d=\"M4 12v11l16 8V19Z\" fill=\"url(#shop-brick)\" /><path d=\"M20 19v12l15-7V12Z\" fill=\"#b44629\" /><ellipse cx=\"15\" cy=\"11\" rx=\"3\" ry=\"1.5\" fill=\"#b14f33\"/><ellipse cx=\"23\" cy=\"12\" rx=\"3\" ry=\"1.5\" fill=\"#b14f33\"/><path d=\"m7 14 12 6M7 17l10 5m6 4 9-4\" fill=\"none\" stroke=\"#ffd69f\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  hardware:["#f1c07c","<defs><linearGradient id=\"shop-tools\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#ecfdff\"/><stop offset=\"1\" stop-color=\"#708da0\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"m8 39 24-25 5 5-23 25q-4 2-6-2Z\" fill=\"#879eaf\" /><path d=\"m8 37 24-25 3 3-24 25Z\" fill=\"#f1fdff\" /><path d=\"M31 15q-5-7 1-12l1 7 5 2 4-5q5 8-3 13l-6-2Z\" fill=\"url(#shop-tools)\" /><path d=\"m7 9 7-6 9 8-3 4-5-4-3 3Z\" fill=\"#e4eef6\" /><path d=\"m7 9 4 4 5-4-2-3Z\" fill=\"#fffffe\" /><path d=\"m18 13 22 24q2 4-2 6-2 1-4-1L14 17Z\" fill=\"#de8433\" /><path d=\"m19 16 19 22-2 2-19-22Z\" fill=\"#ffc876\" /><path d=\"m9 36 3 3M34 16l3 1\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  powerDrill:["#ffce47","<defs><linearGradient id=\"shop-drill\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#fff057\"/><stop offset=\"1\" stop-color=\"#e79500\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"M5 8 9 5h22l5 4-2 14H11l-6-5Z\" fill=\"url(#shop-drill)\" /><path d=\"M5 8h7v14l-6-4Z\" fill=\"#2e414c\" /><path d=\"M31 7h5l3 4v9l-5 3-3-3Z\" fill=\"#1e313d\" /><path d=\"M36 10h5v9h-5Z\" fill=\"#859ba9\" /><path d=\"M41 12h6v4h-6Z\" fill=\"#d3e5ee\" /><path d=\"m13 22 10 1-3 13H10Z\" fill=\"#ffbc15\" /><path d=\"m17 24 5 1-3 11h-5Z\" fill=\"#1e3039\" /><path d=\"M8 35h16l3 6-2 3H6l-1-4Z\" fill=\"#1e313a\" /><path d=\"m8 35 15 1 2 3H7Z\" fill=\"#ffd12a\" /><path d=\"M15 10h12M15 14h9\" fill=\"none\" stroke=\"#ffffc3\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M8 10v6\" fill=\"none\" stroke=\"#8c9da7\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"23\" y=\"21\" width=\"5\" height=\"5\" rx=\"1\" fill=\"#2e414c\" /></g>"],
  paintRoller:["#8acce1","<defs><linearGradient id=\"shop-roller\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#a2fef9\"/><stop offset=\"1\" stop-color=\"#1e9cad\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"M35 10h7v14H25v9\" fill=\"none\" stroke=\"#e4f4fa\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M42 12v11H25\" fill=\"none\" stroke=\"#7295ab\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"4\" y=\"5\" width=\"32\" height=\"14\" rx=\"5\" fill=\"url(#shop-roller)\" /><ellipse cx=\"5\" cy=\"12\" rx=\"2\" ry=\"6\" fill=\"#68bfcc\"/><ellipse cx=\"35\" cy=\"12\" rx=\"2\" ry=\"6\" fill=\"#2787a0\"/><path d=\"M10 8h19\" fill=\"none\" stroke=\"#e7ffff\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M10 16v6q1 4 3 0v-5M23 17v5q1 3 2 0v-6\" fill=\"#7febdf\" /><rect x=\"20\" y=\"30\" width=\"9\" height=\"14\" rx=\"3\" fill=\"#fbab56\" /><path d=\"M25 30h2q3 0 3 3v8q0 3-3 3h-2Z\" fill=\"#bb6d2d\" /><path d=\"M22 33v7\" fill=\"none\" stroke=\"#ffdc98\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  fasteners:["#d7e8f4","<defs><linearGradient id=\"shop-bolt\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#fcffff\"/><stop offset=\"1\" stop-color=\"#7991a7\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"m9 8 8-5 8 4-1 9-8 5-8-4Z\" fill=\"#9db5c2\" /><path d=\"m9 8 8-5 8 4-8 5Z\" fill=\"#ffffff\" /><path d=\"m17 12 8-5-1 9-8 5Z\" fill=\"#678498\" /><path d=\"m16 20 5-4 19 21-5 6Z\" fill=\"url(#shop-bolt)\" /><path d=\"m22 23 5-4m-1 8 5-4m-1 8 5-4m-1 8 5-4\" fill=\"none\" stroke=\"#4f7187\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m4 31 9-5 9 5v10l-9 5-9-5Z\" fill=\"#aabbc7\" /><path d=\"m4 31 9-5 9 5-9 5Z\" fill=\"#fbffff\" /><ellipse cx=\"13\" cy=\"31\" rx=\"3.5\" ry=\"2\" fill=\"#395469\"/><path d=\"M6 35v4m10-1v3\" fill=\"none\" stroke=\"#f1ffff\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  sofa:["#b7c9fb","<defs><linearGradient id=\"shop-sofa\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#c9c5ff\"/><stop offset=\"1\" stop-color=\"#716fc7\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"m6 33 5 1-1 9H6ZM36 34h4v8h-4Z\" fill=\"#ce9458\" /><path d=\"M4 15q0-5 6-5h29q4 0 5 4v20q0 5-5 5H8q-4 0-4-4Z\" fill=\"#555ea4\" /><rect x=\"7\" y=\"7\" width=\"31\" height=\"21\" rx=\"5\" fill=\"url(#shop-sofa)\" /><path d=\"m36 10 6 4v19l-6 3Z\" fill=\"#5f64b1\" /><rect x=\"9\" y=\"11\" width=\"12\" height=\"13\" rx=\"3\" fill=\"#b9b7f6\" /><rect x=\"23\" y=\"11\" width=\"12\" height=\"13\" rx=\"3\" fill=\"#a2a3e4\" /><path d=\"M9 25h26l5 6-4 5H9l-4-5Z\" fill=\"#c7c3ff\" /><path d=\"M22 25v8\" fill=\"none\" stroke=\"#8181c4\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"3\" y=\"21\" width=\"7\" height=\"16\" rx=\"3\" fill=\"#9ca1df\" /><rect x=\"35\" y=\"21\" width=\"8\" height=\"16\" rx=\"3\" fill=\"#8187cd\" /><path d=\"M5 23h3M37 23h4M11 13h7M25 13h6\" fill=\"none\" stroke=\"#f7f3ff\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M11 35h22\" fill=\"none\" stroke=\"#666fb5\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  armchair:["#f1c07c","<defs><linearGradient id=\"shop-chair\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#ffca8e\"/><stop offset=\"1\" stop-color=\"#bf6739\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"M10 32h5l-1 11h-4ZM32 32h4v11h-4Z\" fill=\"#9b6b43\" /><path d=\"M10 6q11-5 24 0l4 25-7 8H12l-6-8Z\" fill=\"#b16544\" /><path d=\"M12 5q10-4 20 0l3 20H9Z\" fill=\"url(#shop-chair)\" /><path d=\"M15 8q7-2 13 0l2 14H13Z\" fill=\"#f9b177\" /><path d=\"M17 9q5-2 9 0\" fill=\"none\" stroke=\"#ffebc0\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M10 26h24l3 6-5 6H12l-6-5Z\" fill=\"#ffc990\" /><path d=\"M4 20q3-2 6 0l3 16-5 3-4-3ZM34 20q4-2 8 1v14l-7 4-3-3Z\" fill=\"#d88956\" /><path d=\"m5 21 3-1 4 13-3 2Z\" fill=\"#ffd39e\" /><path d=\"m35 21 4 1-1 12-4 2Z\" fill=\"#f8b272\" /><path d=\"M15 34h15\" fill=\"none\" stroke=\"#c3774c\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  wardrobe:["#f1c07c","<defs><linearGradient id=\"shop-wardrobe\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#ffd69a\"/><stop offset=\"1\" stop-color=\"#cf8b4c\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"m5 5 28-3 10 5-1 35-8 3-29-3Z\" fill=\"#9a5f34\" /><path d=\"m5 5 28-3v39L5 39Z\" fill=\"url(#shop-wardrobe)\" /><path d=\"m33 2 10 5-1 35-9-1Z\" fill=\"#a76b34\" /><path d=\"m5 5 28-3 8 4-27 4Z\" fill=\"#ffeaba\" /><path d=\"m8 10 10-1v29L8 37Z\" fill=\"#f6c586\" /><path d=\"m20 9 10-1v30l-10 .5Z\" fill=\"#e9b072\" /><path d=\"M19 9v30\" fill=\"none\" stroke=\"#a66937\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m10 12 5-.6M22 11l5-.5\" fill=\"none\" stroke=\"#ffe0aa\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M15 21v6M24 21v6\" fill=\"none\" stroke=\"#fffff6\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M7 40h4v4H7ZM35 42h4v3h-4Z\" fill=\"#77492c\" /></g>"],
  desk:["#f1c07c","<defs><linearGradient id=\"shop-desk\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#ffdb9f\"/><stop offset=\"1\" stop-color=\"#c9884f\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"M6 20h4v23H6ZM35 16h4v25h-4Z\" fill=\"#8096a0\" /><path d=\"m8 22 2-2v22l-2 1ZM37 19l2-2v23l-2 1Z\" fill=\"#d9e8ef\" /><path d=\"M1 18 31 12 46 18 16 25Z\" fill=\"#ffe2ac\" /><path d=\"M1 18v4l15 7v-4ZM16 25l30-7v4l-30 7Z\" fill=\"#c07a46\" /><path d=\"m27 25 13-3v16l-13 3Z\" fill=\"#d49358\" /><path d=\"m29 26 9-2v5l-9 2ZM29 33l9-2v5l-9 2Z\" fill=\"#f4bd80\" /><path d=\"m32 28 3-.5m-3 7 3-.6\" fill=\"none\" stroke=\"#fff6d0\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m13 3 18-2v13l-18 3Z\" fill=\"#3b5a6c\" /><path d=\"m15 5 14-1v8l-14 2Z\" fill=\"#96d1e2\" /><path d=\"m23 14v4m-4 1 8-1\" fill=\"none\" stroke=\"#88a4b2\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m16 20 13-2 6 2-13 2Z\" fill=\"#e2f2f2\" /></g>"],
  furnitureBed:["#a1dfd6","<defs><linearGradient id=\"shop-bed\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#9fe5dd\"/><stop offset=\"1\" stop-color=\"#399ba2\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"M4 12 29 6l15 6v25l-27 8L3 36Z\" fill=\"#41757d\" /><path d=\"M4 8 28 3v17L4 27Z\" fill=\"#c9ac90\" /><path d=\"m7 10 18-4v12L7 23Z\" fill=\"#eacca9\" /><path d=\"M4 22 29 16 44 24 18 32Z\" fill=\"#fffffd\" /><path d=\"m4 22 14 10v10L4 33Z\" fill=\"#cef5ea\" /><path d=\"m18 32 26-8v11l-26 8Z\" fill=\"url(#shop-bed)\" /><path d=\"m8 18 9-3 6 3-9 4Z\" fill=\"#fffffc\" /><path d=\"m20 15 8-2 6 3-9 3Z\" fill=\"#ffffff\" /><path d=\"m5 27 13 8 26-8v8l-26 8-13-9Z\" fill=\"#65bab9\" /><path d=\"m20 34 21-6\" fill=\"none\" stroke=\"#b8f4e2\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M5 34h3v8H5ZM36 37h3v7h-3Z\" fill=\"#825d45\" /></g>"],
  homeLighting:["#ffe67f","<defs><linearGradient id=\"shop-lamp\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#fff6a4\"/><stop offset=\"1\" stop-color=\"#e2b068\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><ellipse cx=\"24\" cy=\"42\" rx=\"11\" ry=\"3\" fill=\"#363f47\"/><ellipse cx=\"23\" cy=\"40.5\" rx=\"10\" ry=\"2.5\" fill=\"#cad5ce\"/><rect x=\"22\" y=\"19\" width=\"3\" height=\"21\" rx=\"1\" fill=\"#8a9c98\" /><path d=\"M22.5 23v15\" fill=\"none\" stroke=\"#fffdd6\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M15 4q9-3 18 0l8 19q-17 6-34 0Z\" fill=\"url(#shop-lamp)\" /><path d=\"M15 4q9-3 18 0l2 5q-12-3-22 0Z\" fill=\"#fff1b4\" /><path d=\"m32 5 8 17-7 2-4-21Z\" fill=\"#d19e5c\" /><path d=\"m17 6-5 15 5 2 4-19Z\" fill=\"#ffffd2\" /><ellipse cx=\"24\" cy=\"23\" rx=\"17\" ry=\"3.4\" fill=\"#be925b\"/><ellipse cx=\"24\" cy=\"23.1\" rx=\"13\" ry=\"1.8\" fill=\"#ffffb6\"/><path d=\"M29 26v5\" fill=\"none\" stroke=\"#edc574\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  parkLantern:["#efce89","<defs><linearGradient id=\"real-parkLantern\" x2=\".6\" y2=\"1\"><stop stop-color=\"#b2c8c9\"/><stop offset=\"1\" stop-color=\"#3c5c6e\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><rect x=\"22\" y=\"14\" width=\"4\" height=\"29\" rx=\"1\" fill=\"url(#real-parkLantern)\"/><ellipse cx=\"24\" cy=\"43\" rx=\"8\" ry=\"2\" fill=\"#738893\"/><path d=\"M23 24v15\" fill=\"none\" stroke=\"#e7ecd4\" stroke-width=\"0.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><g transform=\"translate(24 5)\"><path d=\"m-7 2 7-5 7 5-2 13H-5Z\" fill=\"#6f868c\" /><path d=\"m-4 4 8 0-1 8h-6Z\" fill=\"#fffea6\" /><path d=\"M0 4v8\" fill=\"none\" stroke=\"#d0c28f\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M-8 2h16L4-2H-4Z\" fill=\"#44626f\" /></g></g>"],
  parkLanternDouble:["#efce89","<defs><linearGradient id=\"real-parkLanternDouble\" x2=\".6\" y2=\"1\"><stop stop-color=\"#b2c8c9\"/><stop offset=\"1\" stop-color=\"#3c5c6e\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><rect x=\"22\" y=\"14\" width=\"4\" height=\"29\" rx=\"1\" fill=\"url(#real-parkLanternDouble)\"/><ellipse cx=\"24\" cy=\"43\" rx=\"8\" ry=\"2\" fill=\"#738893\"/><path d=\"M23 24v15\" fill=\"none\" stroke=\"#e7ecd4\" stroke-width=\"0.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M11 9q13-10 26 0M24 7v8\" fill=\"none\" stroke=\"#849ea2\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><g transform=\"translate(11 10)\"><path d=\"m-7 2 7-5 7 5-2 13H-5Z\" fill=\"#6f868c\" /><path d=\"m-4 4 8 0-1 8h-6Z\" fill=\"#fffea6\" /><path d=\"M0 4v8\" fill=\"none\" stroke=\"#d0c28f\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M-8 2h16L4-2H-4Z\" fill=\"#44626f\" /></g><g transform=\"translate(37 10)\"><path d=\"m-7 2 7-5 7 5-2 13H-5Z\" fill=\"#6f868c\" /><path d=\"m-4 4 8 0-1 8h-6Z\" fill=\"#fffea6\" /><path d=\"M0 4v8\" fill=\"none\" stroke=\"#d0c28f\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M-8 2h16L4-2H-4Z\" fill=\"#44626f\" /></g></g>"],
  parkLanternGlobe:["#efce89","<defs><linearGradient id=\"real-parkLanternGlobe\" x2=\".6\" y2=\"1\"><stop stop-color=\"#b2c8c9\"/><stop offset=\"1\" stop-color=\"#3c5c6e\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><rect x=\"22\" y=\"19\" width=\"4\" height=\"29\" rx=\"1\" fill=\"url(#real-parkLanternGlobe)\"/><ellipse cx=\"24\" cy=\"43\" rx=\"8\" ry=\"2\" fill=\"#738893\"/><path d=\"M23 24v15\" fill=\"none\" stroke=\"#e7ecd4\" stroke-width=\"0.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><ellipse cx=\"24\" cy=\"12\" rx=\"10\" ry=\"11\" fill=\"#d0d8b9\"/><ellipse cx=\"23\" cy=\"11\" rx=\"8\" ry=\"9\" fill=\"#fffea7\"/><ellipse cx=\"20\" cy=\"7\" rx=\"3\" ry=\"3\" fill=\"#ffffe1\"/></g>"],
  parkPath:["#efc78f","<defs><linearGradient id=\"real-parkPath\" x2=\".6\" y2=\"1\"><stop stop-color=\"#fde3b3\"/><stop offset=\"1\" stop-color=\"#af9564\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M3 24q7-9 21-17 13 11 21 18v18H3Z\" fill=\"#599f5a\" /><path d=\"M22 6h6C6 22 44 22 38 45H10C44 27 6 25 22 6Z\" fill=\"url(#real-parkPath)\" /><path d=\"M24 10C11 23 42 24 29 41\" fill=\"none\" stroke=\"#fffdce\" stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><g transform=\"translate(-5 8) scale(0.45)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g><g transform=\"translate(28 13) scale(0.38)\"><rect x=\"21\" y=\"31\" width=\"5\" height=\"14\" rx=\"1\" fill=\"#9a693e\"/><path d=\"m24 2-12 17h6L7 31h8L4 40h40L33 30h7L30 18h6Z\" fill=\"#26754a\" /><path d=\"M24 2v36H8l12-9h-6l10-12h-6Z\" fill=\"#78be66\" /><path d=\"m24 14 7 13H25l9 10H24Z\" fill=\"#429a58\" /></g></g>"],
  parkAlley:["#8ee68b","<defs><linearGradient id=\"real-parkAlley\" x2=\".6\" y2=\"1\"><stop stop-color=\"#f7e0a3\"/><stop offset=\"1\" stop-color=\"#af9968\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 30 24 12l22 18v15H2Z\" fill=\"#4c8a58\" /><path d=\"M22 7h5l13 38H9Z\" fill=\"url(#real-parkAlley)\" /><g transform=\"translate(-4 3) scale(0.55)\"><rect x=\"21\" y=\"31\" width=\"5\" height=\"14\" rx=\"1\" fill=\"#9a693e\"/><path d=\"m24 2-12 17h6L7 31h8L4 40h40L33 30h7L30 18h6Z\" fill=\"#26754a\" /><path d=\"M24 2v36H8l12-9h-6l10-12h-6Z\" fill=\"#78be66\" /><path d=\"m24 14 7 13H25l9 10H24Z\" fill=\"#429a58\" /></g><g transform=\"translate(26 3) scale(0.55)\"><rect x=\"21\" y=\"31\" width=\"5\" height=\"14\" rx=\"1\" fill=\"#9a693e\"/><path d=\"m24 2-12 17h6L7 31h8L4 40h40L33 30h7L30 18h6Z\" fill=\"#26754a\" /><path d=\"M24 2v36H8l12-9h-6l10-12h-6Z\" fill=\"#78be66\" /><path d=\"m24 14 7 13H25l9 10H24Z\" fill=\"#429a58\" /></g><g transform=\"translate(-8 18) scale(0.6)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g><g transform=\"translate(27 18) scale(0.6)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g></g>"],
  parkSignpost:["#efc78f","<defs><linearGradient id=\"real-parkSignpost\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffd190\"/><stop offset=\"1\" stop-color=\"#af7541\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M21 3h5l1 42h-7Z\" fill=\"url(#real-parkSignpost)\" /><path d=\"M4 8 34 6l10 7-9 7-31 1Z\" fill=\"#69a265\" /><path d=\"m4 8 30-2 10 7-9-4-31 2Z\" fill=\"#a3cf81\" /><path d=\"m42 25-29-2-10 6 10 8 29 1Z\" fill=\"#efb369\" /><path d=\"m12 14 19-1m-14 17 17 1\" fill=\"none\" stroke=\"#f1ffce\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  lukoil:["#cc2229","<rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"3\" fill=\"#fff\" stroke=\"none\"/><svg x=\"2.5\" y=\"2.5\" width=\"19\" height=\"19\" viewBox=\"2.834 74.618 43.667 43.191\" preserveAspectRatio=\"xMidYMid meet\" fill=\"none\" stroke=\"none\"><path d=\"M2.834 74.618v43.191h43.667V74.618H2.834zm13.654 7.106s.124-2.417 2.5-2.417c2.375 0 2.479 2.417 2.479 2.417v16.855s.029 1.528 1.714 1.528 1.591-1.528 1.591-1.528V81.724s.227-2.417 2.541-2.417 2.499 2.417 2.499 2.417v16.855s-.082 6.196-6.63 6.527c-6.569-.187-6.713-6.527-6.713-6.527l.019-16.855zm-3.346 29.889s-5.04 0-5.04-4.938V81.723s0-2.417 2.52-2.417 2.499 2.417 2.499 2.417v23.383s-.186 1.569 1.735 1.569h22.453l-5.412-13.22s-.868-2.292 0-3.862c.867-1.57 4.544-7.87 4.544-7.87s1.012-2.417 2.913-2.417 2.995 2.045 2.21 3.471c-.785 1.425-4.338 7.519-4.338 7.519s-.909 1.26 0 2.975c1.487 3.553 7.519 18.343 7.519 18.343H13.142v-.001z\" fill=\"#cc2229\"/></svg>"],
  rosneft:["#fed208","<rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"3\" fill=\"#fed208\" stroke=\"none\"/><svg x=\"2.5\" y=\"2.5\" width=\"19\" height=\"19\" viewBox=\"4 1 24 30\" preserveAspectRatio=\"xMidYMid meet\" fill=\"none\" stroke=\"none\"><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M10.4636 29.7696V21.9976L5.5 17.0257L5.53182 9.21395H7.99773V6.73996H10.4636V4.27392H12.9295V2.22949H19.1023V4.28983H21.5682V6.73996H24.0341V9.21395H26.5V17.0575L21.5682 21.9896V29.7696H10.4636Z\" fill=\"white\"/><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M14.9736 15.3867H17.0338V27.7169H14.9736V15.3867ZM17.4395 17.4391H19.4918V27.7169H17.4395V17.4391ZM12.5077 17.4391H14.56V27.7169H12.5077V17.4391Z\" fill=\"#FED208\"/><path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M19.9054 8.8005H21.9656V18.6647L19.9054 20.725V8.8005ZM19.4997 17.0259H17.4395V6.34242H19.4997V17.0259ZM14.9736 4.29004H17.0338V14.9736H14.9736V4.29004ZM14.5599 17.0259H12.4997V6.34242H14.5599V17.0259ZM10.0417 8.8005H12.102V20.7329L10.0417 18.6726V8.8005V8.8005ZM7.56787 11.2665H9.6281V18.259L7.56787 16.2066V11.2665ZM22.3792 11.2665H24.4315V16.2066L22.3872 18.251V11.2665H22.3792Z\" fill=\"black\"/></svg>"],
  gazpromneft:["#0079c1","<rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"3\" fill=\"#fff\" stroke=\"none\"/><svg x=\"2.5\" y=\"2.5\" width=\"19\" height=\"19\" viewBox=\"5 5 228 380\" preserveAspectRatio=\"xMidYMid meet\" fill=\"none\" stroke=\"none\"><g fill=\"#0079c1\"><path d=\"M215.293 73.913c-8.08-35.25-28.276-63.913-31-68.594-4.39 6.577-20.46 31.886-28.715 59.97-8.87 31.298-10.187 59.074-7.113 86.43s14.577 55.438 14.577 55.438c6.147 14.762 15.368 30.56 21.34 38.322 8.78-11.416 28.979-45.488 35.303-89.959 3.51-24.71 3.599-46.358-4.392-81.607zm-31 162.785c-3.951-7.455-10.098-21.656-10.713-43.592-.176-21.199 8.343-39.342 10.802-43.145 2.195 3.803 9.572 19.601 10.45 41.248.526 21.208-6.498 37.884-10.538 45.49zm28.629-102.965c-.263 13.445-1.844 27.636-3.951 36.12.79-14.623-.966-35.242-4.391-51.339-3.338-16.088-12.821-42.995-20.462-55.43-7.025 11.847-15.631 35.11-20.197 55.281-4.48 20.198-4.654 44.611-4.654 51.935-1.23-6.173-4.216-28.18-3.338-50.319.703-18.257 4.918-37.006 7.289-45.63 8.957-28.812 19.057-47.236 20.9-50.16 1.933 2.923 14.666 25.59 21.252 49.431 6.586 23.834 7.903 46.65 7.552 60.111\"/><path d=\"M197.905 253.69h-61.208v41.072c.088-.053.176-.114.176-.167 14.402-14.419 37.849-14.419 52.25 0 14.402 14.43 14.402 37.813 0 52.233-.087.062-.087.113-.175.166v.018c-.088.07-.176.123-.264.193-14.313 14.28-33.194 21.428-51.987 21.428-18.881 0-37.761-7.2-52.163-21.604-25.38-25.387-28.365-64.658-9.045-93.34 2.634-3.873 5.62-7.56 9.045-10.986 14.402-14.41 33.282-21.61 52.163-21.61v-98.777c-72.536 0-131.374 58.82-131.374 131.374 0 72.545 58.838 131.365 131.374 131.365 37.849 0 71.922-16 95.896-41.58V253.69h-34.688\"/></g></svg>"],
  tatneft:["#008f56","<rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"3\" fill=\"#fff\" stroke=\"none\"/><svg x=\"2.5\" y=\"2.5\" width=\"19\" height=\"19\" viewBox=\"0 0 24 46\" preserveAspectRatio=\"xMidYMid meet\" fill=\"none\" stroke=\"none\"><path d=\"M18.8174 9.57812C21.77 17.0674 16.9672 21.8763 12.1643 26.7247C7.7158 31.6518 3.77904 36.7761 11.6919 45.9997C8.73935 38.5104 13.5422 33.7015 18.345 28.8532C22.7936 23.926 26.7303 18.8018 18.8174 9.57812Z\" fill=\"#008f56\"/><path d=\"M11.6534 0C14.6059 7.48929 9.8031 12.2982 5.00027 17.1465C0.551733 22.0737 -3.38502 27.1979 4.52785 36.3822C1.57529 28.8929 6.37813 24.084 11.181 19.2356C15.6689 14.3479 19.5663 9.22365 11.6534 0Z\" fill=\"#e52529\"/></svg>"],
  neftmagistral:["#e30613","<rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"3\" fill=\"#fff\" stroke=\"none\"/><svg x=\"2.5\" y=\"2.5\" width=\"19\" height=\"19\" viewBox=\"26 0 66 56\" preserveAspectRatio=\"xMidYMid meet\" fill=\"none\" stroke=\"none\">\n    <polygon fill=\"#161616\" fill-rule=\"evenodd\" points=\"59.08 0 26.68 56 91.59 55.97 88.07 49.73 38.45 49.73 47.83 33.23 51.04 33.18 42.15 48.52 50.45 48.52 68.36 15.94 64.51 9.3 54.84 26.34 51.53 26.34 62.86 6.48 59.08 0\"/>\n    <polygon fill=\"#e30613\" fill-rule=\"evenodd\" points=\"62.99 29.56 69.59 40.45 76.07 29.17 87.33 48.5 79.64 48.47 75.94 42.22 72.55 48.47 66.41 48.47 62.97 42.51 59.42 48.5 52.56 48.5 62.99 29.56\"/>\n    <path fill=\"#161616\" fill-rule=\"evenodd\" d=\"M69.19,17.3c-.75,1.31-1.67,2.78-2.55,4.27v2.8c.31-.67,.64-1.29,1.03-1.9-.67,2.98-.72,5.94-.33,8.99-.26-.2-.49-.41-.7-.61v2.01c.8,.51,1.72,.85,2.72,.85,2.93,0,5.29-2.08,5.32-5.11,0-.85-.21-1.88-.57-2.75l-4.93-8.53Zm-2.55,4.27c-1.31,2.34-2.47,4.83-2.49,7.2,0,1.41,.98,3.08,2.49,4.09v-2.01c-.98-1-1.16-2.16-.95-3.65,.21-1,.54-1.93,.95-2.83v-2.8Z\"/>\n  </svg>"],
  shell:["#ffcd00","<rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"3\" fill=\"#fff\" stroke=\"none\"/><svg x=\"2.5\" y=\"2.5\" width=\"19\" height=\"19\" viewBox=\"0 0 150 139\" preserveAspectRatio=\"xMidYMid meet\" fill=\"none\" stroke=\"none\"><path fill=\"#FFCD00\" d=\"M75.01 132.31c-1.18 0-2.3-.36-3.24-1.04l-3.62-2.65H33.72l-3.18-25.32L7.61 86.61a67.5 67.5 0 0 1-.98-11.54C6.63 37.36 37.3 6.7 75.01 6.7c37.7 0 68.37 30.67 68.37 68.37 0 3.85-.33 7.73-.98 11.55l-22.92 16.69-3.19 25.32H81.87l-3.64 2.68c-.89.64-2.05 1-3.22 1\"/><path fill=\"#DA291C\" d=\"M68.47 135.84c1.92 1.39 4.2 2.1 6.53 2.1s4.63-.72 6.54-2.1l2.17-1.58h37.53l3.51-27.84 22.76-16.57C148.5 85 149 80.04 149 75.06c0-40.86-33.15-74-74-74S1 34.2 1 75.06c0 4.98.48 9.94 1.5 14.79l22.76 16.57 3.49 27.84h37.56zm-.98-14.53H40.18l-2.74-22.06-22.5-16.35c-.66-2.57-1-5.18-1-7.84 0-4.42.93-8.79 2.75-12.82l39.81 40.23-38.7-47.75c1.52-6.2 4.89-11.79 9.67-16.02l34.7 59.86-30.76-65.53c3.97-5.31 9.51-9.2 15.85-11.15l21.21 74.33-15.5-77.4a31.36 31.36 0 0 1 15.45-4.06c1.15 0 2.29.05 3.42.17L75 95.42l3.15-80.49c1.15-.12 2.28-.17 3.45-.17 5.39 0 10.72 1.39 15.44 4.06l-15.5 77.4 21.23-74.33a31.4 31.4 0 0 1 15.83 11.15L87.86 98.56l34.7-59.86c4.75 4.23 8.13 9.82 9.67 16.02l-38.7 47.76 39.81-40.23c1.8 4.03 2.71 8.4 2.71 12.82 0 2.66-.32 5.27-1 7.84l-22.46 16.35-2.76 22.06H82.52l-4.02 2.93c-1.03.73-2.25 1.16-3.5 1.16s-2.47-.42-3.48-1.16z\"/></svg>"],
  teboil:["#e7342c","<rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"3\" fill=\"#e7342c\" stroke=\"none\"/><svg x=\"2.5\" y=\"2.5\" width=\"19\" height=\"19\" viewBox=\"0 0 21 19.261702\" preserveAspectRatio=\"xMidYMid meet\" fill=\"none\" stroke=\"none\"><g transform=\"translate(26.859007 -19.462575)\"><path d=\"M -26.859007,19.462575 L 48.027993,19.462575 L 48.027993,38.724277 L -26.859007,38.724277 L -26.859007,19.462575 z\"\n              id=\"path14\" style=\"fill:#e7342c;fill-rule:evenodd;stroke:none\"/><path d=\"M -18.363007,25.489977 L -22.148007,25.489977 L -21.316007,22.068077 L -10.089007,22.068077 L -10.910007,25.489977 L -14.597007,25.489977 L -17.085007,35.642277 L -20.824017,35.642277 L -18.363007,25.489977 z\"\n              id=\"path16\" style=\"fill:#ffffff;fill-rule:evenodd;stroke:none\"/></g></svg>"],
  charging:['#ffd166'], service:['#c5d2de'], parking:['#79baff'],
  dining:["#ffd264","<defs><linearGradient id=\"real-dining\" x2=\".6\" y2=\"1\"><stop stop-color=\"#d67d4b\"/><stop offset=\"1\" stop-color=\"#7c3724\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"24\" cy=\"32\" rx=\"22\" ry=\"11\" fill=\"#85a4b5\"/><ellipse cx=\"23\" cy=\"29\" rx=\"22\" ry=\"11\" fill=\"#fffffc\"/><ellipse cx=\"23\" cy=\"29\" rx=\"17\" ry=\"7\" fill=\"#d6ece3\"/><path d=\"M10 24q12-11 25 0l2 9q-14 10-28-1Z\" fill=\"url(#real-dining)\" /><path d=\"m14 24 17 7m-18-3 15 6\" fill=\"none\" stroke=\"#ffc58d\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><ellipse cx=\"35\" cy=\"24\" rx=\"6\" ry=\"5\" fill=\"#75b65b\"/><ellipse cx=\"36\" cy=\"22\" rx=\"3\" ry=\"3\" fill=\"#a2d97a\"/><ellipse cx=\"12\" cy=\"32\" rx=\"4\" ry=\"3\" fill=\"#fec84e\"/></g>"],
  bag:['#c5a4f5'], groceries:['#8bd17c'], pharmacy:['#77d6af'],
  magnit:['#e81000','<rect x="1" y="1" width="22" height="22" rx="3" fill="#e81000" stroke="none"/><g transform="translate(-1 0)" fill="#faf9f6" stroke="none"><path d="M5 17V10a6 6 0 0 1 6-6h10v2.5H11A3.5 3.5 0 0 0 7.5 10v4.5Q7.5 17 5 17Z"/><path d="M21 7v7a6 6 0 0 1-6 6H5v-2.5h10a3.5 3.5 0 0 0 3.5-3.5V9.5Q18.5 7 21 7Z"/><path d="M9.3 15.1V9h1.9l1.65 2.1L14.5 9h1.9v6.1h-2v-3.2l-1.55 1.8-1.55-1.8v3.2Z"/></g>'],
  pyaterochka:['#ec281e','<rect x="1" y="1" width="22" height="22" rx="3" fill="#ec281e" stroke="none"/><circle cx="12" cy="12" r="9.2" stroke="#faf9f2" stroke-width="1.6"/><path d="m8.3 7.8-.9 5.7q3.5-1.7 5.6-.5 2.1 1.3 1.1 3.5-1.1 2.2-5.3 1.4l-.9 2.3q6 1.5 9-3 2.2-4-1.3-6.2-2-1.2-4.7-.5l.4-1.7Z" fill="#faf9f2" stroke="none"/><path d="M8.5 6.4q4.3-4.2 11-3.1-2 5.8-7.5 4.6Z" fill="#35a851" stroke="#faf9f2" stroke-width="1.2"/><path d="m10.3 6.6 7.5-2.4q-4.1 3.2-6.2 3Z" fill="#7dc447" stroke="none"/>'],
  globus:['#efac19',"<rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"3\" fill=\"#efac19\" stroke=\"none\"/><circle cx=\"12\" cy=\"12\" r=\"9.3\" fill=\"#078b3c\" stroke=\"#fff8df\" stroke-width=\".65\"/><path d=\"M2.7 12h18.6M4.5 6.4q7.5 2.6 15 0M4.5 17.6q7.5-2.6 15 0M12 2.7v18.6M8.8 3.3q-4.3 8.7 0 17.4M15.2 3.3q4.3 8.7 0 17.4\" fill=\"none\" stroke=\"#fff8df\" stroke-width=\".55\" stroke-opacity=\".8\"/><text x=\"12\" y=\"16.7\" text-anchor=\"middle\" font-family=\"Arial Black,Arial,sans-serif\" font-weight=\"900\" font-size=\"13.5\" fill=\"#ef741b\" stroke=\"#fff8df\" stroke-width=\".65\" paint-order=\"stroke\" stroke-linejoin=\"round\">G</text>"],
  dixy:['#eb7e16','<rect x="1" y="1" width="22" height="22" rx="3" fill="#eb7e16" stroke="none"/><path d="M1 16q11 4 22 0v4a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3Z" fill="#7eb02d" stroke="none"/><path d="M1 16q11 4 22 0" fill="none" stroke="#faf9f3" stroke-width=".9"/><path d="M6.3 14.5v-2q0-.7.8-.7h.6q1-2.1 1.3-6.6.1-1.1 1.3-1.1h5.6q.6 0 .6.6v7.1h.5q.9 0 .9.8v2q0 .7-.7.7h-1q-.8 0-.8-.7v-.9H8.8v.9q0 .7-.8.7h-1q-.7 0-.7-.8Zm3.5-2.7h3.8V6.5h-2.3q-.3 3.5-1.5 5.3Z" fill="#faf9f3" fill-rule="evenodd" stroke="none"/>'],
  metro:['#ffd84d','<rect x="1" y="4" width="22" height="16" rx="2" fill="#145197" stroke="none"/><text x="12" y="14.4" text-anchor="middle" font-family="Arial,sans-serif" font-weight="900" font-size="6.2" fill="#ffdf43" stroke="none">METRO</text>'],
  chizhik:['#f9d500','<rect x="1" y="1" width="22" height="22" rx="3" fill="#f9d500" stroke="none"/><g transform="translate(-.8 -.4)"><path d="M4 8q2 2 4 2C9 3 17 3 19 8l3 1-2 2 1 1-2 1q-1 8-9 7l-4-2 2-1Q2 15 4 8Z" fill="#080909" stroke="none"/><ellipse cx="15.8" cy="9" rx="2.25" ry="3" transform="rotate(9 15.8 9)" fill="#fafafa" stroke="none"/><ellipse cx="16.6" cy="8.5" rx=".7" ry="1.25" fill="#080909" stroke="none"/></g>'],
  perekrestok:['#71cc86','<rect x="1" y="1" width="22" height="22" rx="3" fill="#124d39" stroke="none"/><path d="M12 12C2 13 2 3 8 3q5 0 4 9Z" fill="#b6df67" stroke="none"/><path d="M12 12C11 2 21 2 21 8q0 5-9 4Z" fill="#72c98b" stroke="none"/><path d="M12 12c10-1 10 9 4 9q-5 0-4-9Z" fill="#24946c" stroke="none"/><path d="M12 12c1 10-9 10-9 4q0-5 9-4Z" fill="#339b42" stroke="none"/>'],
  bed:["#a7ceff","<defs><linearGradient id=\"shop-bed\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#9fe5dd\"/><stop offset=\"1\" stop-color=\"#399ba2\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"M4 12 29 6l15 6v25l-27 8L3 36Z\" fill=\"#41757d\" /><path d=\"M4 8 28 3v17L4 27Z\" fill=\"#c9ac90\" /><path d=\"m7 10 18-4v12L7 23Z\" fill=\"#eacca9\" /><path d=\"M4 22 29 16 44 24 18 32Z\" fill=\"#fffffd\" /><path d=\"m4 22 14 10v10L4 33Z\" fill=\"#cef5ea\" /><path d=\"m18 32 26-8v11l-26 8Z\" fill=\"url(#shop-bed)\" /><path d=\"m8 18 9-3 6 3-9 4Z\" fill=\"#fffffc\" /><path d=\"m20 15 8-2 6 3-9 3Z\" fill=\"#ffffff\" /><path d=\"m5 27 13 8 26-8v8l-26 8-13-9Z\" fill=\"#65bab9\" /><path d=\"m20 34 21-6\" fill=\"none\" stroke=\"#b8f4e2\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M5 34h3v8H5ZM36 37h3v7h-3Z\" fill=\"#825d45\" /></g>"],
  apartment:["#e1eefe","<defs><linearGradient id=\"real-apartment\" x2=\".6\" y2=\"1\"><stop stop-color=\"#faebd0\"/><stop offset=\"1\" stop-color=\"#acacac\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M7 7 31 3l11 6v34l-11 3-24-5Z\" fill=\"url(#real-apartment)\" /><path d=\"m31 3 11 6v34l-11 3Z\" fill=\"#596781\" /><path d=\"M6 7 31 2l13 6-12 3Z\" fill=\"#dadae1\" /><rect x=\"11\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"19\" y=\"36\" width=\"10\" height=\"9\" rx=\"1\" fill=\"#49687e\"/><path d=\"M24 36v8\" fill=\"none\" stroke=\"#ede8cd\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  tree:["#83e98e","<defs><linearGradient id=\"real-tree\" x2=\".6\" y2=\"1\"><stop stop-color=\"#a5e06f\"/><stop offset=\"1\" stop-color=\"#207942\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"translate(0 0) scale(1)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g></g>"],
  bench:["#f7bb76","<defs><linearGradient id=\"real-bench\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffd595\"/><stop offset=\"1\" stop-color=\"#c17d3f\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M7 24h5v19H8ZM36 22h4v20h-4Z\" fill=\"#506c7c\" /><path d=\"M5 13 37 9l5 4-32 5Z\" fill=\"#ffd78e\" /><path d=\"m6 15 32-4v5L6 20Z\" fill=\"#d58f4a\" /><path d=\"m6 21 32-4v5L6 26Z\" fill=\"#eaa55a\" /><path d=\"m4 28 32-5 9 6-32 6Z\" fill=\"#ffc67b\" /><path d=\"m13 35 32-6v4l-32 6Z\" fill=\"#bb793d\" /><path d=\"m7 29 29-4m-25 7 28-4\" fill=\"none\" stroke=\"#ffecae\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  benchTree:["#f7bb76","<defs><linearGradient id=\"real-benchTree\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffd595\"/><stop offset=\"1\" stop-color=\"#c17d3f\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"translate(20 -2) scale(0.57)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g><g transform=\"translate(0 10) scale(.72)\"><path d=\"M7 24h5v19H8ZM36 22h4v20h-4Z\" fill=\"#506c7c\" /><path d=\"M5 13 37 9l5 4-32 5Z\" fill=\"#ffd78e\" /><path d=\"m6 15 32-4v5L6 20Z\" fill=\"#d58f4a\" /><path d=\"m6 21 32-4v5L6 26Z\" fill=\"#eaa55a\" /><path d=\"m4 28 32-5 9 6-32 6Z\" fill=\"#ffc67b\" /><path d=\"m13 35 32-6v4l-32 6Z\" fill=\"#bb793d\" /><path d=\"m7 29 29-4m-25 7 28-4\" fill=\"none\" stroke=\"#ffecae\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g></g>"],
  benchArms:["#f7bb76","<defs><linearGradient id=\"real-benchArms\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffd595\"/><stop offset=\"1\" stop-color=\"#c17d3f\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M7 24h5v19H8ZM36 22h4v20h-4Z\" fill=\"#506c7c\" /><path d=\"M5 13 37 9l5 4-32 5Z\" fill=\"#ffd78e\" /><path d=\"m6 15 32-4v5L6 20Z\" fill=\"#d58f4a\" /><path d=\"m6 21 32-4v5L6 26Z\" fill=\"#eaa55a\" /><path d=\"m4 28 32-5 9 6-32 6Z\" fill=\"#ffc67b\" /><path d=\"m13 35 32-6v4l-32 6Z\" fill=\"#bb793d\" /><path d=\"m7 29 29-4m-25 7 28-4\" fill=\"none\" stroke=\"#ffecae\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M5 24v-4h7v12M35 20v-4h8v13\" fill=\"none\" stroke=\"#708e96\" stroke-width=\"2.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  gazebo:["#f7bb76","<defs><linearGradient id=\"real-gazebo\" x2=\".6\" y2=\"1\"><stop stop-color=\"#c3e48e\"/><stop offset=\"1\" stop-color=\"#538859\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M7 40 24 34l18 7-18 5Z\" fill=\"#cca571\" /><path d=\"m7 40 17 6v2L7 43Z\" fill=\"#926a3a\" /><path d=\"M10 18v23M24 14v23M38 17v24\" fill=\"none\" stroke=\"#f5ce88\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M10 32v8M38 32v9M10 34l8 3m13-1 7-3\" fill=\"none\" stroke=\"#c28e4a\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M2 19 13 7l13-5 20 14-8 6-15-6-13 7Z\" fill=\"#689d6d\" /><path d=\"m26 2 20 14-8 6-15-6Z\" fill=\"#376b51\" /><path d=\"m6 18 18-12 17 10\" fill=\"none\" stroke=\"#d7dba8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M12 22h24\" fill=\"none\" stroke=\"#f4cd8c\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  gazeboArch:["#f7bb76","<defs><linearGradient id=\"real-gazeboArch\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ecc68e\"/><stop offset=\"1\" stop-color=\"#9b784c\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M7 40 24 34l18 7-18 5Z\" fill=\"#cca571\" /><path d=\"m7 40 17 6v2L7 43Z\" fill=\"#926a3a\" /><path d=\"M10 18v23M24 14v23M38 17v24\" fill=\"none\" stroke=\"#f5ce88\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M10 32v8M38 32v9M10 34l8 3m13-1 7-3\" fill=\"none\" stroke=\"#c28e4a\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M2 19 13 7l13-5 20 14-8 6-15-6-13 7Z\" fill=\"#b1915f\" /><path d=\"m26 2 20 14-8 6-15-6Z\" fill=\"#755c3d\" /><path d=\"m6 18 18-12 17 10\" fill=\"none\" stroke=\"#d7dba8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M16 40V27q8-14 16-1v14h-3V27q-5-9-10 1v12Z\" fill=\"#ffe094\" /></g>"],
  picnic:["#f7bb76","<defs><linearGradient id=\"real-picnic\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffd59c\"/><stop offset=\"1\" stop-color=\"#ad713a\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M17 20 10 42m23-29 9 27M10 28l25 10M15 24l23 9\" fill=\"none\" stroke=\"#718385\" stroke-width=\"2.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m5 17 27-12 13 7-28 13Z\" fill=\"url(#real-picnic)\" /><path d=\"m17 25 28-13v4L17 29Z\" fill=\"#a96a34\" /><path d=\"m2 30 25-12 6 4L8 34Z\" fill=\"#f4b470\" /><path d=\"m24 36 19-9 5 4-18 9Z\" fill=\"#e3a05e\" /><path d=\"M12 17 33 8m-15 13 22-10\" fill=\"none\" stroke=\"#ffebbb\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  playground:["#ffd264","<defs><linearGradient id=\"real-playground\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffdf6c\"/><stop offset=\"1\" stop-color=\"#d68122\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M8 20v24M29 19v25M12 24v19M20 24v19M12 29h8m-8 6h8\" fill=\"none\" stroke=\"#cd8441\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m4 17 14-14 15 14Z\" fill=\"#fa784a\" /><path d=\"m18 3 15 14H18Z\" fill=\"#c75838\" /><path d=\"M8 17h21v8H8Z\" fill=\"url(#real-playground)\" /><rect x=\"14\" y=\"17\" width=\"8\" height=\"8\" rx=\"2\" fill=\"#6c7064\"/><path d=\"M28 22h6q-1 14 11 18v4q-20-4-17-22Z\" fill=\"#6fc7e9\" /><path d=\"M31 24q0 13 11 17\" fill=\"none\" stroke=\"#d2ffff\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  bridge:["#f7bb76","<defs><linearGradient id=\"real-bridge\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffdc9b\"/><stop offset=\"1\" stop-color=\"#ac7b42\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 36q22-12 44 0v9H2Z\" fill=\"#54abca\" /><path d=\"M5 36Q24 2 43 36M5 28Q24-4 43 28\" fill=\"none\" stroke=\"#cca060\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M3 32q21-26 42 0l-4 5q-17-23-34 0Z\" fill=\"url(#real-bridge)\" /><path d=\"M9 23v10M16 15v12M24 12v13M32 15v12M39 23v10\" fill=\"none\" stroke=\"#f1c47d\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M5 42q5-3 10 0m11 0q5-3 10 0\" fill=\"none\" stroke=\"#aaf1f8\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  promenade:["#77d6e6","<defs><linearGradient id=\"real-promenade\" x2=\".3\" y2=\"1\"><stop stop-color=\"#66c6d7\"/><stop offset=\"1\" stop-color=\"#237ba3\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><path d=\"M2 27q19 7 44-7v24H2Z\" fill=\"url(#real-promenade)\"/><path d=\"M2 13q18 7 44-7v15Q23 36 2 28Z\" fill=\"#d7c5a1\"/><path d=\"M2 26q19 6 44-8v4Q22 36 2 30Z\" fill=\"#8d8778\"/><path d=\"M5 20v10m12-8v11m13-13v10m13-17v11\" fill=\"none\" stroke=\"#294750\" stroke-width=\"2.6\" stroke-linecap=\"round\"/><path d=\"M4 20q19 6 40-7M4 25q19 6 40-7\" fill=\"none\" stroke=\"#dce8dc\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path d=\"m7 37q5-2 10 0m8-1q5-2 11-2M18 41q5-2 10-1\" fill=\"none\" stroke=\"#b0f0ee\" stroke-width=\"1.7\" stroke-linecap=\"round\"/><path d=\"m7 15 3 8m10-7 2 8m10-11 2 8\" fill=\"none\" stroke=\"#b5a283\" stroke-width=\".9\"/></g>"],
  camping:["#ffc45c","<defs><linearGradient id=\"real-camping\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffc75c\"/><stop offset=\"1\" stop-color=\"#d77e2c\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 40 23 3l24 37-23 6Z\" fill=\"url(#real-camping)\" /><path d=\"m23 3 24 37-23 6Z\" fill=\"#7a9867\" /><path d=\"m23 14-13 26h26Z\" fill=\"#2c3d3e\" /><path d=\"m23 14 2 26h11Z\" fill=\"#e39f47\" /><path d=\"M23 5 4 39M24 5l21 35\" fill=\"none\" stroke=\"#fee4ab\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  park:["#83e98e","<defs><linearGradient id=\"real-park\" x2=\".6\" y2=\"1\"><stop stop-color=\"#a5e06f\"/><stop offset=\"1\" stop-color=\"#207942\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"translate(1 0) scale(0.95)\"><rect x=\"21\" y=\"31\" width=\"5\" height=\"14\" rx=\"1\" fill=\"#9a693e\"/><path d=\"m24 2-12 17h6L7 31h8L4 40h40L33 30h7L30 18h6Z\" fill=\"#26754a\" /><path d=\"M24 2v36H8l12-9h-6l10-12h-6Z\" fill=\"#78be66\" /><path d=\"m24 14 7 13H25l9 10H24Z\" fill=\"#429a58\" /></g></g>"],
  museum:["#ffffff","<defs><linearGradient id=\"real-museum\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffffec\"/><stop offset=\"1\" stop-color=\"#b3c0c5\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 17 24 3l22 14Z\" fill=\"#ece7d1\" /><path d=\"M9 15 24 7l15 8Z\" fill=\"#b4c3ca\" /><rect x=\"5\" y=\"18\" width=\"38\" height=\"4\" rx=\"0\" fill=\"#fffbe7\"/><rect x=\"8\" y=\"22\" width=\"5\" height=\"17\" rx=\"1\" fill=\"url(#real-museum)\"/><rect x=\"17\" y=\"22\" width=\"5\" height=\"17\" rx=\"1\" fill=\"url(#real-museum)\"/><rect x=\"26\" y=\"22\" width=\"5\" height=\"17\" rx=\"1\" fill=\"url(#real-museum)\"/><rect x=\"35\" y=\"22\" width=\"5\" height=\"17\" rx=\"1\" fill=\"url(#real-museum)\"/><path d=\"M4 39h40v4H4ZM1 44h46v3H1Z\" fill=\"#c6cfca\" /></g>"],
  pool:["#ffffff","<defs><linearGradient id=\"real-pool\" x2=\".6\" y2=\"1\"><stop stop-color=\"#bbfcfd\"/><stop offset=\"1\" stop-color=\"#43a7c9\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 20 26 10l21 12-24 13Z\" fill=\"#f2fbe7\" /><path d=\"M7 21 26 14l15 8-18 10Z\" fill=\"url(#real-pool)\" /><path d=\"m2 20 21 15v10L2 31Z\" fill=\"#9ac6d1\" /><path d=\"m23 35 24-13v11L23 46Z\" fill=\"#58a0bc\" /><path d=\"M30 25V7q0-6 5-3M37 22V5q0-5 5-2M30 12l7-3m-7 9 7-3\" fill=\"none\" stroke=\"#fffffb\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m12 22 5 1m2 3 7-3\" fill=\"none\" stroke=\"#e8ffff\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  beach:["#ffe271","<defs><linearGradient id=\"real-beach\" x2=\".6\" y2=\"1\"><stop stop-color=\"#fff7a4\"/><stop offset=\"1\" stop-color=\"#e0b059\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M1 34q23-18 46-4v17H1Z\" fill=\"url(#real-beach)\" /><path d=\"M1 38q9-7 20 0 11-9 26-6v15H1Z\" fill=\"#68cce6\" /><path d=\"M25 15 21 39\" fill=\"none\" stroke=\"#ab7d4e\" stroke-width=\"2.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M4 20Q24-8 45 17L25 24Z\" fill=\"#ff9e76\" /><path d=\"M24 5Q14 10 13 21l12 3 10-5Q31 8 24 5Z\" fill=\"#ffe396\" /><path d=\"m24 5 1 19 10-5Q30 8 24 5Z\" fill=\"#e27055\" /><path d=\"M5 41q7-4 14 0\" fill=\"none\" stroke=\"#e1ffff\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
  mountains:["#a8d4c0","<defs><linearGradient id=\"real-mountains\" x2=\".6\" y2=\"1\"><stop stop-color=\"#c2cfc7\"/><stop offset=\"1\" stop-color=\"#5b7e7a\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M1 45 18 4l17 41Z\" fill=\"url(#real-mountains)\" /><path d=\"m18 4 17 41H20Z\" fill=\"#61857f\" /><path d=\"m1 45 12-15 7 8 9-26 18 33Z\" fill=\"#86a49e\" /><path d=\"m18 4-7 17 6-3 5 7 3-4Z\" fill=\"#fffff4\" /><path d=\"m29 12-7 21 6-4 5 4 3-6Z\" fill=\"#f0fdee\" /></g>"],
  concert:["#dbb0ff","<defs><linearGradient id=\"real-concert\" x2=\".6\" y2=\"1\"><stop stop-color=\"#e9dbff\"/><stop offset=\"1\" stop-color=\"#837aae\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"rotate(30 24 24)\"><rect x=\"16\" y=\"2\" width=\"16\" height=\"24\" rx=\"8\" fill=\"url(#real-concert)\"/><rect x=\"20\" y=\"25\" width=\"8\" height=\"18\" rx=\"2\" fill=\"#556271\"/><path d=\"M19 9h10M18 14h12m-11 5h10\" fill=\"none\" stroke=\"#7d8ba0\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g><path d=\"M18 42q-5 5-12 2\" fill=\"none\" stroke=\"#a8c0ce\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"],
};

// Keep original saved icons; volumetric alternatives have their own stable IDs.
POINT_GRAPHICS["realistic_dining"]=["Кафе","Ресторан · объёмный","🍽️","<path d=\"M4 3v5a3 3 0 0 0 6 0V3M7 3v18M17 21V3c-4 3-4 9 0 9\"/>"];
POINT_GRAPHIC_PAINT["realistic_dining"]=["#ffd264","<defs><linearGradient id=\"real-dining\" x2=\".6\" y2=\"1\"><stop stop-color=\"#d67d4b\"/><stop offset=\"1\" stop-color=\"#7c3724\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"24\" cy=\"32\" rx=\"22\" ry=\"11\" fill=\"#85a4b5\"/><ellipse cx=\"23\" cy=\"29\" rx=\"22\" ry=\"11\" fill=\"#fffffc\"/><ellipse cx=\"23\" cy=\"29\" rx=\"17\" ry=\"7\" fill=\"#d6ece3\"/><path d=\"M10 24q12-11 25 0l2 9q-14 10-28-1Z\" fill=\"url(#real-dining)\" /><path d=\"m14 24 17 7m-18-3 15 6\" fill=\"none\" stroke=\"#ffc58d\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><ellipse cx=\"35\" cy=\"24\" rx=\"6\" ry=\"5\" fill=\"#75b65b\"/><ellipse cx=\"36\" cy=\"22\" rx=\"3\" ry=\"3\" fill=\"#a2d97a\"/><ellipse cx=\"12\" cy=\"32\" rx=\"4\" ry=\"3\" fill=\"#fec84e\"/></g>"];
POINT_GRAPHIC_PAINT["dining"]=["#edf2f7"];
POINT_GRAPHICS["realistic_bakery"]=["Кафе","Пекарня · объёмный","🥐","<path d=\"m3 13 4-7 5-2 5 2 4 7-3 5-4-3h-4l-4 3ZM7 6l3 9M17 6l-3 9\"/>"];
POINT_GRAPHIC_PAINT["realistic_bakery"]=["#edb565","<defs><linearGradient id=\"real-bakery\" x2=\".6\" y2=\"1\"><stop stop-color=\"#f8d17e\"/><stop offset=\"1\" stop-color=\"#b46c2d\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"24\" cy=\"39\" rx=\"21\" ry=\"5\" fill=\"#c7b99b\"/><path d=\"M3 21q4-12 12-12 10-7 22 2 7 3 9 12l-10 10-8-5-8 1-8 5Z\" fill=\"url(#real-bakery)\" /><path d=\"M3 21q-2 10 6 18l4-7-2-10ZM46 23q1 10-8 16l-3-7 1-10Z\" fill=\"#ce883d\" /><path d=\"M13 14l6 14M24 10l1 17M35 14l-5 14\" fill=\"none\" stroke=\"#ae672d\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M15 12q10-6 20 1\" fill=\"none\" stroke=\"#ffe6ab\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"];
POINT_GRAPHIC_PAINT["bakery"]=["#edb565"];
POINT_GRAPHICS["realistic_takeaway"]=["Кафе","Еда с собой · объёмный","🥤","<path d=\"M5 7h14M7 7l1 14h8l1-14M11 7l2-5h5M5 4h12\"/>"];
POINT_GRAPHIC_PAINT["realistic_takeaway"]=["#ffbf7c","<defs><linearGradient id=\"real-takeaway\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffda9e\"/><stop offset=\"1\" stop-color=\"#d58f52\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M9 13h29l-4 31H13Z\" fill=\"url(#real-takeaway)\" /><path d=\"M17 14h16l-3 28H19Z\" fill=\"#f8ca8b\" /><path d=\"M10 21h27l-1 13H12Z\" fill=\"#7a5f45\" /><ellipse cx=\"23\" cy=\"27\" rx=\"5\" ry=\"5\" fill=\"#dfbf95\"/><path d=\"M6 12h35v5H6ZM10 7h27l3 5H7Z\" fill=\"#3f505f\" /><path d=\"M14 9h17\" fill=\"none\" stroke=\"#919f96\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"];
POINT_GRAPHIC_PAINT["takeaway"]=["#f294ac"];
POINT_GRAPHICS["realistic_bed"]=["Отель","Ночлег · объёмный","🛏️","<path d=\"M3 20V5M21 20V9H9v6M3 15h18M3 18h18\"/><circle cx=\"6\" cy=\"11\" r=\"2\"/>"];
POINT_GRAPHIC_PAINT["realistic_bed"]=["#a7ceff","<defs><linearGradient id=\"shop-bed\" x1=\"0\" y1=\"0\" x2=\".65\" y2=\"1\"><stop stop-color=\"#9fe5dd\"/><stop offset=\"1\" stop-color=\"#399ba2\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"43\" rx=\"20\" ry=\"2\" fill=\"#0b101a55\"/><path d=\"M4 12 29 6l15 6v25l-27 8L3 36Z\" fill=\"#41757d\" /><path d=\"M4 8 28 3v17L4 27Z\" fill=\"#c9ac90\" /><path d=\"m7 10 18-4v12L7 23Z\" fill=\"#eacca9\" /><path d=\"M4 22 29 16 44 24 18 32Z\" fill=\"#fffffd\" /><path d=\"m4 22 14 10v10L4 33Z\" fill=\"#cef5ea\" /><path d=\"m18 32 26-8v11l-26 8Z\" fill=\"url(#shop-bed)\" /><path d=\"m8 18 9-3 6 3-9 4Z\" fill=\"#fffffc\" /><path d=\"m20 15 8-2 6 3-9 3Z\" fill=\"#ffffff\" /><path d=\"m5 27 13 8 26-8v8l-26 8-13-9Z\" fill=\"#65bab9\" /><path d=\"m20 34 21-6\" fill=\"none\" stroke=\"#b8f4e2\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M5 34h3v8H5ZM36 37h3v7h-3Z\" fill=\"#825d45\" /></g>"];
POINT_GRAPHIC_PAINT["bed"]=["#9ebcfa"];
POINT_GRAPHICS["realistic_key"]=["Отель","Заселение · объёмный","🔑","<circle cx=\"8\" cy=\"8\" r=\"5\"/><path d=\"m12 12 9 9M16 16l3-3M19 19l3-3\"/>"];
POINT_GRAPHIC_PAINT["realistic_key"]=["#ffe271","<defs><linearGradient id=\"real-key\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffef9d\"/><stop offset=\"1\" stop-color=\"#c68d3a\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"13\" cy=\"13\" rx=\"10\" ry=\"10\" fill=\"#b68739\"/><ellipse cx=\"12\" cy=\"11\" rx=\"9\" ry=\"9\" fill=\"url(#real-key)\"/><ellipse cx=\"12\" cy=\"11\" rx=\"4\" ry=\"4\" fill=\"#1f3d4f\"/><path d=\"m17 17 24 22-5 6-6-6 3-3-4-4-3 2-6-7Z\" fill=\"url(#real-key)\" /><path d=\"m19 19 17 19\" fill=\"none\" stroke=\"#ffffc5\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"];
POINT_GRAPHIC_PAINT["key"]=["#f4ce77"];
POINT_GRAPHICS["realistic_bellhop"]=["Отель","Ресепшен · объёмный","🛎️","<path d=\"M3 18h18M5 15a7 7 0 0 1 14 0ZM12 8V5M10 5h4M3 21h18\"/>"];
POINT_GRAPHIC_PAINT["realistic_bellhop"]=["#ffe271","<defs><linearGradient id=\"real-bellhop\" x2=\".6\" y2=\"1\"><stop stop-color=\"#fff1a3\"/><stop offset=\"1\" stop-color=\"#bc7f28\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><ellipse cx=\"24\" cy=\"40\" rx=\"21\" ry=\"4\" fill=\"#4f5f66\"/><path d=\"M5 35q0-25 19-25t19 25Z\" fill=\"url(#real-bellhop)\" /><rect x=\"20\" y=\"6\" width=\"8\" height=\"5\" rx=\"2\" fill=\"#d09e56\"/><ellipse cx=\"24\" cy=\"6\" rx=\"5\" ry=\"2\" fill=\"#ffe28b\"/><ellipse cx=\"24\" cy=\"35\" rx=\"21\" ry=\"4\" fill=\"#dab372\"/><path d=\"M12 28q1-9 7-12\" fill=\"none\" stroke=\"#ffffcd\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"];
POINT_GRAPHIC_PAINT["bellhop"]=["#f4ce77"];
POINT_GRAPHICS["realistic_apartment"]=["Жильё","Квартира · объёмный","🏢","<path d=\"M5 21V3h14v18M9 7h1M14 7h1M9 11h1M14 11h1M10 21v-5h4v5\"/>"];
POINT_GRAPHIC_PAINT["realistic_apartment"]=["#e1eefe","<defs><linearGradient id=\"real-apartment\" x2=\".6\" y2=\"1\"><stop stop-color=\"#a99a85\"/><stop offset=\"1\" stop-color=\"#6d625a\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M7 7 31 3l11 6v34l-11 3-24-5Z\" fill=\"url(#real-apartment)\" /><path d=\"m31 3 11 6v34l-11 3Z\" fill=\"#4d4548\" /><path d=\"M6 7 31 2l13 6-12 3Z\" fill=\"#dadae1\" /><rect x=\"11\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"12\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"20\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"11\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#fffaa5\"/><rect x=\"18\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"25\" y=\"28\" width=\"4\" height=\"5\" rx=\"0.4\" fill=\"#92c7df\"/><rect x=\"19\" y=\"36\" width=\"10\" height=\"9\" rx=\"1\" fill=\"#49687e\"/><path d=\"M24 36v8\" fill=\"none\" stroke=\"#ede8cd\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"];
POINT_GRAPHIC_PAINT["apartment"]=["#ced8e4"];
POINT_GRAPHICS["realistic_cottage"]=["Жильё","Загородный дом · объёмный","🏡","<path d=\"m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7M16 5V2\"/>"];
POINT_GRAPHIC_PAINT["realistic_cottage"]=["#93edad","<defs><linearGradient id=\"real-cottage\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffe6b0\"/><stop offset=\"1\" stop-color=\"#bf8e60\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"translate(22 5) scale(0.55)\"><path d=\"M21 23h5l2 22h-8Z\" fill=\"#8e623e\" /><path d=\"m23 30-8-7 2-2 7 5 8-9 2 2-8 12Z\" fill=\"#ab7d4a\" /><ellipse cx=\"24\" cy=\"20\" rx=\"15\" ry=\"12\" fill=\"#287c3b\"/><ellipse cx=\"16\" cy=\"15\" rx=\"10\" ry=\"10\" fill=\"#4ba045\"/><ellipse cx=\"29\" cy=\"12\" rx=\"11\" ry=\"11\" fill=\"#76c050\"/><ellipse cx=\"35\" cy=\"22\" rx=\"8\" ry=\"8\" fill=\"#40883b\"/><ellipse cx=\"25\" cy=\"8\" rx=\"6\" ry=\"5\" fill=\"#a9e06c\"/></g><g transform=\"translate(-1 8) scale(.82)\"><path d=\"M6 23 24 10l16 12v20H6Z\" fill=\"#ffdba8\" /><path d=\"m24 10 18 10v21l-10 3V22Z\" fill=\"#c4a178\" /><path d=\"M2 23 23 5l22 14-6 6-16-12L7 27Z\" fill=\"#ce784c\" /><path d=\"m23 5 22 14-6 6-16-12Z\" fill=\"#974935\" /><path d=\"m6 22 17-14 17 11\" fill=\"none\" stroke=\"#feae7b\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"10\" y=\"27\" width=\"9\" height=\"9\" rx=\"1\" fill=\"#81bdcd\"/><rect x=\"23\" y=\"25\" width=\"7\" height=\"17\" rx=\"1\" fill=\"#9c633c\"/><path d=\"M14.5 28v7M11 31.5h7\" fill=\"none\" stroke=\"#ecfff8\" stroke-width=\"1\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><rect x=\"27\" y=\"32\" width=\"1\" height=\"2\" rx=\"0.5\" fill=\"#ffefb6\"/><path d=\"M4 41h31v3H4Z\" fill=\"#a08058\" /></g><path d=\"M1 43h45v3H1Z\" fill=\"#649354\" /></g>"];
POINT_GRAPHIC_PAINT["cottage"]=["#90d5a4"];
POINT_GRAPHICS["realistic_camping"]=["Жильё","Кемпинг · объёмный","⛺","<path d=\"m12 3-10 18h20ZM12 3v18M7 21l5-9 5 9\"/>"];
POINT_GRAPHIC_PAINT["realistic_camping"]=["#ffc45c","<defs><linearGradient id=\"real-camping\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffc75c\"/><stop offset=\"1\" stop-color=\"#d77e2c\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 40 23 3l24 37-23 6Z\" fill=\"url(#real-camping)\" /><path d=\"m23 3 24 37-23 6Z\" fill=\"#7a9867\" /><path d=\"m23 14-13 26h26Z\" fill=\"#2c3d3e\" /><path d=\"m23 14 2 26h11Z\" fill=\"#e39f47\" /><path d=\"M23 5 4 39M24 5l21 35\" fill=\"none\" stroke=\"#fee4ab\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"];
POINT_GRAPHIC_PAINT["camping"]=["#edb565","<path d=\"m12 3-10 18h20Z\"/><path stroke=\"#d9edf4\" d=\"M12 3v18M7 21l5-9 5 9\"/>"];
POINT_GRAPHICS["realistic_museum"]=["Другое","Музей · объёмный","🏛️","<path d=\"m2 7 10-5 10 5ZM4 10v8M9 10v8M15 10v8M20 10v8M3 18h18M2 22h20\"/>"];
POINT_GRAPHIC_PAINT["realistic_museum"]=["#ffffff","<defs><linearGradient id=\"real-museum\" x2=\".6\" y2=\"1\"><stop stop-color=\"#ffffec\"/><stop offset=\"1\" stop-color=\"#b3c0c5\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 17 24 3l22 14Z\" fill=\"#ece7d1\" /><path d=\"M9 15 24 7l15 8Z\" fill=\"#b4c3ca\" /><rect x=\"5\" y=\"18\" width=\"38\" height=\"4\" rx=\"0\" fill=\"#fffbe7\"/><rect x=\"8\" y=\"22\" width=\"5\" height=\"17\" rx=\"1\" fill=\"url(#real-museum)\"/><rect x=\"17\" y=\"22\" width=\"5\" height=\"17\" rx=\"1\" fill=\"url(#real-museum)\"/><rect x=\"26\" y=\"22\" width=\"5\" height=\"17\" rx=\"1\" fill=\"url(#real-museum)\"/><rect x=\"35\" y=\"22\" width=\"5\" height=\"17\" rx=\"1\" fill=\"url(#real-museum)\"/><path d=\"M4 39h40v4H4ZM1 44h46v3H1Z\" fill=\"#c6cfca\" /></g>"];
POINT_GRAPHIC_PAINT["museum"]=["#edf2f7"];
POINT_GRAPHICS["realistic_pool"]=["Другое","Бассейн · объёмный","🏊","<path d=\"M7 15V5a2 2 0 0 1 4 0M15 15V5a2 2 0 0 1 4 0M7 7h8M7 11h8M2 17q2-2 4 0t4 0 4 0 4 0 4 0M2 21q2-2 4 0t4 0 4 0 4 0 4 0\"/>"];
POINT_GRAPHIC_PAINT["realistic_pool"]=["#ffffff","<defs><linearGradient id=\"real-pool\" x2=\".6\" y2=\"1\"><stop stop-color=\"#bbfcfd\"/><stop offset=\"1\" stop-color=\"#43a7c9\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M2 20 26 10l21 12-24 13Z\" fill=\"#f2fbe7\" /><path d=\"M7 21 26 14l15 8-18 10Z\" fill=\"url(#real-pool)\" /><path d=\"m2 20 21 15v10L2 31Z\" fill=\"#9ac6d1\" /><path d=\"m23 35 24-13v11L23 46Z\" fill=\"#58a0bc\" /><path d=\"M30 25V7q0-6 5-3M37 22V5q0-5 5-2M30 12l7-3m-7 9 7-3\" fill=\"none\" stroke=\"#fffffb\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"m12 22 5 1m2 3 7-3\" fill=\"none\" stroke=\"#e8ffff\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"];
POINT_GRAPHIC_PAINT["pool"]=["#edf2f7","<path d=\"M7 15V5a2 2 0 0 1 4 0M15 15V5a2 2 0 0 1 4 0M7 7h8M7 11h8\"/><path stroke=\"#72cffa\" d=\"M2 17q2-2 4 0t4 0 4 0 4 0 4 0M2 21q2-2 4 0t4 0 4 0 4 0 4 0\"/>"];
POINT_GRAPHICS["realistic_beach"]=["Другое","Море / пляж · объёмный","🏖️","<path d=\"M3 11a9 9 0 0 1 18 0ZM12 2c-3 3-3 6-3 9M12 2c3 3 3 6 3 9M12 11v8M3 21q5-4 10-2t8 0\"/>"];
POINT_GRAPHIC_PAINT["realistic_beach"]=["#ffe271","<defs><linearGradient id=\"real-beach\" x2=\".6\" y2=\"1\"><stop stop-color=\"#fff7a4\"/><stop offset=\"1\" stop-color=\"#e0b059\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M1 34q23-18 46-4v17H1Z\" fill=\"url(#real-beach)\" /><path d=\"M1 38q9-7 20 0 11-9 26-6v15H1Z\" fill=\"#68cce6\" /><path d=\"M25 15 21 39\" fill=\"none\" stroke=\"#ab7d4e\" stroke-width=\"2.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M4 20Q24-8 45 17L25 24Z\" fill=\"#ff9e76\" /><path d=\"M24 5Q14 10 13 21l12 3 10-5Q31 8 24 5Z\" fill=\"#ffe396\" /><path d=\"m24 5 1 19 10-5Q30 8 24 5Z\" fill=\"#e27055\" /><path d=\"M5 41q7-4 14 0\" fill=\"none\" stroke=\"#e1ffff\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"];
POINT_GRAPHIC_PAINT["beach"]=["#f4ce77","<path stroke=\"#ed9c86\" d=\"M3 11a9 9 0 0 1 18 0ZM12 2c-3 3-3 6-3 9M12 2c3 3 3 6 3 9\"/><path d=\"M12 11v8\"/><path stroke=\"#72cffa\" d=\"M3 21q5-4 10-2t8 0\"/>"];
POINT_GRAPHICS["realistic_mountains"]=["Другое","Горы · объёмный","⛰️","<path d=\"m2 21 8-18 8 18ZM7 10l3 3 3-3M15 14l3-7 5 14\"/>"];
POINT_GRAPHIC_PAINT["realistic_mountains"]=["#a8d4c0","<defs><linearGradient id=\"real-mountains\" x2=\".6\" y2=\"1\"><stop stop-color=\"#c2cfc7\"/><stop offset=\"1\" stop-color=\"#5b7e7a\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><path d=\"M1 45 18 4l17 41Z\" fill=\"url(#real-mountains)\" /><path d=\"m18 4 17 41H20Z\" fill=\"#61857f\" /><path d=\"m1 45 12-15 7 8 9-26 18 33Z\" fill=\"#86a49e\" /><path d=\"m18 4-7 17 6-3 5 7 3-4Z\" fill=\"#fffff4\" /><path d=\"m29 12-7 21 6-4 5 4 3-6Z\" fill=\"#f0fdee\" /></g>"];
POINT_GRAPHIC_PAINT["mountains"]=["#9fc1b1","<path d=\"m2 21 8-18 8 18ZM15 14l3-7 5 14\"/><path stroke=\"#edf2f7\" d=\"m7 10 3 3 3-3M16.5 10.5l1.5 1.5 1.5-1.5\"/>"];
POINT_GRAPHICS["realistic_concert"]=["Другое","Концерт · объёмный","🎤","<rect x=\"9\" y=\"2\" width=\"6\" height=\"12\" rx=\"3\"/><path d=\"M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8M10 6h4M10 9h4\"/>"];
POINT_GRAPHIC_PAINT["realistic_concert"]=["#dbb0ff","<defs><linearGradient id=\"real-concert\" x2=\".6\" y2=\"1\"><stop stop-color=\"#e9dbff\"/><stop offset=\"1\" stop-color=\"#837aae\"/></linearGradient></defs><g transform=\"scale(.5)\" stroke=\"none\"><ellipse cx=\"24\" cy=\"44\" rx=\"20\" ry=\"2\" fill=\"#07101b44\"/><g transform=\"rotate(30 24 24)\"><rect x=\"16\" y=\"2\" width=\"16\" height=\"24\" rx=\"8\" fill=\"url(#real-concert)\"/><rect x=\"20\" y=\"25\" width=\"8\" height=\"18\" rx=\"2\" fill=\"#556271\"/><path d=\"M19 9h10M18 14h12m-11 5h10\" fill=\"none\" stroke=\"#7d8ba0\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g><path d=\"M18 42q-5 5-12 2\" fill=\"none\" stroke=\"#a8c0ce\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>"];
POINT_GRAPHIC_PAINT["concert"]=["#c5a4f5","<rect stroke=\"#edf2f7\" x=\"9\" y=\"2\" width=\"6\" height=\"12\" rx=\"3\"/><path d=\"M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8\"/><path stroke=\"#aebbd0\" d=\"M10 6h4M10 9h4\"/>"];

function pointIconSvg(content, color) {
  return '<span class="stop-type-icon" style="color:' + color + '"><svg class="stop-type-glyph" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + content + '</svg></span>';
}
function pointGraphicIcon(key) {
  const graphic = POINT_GRAPHICS[key];
  if (!graphic) return stopTypeIcon('Другое');
  const paint = POINT_GRAPHIC_PAINT[key];
  return pointIconSvg(paint[1] || graphic[3], paint[0]);
}
function pointIconLabel(icon) {
  const value = String(icon || '📍');
  if (value.startsWith('graphic:')) return (POINT_GRAPHICS[value.slice(8)] || [null,'Место'])[1];
  return value.startsWith('type:') ? value.slice(5) : pointIconText(value);
}
function pointIconChoices(type) {
  const category = TYPE_ICONS[type] ? type : 'Другое';
  const graphics = Object.keys(POINT_GRAPHICS).filter(key => POINT_GRAPHICS[key][0] === category).map(key => 'graphic:' + key);
  const limit = category === 'Другое' || category === 'Парк' ? ICON_SETS[category].length : category === 'Жильё' ? 8 : 6;
  const emoji = (ICON_SETS[category] || []).slice(0, limit).map(value => 'emoji:' + value);
  return ['type:' + category].concat(category === 'Жильё' ? emoji.concat(graphics) : graphics.concat(emoji));
}
function stopTypeIcon(type) {
  if (type === 'Парк') return pointGraphicIcon('park');
  const icons = {
    'Заправка':['fuel','#db8178'], 'Кафе':['cafe','#f4c16c'],
    'Магазин':['cart','#83c5f5'], 'Отель':['hotel','#c6acff'],
    'Жильё':['home','#7edbb4'], 'Другое':['location','#db8178']
  };
  const icon = icons[type] || icons['Другое'];
  const details = {
    fuel:'<path stroke="#edf2f7" d="M6 6h6v4H6"/>',
    cafe:'<path stroke="#edf2f7" d="M4 8h13v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4ZM17 9h2a3 3 0 0 1 0 6h-2"/>',
    cart:'<circle stroke="#edf2f7" cx="9" cy="21" r="1"/><circle stroke="#edf2f7" cx="18" cy="21" r="1"/>',
    hotel:'<path stroke="#edf2f7" d="M8 7h1M15 7h1M8 11h1M15 11h1"/>',
    home:'',
    location:''
  };
  return '<span class="stop-type-icon" style="color:' + icon[1] + '">' + dayActionIcon(icon[0]).replace('class="day-action-icon"','class="stop-type-glyph"').replace('</svg>',details[icon[0]] + '</svg>') + '</span>';
}
function pointIconText(icon) {
  const value = String(icon || '📍');
  if (value.startsWith('graphic:')) return (POINT_GRAPHICS[value.slice(8)] || [null,null,'📍'])[2];
  if (value.startsWith('type:')) return TYPE_ICONS[value.slice(5)] || '📍';
  return value.startsWith('emoji:') ? value.slice(6) : value;
}
function pointIconMarkup(icon, type) {
  const value = String(icon || '📍');
  if (value.startsWith('graphic:')) return pointGraphicIcon(value.slice(8));
  if (value.startsWith('type:')) return stopTypeIcon(value.slice(5));
  if (!value.startsWith('emoji:') && type && value === TYPE_ICONS[type]) return stopTypeIcon(type);
  return pointIconText(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('[data-ui-icon]').forEach(function(el) {
    el.innerHTML = dayActionIcon(el.dataset.uiIcon);
  });
});
const WALK_DAY_ICONS = {'walker:person': 'Городской пешеход', 'walker:dog': 'С корги'};

function dayIconValue(day) {
  if ((day.walkMode || day.walkReview) && (day.icon == null || /^🚶(?:\u200d[♂♀]\ufe0f?)?$/u.test(day.icon))) return 'walker:person';
  return day.icon || '';
}

function dayIconMarkup(icon) {
  if (!Object.hasOwn(WALK_DAY_ICONS, icon)) return _escHtml(icon);
  const base = icon.slice('walker:'.length);
  const season = typeof walkStyleParts === 'function' ? walkStyleParts(walkIconStyle()).season : 'autumn';
  const style = typeof walkStyleValue === 'function' ? walkStyleValue(base, season) : base;
  const glyph = typeof gpsWalkerGlyph === 'function' ? gpsWalkerGlyph(style) : dayActionIcon('walk');
  return `<span class="day-walker-icon" data-day-walker="${style}" aria-hidden="true">${glyph}</span>`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-day-walker]').forEach(icon => {
    if (!icon.querySelector('.gps-walker')) icon.innerHTML = gpsWalkerGlyph(icon.dataset.dayWalker);
  });
});

function startPointIconMarkup(icon, recorded) {
  if (/^walker:/.test(icon || '') || /^🚶(?:\u200d[♂♀]\ufe0f?)?$/u.test(icon || '')) {
    const style = typeof walkIconStyle === 'function' ? walkIconStyle() : 'person';
    return '<span class="start-walker-glyph">' + (typeof gpsWalkerGlyph === 'function' ? gpsWalkerGlyph(style) : dayActionIcon('walk')) + '</span>';
  }
  if (recorded && (!icon || icon === '🚶' || icon === '🚶‍♂️' || icon === '🚶‍♀️')) {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4c5-4 9 4 14 0v10c-5 4-9-4-14 0"/></svg>';
  }
  return pointIconMarkup(icon);
}
function startPointNameMarkup(start, recorded = false) {
  const name = String(start.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<span class="depart-start-icon">' + startPointIconMarkup(start.icon, recorded) + '</span><span class="depart-name-text">' + name + '</span>';
}
function renderDaySection(d) {
  const canDrive = isAdmin();
  if (typeof discardInlinePlanTimeForDay === 'function') discardInlinePlanTimeForDay(d);
  const data    = DAYS_DATA[d];
  const dayIcon = dayIconValue(data);
  const sec     = document.createElement('div');
  sec.className  = 'day-section' + (d === currentDay ? ' visible' : '');
  sec.dataset.day = d;
  sec.id          = 'day' + d;

  sec.innerHTML = `
    <div class="day-header">
      <div style="flex:1;min-width:0">
        <div class="day-label" style="color:${data.color};">
          ${isAdmin() ? `<span class="day-icon-wrap" id="d${d}-day-icon-wrap" onclick="editDayIcon(${d}, this)" title="Иконка дня"><span class="day-icon-val" id="d${d}-day-icon">${dayIconMarkup(dayIcon || '📅')}</span><span class="day-date-edit-icon">${dayActionIcon('edit')}</span></span> · ` : (dayIcon ? `<span class="day-icon-val">${dayIconMarkup(dayIcon)}</span> · ` : '')}
          <span class="day-date-wrap" ${isAdmin() ? `onclick="editDayDate(${d}, this)" title="Нажмите для изменения даты"` : ''}>
            <span class="day-date-text">${data.dateISO || 'Дата'}</span>
            ${isAdmin() ? `<span class="day-date-edit-icon">${dayActionIcon('edit')}</span>` : ''}
          </span>
          ${data.date ? ` · <span class="day-desc-wrap" ${isAdmin() ? `onclick="editDesc(${d}, this)" title="Нажмите для изменения описания"` : ''}>
            <span class="day-desc-text">${data.date}</span>
            ${isAdmin() ? `<span class="day-date-edit-icon">${dayActionIcon('edit')}</span>` : ''}
          </span>` : (isAdmin() ? ` · <span class="day-desc-wrap" onclick="editDesc(${d}, this)" title="Добавить описание"><span class="day-desc-text" style="color:var(--muted);font-style:italic">описание</span><span class="day-date-edit-icon">${dayActionIcon('edit')}</span></span>` : '')}
        </div>
      </div>
      <div class="day-header-actions">
      <button class="nav-day-btn day-navigate-btn" onclick="openShareDay(${d})" title="Открыть маршрут в навигаторе" aria-label="Открыть маршрут в навигаторе">${dayActionIcon('navigate')}</button>
      ${isAdmin() ? `
      <div class="day-overflow-wrap" style="position:relative">
        <button class="nav-day-btn day-menu-trigger" id="dayMenuTrigger${d}" onclick="toggleDayMenu(${d})" title="Ещё" aria-label="Действия с днём" aria-haspopup="dialog" aria-expanded="false" aria-controls="dayMenu${d}">${dayActionIcon('more')}</button>
        <div class="day-overflow-menu" id="dayMenu${d}" role="dialog" aria-label="Действия с днём">
          <div class="day-actions-heading"><span>Действия с днём</span><button class="day-actions-close" onclick="closeDayMenus(true)" aria-label="Закрыть действия с днём">✕</button></div>
          <div class="day-actions-grid">
          <button class="dom-item" onclick="closeDayMenus();fetchDayWeather(${d})">${dayActionIcon('weather')}<span>Погода</span></button>
          ${isAdmin() ? `
          <button class="dom-item" onclick="closeDayMenus();reverseDay(${d})">${dayActionIcon('reverse')}<span>Обратный маршрут</span></button>
          <button class="dom-item" onclick="closeDayMenus();archiveDay(${d})">${dayActionIcon('archive')}<span>В архив</span></button>
          <button class="dom-item" onclick="closeDayMenus();openImportModal(${d})">${dayActionIcon('import')}<span>Импорт из карт</span></button>` : ''}
          </div>
          ${isAdmin() ? `<div class="day-overflow-divider"></div>
          <div class="day-mode-row">
            <div class="day-mode-group" id="dayVisRow${d}">
              <div class="day-mode-label">Читатель</div>
              <div class="day-mode-pills">
                <button class="day-mode-pill ${!data.hidden ? 'active' : ''}" aria-label="День виден читателю" onclick="setDayVisibility(${d},true)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
                <button class="day-mode-pill ${data.hidden ? 'active' : ''}" aria-label="День скрыт от читателя" onclick="setDayVisibility(${d},false)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button>
              </div>
            </div>
            <div class="day-mode-group" id="dayModeRow${d}">
              <div class="day-mode-label">Передвижение</div>
              <div class="day-mode-pills">
                <button class="day-mode-pill ${!data.walkMode ? 'active' : ''}" aria-label="На машине" onclick="setDayMode(${d},'auto')">${dayActionIcon('car')}</button>
                <button class="day-mode-pill ${data.walkMode ? 'active' : ''}" aria-label="Пешком" onclick="setDayMode(${d},'walk')">${dayActionIcon('walk')}</button>
              </div>
            </div>
          </div>
          <div class="day-actions-footer">
          <button class="dom-item" onclick="closeDayMenus();confirmReset(${d})">${dayActionIcon('reset')}<span>Сбросить факт</span></button>
          <button class="dom-item dom-red" onclick="closeDayMenus();confirmDeleteDay(${d})">${dayActionIcon('delete')}<span>Удалить день</span></button>
          </div>` : ''}
        </div>
      </div>
      ` : `<button class="nav-day-btn day-weather-btn" onclick="fetchDayWeather(${d})" title="Погода на маршруте" aria-label="Погода на маршруте">${dayActionIcon('weather')}</button>`}
      </div>
      <div class="day-route" id="d${d}-route"></div>
    </div>
    <div class="depart-row">
      <div class="depart-icon" id="d${d}-depart-icon">${dayActionIcon(data.walkMode ? 'walk' : 'car')}</div>
      <div class="depart-label" style="${isAdmin() ? 'cursor:pointer' : ''}"
           ${isAdmin() ? `onclick="openEditStart(${d})" title="Изменить точку старта"` : ''}>
        <span class="depart-start-name" id="d${d}-start-name">${startPointNameMarkup(data.start, !!data.walkReview)}</span>
        ${isAdmin() ? `<span class="depart-edit-icon">${dayActionIcon('edit')}</span>` : ''}
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
            autocomplete="nope"
            ${isAdmin() ? `onfocus="this.dataset.prevVal=this.value" oninput="applyMask(this)" onblur="padTime(this)" ondblclick="fillOnTime(this)"` : `readonly style="pointer-events:none;border-style:solid;"`}>
        </div>
      </div>
    </div>
    <div class="weather-strip" id="ws-d${d}-start" style="display:none" onclick="toggleWeatherStrip('d${d}-start')"></div>
    <div class="day-progress">
      <div class="progress-label"><span>Пройдено</span><span id="d${d}-pct">0 км</span></div>
      <div class="progress-bar">
        <div class="progress-fill" id="d${d}-fill"></div>
        ${!data.walkReview ? `<div class="progress-drive-track">
          ${canDrive ? '<button type="button" class="progress-drive" onclick="toggleDrivingMode()">' : '<span class="progress-marker" aria-hidden="true">'}
            ${data.walkMode ? dayActionIcon('walk') : `<span class="progress-drive-vehicle" data-progress-day="${d}" aria-hidden="true">${typeof progressVehicleGlyph === 'function' ? progressVehicleGlyph(d) : dayActionIcon('car')}</span>`}
            ${canDrive ? `<span class="progress-drive-start">${data.walkMode ? 'Иду' : 'Еду'}</span><span class="progress-drive-stop">Стоп</span></button>` : '</span>'}
        </div>` : ''}
      </div>
    </div>
    <div class="stats-row">
      <div class="stat-box"><div class="stat-val" id="d${d}-stop-count">${data.stops.length}</div><div class="stat-key">ОСТАНОВОК</div></div>
      <div class="stat-box"><div class="stat-val" id="d${d}-travel-time" style="font-size:13px;">—</div><div class="stat-key" id="d${d}-travel-km" style="letter-spacing:0.06em;">В ПУТИ</div></div>
      <div class="stat-box"><div class="stat-val" id="d${d}-delta-val">—</div><div class="stat-key">ОТКЛОНЕНИЕ</div></div>
    </div>
    <div id="d${d}-stops"></div>
  `;
  return sec;
}

function renderAllDays() {
  const container = document.getElementById('daySections');
  container.innerHTML = '';
  var admin = typeof isAdmin === 'function' && isAdmin();
  dayKeys().forEach(d => {
    if (DAYS_DATA[d].archived) return;
    if (!admin && DAYS_DATA[d].hidden) return;
    container.appendChild(renderDaySection(d));
    updateRouteProgress(d);
    renderStops(d);
    updateDayRoute(d);
    updateTravelStats(d);
  });
  if (!container.children.length) {
    const hasArchive = admin && dayKeys().some(d => DAYS_DATA[d].archived);
    const emptyText = admin
      ? (hasArchive ? 'Добавьте день или восстановите маршрут из архива.' : 'Добавьте день, чтобы начать маршрут.')
      : (SPECTATOR_MODE ? 'Владелец ещё не опубликовал дни или снял их с публикации.' : 'Доступных дней пока нет.');
    container.innerHTML = '<div class="route-empty"><div class="route-empty-icon">' + (SPECTATOR_MODE ? '👁' : '📦') + '</div><h3>'
      + (SPECTATOR_MODE ? 'Нет опубликованных дней' : 'Нет активных дней') + '</h3><p>'
      + emptyText + '</p>' + (admin ? '<div class="route-empty-actions"><button type="button" class="publication-btn" onclick="addNewDay(event)">＋ Добавить день</button>'
        + (hasArchive ? '<button type="button" class="publication-btn route-empty-archive" onclick="toggleArchive(this)">Открыть архив</button>' : '') + '</div>' : '') + '</div>';
  } else if (admin && !container.querySelector('.day-section.visible')) {
    switchDay(Number(container.firstElementChild.dataset.day));
  }
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
  // Пересчитать цвета по позиции среди активных дней (архивные не в счёт)
  var _colorsChanged = false;
  var activeIdx = 0;
  dayKeys().forEach(function(d) {
    var newColor = DAY_COLORS[activeIdx % DAY_COLORS.length];
    if (DAYS_DATA[d].archived) return; // архивные не меняют цвет и не занимают индекс
    if (DAYS_DATA[d].color !== newColor) { DAYS_DATA[d].color = newColor; _colorsChanged = true; }
    activeIdx++;
  });
  if (_colorsChanged && typeof redrawDay === 'function') {
    dayKeys().forEach(function(d) { redrawDay(d); });
  }
  const tabsEl = document.getElementById('dayTabs');
  tabsEl.innerHTML = '';
  var admin = typeof isAdmin === 'function' && isAdmin();
  dayKeys().forEach(d => {
    const data = DAYS_DATA[d];
    // Читатель не видит скрытые дни; архивные не показываются вообще
    if (data.archived) return;
    if (!admin && data.hidden) return;
    const btn  = document.createElement('button');
    btn.className  = 'day-tab' + (d === currentDay ? ' active' : '') + (data.hidden ? ' day-hidden' : '');
    btn.dataset.day = d;
    var shortDate = data.dateISO ? fmtDateShort(data.dateISO) : (typeof _dayLabel === 'function' ? _dayLabel(d) : 'День ' + d);
    var dateParts = shortDate.split(' ');
    const icon = dayIconValue(data);
    btn.innerHTML = '<span class="day-tab-number">' + (icon ? dayIconMarkup(icon) + ' ' : '') + _escHtml(dateParts[0]) + '</span>'
      + '<span class="day-tab-month">' + _escHtml(dateParts.slice(1).join(' ')) + '</span>';
    btn.setAttribute('aria-label', (icon ? (Object.hasOwn(WALK_DAY_ICONS, icon) ? WALK_DAY_ICONS[icon] : icon) + ' ' : '') + shortDate);
    btn.onclick = () => switchDay(d);
    btn.style.setProperty('--dc', data.color);
    if (d === currentDay) {
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
