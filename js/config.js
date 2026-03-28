// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const DAY_COLORS   = ['#f5a623','#60a5fa','#a78bfa','#34d399','#f472b6','#fb923c'];
const DAY_ORDINALS = ['первый','второй','третий','четвёртый','пятый','шестой'];

const TYPE_ICONS = {
  'Заправка': '⛽',
  'Кафе':     '🍜',
  'Отель':    '🛎️',
  'Жильё':    '🏠',
  'Другое':   '📍',
};

// ── CLOUD CONFIG ──────────────────────────────────────────────────────────────
// Токен хранится только в localStorage владельца.
// Gist ID может прийти из URL (?gist=ID) — тогда сайт открывается без токена
// в режиме «только чтение». Идеально для шаринга ссылки.

// Читаем ?gist= из URL и сохраняем в localStorage при первом визите
(function seedFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const urlGist  = params.get('gist');
  const urlFbKey = params.get('fbkey');
  let changed = false;
  if (urlGist && urlGist.trim()) {
    localStorage.setItem('travel_gist_id', urlGist.trim());
    changed = true;
  }
  if (urlFbKey && urlFbKey.trim()) {
    localStorage.setItem('travel_firebase_key', urlFbKey.trim());
    changed = true;
  }
  // Убираем токены из адресной строки — они уже сохранены в localStorage
  if (changed && window.history && window.history.replaceState) {
    params.delete('gist');
    params.delete('fbkey');
    const clean = params.toString()
      ? window.location.pathname + '?' + params.toString()
      : window.location.pathname;
    window.history.replaceState({}, '', clean);
  }
})();

const CLOUD_CONFIG = {
  get apiKey() { return localStorage.getItem('travel_gist_token') || ''; },
  get binId()  { return localStorage.getItem('travel_gist_id')    || ''; },
  // true — есть токен, можно писать
  get canWrite() { return !!(this.apiKey && this.binId); },
  // true — есть хотя бы gistId (читаем публичный gist без токена)
  get canRead()  { return !!this.binId; },
};

var GIST_URL = GIST_URL || 'https://api.github.com/gists';

// ── DEMO MODE ─────────────────────────────────────────────────────────────────
// Демо = нет gist ID (маршрут не подключён к облаку). Firebase key без gist — тоже демо.
function isDemoMode() {
  return !CLOUD_CONFIG.canRead;
}

// Имя "демо-пользователя" — сообщения с этим именем отображаются как "мои"
const DEMO_MY_NAME = 'Вы';

const DEMO_CHAT = [
  { name: 'Настя', role: 'admin', text: 'Всем привет! Маршрут готов, проверяйте точки 🗺', ts: Date.now() - 3600000 * 5 },
  { name: 'Саша', role: 'viewer', text: 'Огонь! А заправки точно Газпромнефть?', ts: Date.now() - 3600000 * 4.5 },
  { name: 'Настя', role: 'admin', text: 'Да, каждые ~400 км, проверила на карте ⛽', ts: Date.now() - 3600000 * 4 },
  { name: DEMO_MY_NAME, role: 'admin', text: 'Выезжаем в 3 утра? Серьёзно? 😅', ts: Date.now() - 3600000 * 3 },
  { name: 'Настя', role: 'admin', text: 'Зато к вечеру уже в Ростове! 🛎️', ts: Date.now() - 3600000 * 2.5, reactions: { '💪': ['s1','s2'], '🔥': ['s3'] } },
  { name: 'Саша', role: 'viewer', text: 'Кто берёт термос с кофе? ☕', ts: Date.now() - 3600000 * 2 },
  { name: DEMO_MY_NAME, role: 'admin', text: 'Я возьму! И печеньки 🍪', ts: Date.now() - 3600000 * 1.5, reactions: { '❤️': ['s1','s2','s3'] } },
  { name: 'Настя', role: 'admin', text: 'GPX можно скачать и открыть в Organic Maps — работает без интернета', ts: Date.now() - 3600000 },
  { name: 'Саша', role: 'viewer', text: 'Скачал карту по маршруту, 2000 тайлов 📥', ts: Date.now() - 1800000 },
  { name: DEMO_MY_NAME, role: 'admin', text: 'Всё готово, завтра выезжаем! 🚗💨', ts: Date.now() - 600000, reactions: { '🎉': ['s1','s2','s3'], '🚗': ['s1'] } },
];

// ── РОЛИ ──────────────────────────────────────────────────────────────────────
// isAdmin() = true  → Полный доступ (AdminWrite ИЛИ демо-режим)
// isViewer() = true → Только чтение (нет gist, нет демо → никогда не бывает,
//                     но если gist есть без токена — читатель)
function isAdmin() {
  return CLOUD_CONFIG.canWrite || (typeof isDemoMode === 'function' && isDemoMode());
}
function isViewer() {
  return !isAdmin();
}

// Set viewer-mode class on body as early as possible (CSS hides admin-only elements)
if (document.body) {
  if (isViewer()) document.body.classList.add('viewer-mode');
} else {
  document.addEventListener('DOMContentLoaded', function() {
    if (isViewer()) document.body.classList.add('viewer-mode');
  });
}
