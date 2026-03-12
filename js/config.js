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
// Токен и Gist ID хранятся в localStorage браузера — не в коде.
// Вводятся через кнопку ⚙ в шапке при первом открытии сайта.
const CLOUD_CONFIG = {
  get apiKey() { return localStorage.getItem('travel_gist_token') || ''; },
  get binId()  { return localStorage.getItem('travel_gist_id')    || ''; },
};
