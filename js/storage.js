// ── CLOUD STORAGE HELPERS (GitHub Gist API) ───────────────────────────────────

// cloudEnabled = можно хотя бы читать (gistId есть)
function cloudEnabled() {
  return CLOUD_CONFIG.canRead;
}

function setSyncStatus(text, color) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  // During tile prefetch, only prefetch messages (📥/✅ Карта) can update status
  if (window._tilePrefetching && !text.includes('📥') && !text.includes('Карта загружена')) return;
  el.textContent = text;
  el.style.color = color || 'var(--muted)';
}

function setModeBadge() {
  const badge = document.getElementById('modeBadge');
  if (!badge) return;
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    badge.textContent = '📱 демо';
    badge.className = 'mode-badge viewer';
  } else if (!cloudEnabled()) {
    badge.textContent = '⊘ офлайн';
    badge.className = 'mode-badge';
  } else if (CLOUD_CONFIG.canWrite) {
    badge.textContent = 'админ';
    badge.className = 'mode-badge admin';
  } else {
    badge.textContent = 'чтение';
    badge.className = 'mode-badge viewer';
  }
}

let _gistOwnerLogin = null; // кешируем логин владельца после первого API-запроса

async function fetchCloudData() {
  const headers = { 'Accept': 'application/vnd.github+json' };
  if (CLOUD_CONFIG.apiKey) headers['Authorization'] = `token ${CLOUD_CONFIG.apiKey}`;

  // Зрители (без токена): если знаем логин — читаем raw URL (нет лимитов API)
  if (!CLOUD_CONFIG.apiKey && _gistOwnerLogin) {
    const rawUrl = `https://gist.githubusercontent.com/${_gistOwnerLogin}/${CLOUD_CONFIG.binId}/raw/data.json?t=${Date.now()}`;
    const r = await fetch(rawUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }

  // Первый запрос (или владелец с токеном) — через API, запоминаем логин
  const r = await fetch(`${GIST_URL}/${CLOUD_CONFIG.binId}`, { headers, cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const json = await r.json();

  // Сохраняем логин для дальнейших запросов без токена
  if (json.owner?.login) _gistOwnerLogin = json.owner.login;

  const raw = json.files['data.json']?.content;
  if (!raw) throw new Error('data.json not found in gist');
  return JSON.parse(raw);
}

async function pushCloudData(payload) {
  if (!CLOUD_CONFIG.canWrite) throw new Error('Нет токена — запись недоступна');
  const r = await fetch(`${GIST_URL}/${CLOUD_CONFIG.binId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `token ${CLOUD_CONFIG.apiKey}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      files: { 'data.json': { content: JSON.stringify(payload) } }
    })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}

// Debounce: откладывает облачное сохранение на 1.5с после последнего изменения
let _saveCloudTimer = null;
function scheduleCloudSave(payload) {
  clearTimeout(_saveCloudTimer);
  _saveCloudTimer = setTimeout(async () => {
    setSyncStatus('☁ сохранение…', 'var(--amber)');
    try {
      await pushCloudData(payload);
      setSyncStatus('☁ сохранено', 'var(--green)');
      setTimeout(() => setSyncStatus('☁ ок', 'var(--muted)'), 2000);
    } catch(e) {
      console.error('Cloud save error', e);
      setSyncStatus('☁ ошибка', '#f87171');
    }
    _saveCloudTimer = null;
  }, 1500);
}

// ── APPLY SAVED PAYLOAD ───────────────────────────────────────────────────────
function applyPayload(saved) {
  state.actuals = saved.actuals || {};

  if (saved.daysData) {
    Object.keys(DAYS_DATA).forEach(k => delete DAYS_DATA[k]);
    Object.entries(saved.daysData).forEach(([dayStr, dayData]) => {
      DAYS_DATA[Number(dayStr)] = dayData;
    });
  } else {
    // старый формат (обратная совместимость)
    if (saved.stopsData) {
      Object.entries(saved.stopsData).forEach(([dayStr, stops]) => {
        const day = Number(dayStr);
        if (DAYS_DATA[day]) DAYS_DATA[day].stops = stops.map(s => ({ ...s }));
      });
    }
    if (saved.extraDays) {
      saved.extraDays.forEach(ed => {
        if (!DAYS_DATA[ed.day]) {
          DAYS_DATA[ed.day] = {
            color: ed.color, date: ed.date,
            departP: ed.departP, departA: ed.departA || '',
            start: ed.start, stops: ed.stops
          };
        }
      });
    }
    if (saved.dates) {
      dayKeys().forEach(day => {
        if (saved.dates[day]) DAYS_DATA[day].date = saved.dates[day];
      });
    }
  }

  Object.entries(state.actuals).forEach(([id, a]) => {
    dayKeys().forEach(day => {
      DAYS_DATA[day].stops.forEach(s => {
        if (s.id !== id) return;
        if (a.arrA !== undefined) s.arrA = a.arrA;
        if (a.depA !== undefined) s.depA = a.depA;
      });
    });
  });

  dayKeys().forEach(day => {
    if (saved['dep' + day]) DAYS_DATA[day].departA = saved['dep' + day];
  });

  // ── Миграция note → notes[] ─────────────────────────────────────────────
  dayKeys().forEach(function(day) {
    (DAYS_DATA[day].stops || []).forEach(function(s) {
      if (s.notes) return; // уже новый формат
      if (s.note || (s.noteImages && s.noteImages.length)) {
        s.notes = [{ text: s.note || '', images: s.noteImages || [], public: false }];
      } else {
        s.notes = [];
      }
      delete s.note;
      delete s.noteImages;
    });
  });
}

// ── LOAD STATE ────────────────────────────────────────────────────────────────
// loadState — единственная точка включения OSRM (enableRouteLoading).
// Init в app.js рисует placeholder-прямые БЕЗ OSRM.
// Здесь мы: flush очередь → enableRouteLoading → redraw → колбэки ссылаются
// на актуальные полилинии, гонки нет.
async function loadState() {
  var _didRedraw = false;  // флаг: step 1 уже перерисовал с OSRM

  // ── ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ: полная перерисовка слоёв ──
  function _fullRedraw() {
    if (typeof _flushQueue === 'function') _flushQueue(); // убить OSRM от предыдущего redraw
    if (typeof enableRouteLoading === 'function') enableRouteLoading();
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
  }

  // 1. Сначала грузим из localStorage (мгновенно — UI не ждёт)
  try {
    const raw = localStorage.getItem('travel_tracker_v3');
    if (raw) {
      applyPayload(JSON.parse(raw));
      _fullRedraw();
      _didRedraw = true;
      renderTabs();
      renderAllDays();
      if (typeof renderArchiveBtn === 'function') renderArchiveBtn();
      updateProgress();
      switchDay(_pickVisibleDay(currentDay));
      _lastGeoHash = _buildGeoHash();
      _lastViewerHash = _buildViewerHash();
    }
  } catch(e) { console.error('loadState localStorage error', e); }

  // 2. Затем пробуем облако (перезаписывает локальный кэш)
  if (!cloudEnabled()) {
    // Демо / офлайн: если step 1 не отработал — перерисовать с OSRM.
    // Init нарисовал прямые (OSRM был выключен) → нужен redraw с enableRouteLoading.
    if (!_didRedraw) {
      _fullRedraw();
      renderTabs();
      renderAllDays();
      if (typeof renderArchiveBtn === 'function') renderArchiveBtn();
      updateProgress();
      switchDay(_pickVisibleDay(currentDay));
    }
    setSyncStatus('☁ офлайн', 'var(--muted)');
    setModeBadge();
    return;
  }

  // Если нет токена — режим «только чтение»
  if (!CLOUD_CONFIG.canWrite) {
    setSyncStatus('👁 только чтение', 'var(--amber)');
  } else {
    setSyncStatus('☁ загрузка…', 'var(--amber)');
  }
  setModeBadge();
  try {
    const saved = await fetchCloudData();
    const json  = JSON.stringify(saved);
    _lastCloudHash = strHash(json);
    const geoHashBefore = _buildGeoHash();
    applyPayload(saved);
    if (typeof enableRouteLoading === 'function') enableRouteLoading(); // реальные данные из облака — OSRM можно
    const geoHashAfter = _buildGeoHash();
    _lastGeoHash = geoHashAfter;
    _lastViewerHash = _buildViewerHash();
    // Сохраняем в localStorage чтобы следующий визит мог пропустить cloud fetch.
    // При QuotaExceeded очищаем routeCache — он восстановится через OSRM,
    // а travel_tracker_v3 важнее (без него каждый визит = прямые линии у читателя)
    try {
      localStorage.setItem('travel_tracker_v3', json);
    } catch(e) {
      if (e.name === 'QuotaExceededError') {
        try { localStorage.removeItem('travel_route_cache_v2'); } catch {}
        try { localStorage.setItem('travel_tracker_v3', json); } catch {}
      }
    }

    if (geoHashBefore !== geoHashAfter) {
      // Геометрия изменилась (первый визит или маршрут реально поменялся) → полный redraw.
      // _flushQueue гарантирует: OSRM-колбэки от step 1 не обновят уничтоженные полилинии,
      // а новые запросы будут ссылаться на актуальные объекты.
      _fullRedraw();
    }
    // Если геометрия та же — слои не трогаем, линии по дорогам из _routeCache остаются
    // Обновляем UI после загрузки облачных данных
    renderTabs();
    renderAllDays();
    if (typeof renderArchiveBtn === 'function') renderArchiveBtn();
    updateProgress();
    var validDay = _pickVisibleDay(currentDay);
    if (validDay !== currentDay) currentDay = validDay;
    switchMapDay(currentDay);
    setSyncStatus('☁ загружено', 'var(--green)');
    setTimeout(() => setSyncStatus(
      CLOUD_CONFIG.canWrite ? '☁ ок' : '👁 только чтение',
      CLOUD_CONFIG.canWrite ? 'var(--muted)' : 'var(--amber)'
    ), 2000);
  } catch(e) {
    console.error('loadState cloud error', e);
    setSyncStatus('☁ ошибка загрузки', '#f87171');
  }
}

// ── SAVE DATA ─────────────────────────────────────────────────────────────────
function saveData() {
  try {
    dayKeys().forEach(day => DAYS_DATA[day].stops.forEach(s => {
      const aEl = document.getElementById('arr-' + s.id);
      const dEl = document.getElementById('dep-' + s.id);
      if (!state.actuals[s.id]) state.actuals[s.id] = {};
      if (aEl) { s.arrA = aEl.value; state.actuals[s.id].arrA = aEl.value; }
      if (dEl) { s.depA = dEl.value; state.actuals[s.id].depA = dEl.value; }
    }));

    const deps = {};
    dayKeys().forEach(day => {
      const el = document.getElementById('d' + day + '-depart');
      deps['dep' + day] = el ? el.value : '';
      DAYS_DATA[day].departA = deps['dep' + day];
    });

    const daysData = {};
    dayKeys().forEach(day => {
      daysData[day] = JSON.parse(JSON.stringify(DAYS_DATA[day]));
    });

    const payload = { actuals: state.actuals, daysData, ...deps };

    // Всегда сохраняем в localStorage как кэш
    localStorage.setItem('travel_tracker_v3', JSON.stringify(payload));

    // Дополнительно — в облако (с дебаунсом), только если есть токен
    if (CLOUD_CONFIG.canWrite) scheduleCloudSave(payload);

  } catch(e) { console.error('saveData error', e); }
  showToast();
  updateProgress();
}

// ── AUTO-POLL (тихое обновление) ──────────────────────────────────────────────
let _lastCloudHash = null;
let _lastGeoHash   = null;  // хэш только координат — перерисовка карты только при изменении геометрии
let _lastViewerHash = null; // хэш видимых читателю данных — сайдбар обновляется только при видимых изменениях
let _userIsTyping  = false;
let _userHasFocus  = false;  // любой инпут сфокусирован
let _typingTimer   = null;

// Хэш только геометрии маршрута: ключи дней, start + stops lat/lng, walkMode.
// Изменение времени/факта не влияет → читатель не видит вспышку прямых линий.
function _buildGeoHash() {
  try {
    var parts = dayKeys().sort(function(a,b){return a-b;}).map(function(d) {
      var day = DAYS_DATA[d];
      if (!day) return '';
      var pts = day.start.lat + ',' + day.start.lng;
      day.stops.forEach(function(s) { pts += '|' + s.lat + ',' + s.lng; });
      return d + ':' + (day.walkMode ? '1' : '0') + ':' + pts;
    });
    return strHash(parts.join(';'));
  } catch(e) { return null; }
}

// Хэш данных видимых читателю: координаты + времена + public notes + даты.
// Приватные заметки НЕ входят → их добавление/изменение не мигает сайдбаром у читателя.
function _buildViewerHash() {
  try {
    var parts = dayKeys().sort(function(a,b){return a-b;}).map(function(d) {
      var day = DAYS_DATA[d];
      if (!day) return '';
      var s = d + ':' + (day.hidden?'H':'') + ':' + (day.dateISO||'') + ':' + (day.date||'') + ':' + (day.departP||'') + ':' + (day.departA||'');
      day.stops.forEach(function(st) {
        s += '|' + st.lat + ',' + st.lng + ',' + (st.arrP||'') + ',' + (st.arrA||'') + ',' + (st.depP||'') + ',' + (st.depA||'');
        // Только public notes
        if (st.notes) {
          st.notes.forEach(function(n) {
            if (n.public) s += ',N:' + (n.text||'') + ':' + (n.images||[]).length;
          });
        }
      });
      return s;
    });
    return strHash(parts.join(';'));
  } catch(e) { return null; }
}

function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
  return h;
}

// Выбрать currentDay с учётом скрытых дней для читателя
function _pickVisibleDay(preferred) {
  var keys = dayKeys();
  if (!keys.length) return 1;
  var viewer = typeof isViewer === 'function' && isViewer();
  if (keys.includes(preferred) && (!viewer || !DAYS_DATA[preferred]?.hidden)) return preferred;
  for (var i = 0; i < keys.length; i++) {
    if (!viewer || !DAYS_DATA[keys[i]]?.hidden) return keys[i];
  }
  return keys[0] || 1;
}

document.addEventListener('input', () => {
  _userIsTyping = true;
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(() => { _userIsTyping = false; }, 5000);
});

document.addEventListener('focusin', e => {
  if (e.target.matches('input, select, textarea')) _userHasFocus = true;
});
document.addEventListener('focusout', e => {
  if (e.target.matches('input, select, textarea')) {
    // небольшая задержка на случай перехода между полями
    setTimeout(() => {
      if (!document.activeElement?.matches('input, select, textarea')) _userHasFocus = false;
    }, 200);
  }
});

async function pollCloud() {
  if (!cloudEnabled()) return;
  // Блокируем поллинг если пользователь активно вводит данные или идёт сохранение
  if (_userIsTyping || _userHasFocus) return;
  if (_saveCloudTimer) return;

  try {
    const saved = await fetchCloudData();
    const json  = JSON.stringify(saved);
    const hash  = strHash(json);
    if (hash === _lastCloudHash) return;
    _lastCloudHash = hash;

    applyPayload(saved);
    localStorage.setItem('travel_tracker_v3', json);

    // Проверяем изменилась ли геометрия маршрута (координаты, walkMode, состав дней).
    // Если нет — не трогаем слои карты: читатель не видит вспышку прямых линий
    // при каждом поллинге из-за изменения только времён/факта.
    const newGeoHash = _buildGeoHash();
    const geoChanged = (newGeoHash !== _lastGeoHash);
    _lastGeoHash = newGeoHash;

    if (geoChanged) {
      // Геометрия изменилась (добавили точку, поменяли координаты, поменяли порядок дней)
      // → flush OSRM очередь + пересоздаём слои карты полностью
      if (typeof _flushQueue === 'function') _flushQueue();
      Object.keys(layers).forEach(k => {
        if (map.hasLayer(layers[k])) map.removeLayer(layers[k]);
        delete layers[k];
      });
      Object.keys(segmentLayers).forEach(k => { delete segmentLayers[k]; });
      dayKeys().forEach(d => {
        layers[d] = L.layerGroup();
        segmentLayers[d] = [];
        redrawDay(d);
      });
    }
    // Если геометрия та же — слои не трогаем, линии по дорогам остаются

    // Для читателя: renderAllDays только если изменились видимые данные
    // (координаты, времена, public notes). Приватные заметки не мигают сайдбаром.
    var newViewerHash = _buildViewerHash();
    var viewerChanged = (newViewerHash !== _lastViewerHash);
    _lastViewerHash = newViewerHash;

    var shouldRenderUI = isAdmin() || viewerChanged;
    if (shouldRenderUI) {
      renderTabs();
      renderAllDays();
      if (typeof renderArchiveBtn === 'function') renderArchiveBtn();
    }
    updateProgress();
    // Переключаем карту на текущий день только если изменилась геометрия —
    // иначе fitBounds прыгает на маршрут каждые 10 сек пока читатель смотрит на карту
    var validDay = _pickVisibleDay(currentDay);
    if (validDay !== currentDay) currentDay = validDay;
    if (geoChanged) switchMapDay(currentDay);
    const t = new Date().toLocaleTimeString('ru', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    setSyncStatus(`🔄 обновлено ${t}`, 'var(--green)');
    setTimeout(() => setSyncStatus(
      CLOUD_CONFIG.canWrite ? '☁ ок' : '👁 только чтение',
      CLOUD_CONFIG.canWrite ? 'var(--muted)' : 'var(--amber)'
    ), 3000);
    // Тост только при геометрических изменениях — иначе мигает каждые 10 сек
    if (geoChanged) showToast('🔄 Маршрут обновлён');
  } catch(e) {
    console.warn('poll error', e);
  }
}

function startPolling(intervalMs = 10000) {
  if (!cloudEnabled()) return;
  // Читатель: каждые 10 сек (raw CDN, без лимитов, баланс живости и батареи)
  // Админ: каждые 20 сек — не перетираем несохранённые правки
  const interval = CLOUD_CONFIG.canWrite ? 20000 : intervalMs;
  setInterval(() => {
    if (CLOUD_CONFIG.canWrite && _saveCloudTimer) return;
    pollCloud();
  }, interval);
}

function copyShareLink() {
  const gistId = CLOUD_CONFIG.binId;
  if (!gistId) {
    const st = document.getElementById('cs-status');
    st.textContent = '⚠ Сначала сохраните Gist ID';
    st.style.color = '#f87171';
    return;
  }
  const url = new URL(window.location.href);
  url.search = ''; // убираем старые params
  url.searchParams.set('gist', gistId);
  const fbKey = localStorage.getItem('travel_firebase_key') || '';
  if (fbKey) url.searchParams.set('fbkey', fbKey);
  navigator.clipboard.writeText(url.toString()).then(() => {
    const st = document.getElementById('cs-status');
    st.textContent = '✓ Ссылка скопирована! Gist должен быть публичным.';
    st.style.color = 'var(--green)';
  });
}

// ── CLOUD SETTINGS UI ─────────────────────────────────────────────────────────
function openCloudSettings() {
  document.getElementById('cs-token').value        = localStorage.getItem('travel_gist_token') || '';
  document.getElementById('cs-gist').value          = localStorage.getItem('travel_gist_id')    || '';
  document.getElementById('cs-firebase-key').value  = localStorage.getItem('travel_firebase_key') || '';

  document.getElementById('cs-status').textContent  = '';
  document.getElementById('cloudSettingsModal').classList.add('show');

  _checkAppVersion();
}

// ── VERSION CHECK ─────────────────────────────────────────────────────────────
async function _checkAppVersion() {
  var curEl   = document.getElementById('csVerCurrent');
  var badge   = document.getElementById('csVerBadge');
  var hint    = document.getElementById('csVerHint');
  var hintTxt = document.getElementById('csVerHintText');
  var block   = document.getElementById('csVerBlock');

  var ver = (typeof APP_VERSION !== 'undefined' ? 'v' + APP_VERSION : '') +
            (typeof APP_BUILD   !== 'undefined' ? ' build ' + APP_BUILD : '');
  curEl.textContent = ver || '—';

  badge.className  = 'cs-ver-badge spin';
  badge.textContent = '⟳ проверяю…';
  hint.style.display = 'none';
  block.className = 'cs-ver-block';

  try {
    var localBuild = typeof APP_BUILD !== 'undefined' ? APP_BUILD : null;

    // Ask the active SW for its version via MessageChannel — bypasses all caches
    var reg = await navigator.serviceWorker.ready;
    var worker = reg.active;
    if (!worker) throw new Error('no active SW');

    var swInfo = await new Promise(function(resolve, reject) {
      var mc = new MessageChannel();
      // Set up listener BEFORE posting message
      mc.port1.onmessage = function(ev) {
        clearTimeout(timer);
        resolve(ev.data);
      };
      var timer = setTimeout(function() { reject(new Error('SW timeout')); }, 4000);
      // Transfer port2 to SW so it can reply on it
      worker.postMessage({ type: 'GET_VERSION' }, [mc.port2]);
    });

    var serverBuild = swInfo.build;
    var serverVer   = swInfo.version;

    if (!serverBuild) {
      badge.className  = 'cs-ver-badge spin';
      badge.textContent = '? не удалось проверить';
      return;
    }

    if (localBuild === serverBuild) {
      badge.className  = 'cs-ver-badge ok';
      badge.textContent = '✓ актуальная';
      block.classList.add('ver-ok');
    } else {
      badge.className  = 'cs-ver-badge old';
      var newVerStr = serverVer ? 'v' + serverVer + ' build ' + serverBuild : 'build ' + serverBuild;
      badge.textContent = '↑ доступна ' + newVerStr;
      block.classList.add('ver-old');
      hint.style.display = 'block';
      var isPWA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
      hintTxt.textContent = isPWA
        ? 'PWA: нажми кнопку ниже или закрой/открой приложение.'
        : 'Нажми кнопку ниже — страница перезагрузится с новой версией.';
    }
  } catch(e) {
    badge.className  = 'cs-ver-badge spin';
    badge.textContent = navigator.onLine ? '? ошибка проверки' : '— офлайн';
  }
}

function closeCloudSettings() {
  document.getElementById('cloudSettingsModal').classList.remove('show');
}

function clearCloudSettings() {
  localStorage.removeItem('travel_gist_token');
  localStorage.removeItem('travel_gist_id');
  localStorage.removeItem('travel_firebase_key');
  document.getElementById('cs-token').value       = '';
  document.getElementById('cs-gist').value        = '';
  document.getElementById('cs-firebase-key').value = '';

  const st = document.getElementById('cs-status');
  st.textContent = '✓ Настройки очищены — работаем офлайн';
  st.style.color = 'var(--muted)';
  setSyncStatus('☁ офлайн', 'var(--muted)');
}

async function saveCloudSettings() {
  const token  = document.getElementById('cs-token').value.trim();
  const gist   = document.getElementById('cs-gist').value.trim();
  const fbKey  = document.getElementById('cs-firebase-key').value.trim();
  const st     = document.getElementById('cs-status');

  // Firebase key — сохраняем сразу без проверки (нужен всем, в т.ч. читателям)
  if (fbKey) localStorage.setItem('travel_firebase_key', fbKey);


  // Если ни токена ни gist — только firebase, закрываем
  if (!token && !gist) {
    if (fbKey) {
      st.textContent = '✓ Firebase Key сохранён';
      st.style.color = 'var(--green)';
      setTimeout(() => closeCloudSettings(), 800);
    } else {
      st.textContent = '⚠ Заполните хотя бы одно поле';
      st.style.color = '#f87171';
    }
    return;
  }

  // Если есть gist но нет токена — режим читателя, проверка не нужна
  if (gist && !token) {
    localStorage.setItem('travel_gist_id', gist);
    st.textContent = '✓ Сохранено (режим чтения)';
    st.style.color = 'var(--green)';
    setTimeout(() => {
      closeCloudSettings();
      loadState().then(() => startPolling());
    }, 800);
    return;
  }

  // Есть и токен и gist — проверяем подключение
  if (!token || !gist) {
    st.textContent = '⚠ Для записи нужны оба поля (токен + Gist ID)';
    st.style.color = '#f87171';
    return;
  }

  st.textContent = '⏳ Проверяем подключение…';
  st.style.color = 'var(--amber)';

  try {
    const r = await fetch(`${GIST_URL}/${gist}`, {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
    });
    if (r.status === 401) throw new Error('Токен неверный (401)');
    if (r.status === 404) throw new Error('Gist не найден (404)');
    if (!r.ok) throw new Error('HTTP ' + r.status);

    localStorage.setItem('travel_gist_token', token);
    localStorage.setItem('travel_gist_id',    gist);

    st.textContent = '✓ Подключено! Загружаем данные…';
    st.style.color = 'var(--green)';
    setTimeout(() => {
      closeCloudSettings();
      loadState().then(() => startPolling());
    }, 800);
  } catch(e) {
    st.textContent = '✗ Ошибка: ' + e.message;
    st.style.color = '#f87171';
  }
}
