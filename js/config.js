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
(function seedGistFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const urlGist = params.get('gist');
  if (urlGist && urlGist.trim()) {
    localStorage.setItem('travel_gist_id', urlGist.trim());
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
