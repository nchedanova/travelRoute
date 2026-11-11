// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const DAY_COLORS   = ['#f5a623','#00CED1','#a78bfa','#34d399','#FA8072','#CED23A','#00BFFF','#CC5500'];

const TYPE_ICONS = {
  'Заправка': '⛽',
  'Кафе':     '🍜',
  'Магазин':  '🛒',
  'Отель':    '🛎️',
  'Жильё':    '🏠',
  'Парк':     '🌳',
  'Другое':   '📍',
};

// Иконки для пикера по типу точки
const ICON_SETS = {
  'Заправка': ['⛽','⚡','🔋','🚗','🚙','🛻','🛢️','🏪','💳','🔑','🚘','🏁'],
  'Кафе':     ['🍜','🍝','🥞','🧇','🥐','☕','🥗','🍕','🍔','🌮','🍣','🥩','🍱','🫖','🧁','🍦','🥤','🍵'],
  'Магазин':  ['🛒','🏪','🛍️','🏬','🧴','💊','🥑','🍞','🥛','🧃','🧹','🔧'],
  'Отель':    ['🛎️','🏨','🛏️','🔑','🛁','🌙','⭐','🌟','🏩','🏡'],
  'Жильё':    ['🏠','🏡','🏘️','🛖','⛺','🔑','🛋️','🌿','🏗️','🏚️'],
  'Парк':     ['🌳','🌲','🍃','🌿','🍀','🍂','🌸','🌼','🌷','🌻','🦆','🦢','🐿️','🦔','🛝','🧺','🏞️','🌊'],
  'Другое':   ['📍','🌳','🌲','🍃','🌿','🍀','🍂','🌊','🏞️','🌸','🌼','🦆','🦢','🏛️','🏊','🏖️','⛰️','🎤'],
};

// Минуты стоянки для автозаполнения план.отправления (depP = arrP + offset)
const DEP_OFFSETS = { 'Заправка': 20, 'Кафе': 60 };

// ── CLOUD CONFIG ──────────────────────────────────────────────────────────────
// Это режим публикаций без чата, а не серверное ограничение доступа.
// Для читательского устройства роль зрителя сохраняется по маршруту для запуска PWA.
const LOCAL_PREVIEW = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) &&
  ['admin', 'reader', 'spectator'].includes(new URLSearchParams(window.location.search).get('preview'));
const PREVIEW_ROLE = LOCAL_PREVIEW ? new URLSearchParams(window.location.search).get('preview') : '';
const LOCAL_WALK_REVIEW = LOCAL_PREVIEW && new URLSearchParams(window.location.search).get('walk') === '1';
function resolveSpectatorMode() {
  var params = new URLSearchParams(window.location.search);
  if (LOCAL_PREVIEW) return PREVIEW_ROLE === 'spectator';
  var explicit = params.get('chat') === '0';
  var routeId = params.get('gist') || localStorage.getItem('travel_gist_id');
  // A viewer's installed PWA starts without query parameters. Remember its role per route.
  // Owner previews must not change the owner's saved role.
  if (routeId && !localStorage.getItem('travel_gist_token')) {
    var key = 'travel_spectator_route_' + routeId;
    if (explicit) localStorage.setItem(key, '1');
    else if (params.has('gist') || params.has('chat')) localStorage.removeItem(key);
    else return localStorage.getItem(key) === '1';
  }
  return explicit;
}
const SPECTATOR_MODE = resolveSpectatorMode();
function isChatEnabled() { return !SPECTATOR_MODE; }
// Токен хранится только в localStorage владельца.
// Gist ID может прийти из URL (?gist=ID) — тогда сайт открывается без токена
// в режиме «только чтение». Идеально для шаринга ссылки.

// Читаем ?gist= из URL и сохраняем в localStorage при первом визите
(function seedFromUrl() {
  if (LOCAL_PREVIEW) return;
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
  get apiKey() { return LOCAL_PREVIEW ? '' : localStorage.getItem('travel_gist_token') || ''; },
  get binId()  { return LOCAL_PREVIEW ? '' : localStorage.getItem('travel_gist_id')    || ''; },
  // true — есть токен, можно писать
  get canWrite() { return !SPECTATOR_MODE && !!(this.apiKey && this.binId); },
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
  if (LOCAL_PREVIEW) return PREVIEW_ROLE === 'admin';
  return !SPECTATOR_MODE && (CLOUD_CONFIG.canWrite || (typeof isDemoMode === 'function' && isDemoMode()));
}
function isViewer() {
  return !isAdmin();
}

// Set viewer-mode class on body as early as possible (CSS hides admin-only elements)
if (document.body) {
  if (SPECTATOR_MODE) document.body.classList.add('spectator-mode');
  if (isViewer()) document.body.classList.add('viewer-mode');
} else {
  document.addEventListener('DOMContentLoaded', function() {
    if (SPECTATOR_MODE) document.body.classList.add('spectator-mode');
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
  ['🍜','лапша рамен noodles ramen кафе еда'],
  ['🍝','паста спагетти pasta'],
  ['🥞','блины pancake завтрак breakfast'],
  ['🧇','вафли waffles'],
  ['🥐','круассан выпечка croissant еда'],
  ['🍕','пицца pizza'],
  ['🍔','бургер burger еда'],
  ['🌮','тако мексика taco'],
  ['🌯','шаурма kebab wrap'],
  ['🍱','ланч бэнто lunch bento'],
  ['🍣','суши sushi'],
  ['🥩','мясо стейк meat steak'],
  ['🍗','курица chicken'],
  ['🥗','салат salad еда'],
  ['🍲','суп soup pot'],
  ['🥘','рагу жаркое stew'],
  ['🥓','бекон bacon шашлык'],
  ['🍦','мороженое ice cream'],
  ['🧁','кексы cupcake выпечка'],
  ['🎂','торт cake'],
  ['🍩','пончик donut'],
  ['☕','кофе кофейня кафе coffee'],
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
  ['🍂','листья осень листопад autumn leaves'],
  ['🏞️','набережная река прогулка пейзаж river promenade'],
  ['🏖️','пляж море beach sea'],
  ['⛰️','горы вершина mountain'],
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
  ['🏛️','музей архитектура история museum'],
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
  ['🚻','туалет уборная restroom wc'],
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
  ['📍','пин метка геометка маркер место точка pin location'],
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
// Small offline alias groups; no network, persistent search history or route storage.
const EMOJI_SEARCH_GROUPS = [
  'дерево деревья деревьями деревце деревцем деревцу деревца деревцо tree trees',
  'листья лист листик листики листиков листочком листочек листочки листва leaves leaf',
  'трава травка травушка зелень зеленый зеленая зелёный зелёная растительность',
  'цветы цветок цветочек цветочки цветочков flowers flower',
  'парк парки парке парку парков сквер скверик park parks',
  'лес леса лесу лесной лесок forest woods',
  'прогулка прогулки прогулке гулять погулять прогулочный walk walking',
  'набережная набережной набережную набережные promenade embankment',
  'море морю моря морской морское sea ocean',
  'пляж пляже пляжи пляжный beach beaches',
  'река реке рекой речка речке речной river rivers',
  'музей музеи музее музея museum museums',
  'гора горы горе горный mountain mountains',
  'бассейн бассейны бассейне бассейна pool pools',
  'плавание плавать поплавать купание купаться swimming swim',
  'кафе кафешка кафешки кафетерий cafe café',
  'еда поесть покушать перекус перекусить food meal',
  'ресторан рестораны ресторане restaurant restaurants',
  'кофе кофейня кофейни кофейне coffee',
  'выпечка пекарня пекарни булочная bakery pastry',
  'завтрак позавтракать breakfast',
  'заправка заправки заправке заправиться азс fuel petrol',
  'зарядка зарядки зарядке зарядить charging',
  'машина машины машинка машинки машиной автомобиль авто car cars',
  'магазин магазины магазине магазины магазинчик shop store shops',
  'покупки купить закупиться shopping',
  'отель отели отеле гостиница гостиницы hotel hotels',
  'дом дома домик домики домой house houses home',
  'палатка палатки палатке кемпинг camping tent',
  'концерт концерты концерте выступление concert',
  'аптека аптеки аптеке лекарства pharmacy',
  'туалет туалеты туалете уборная wc restroom',
  'фото фотография фотографии фотка фотки photo photos'
];
function _emojiSearchTokens(text) {
  return String(text || '').toLowerCase().replace(/ё/g,'е').match(/[a-zа-я0-9]+/g) || [];
}
let _emojiSearchIndex = null;
function _getEmojiSearchIndex() {
  if (_emojiSearchIndex) return _emojiSearchIndex;
  const aliases = new Map();
  EMOJI_SEARCH_GROUPS.forEach((group, index) => {
    _emojiSearchTokens(group).forEach(word => aliases.set(word, index));
  });
  // Same emoji may occur under several topics: merge tags and return it only once.
  const entries = new Map();
  EMOJI_DICT.forEach(([emoji, tags]) => {
    if (!entries.has(emoji)) entries.set(emoji, new Set());
    _emojiSearchTokens(tags).forEach(word => entries.get(emoji).add(word));
  });
  _emojiSearchIndex = {aliases, entries:Array.from(entries, ([emoji, words]) => ({emoji, words:Array.from(words)}))};
  return _emojiSearchIndex;
}
function searchEmoji(query) {
  const terms = _emojiSearchTokens(query).filter(word => word.length >= 2).slice(0, 8);
  if (!terms.length) return [];
  const {aliases, entries} = _getEmojiSearchIndex();
  return entries.map((entry, order) => {
    let score = 0;
    for (const term of terms) {
      const group = aliases.get(term);
      let best = 0;
      for (const word of entry.words) {
        if (word === term) best = Math.max(best, 100);
        else if (group !== undefined && aliases.get(word) === group) best = Math.max(best, 85);
        else if (word.startsWith(term)) best = Math.max(best, 60);
      }
      if (!best) return null;
      score += best;
    }
    return {emoji:entry.emoji, score, order};
  }).filter(Boolean).sort((a,b) => b.score-a.score || a.order-b.order)
    .slice(0,24).map(entry => entry.emoji);
}
