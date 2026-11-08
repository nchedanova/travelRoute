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
function updateRouteProgress(day, gpsFraction = 0) {
  const fill = document.getElementById('d' + day + '-fill');
  if (!fill) return;
  const data = DAYS_DATA[day];
  const reached = data.stops.findLastIndex(stop => [stop.arrA, stop.depA].some(time => _parseTime(time) !== null)) + 1;
  const totalKm = getDayRouteKm(day);
  const markedKm = reached ? getDayRouteKm(day, reached) : 0;
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
  if (!km) {
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
  charging:['Заправка','Зарядка','⚡','<path d="m13 2-8 12h6l-1 8 9-13h-6Z"/>'],
  service:['Заправка','Автосервис','🔧','<path d="M21 3a6 6 0 0 1-8 8L5 20a2 2 0 0 1-3-3l9-8a6 6 0 0 1 8-8l-4 4 4 2Z"/>'],
  parking:['Заправка','Парковка','🅿️','<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>'],
  dining:['Кафе','Ресторан','🍽️','<path d="M4 3v5a3 3 0 0 0 6 0V3M7 3v18M17 21V3c-4 3-4 9 0 9"/>'],
  bakery:['Кафе','Пекарня','🥐','<path d="m3 13 4-7 5-2 5 2 4 7-3 5-4-3h-4l-4 3ZM7 6l3 9M17 6l-3 9"/>'],
  takeaway:['Кафе','Еда с собой','🥤','<path d="M5 7h14M7 7l1 14h8l1-14M11 7l2-5h5M5 4h12"/>'],
  bag:['Магазин','Покупки','🛍️','<path d="M5 8h14l2 13H3ZM8 8V6a4 4 0 0 1 8 0v2"/>'],
  groceries:['Магазин','Продукты','🥑','<path d="M12 7c-8-6-12 6-6 13 2 2 4 0 6 0s4 2 6 0c6-7 2-19-6-13ZM12 7c0-4 2-5 5-5"/>'],
  pharmacy:['Магазин','Аптека','💊','<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 7v10M7 12h10"/>'],
  bed:['Отель','Ночлег','🛏️','<path d="M3 20V5M21 20V9H9v6M3 15h18M3 18h18"/><circle cx="6" cy="11" r="2"/>'],
  key:['Отель','Заселение','🔑','<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9M16 16l3-3M19 19l3-3"/>'],
  bellhop:['Отель','Ресепшен','🛎️','<path d="M3 18h18M5 15a7 7 0 0 1 14 0ZM12 8V5M10 5h4M3 21h18"/>'],
  apartment:['Жильё','Квартира','🏢','<path d="M5 21V3h14v18M9 7h1M14 7h1M9 11h1M14 11h1M10 21v-5h4v5"/>'],
  cottage:['Жильё','Загородный дом','🏡','<path d="m3 11 9-8 9 8M5 10v11h14V10M9 21v-7h6v7M16 5V2"/>'],
  camping:['Жильё','Кемпинг','⛺','<path d="m12 3-10 18h20ZM12 3v18M7 21l5-9 5 9"/>'],
  park:['Другое','Парк','🌳','<path d="m12 2-6 7h3l-5 6h6v7h4v-7h6l-5-6h3Z"/>'],
  tree:['Другое','Дерево','🌳','<path d="M12 14v8M8 22h8"/><path d="M7 16a4 4 0 0 1-3-7 5 5 0 0 1 8-6 5 5 0 0 1 8 6 4 4 0 0 1-3 7Z"/>'],
  leaves:['Другое','Листья','🍃','<path d="M4 20 19 5M9 15C2 15 2 5 20 3c0 13-4 17-11 12ZM10 14v-4M14 10h4"/>'],
  promenade:['Другое','Набережная','🌊','<path d="M3 3v8M11 3v8M19 3v8M3 5h16M3 9h16M2 13h20M2 17q2-2 4 0t4 0 4 0 4 0 4 0M2 21q2-2 4 0t4 0 4 0 4 0 4 0"/>'],
  museum:['Другое','Музей','🏛️','<path d="m2 7 10-5 10 5ZM4 10v8M9 10v8M15 10v8M20 10v8M3 18h18M2 22h20"/>'],
  pool:['Другое','Бассейн','🏊','<path d="M7 15V5a2 2 0 0 1 4 0M15 15V5a2 2 0 0 1 4 0M7 7h8M7 11h8M2 17q2-2 4 0t4 0 4 0 4 0 4 0M2 21q2-2 4 0t4 0 4 0 4 0 4 0"/>'],
  beach:['Другое','Море / пляж','🏖️','<path d="M3 11a9 9 0 0 1 18 0ZM12 2c-3 3-3 6-3 9M12 2c3 3 3 6 3 9M12 11v8M3 21q5-4 10-2t8 0"/>'],
  mountains:['Другое','Горы','⛰️','<path d="m2 21 8-18 8 18ZM7 10l3 3 3-3M15 14l3-7 5 14"/>'],
  concert:['Другое','Концерт','🎤','<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8M10 6h4M10 9h4"/>']
};
const POINT_GRAPHIC_PAINT = {
  charging:['#ffd166'], service:['#c5d2de'], parking:['#79baff'],
  dining:['#edf2f7'], bakery:['#edb565'], takeaway:['#f294ac'],
  bag:['#c5a4f5'], groceries:['#8bd17c'], pharmacy:['#77d6af'],
  bed:['#9ebcfa'], key:['#f4ce77'], bellhop:['#f4ce77'],
  apartment:['#ced8e4'], cottage:['#90d5a4'],
  tree:['#83d18b'], leaves:['#96d98b'],
  promenade:['#dce6ed','<path d="M3 3v8M11 3v8M19 3v8M3 5h16M3 9h16M2 13h20"/><path stroke="#72cffa" d="M2 17q2-2 4 0t4 0 4 0 4 0 4 0M2 21q2-2 4 0t4 0 4 0 4 0 4 0"/>'],
  camping:['#edb565','<path d="m12 3-10 18h20Z"/><path stroke="#d9edf4" d="M12 3v18M7 21l5-9 5 9"/>'],
  park:['#83d18b',
    '<path stroke="#d2a67e" d="M12 15v7"/><path fill="#83d18b" fill-opacity=".22" d="m12 2-6 7h3l-5 6h16l-5-6h3Z"/>'],
  museum:['#edf2f7'],
  pool:['#edf2f7',
    '<path d="M7 15V5a2 2 0 0 1 4 0M15 15V5a2 2 0 0 1 4 0M7 7h8M7 11h8"/><path stroke="#72cffa" d="M2 17q2-2 4 0t4 0 4 0 4 0 4 0M2 21q2-2 4 0t4 0 4 0 4 0 4 0"/>'],
  beach:['#f4ce77',
    '<path stroke="#ed9c86" d="M3 11a9 9 0 0 1 18 0ZM12 2c-3 3-3 6-3 9M12 2c3 3 3 6 3 9"/><path d="M12 11v8"/><path stroke="#72cffa" d="M3 21q5-4 10-2t8 0"/>'],
  mountains:['#9fc1b1',
    '<path d="m2 21 8-18 8 18ZM15 14l3-7 5 14"/><path stroke="#edf2f7" d="m7 10 3 3 3-3M16.5 10.5l1.5 1.5 1.5-1.5"/>'],
  concert:['#c5a4f5',
    '<rect stroke="#edf2f7" x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/><path stroke="#aebbd0" d="M10 6h4M10 9h4"/>']
};
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
  return ['type:' + category].concat(Object.keys(POINT_GRAPHICS)
    .filter(key => POINT_GRAPHICS[key][0] === category).map(key => 'graphic:' + key),
    (ICON_SETS[category] || []).slice(0, category === 'Другое' ? ICON_SETS[category].length : 6).map(emoji => 'emoji:' + emoji));
}
function stopTypeIcon(type) {
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
function startPointNameMarkup(start) {
  const name = String(start.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<span class="depart-start-icon">' + pointIconMarkup(start.icon) + '</span><span class="depart-name-text">' + name + '</span>';
}
function renderDaySection(d) {
  const canDrive = isAdmin();
  if (typeof discardInlinePlanTimeForDay === 'function') discardInlinePlanTimeForDay(d);
  const data    = DAYS_DATA[d];
  const sec     = document.createElement('div');
  sec.className  = 'day-section' + (d === currentDay ? ' visible' : '');
  sec.dataset.day = d;
  sec.id          = 'day' + d;

  sec.innerHTML = `
    <div class="day-header">
      <div style="flex:1;min-width:0">
        <div class="day-label" style="color:${data.color};">
          ${isAdmin() ? `<span class="day-icon-wrap" id="d${d}-day-icon-wrap" onclick="editDayIcon(${d}, this)" title="Иконка дня"><span class="day-icon-val" id="d${d}-day-icon">${data.icon || '📅'}</span><span class="day-date-edit-icon">${dayActionIcon('edit')}</span></span> · ` : (data.icon ? `<span class="day-icon-val">${data.icon}</span> · ` : '')}
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
        <span class="depart-start-name" id="d${d}-start-name">${startPointNameMarkup(data.start)}</span>
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
            ${data.walkMode ? dayActionIcon('walk') : `<span class="progress-drive-vehicle" aria-hidden="true">${typeof progressVehicleGlyph === 'function' ? progressVehicleGlyph() : dayActionIcon('car')}</span>`}
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
    btn.innerHTML = '<span class="day-tab-number">' + _escHtml((data.icon ? data.icon + ' ' : '') + dateParts[0]) + '</span>'
      + '<span class="day-tab-month">' + _escHtml(dateParts.slice(1).join(' ')) + '</span>';
    btn.setAttribute('aria-label', (data.icon ? data.icon + ' ' : '') + shortDate);
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
