// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const DAY_COLORS   = ['#f5a623','#60a5fa','#a78bfa','#34d399','#f472b6','#fb923c'];
const DAY_ORDINALS = ['первый','второй','третий','четвёртый','пятый','шестой'];

const TYPE_ICONS = {
  'Заправка': '⛽',
  'Кафе':     '🍜',
  'Отель':    '🛎',
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
  const urlGist = params.get('gist');
  if (urlGist && urlGist.trim()) {
    localStorage.setItem('travel_gist_id', urlGist.trim());
  }
  const urlFbKey = params.get('fbkey');
  if (urlFbKey && urlFbKey.trim()) {
    localStorage.setItem('travel_firebase_key', urlFbKey.trim());
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
// Демо = нет ни gist, ни firebase key. Всё работает локально.
function isDemoMode() {
  return !CLOUD_CONFIG.canRead && !localStorage.getItem('travel_firebase_key');
}

const DEMO_CHAT = [
  { name: 'Надя', role: 'admin', text: 'Всем привет! Маршрут готов, проверяйте точки 🗺', ts: Date.now() - 3600000 * 5 },
  { name: 'Дима', role: 'viewer', text: 'Огонь! А заправки точно Газпромнефть?', ts: Date.now() - 3600000 * 4.5 },
  { name: 'Надя', role: 'admin', text: 'Да, каждые ~400 км, проверила на карте ⛽', ts: Date.now() - 3600000 * 4 },
  { name: 'Саша', role: 'viewer', text: 'Выезжаем в 3 утра? Серьёзно? 😅', ts: Date.now() - 3600000 * 3 },
  { name: 'Надя', role: 'admin', text: 'Зато к вечеру уже в Ростове! 🏨', ts: Date.now() - 3600000 * 2.5, reactions: { '💪': ['s1','s2'], '🔥': ['s3'] } },
  { name: 'Дима', role: 'viewer', text: 'Кто берёт термос с кофе? ☕', ts: Date.now() - 3600000 * 2 },
  { name: 'Саша', role: 'viewer', text: 'Я возьму! И печеньки 🍪', ts: Date.now() - 3600000 * 1.5, reactions: { '❤️': ['s1','s2','s3'] } },
  { name: 'Надя', role: 'admin', text: 'Кстати, GPX-файл можно скачать и открыть в Organic Maps — будет работать без интернета', ts: Date.now() - 3600000 },
  { name: 'Дима', role: 'viewer', text: 'Скачал карту по маршруту, 2000 тайлов 📥', ts: Date.now() - 1800000 },
  { name: 'Надя', role: 'admin', text: 'Отлично! Все готовы, выезжаем завтра! 🚗💨', ts: Date.now() - 600000, reactions: { '🎉': ['s1','s2','s3'], '🚗': ['s1'] } },
];
