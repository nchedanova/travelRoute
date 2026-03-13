// ── CLOUD STORAGE HELPERS (GitHub Gist API) ───────────────────────────────────
const GIST_URL = 'https://api.github.com/gists';

// cloudEnabled = можно хотя бы читать (gistId есть)
function cloudEnabled() {
  return CLOUD_CONFIG.canRead;
}

function setSyncStatus(text, color) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  el.textContent = text;
  el.style.color = color || 'var(--muted)';
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
}

// ── LOAD STATE ────────────────────────────────────────────────────────────────
async function loadState() {
  // 1. Сначала грузим из localStorage (мгновенно — UI не ждёт)
  try {
    const raw = localStorage.getItem('travel_tracker_v3');
    if (raw) applyPayload(JSON.parse(raw));
  } catch(e) { console.error('loadState localStorage error', e); }

  // 2. Затем пробуем облако (перезаписывает локальный кэш)
  if (!cloudEnabled()) {
    setSyncStatus('☁ офлайн', 'var(--muted)');
    return;
  }

  // Если нет токена — режим «только чтение»
  if (!CLOUD_CONFIG.canWrite) {
    setSyncStatus('👁 только чтение', 'var(--amber)');
  } else {
    setSyncStatus('☁ загрузка…', 'var(--amber)');
  }
  try {
    const saved = await fetchCloudData();
    const json  = JSON.stringify(saved);
    _lastCloudHash = strHash(json);
    applyPayload(saved);
    // Обновляем UI после загрузки облачных данных
    dayKeys().forEach(d => redrawDay(d));
    renderTabs();
    renderAllDays();
    updateProgress();
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
let _userIsTyping  = false;
let _userHasFocus  = false;  // любой инпут сфокусирован
let _typingTimer   = null;

function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
  return h;
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
  // Владельцу поллинг не нужен — он сам пишет; зрителю блокируем только если активен инпут
  if (CLOUD_CONFIG.canWrite) return;
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

    dayKeys().forEach(d => redrawDay(d));
    renderTabs();
    renderAllDays();
    updateProgress();
    const t = new Date().toLocaleTimeString('ru', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    setSyncStatus(`🔄 обновлено ${t}`, 'var(--green)');
    setTimeout(() => setSyncStatus('👁 только чтение', 'var(--amber)'), 3000);
    showToast('🔄 Данные обновлены');
  } catch(e) {
    console.warn('poll error', e);
  }
}

function startPolling(intervalMs = 10000) {
  if (!cloudEnabled()) return;
  // Владелец не поллит — он источник правды
  if (CLOUD_CONFIG.canWrite) return;
  setInterval(pollCloud, intervalMs);
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
  navigator.clipboard.writeText(url.toString()).then(() => {
    const st = document.getElementById('cs-status');
    st.textContent = '✓ Ссылка скопирована! Gist должен быть публичным.';
    st.style.color = 'var(--green)';
  });
}

// ── CLOUD SETTINGS UI ─────────────────────────────────────────────────────────
function openCloudSettings() {
  document.getElementById('cs-token').value = localStorage.getItem('travel_gist_token') || '';
  document.getElementById('cs-gist').value  = localStorage.getItem('travel_gist_id')    || '';
  document.getElementById('cs-status').textContent = '';
  document.getElementById('cloudSettingsModal').classList.add('show');
}

function closeCloudSettings() {
  document.getElementById('cloudSettingsModal').classList.remove('show');
}

function clearCloudSettings() {
  localStorage.removeItem('travel_gist_token');
  localStorage.removeItem('travel_gist_id');
  document.getElementById('cs-token').value = '';
  document.getElementById('cs-gist').value  = '';
  const st = document.getElementById('cs-status');
  st.textContent = '✓ Настройки очищены — работаем офлайн';
  st.style.color = 'var(--muted)';
  setSyncStatus('☁ офлайн', 'var(--muted)');
}

async function saveCloudSettings() {
  const token = document.getElementById('cs-token').value.trim();
  const gist  = document.getElementById('cs-gist').value.trim();
  const st    = document.getElementById('cs-status');

  if (!token || !gist) {
    st.textContent = '⚠ Заполните оба поля';
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
