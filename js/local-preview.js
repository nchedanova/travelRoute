// Local-only test harness. No Gist token, no cloud writes, shared route across role tabs.
if (LOCAL_PREVIEW) {
  const reviewWalk = LOCAL_WALK_REVIEW;
  const reviewSuffix = reviewWalk ? '&walk=1' : '';
  document.addEventListener('DOMContentLoaded', function() {
    var bar = document.createElement('div');
    bar.className = 'local-preview-bar';
    bar.innerHTML = '<span>Локально · без записи в облако</span>'
      + (PREVIEW_ROLE === 'admin' ? '<button class="publication-btn" id="loadLocalHistory">Мой маршрут · восстановленная копия</button>' : '')
      + '<div class="preview-roles" role="group" aria-label="Режим проверки">'
      + Object.entries({admin:'Владелец',reader:'Читатель',spectator:'Зритель'}).map(function(pair) {
        return '<button type="button" class="preview-role-btn" data-role="' + pair[0] + '" aria-pressed="' + (PREVIEW_ROLE === pair[0]) + '">' + pair[1] + '</button>';
      }).join('') + '</div>';
    document.body.prepend(bar);
    document.body.classList.add('local-preview');
    var loadHistory = document.getElementById('loadLocalHistory');
    if (loadHistory) loadHistory.addEventListener('click', async function() {
      try {
        var response = await fetch('./local-route.json', {cache:'no-store'});
        if (!response.ok) throw new Error('Локальная копия маршрута недоступна');
        var payload = await response.json();
        localStorage.setItem(routeStorageKey(), JSON.stringify(payload));
        location.href = location.pathname + '?preview=admin' + reviewSuffix;
      } catch(e) { showToast(e.message); }
    });
    bar.querySelectorAll('[data-role]').forEach(function(button) {
      button.addEventListener('click', function() {
        location.href = location.pathname + '?preview=' + button.dataset.role + reviewSuffix + (button.dataset.role === 'spectator' ? '&chat=0' : '');
      });
    });
    var badge = document.getElementById('modeBadge');
    if (badge) badge.textContent = {admin:'локально · владелец',reader:'локально · читатель',spectator:'локально · зритель'}[PREVIEW_ROLE];
    var changelog = document.getElementById('changelogModal');
    if (changelog) changelog.classList.remove('show');
  });
  window.addEventListener('storage', function(event) {
    if (event.key === routeStorageKey() && PREVIEW_ROLE !== 'admin') location.reload();
  });
}

installWalkReview();

function installWalkReview() {
  const originalAdd = addNewDay;
  const originalSwitch = switchDay;
  const originalRenderAllDays = renderAllDays;
  let session = null;
  const checkpointMeters = 500;

  const picker = document.createElement('div');
  picker.id = 'walk-review-picker';
  picker.className = 'walk-review-picker';
  picker.hidden = true;
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Новый день');
  picker.innerHTML = `
    <button type="button" data-mode="auto">${dayActionIcon('car')}<span>Автомаршрут</span></button>
    <button type="button" data-mode="walk">${dayActionIcon('walk')}<span>Пеший маршрут</span></button>
    <button type="button" data-mode="record">${dayActionIcon('map')}<span>Запись прогулки<small>Точка каждые 500 м</small></span></button>`;
  let trigger;

  function closeChoice(restoreFocus = false) {
    picker.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger?.focus();
    trigger = null;
  }

  function positionChoice() {
    if (picker.hidden) return;
    if (!trigger?.isConnected) { closeChoice(); return; }
    const anchor = trigger.getBoundingClientRect();
    const gap = 8;
    picker.style.maxHeight = '';
    const below = window.innerHeight - anchor.bottom - 2 * gap;
    const above = anchor.top - 2 * gap;
    const placeAbove = picker.offsetHeight > below && above > below;
    picker.style.maxHeight = Math.max(0, placeAbove ? above : below) + 'px';
    picker.style.left = Math.max(gap, Math.min(anchor.right - picker.offsetWidth, window.innerWidth - picker.offsetWidth - gap)) + 'px';
    picker.style.top = (placeAbove ? anchor.top - picker.offsetHeight - gap : anchor.bottom + gap) + 'px';
  }

  picker.addEventListener('click', event => {
    const mode = event.target.closest('[data-mode]')?.dataset.mode;
    if (!mode || !isAdmin()) return;
    closeChoice();
    const id = originalAdd(mode === 'record' ? 'walk' : mode);
    if (mode !== 'record') return;
    const today = new Date();
    Object.assign(DAYS_DATA[id], {
      dateISO: today.toLocaleDateString('ru-RU'), date: 'Прогулка', icon: '🚶',
      walkReview: { phase: 'ready', segments: [], meters: 0, checkpoints: 0 }
    });
    redrawDay(id);
    renderTabs();
    renderAllDays();
    switchDay(id);
    saveData();
  });

  function recordedTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
  }

  function setRecordedStart(id, fix) {
    const day = DAYS_DATA[id];
    const [lat, lng] = fix.point;
    day.start = {...day.start, lat, lng, name: 'Старт прогулки', icon: '🚶'};
    day.departA = recordedTime(fix.time);
    day.departP ||= day.departA;
    document.getElementById('d' + id + '-departP-display').textContent = day.departP;
    document.getElementById('d' + id + '-start-name').innerHTML = startPointNameMarkup(day.start);
    const actual = document.getElementById('d' + id + '-depart');
    actual.value = day.departA;
    actual.classList.remove('empty');
    updateDayRoute(id);
    redrawDay(id);
  }

  function addRecordedStop(id, name, point, timestamp) {
    const day = DAYS_DATA[id];
    const [lat, lng] = point;
    const time = recordedTime(timestamp);
    const stop = {
      id: 'walk-' + id + '-' + Date.now() + '-' + day.stops.length,
      num: day.stops.length + 1, name, lat, lng, type: 'Другое', icon: '📍',
      arrP: time, depP: '', arrA: time, depA: '', notes: []
    };
    day.stops.push(stop);
    const list = document.getElementById('d' + id + '-stops');
    if (!list.querySelector('.stop-card')) list.replaceChildren();
    list.appendChild(makeStopCard(stop, id));
    updateDayRoute(id);
    redrawDay(id);
    return stop;
  }

  function closeRecordedStop(id, recording, timestamp) {
    const stop = DAYS_DATA[id].stops.find(item => item.id === recording.pauseStopId);
    if (stop && !stop.depA) {
      stop.depA = recordedTime(timestamp);
      stop.depP ||= stop.depA;
      const planned = document.getElementById('planned-dep-' + stop.id);
      if (planned) planned.textContent = stop.depP;
      const input = document.getElementById('dep-' + stop.id);
      if (input) {
        input.placeholder = stop.depP;
        input.value = stop.depA;
        input.classList.remove('empty');
        document.getElementById('dep-block-' + stop.id).style.display = '';
      }
    }
    delete recording.pauseStopId;
  }

  function stopWatch() {
    if (!session) return;
    const active = session;
    session = null;
    if (active.watchId != null) navigator.geolocation.clearWatch(active.watchId);
    active.wakeLock?.release().catch(() => {});
    setWalkGpsActive(false);
  }

  function suspendRecording(message) {
    if (!session) return;
    const {id, recording} = session;
    stopWatch();
    recording.phase = recording.startedAt ? 'paused' : 'ready';
    if (currentDay === id) renderRecording(id);
    saveData();
    if (message) showToast(message);
  }

  function acceptFix(active, position) {
    const {id, recording} = active;
    if (session !== active || document.hidden) return;
    if (DAYS_DATA[id]?.walkReview !== recording) { stopWatch(); return; }
    const {latitude, longitude, accuracy} = position.coords;
    if (![latitude, longitude, accuracy, position.timestamp].every(Number.isFinite)
        || accuracy > 35 || Date.now() - position.timestamp > 15000) return;
    const fix = {point: [latitude, longitude], time: position.timestamp, accuracy};
    const previous = active.last;
    if (previous) {
      const seconds = (fix.time - previous.time) / 1000;
      const meters = haversineKm(...previous.point, ...fix.point) * 1000;
      if (fix.time <= active.lastSignalAt) return;
      const gap = fix.time - active.lastSignalAt > 60000;
      if (!gap && meters / seconds > 8) return;
      active.lastSignalAt = fix.time;
      if (gap) {
        // После длительного провала GPS не дорисовываем неизвестный участок.
        recording.segments.push([fix.point]);
      } else if (meters < Math.max(5, Math.min(15, (accuracy + previous.accuracy) / 2))) {
        updateWalkGpsControls(position);
        recording.lastAt = fix.time;
        updateRecordingReadout(id, recording);
        return;
      } else {
        recording.segments.at(-1).push(fix.point);
        const total = recording.meters + meters;
        while ((recording.checkpoints + 1) * checkpointMeters <= total) {
          const mark = ++recording.checkpoints * checkpointMeters;
          const ratio = (mark - recording.meters) / meters;
          const point = previous.point.map((value, i) => value + (fix.point[i] - value) * ratio);
          addRecordedStop(id, mark < 1000 ? mark + ' м' : (mark / 1000).toLocaleString('ru-RU') + ' км',
            point, previous.time + (fix.time - previous.time) * ratio);
        }
        recording.meters = total;
      }
    } else {
      recording.segments.push([fix.point]);
      recording.phase = 'recording';
      if (!recording.startedAt) {
        recording.startedAt = fix.time;
        setRecordedStart(id, fix);
        map.setView(fix.point, 17);
      } else {
        closeRecordedStop(id, recording, fix.time);
      }
    }
    active.last = fix;
    updateWalkGpsControls(position);
    active.lastSignalAt = fix.time;
    recording.lastAt = fix.time;
    refreshWalkTrackLine(id);
    if (!previous) renderRecording(id);
    else updateRecordingReadout(id, recording);
    if (!previous || Date.now() - active.savedAt >= 5000) {
      active.savedAt = Date.now();
      saveData();
    }
  }

  function startWatch(id, recording) {
    if (session || document.hidden) return;
    if (!navigator.geolocation || !window.isSecureContext) {
      showToast('GPS доступен на localhost или по HTTPS.');
      return;
    }
    if (typeof _drivingMode !== 'undefined' && _drivingMode) {
      showToast('Сначала выключите режим «Еду» или «Иду».');
      return;
    }
    const active = {id, recording, last: null, watchId: null, wakeLock: null};
    session = active;
    setWalkGpsActive(true);
    renderRecording(id);
    try {
      active.watchId = navigator.geolocation.watchPosition(
        position => acceptFix(active, position),
        error => {
          if (session !== active) return;
          if (error.code === 1) suspendRecording('Разрешите доступ к геолокации в браузере.');
          else {
            _updateSpeedDisplay(null);
            const hint = document.querySelector('#day' + id + ' .walk-review-panel p');
            if (hint) hint.textContent = 'GPS пока недоступен. Ждём сигнал…';
          }
        },
        {enableHighAccuracy: true, maximumAge: 0, timeout: 20000}
      );
    } catch {
      suspendRecording('Не удалось включить GPS.');
      return;
    }
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then(lock => {
      if (session === active) active.wakeLock = lock;
      else return lock.release();
    }).catch(() => {});
  }

  function updateRecordingReadout(id, recording) {
    const panel = document.querySelector('#day' + id + ' .walk-review-panel');
    if (!panel) return;
    const meters = recording.meters;
    const end = recording.finishedAt || recording.lastAt;
    const minutes = recording.startedAt && end ? Math.floor((end - recording.startedAt) / 60000) : 0;
    panel.querySelector('.walk-review-metrics').textContent =
      (meters / 1000).toLocaleString('ru-RU', {maximumFractionDigits: 2}) + ' км · ' + minutes + ' мин';
    if (recording.phase === 'recording') {
      const remaining = Math.ceil((recording.checkpoints + 1) * checkpointMeters - meters);
      panel.querySelector('p').textContent = 'До следующей точки: ' + remaining + ' м.';
    }
  }

  function renderRecording(id, recenter = false) {
    const recording = DAYS_DATA[id]?.walkReview;
    const editable = isAdmin() && !!recording;
    document.body.classList.toggle('walk-review-recording-day', editable);
    if (!editable) return;
    const section = document.getElementById('day' + id);
    if (!section) return;
    section.classList.add('walk-review-day');
    let panel = section.querySelector('.walk-review-panel');
    if (!panel) {
      panel = document.createElement('section');
      panel.className = 'walk-review-panel';
      section.querySelector('.day-header').after(panel);
    }
    const day = DAYS_DATA[id];
    if (!recording.segments) {
      panel.textContent = 'Демо-прогулка · без GPS-записи';
      return;
    }
    if (recording.phase === 'recording' && session?.recording !== recording) {
      recording.phase = 'paused';
      saveData();
    }
    const {phase} = recording;
    const finished = phase === 'finished';
    const waiting = session?.recording === recording && !session.last;
    const labels = {ready: 'Готово к записи', recording: 'Записываем', paused: 'На паузе', finished: 'Завершена'};
    const descriptions = {
      ready: 'Для записи журнал должен оставаться открытым на включённом экране.',
      recording: 'Следующая точка появится через 500 м.',
      paused: recording.pauseStopId
        ? 'Прибытие отмечено. Продолжение записи заполнит время отправления.'
        : 'Можно продолжить. Остановка и финиш используют последнюю позицию GPS.',
      finished: 'Записанный путь и фактическое время доступны в этом дне.'
    };
    const playing = phase === 'recording';
    const canMark = !waiting && (playing || phase === 'paused');
    const playLabel = phase === 'ready' ? 'Начать запись' : 'Продолжить';
    const buttons = finished ? '' : `
      <button class="walk-review-transport walk-review-primary" data-phase="recording" aria-label="${playLabel}" title="${playLabel}" ${playing || waiting ? 'disabled' : ''}>${dayActionIcon('play')}</button>
      <button class="walk-review-transport" data-phase="paused" aria-label="${waiting ? 'Отменить поиск GPS' : 'Пауза'}" ${playing || waiting ? '' : 'disabled'}>${dayActionIcon('pause')}</button>
      ${phase === 'ready' || waiting ? '' : '<button data-phase="finished" aria-expanded="false" aria-controls="walk-review-confirm-' + id + '">Завершить</button>'}`;
    panel.innerHTML = '<div class="walk-review-heading"><b>Запись прогулки</b><span>' + (waiting ? 'Ищем GPS' : labels[phase]) + '</span></div>'
      + '<p>' + (waiting ? 'Ждём точное местоположение…' : descriptions[phase]) + '</p><div class="walk-review-metrics"></div>'
      + '<div class="walk-review-controls"><div class="walk-review-actions">' + buttons + '</div>'
      + '<div class="walk-review-confirm" id="walk-review-confirm-' + id + '" hidden><span>Завершить прогулку?</span>'
      + '<div class="walk-review-actions"><button data-action="cancel-finish">Нет</button><button class="walk-review-primary" data-action="finish">Да</button></div></div></div>'
      + (canMark ? '<button class="walk-review-mark" data-action="mark" aria-label="Добавить остановку">' + dayActionIcon('plus') + '<span>Остановка</span></button>' : '');
    panel.classList.toggle('walk-review-in-progress', canMark);
    updateRecordingReadout(id, recording);
    panel.onclick = event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      const next = event.target.closest('[data-phase]')?.dataset.phase;
      const confirm = panel.querySelector('.walk-review-confirm');
      if (next === 'finished' || action === 'cancel-finish') {
        const isOpen = next === 'finished' && confirm.hidden;
        confirm.hidden = !isOpen;
        confirm.classList.remove('walk-review-confirm-below');
        if (isOpen) {
          const route = document.getElementById('tabPanelRoute').getBoundingClientRect();
          const header = section.querySelector('.day-header').getBoundingClientRect();
          const popup = confirm.getBoundingClientRect();
          const controls = confirm.parentElement.getBoundingClientRect();
          const above = controls.top - Math.max(route.top, header.bottom);
          const below = route.bottom - controls.bottom;
          if (above < popup.height + 4 && below > above) {
            confirm.classList.add('walk-review-confirm-below');
          }
        }
        const finishButton = panel.querySelector('[data-phase="finished"]');
        finishButton.setAttribute('aria-expanded', String(isOpen));
        if (action === 'cancel-finish') finishButton.focus({preventScroll: true});
        return;
      }
      if (next === 'recording') { startWatch(id, recording); return; }
      if (next === 'paused') { suspendRecording(); return; }
      const point = recording.segments.at(-1)?.at(-1);
      const now = Date.now();
      if (action === 'mark') {
        if (!point) return;
        if (recording.pauseStopId) closeRecordedStop(id, recording, now);
        const stop = addRecordedStop(id, 'Остановка', point, now);
        stopWatch();
        recording.pauseStopId = stop.id;
        recording.phase = 'paused';
      } else if (action === 'finish') {
        stopWatch();
        if (point) addRecordedStop(id, 'Финиш прогулки', point, now);
        recording.phase = 'finished';
        recording.finishedAt = now;
        delete recording.pauseStopId;
      } else return;
      renderRecording(id);
      if (action === 'mark') panel.querySelector('[data-action="mark"]').focus({preventScroll: true});
      saveData();
    };
    if (recenter && phase !== 'ready') {
      const points = recording.segments.flat().concat([day.start, ...day.stops]
        .filter(p => p.lat || p.lng).map(p => [p.lat, p.lng]));
      if (points.length > 1) map.fitBounds(L.latLngBounds(points), {padding: [28, 28], maxZoom: 16});
      else if (points.length === 1) map.setView(points[0], 16);
    }
  }

  addNewDay = event => {
    if (!isAdmin()) return;
    if (typeof event === 'string') return originalAdd(event);
    const anchor = event?.currentTarget || document.querySelector('.day-tab-add, .route-empty .publication-btn');
    if (trigger === anchor) { closeChoice(true); return; }
    closeChoice();
    if (!anchor) return;
    trigger = anchor;
    trigger.setAttribute('aria-controls', picker.id);
    trigger.setAttribute('aria-expanded', 'true');
    picker.hidden = false;
    positionChoice();
    picker.querySelector('button').focus({preventScroll: true});
  };
  switchDay = function(id) {
    if (session && (session.id !== id || DAYS_DATA[id]?.walkReview !== session.recording)) suspendRecording();
    originalSwitch(id);
    renderRecording(id, true);
  };
  renderAllDays = function() {
    originalRenderAllDays();
    renderRecording(currentDay);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspendRecording();
  });
  window.addEventListener('pagehide', () => suspendRecording());
  document.addEventListener('pointerdown', event => {
    if (!picker.contains(event.target) && !trigger?.contains(event.target)) closeChoice();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !picker.hidden) closeChoice(true);
  });
  window.addEventListener('resize', positionChoice);
  document.addEventListener('scroll', event => {
    if (!picker.contains(event.target)) positionChoice();
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(picker);
    renderTabs();
    renderRecording(currentDay, true);
  });
}
