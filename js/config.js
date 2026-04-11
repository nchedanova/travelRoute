// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const DAY_COLORS   = ['#f5a623','#00CED1','#a78bfa','#34d399','#FA8072','#CED23A','#00BFFF','#CC5500'];

const TYPE_ICONS = {
  'Заправка': '⛽',
  'Кафе':     '🍜',
  'Магазин':  '🛒',
  'Отель':    '🛎️',
  'Жильё':    '🏠',
  'Другое':   '📍',
};

// Иконки для пикера по типу точки
const ICON_SETS = {
  'Заправка': ['⛽','⚡','🔋','🚗','🚙','🛻','🛢️','🏪','💳','🔑','🚘','🏁'],
  'Кафе':     ['🍜','🍝','🥞','🧇','🥐','☕','🥗','🍕','🍔','🌮','🍣','🥩','🍱','🫖','🧁','🍦','🥤','🍵'],
  'Магазин':  ['🛒','🏪','🛍️','🏬','🧴','💊','🥑','🍞','🥛','🧃','🧹','🔧'],
  'Отель':    ['🛎️','🏨','🛏️','🔑','🛁','🌙','⭐','🌟','🏩','🏡'],
  'Жильё':    ['🏠','🏡','🏘️','🛖','⛺','🔑','🛋️','🌿','🏗️','🏚️'],
  'Другое':   ['📍','🗺️','📸','🎯','🏛️','🏞️','⛪','🎡','🎪','🏟️','🚏','🌉','🏕️','⛰️','🌄','🔭','🏄','🎭'],
};

// Минуты стоянки для автозаполнения план.отправления (depP = arrP + offset)
const DEP_OFFSETS = { 'Заправка': 20, 'Кафе': 60 };

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

// ── EMOJI SEARCH DICTIONARY ───────────────────────────────────────────────────
// Только заведомо цветные эмодзи (Segoe UI Emoji Windows 10/11 + iOS + Android)
const EMOJI_DICT = [
  // Транспорт
  ['🚗','машина авто автомобиль гоночная race car стоянка парковка'],
  ['🚙','внедорожник джип suv кроссовер'],
  ['🛻','пикап pickup truck'],
  ['🚐','микроавтобус минивэн van'],
  ['🚌','автобус bus'],
  ['🚑','скорая помощь ambulance'],
  ['🚒','пожарная машина fire'],
  ['🚓','полиция police'],
  ['🚕','такси taxi'],
  ['🚚','грузовик truck delivery'],
  ['🚛','фура тягач semi'],
  ['🛵','мопед скутер мотоцикл moped motorcycle'],
  ['🚲','велосипед bike bicycle'],
  ['🛴','самокат scooter kick'],
  ['✈️','самолет авиа рейс flight plane'],
  ['🚂','поезд train'],
  ['🚢','корабль паром судно ferry ship'],
  ['🚁','вертолет helicopter'],
  ['⛵','парусник яхта sail boat'],
  ['🚤','катер лодка speedboat'],
  // Заправка и автосервис
  ['⛽','заправка бензин газ fuel petrol'],
  ['⚡','электро зарядка charging electric'],
  ['🔋','батарея зарядка battery'],
  ['🔧','ремонт сервис repair service wrench'],
  ['🔩','гайка болт nut bolt'],
  ['🚿','мойка душ автомойка wash shower'],
  ['💧','вода water мойка'],
  ['🧹','уборка cleaning sweep'],
  ['🚧','ремонт дорог roadwork construction'],
  // Еда и кафе
  ['🍜','лапша рамен noodles ramen кафе'],
  ['🍝','паста спагетти pasta'],
  ['🥞','блины pancake завтрак breakfast'],
  ['🧇','вафли waffles'],
  ['🥐','круассан выпечка croissant'],
  ['🍕','пицца pizza'],
  ['🍔','бургер burger'],
  ['🌮','тако мексика taco'],
  ['🌯','шаурма kebab wrap'],
  ['🍱','ланч бэнто lunch bento'],
  ['🍣','суши sushi'],
  ['🥩','мясо стейк meat steak'],
  ['🍗','курица chicken'],
  ['🥗','салат salad'],
  ['🍲','суп soup pot'],
  ['🥘','рагу жаркое stew'],
  ['🥓','бекон bacon шашлык'],
  ['🍦','мороженое ice cream'],
  ['🧁','кексы cupcake выпечка'],
  ['🎂','торт cake'],
  ['🍩','пончик donut'],
  ['☕','кофе coffee'],
  ['🍵','чай tea green'],
  ['🥤','напиток drink сок juice'],
  ['🍺','пиво beer'],
  ['🍻','пиво бар beer pub'],
  ['🥂','шампанское ресторан champagne'],
  ['🍷','вино wine'],
  ['🥃','виски whiskey bar'],
  ['🍾','шампанское праздник party'],
  // Магазин
  ['🛒','магазин корзина shop cart'],
  ['🏪','магазин shop store'],
  ['🏬','торговый центр mall'],
  ['🛍','покупки shopping bags'],
  ['💊','аптека таблетки pharmacy pills'],
  ['🍞','хлеб bakery bread'],
  ['🥛','молоко dairy milk'],
  // Отель и жильё
  ['🏨','отель hotel гостиница'],
  ['🔑','ключ key замок lock номер room'],
  ['🏠','дом home house'],
  ['🏡','дача загородный дом cottage'],
  ['⛺','палатка camping tent'],
  ['🌙','ночлег ночь night sleep'],
  ['⭐','звезда star рейтинг rating'],
  // Парк и природа
  ['🌳','дерево парк сквер tree park'],
  ['🌲','ель сосна хвойный forest pine парк'],
  ['🌴','пальма тропики пляж beach palm tropical парк'],
  ['🌿','трава зелень газон nature green парк'],
  ['🍃','листья природа парк leaves'],
  ['🌱','росток природа sprout парк'],
  ['🍀','клевер удача clover'],
  ['🍁','клён осень maple autumn'],
  ['🌾','поле пшеница field grain'],
  ['🌻','подсолнух sunflower поле'],
  ['🌸','цветущий сакура blossom'],
  ['💐','цветы flowers'],
  ['🍄','гриб mushroom лес'],
  ['🌊','море волна пляж beach ocean wave'],
  ['🌋','вулкан гора volcano mountain'],
  ['⛺','кемпинг лагерь camping природа'],
  // Спорт и активности
  ['🏄','сёрфинг surf пляж море beach'],
  ['🎣','рыбалка fishing'],
  ['🏂','сноуборд лыжи snowboard skiing зима'],
  ['⛄','зима снег winter snow лыжи skiing'],
  ['🧗','скалолазание climbing'],
  ['🚵','велоспорт горный велосипед mtb'],
  ['🏊','бассейн плавание swimming'],
  ['⛳','гольф golf'],
  // Культура и достопримечательности
  ['🏯','замок castle крепость'],
  ['🗼','башня tower'],
  ['🗽','статуя monument'],
  ['🕌','мечеть церковь mosque church temple храм'],
  ['🎠','карусель парк аттракцион carousel'],
  ['🎡','колесо обозрения ferris wheel парк'],
  ['🎢','аттракцион roller coaster'],
  ['🎪','цирк circus carnival'],
  ['🎭','театр theatre drama'],
  ['🎨','галерея art gallery'],
  ['🎬','кино cinema film'],
  ['🎤','концерт concert'],
  // Сервисы и инфраструктура
  ['🏥','больница hospital'],
  ['🏦','банк bank'],
  ['📮','почта post office letter'],
  ['🏧','банкомат atm'],
  ['🚏','остановка bus stop'],
  ['🚦','светофор traffic light'],
  ['🌉','мост bridge'],
  ['💈','барбершоп стрижка barbershop'],
  ['🔦','фонарь фонарик flashlight torch'],
  // Навигация и путешествия
  ['🌍','карта map маршрут route глобус'],
  ['🌐','маршрут route карта map глобус'],
  ['📍','место точка pin location'],
  ['📸','фото photo camera'],
  ['🔭','обзорная площадка telescope viewpoint'],
  ['🧳','чемодан luggage travel'],
  ['🎒','рюкзак backpack'],
  ['🧭','компас compass'],
  ['🎯','цель target'],
  ['🚩','флаг точка flag'],
  ['🏁','финиш finish'],
  // Погода
  ['☀️','солнце sun тепло warm'],
  ['🌦','дождь rain гроза storm'],
  ['❄️','снег snow winter зима'],
  ['🌈','радуга rainbow'],
];
function searchEmoji(query) {
  if (!query || query.length < 2) return [];
  var q = query.toLowerCase().trim();
  var results = [];
  for (var i = 0; i < EMOJI_DICT.length; i++) {
    var words = EMOJI_DICT[i][1].split(' ');
    var match = words.some(function(w) { return w === q || w.indexOf(q) === 0; });
    if (match) {
      results.push(EMOJI_DICT[i][0]);
      if (results.length >= 8) break;
    }
  }
  return results;
}
