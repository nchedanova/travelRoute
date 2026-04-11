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
// Формат: [эмодзи, 'ключевые слова через пробел']
const EMOJI_DICT = [
  // Транспорт
  ['🚗','машина авто автомобиль car'],
  ['🚙','внедорожник джип suv кроссовер'],
  ['🛻','пикап грузовик pickup truck'],
  ['🚐','микроавтобус минивэн van'],
  ['🚌','автобус bus'],
  ['🚎','троллейбус'],
  ['🚑','скорая помощь ambulance'],
  ['🚒','пожарная машина fire'],
  ['🚓','полиция police patrol'],
  ['🚕','такси taxi cab'],
  ['🚚','грузовик фура truck delivery'],
  ['🚛','фура тягач semi truck'],
  ['🏎','гоночная машина спорткар race'],
  ['🛵','мопед скутер moped scooter'],
  ['🏍','мотоцикл motorcycle moto'],
  ['🚲','велосипед bike bicycle'],
  ['🛴','самокат scooter kick'],
  ['✈️','самолет авиа рейс flight plane'],
  ['🚂','поезд train железная дорога'],
  ['🚢','корабль паром судно ferry ship'],
  ['🛥','катер лодка boat'],
  ['⛵','парусник яхта sail'],
  ['🚁','вертолет helicopter'],
  ['🛶','лодка каноэ boat canoe'],
  // Заправка и сервис
  ['⛽','заправка бензин газ fuel petrol'],
  ['⚡','электро зарядка charging electric'],
  ['🔋','батарея зарядка battery'],
  ['🔧','ремонт сервис repair service'],
  ['🔩','гайка болт nut bolt'],
  ['🛢','бочка нефть oil barrel'],
  ['🚿','мойка душ wash shower автомойка'],
  ['🧹','мойка уборка cleaning wash'],
  ['💧','вода water мойка wash'],
  ['🪣','ведро bucket мойка'],
  // Еда и кафе
  ['🍜','лапша рамен noodles ramen'],
  ['🍝','паста спагетти pasta spaghetti'],
  ['🥞','блины pancake завтрак breakfast'],
  ['🧇','вафли waffles'],
  ['🥐','круассан croissant выпечка'],
  ['🍕','пицца pizza'],
  ['🍔','бургер burger'],
  ['🌮','тако мексика taco'],
  ['🌯','шаурма kebab roll wrap'],
  ['🍱','ланч бэнто lunch bento'],
  ['🍣','суши sushi'],
  ['🥩','мясо стейк meat steak'],
  ['🍗','курица chicken'],
  ['🥗','салат salad'],
  ['🍲','суп soup горшок pot'],
  ['🥘','рагу жаркое stew'],
  ['🫕','шашлык мангал bbq barbecue'],
  ['🧆','котлеты falafel'],
  ['🍦','мороженое ice cream'],
  ['🧁','кексы cupcake выпечка'],
  ['🎂','торт cake'],
  ['🍩','пончик donut'],
  ['☕','кофе coffee'],
  ['🫖','чай tea'],
  ['🧋','чай латте bubble tea'],
  ['🥤','напиток drink сок juice'],
  ['🍵','чай зеленый tea'],
  ['🍺','пиво beer'],
  ['🍻','пиво бар beer bar'],
  ['🥂','шампанское ресторан champagne restaurant'],
  ['🍷','вино wine'],
  ['🥃','виски whiskey bar'],
  ['🍾','шампанское праздник party'],
  // Магазин
  ['🛒','магазин корзина shop cart'],
  ['🏪','магазин shop store'],
  ['🏬','торговый центр mall shopping'],
  ['🛍','покупки shopping bags'],
  ['🧴','косметика аптека drugstore cosmetics'],
  ['💊','аптека таблетки pharmacy pills'],
  ['🥑','продукты grocery'],
  ['🍞','хлеб bakery bread'],
  ['🥛','молоко dairy milk'],
  ['🧃','сок juice drinks'],
  ['🛺','авторикша tuk-tuk'],
  // Отель и жильё
  ['🏨','отель hotel'],
  ['🛎','сервис отель service hotel bell'],
  ['🛏','кровать bed номер room'],
  ['🔑','ключ key номер room'],
  ['🛁','ванная bath'],
  ['🛋','диван гостиная couch living'],
  ['🏡','дом дача house cottage home'],
  ['🏠','дом home house'],
  ['🏘','посёлок деревня village'],
  ['🛖','хижина cabin shack'],
  ['⛺','палатка camping tent'],
  ['🏕','кемпинг camping'],
  ['🏚','заброшка старый дом abandoned'],
  ['🌙','ночлег ночь night sleep'],
  ['⭐','звезда star рейтинг rating'],
  // Природа и достопримечательности
  ['🏔','гора mountain'],
  ['⛰','гора холм hill mountain'],
  ['🗻','фудзи вулкан volcano mountain'],
  ['🌋','вулкан volcano'],
  ['🏝','остров island пляж'],
  ['🏖','пляж beach море sea'],
  ['🏜','пустыня desert'],
  ['🌊','море волна ocean wave sea'],
  ['🏞','парк природа park nature'],
  ['🌲','лес дерево forest tree'],
  ['🌴','пальма тропики palm tropical'],
  ['🌿','трава природа grass nature'],
  ['🍃','листья природа leaves'],
  ['💐','цветы flowers'],
  ['🌸','сакура cherry blossom'],
  ['🌻','подсолнух sunflower'],
  ['🍄','гриб mushroom лес'],
  ['🏄','сёрфинг surf пляж beach'],
  ['🎣','рыбалка fishing'],
  ['⛷','лыжи skiing'],
  ['🏂','сноуборд snowboard'],
  ['🧗','скалолазание climbing'],
  ['🚵','велоспорт mtb mountain bike'],
  ['🤿','дайвинг diving snorkel'],
  ['🏊','бассейн плавание swimming pool'],
  ['🛟','спасательный круг life buoy'],
  // Культура и туризм
  ['🏛','музей temple museum'],
  ['⛪','церковь church храм'],
  ['🕌','мечеть mosque'],
  ['🕍','синагога synagogue'],
  ['🏯','замок castle'],
  ['🗼','башня tower'],
  ['🗽','статуя statue monument'],
  ['🎡','колесо обозрения ferris wheel парк'],
  ['🎢','аттракцион roller coaster'],
  ['🎪','цирк circus'],
  ['🏟','стадион stadium'],
  ['🎭','театр theatre drama'],
  ['🎨','картинная галерея art gallery'],
  ['🎬','кино cinema'],
  ['🎤','концерт concert'],
  ['🎠','карусель carousel'],
  // Сервисы и инфраструктура
  ['🏥','больница hospital'],
  ['🏦','банк bank'],
  ['🏧','банкомат atm'],
  ['🏤','почта post office'],
  ['🏣','почта'],
  ['🚏','остановка bus stop'],
  ['🅿','парковка parking'],
  ['🚧','ремонт дорог roadwork construction'],
  ['🚦','светофор traffic light'],
  ['🌉','мост bridge'],
  ['🛣','дорога трасса highway road'],
  ['🗺','карта map'],
  ['📍','место точка pin location'],
  ['📸','фото photo'],
  ['🔭','обзорная площадка telescope viewpoint'],
  ['💈','барбершоп barbershop стрижка'],
  // Погода
  ['☀️','солнце sun тепло warm'],
  ['⛅','облачно clouds cloudy'],
  ['🌧','дождь rain'],
  ['⛈','гроза storm thunder'],
  ['❄️','снег snow winter'],
  ['🌫','туман fog mist'],
  ['🌈','радуга rainbow'],
  ['💨','ветер wind'],
  ['🌡','температура temperature'],
  // Разное путешествия
  ['🧳','чемодан luggage travel'],
  ['🗺','маршрут route map'],
  ['📷','фотография camera photo'],
  ['🔦','фонарь torch flashlight'],
  ['⛺','лагерь camp'],
  ['🎒','рюкзак backpack'],
  ['🧭','компас compass'],
  ['🗿','скала stone rock landmark'],
  ['🎯','цель target point'],
  ['🚩','флаг flag точка'],
  ['🏁','финиш finish'],
  ['🏴','старт start флаг'],
];

function searchEmoji(query) {
  if (!query || query.length < 2) return [];
  var q = query.toLowerCase().trim();
  var results = [];
  for (var i = 0; i < EMOJI_DICT.length; i++) {
    if (EMOJI_DICT[i][1].indexOf(q) !== -1) {
      results.push(EMOJI_DICT[i][0]);
      if (results.length >= 8) break;
    }
  }
  return results;
}
