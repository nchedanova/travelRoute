# Дорожный журнал — Правила разработки

## Архитектура

Чистый JS/HTML/CSS, без фреймворков. PWA на GitHub Pages. Firebase Realtime DB для чата, заметок, GPS, реакций к фото. Gist API для маршрутных данных.

### Файлы и порядок загрузки
```
config.js → data.js → storage.js → offline.js → map.js → render.js → app.js → gps.js → chat.js → notes.js → gpx.js → import.js
```
Функции из chat.js (например `_compressToBase64`) доступны в notes.js, но НЕ наоборот. Если нужна функция из файла который грузится позже — это баг.

### Роли
- `isAdmin()` = canWrite (токен + gist ID) ИЛИ демо (нет gist ID вообще)
- `isViewer()` = !isAdmin() = есть gist ID без токена = читатель
- Читатель НЕ видит: вкладку заметок, кнопки редактирования маршрута, admin-only элементы
- Перед добавлением любого UI-элемента спроси: «Видит ли это читатель?» — если нет, оберни в `isAdmin()` проверку

---

## Версионирование — КРИТИЧЕСКИ ВАЖНО

**Текущая версия: v2.8.0 build 49**

При КАЖДОМ деплое обновляй ВСЕ ТРИ места одновременно:

1. `sw.js` → `const APP_BUILD = N;` + `const APP_VERSION = 'X.Y.Z';`
2. `js/app.js` → `var APP_BUILD = N;`
3. `index.html` → ВСЕ теги `<script src="js/xxx.js?v=N">` и `<link rel="stylesheet" href="css/style.css?v=N">`

Номер N должен совпадать везде и быть больше предыдущего. Файлы с фиксированной версией (не менялись): `config.js?v=19`, `offline.js?v=19`, `map.js?v=19`, `import.js?v=19`, `gpx.js?v=19` — их не трогать.

`CACHE_STATIC` генерится автоматически из `APP_VERSION` + `APP_BUILD` — вручную не менять.

### staleWhileRevalidate: нормализация URL при cache.put
```js
const normalUrl = new URL(request.url);
normalUrl.search = '';  // КРИТИЧНО — убирает ?v=N
await cache.put(normalUrl.toString(), responseToCache);
```

---

## Структура DAYS_DATA

```js
DAYS_DATA[d] = {
  color, dateISO, date, departP, departA,
  walkMode: false,
  hidden: false,
  archived: false,
  icon: '',          // иконка дня (emoji, опциональное)
  start: { lat, lng, name, icon },
  stops: [{ id, num, icon, type, name, lat, lng, arrP, depP, arrA, depA,
            notes: [{ text, images: [], public: false }] }]
}
```

При создании новых stops ВСЕГДА добавлять `notes: []`.

---

## Мобилки и PWA — ВСЕГДА УЧИТЫВАЙ

### Blur-события
- НИКОГДА не вешай на blur: скрытие элемента, переключение режимов, показ тостов
- Blur может сработать при клике на ЛЮБУЮ соседнюю кнопку — кнопка исчезнет до срабатывания onclick
- Если кнопка рядом с textarea — добавь `onmousedown="event.preventDefault()"` чтобы предотвратить потерю фокуса

### Display-состояния вложенных элементов
- При скрытии контейнера (wrap) → дочерние элементы (edit, preview) тоже скрыты
- При повторном показе контейнера → ОБЯЗАТЕЛЬНО явно установи display нужных дочерних элементов

### Тосты
- Тост «Сохранено» показывай ТОЛЬКО при явном действии пользователя (нажатие кнопки ✓)
- НЕ показывай тост при автосохранении, blur, фоновой синхронизации

### Скролл
- При открытии чата — scroll-to-bottom минимум 4 раза (0ms, 50ms, 200ms, 500ms) чтобы перебить браузерное восстановление позиции

### CSS на мобилках
- `outline: none; -webkit-tap-highlight-color: transparent` на кнопках
- `touch-action: auto` на textarea внутри draggable-контейнеров
- `event.stopPropagation()` на touch/mouse для textarea в draggable-карточках
- Кнопки-иконки — минимум 28×28px для комфортного тапа
- `.logo` скрыт на мобилке (`@media (max-width:700px) { .logo { display:none; } }`)
- `transition: all` — НИКОГДА

---

## Иконка дня

`DAYS_DATA[d].icon` — опциональная emoji-иконка для дня.

- Отображается в табе перед датой: `(data.icon ? data.icon + ' ' : '') + дата`
- В хэдере дня: кликабельный `.day-icon-wrap` левее даты (только isAdmin())
- Пикер `editDayIcon(d, triggerEl)` — фиксированный набор + поле ввода своей иконки + кнопка «Убрать иконку»
- `selectDayIcon(d, icon)` — сохраняет, вызывает `renderTabs()` + `saveData()`
- Баг toggle: `removeEventListener` вызывается В ПЕРВУЮ ОЧЕРЕДЬ при входе в `editDayIcon`

---

## Обратный маршрут

`reverseDay(d)` открывает модалку `#reverseDayModal` со списком всех точек дня в обратном порядке и чекбоксами. По умолчанию отмечены первый (новый старт) и последний (финиш). `doReverseDay()` создаёт новый день только из отмеченных точек.

---

## Геолокация в формах

Кнопка «Моё местоположение» (`.geo-loc-btn`) добавлена в:
- Модалку «Новая точка» → `useCurrentLocationForModal()`
- Модалку «Точка старта» → `useCurrentLocationForStart()`
- Инлайн-форму редактирования → `useCurrentLocationForEdit(id)`
- Инлайн-форму добавления → `useCurrentLocationForAdd(afterId)`

Общий хелпер `_useCurrentLocation(onSuccess)`: если GPS-маркер уже активен — берёт позицию из него, иначе `getCurrentPosition`. После получения позиции вызывает `resumeGpsFollow()`.

---

## GPS Follow — пауза слежения

При активном «Еду»/«Иду» карта следит за позицией. При ручном драге:
- `dragstart` → `_userPanned = true`, кнопка получает класс `paused`
- `dragend` → setTimeout 7000ms → автовозврат через `resumeGpsFollow()`

**Важно:** используются Leaflet-события `dragstart`/`dragend`, а НЕ `mousedown`/`touchstart` — последние срабатывают и на программный `panTo`, вызывая петлю притягивания.

---

## Заметки к точкам — Правила UX

### Режимы
- **Edit**: textarea + фото внутри одного пузыря (`.stop-note-bubble`), кнопки 📷 и ✓ справа
- **Preview**: текст + фото в `.stop-note-display`, клик → обратно в edit

### Сохранение
- ТОЛЬКО по кнопке ✓ (`commitStopNote`)
- onblur — ничего не делает (no-op)
- Фото хранятся в `_pendingStopImages[pk]` до нажатия ✓

### Shift+Enter в списках (десктоп)
- `Enter` → новый пункт (стандартное поведение)
- `Shift+Enter` → мягкий перенос внутри текущего пункта (через `\u2028`)
- На мобилках поведение не меняется

### Хранение фото
- Firebase (по умолчанию): `note_imgs/{key}`, ключ как `fb:key` в `note.images[]`. Сжатие: 1600px, quality 0.82
- Офлайн/Gist: `data:` URL в `note.images[]`. Сжатие: 800px, quality 0.70
- `_isFirebaseConnected()` вызывать ПЕРЕД `_uploadNoteImg` — Firebase RTDB не бросает при `ref.set()` без связи, а зависает навсегда

### Реакции к фото
Firebase `/note_reactions/{stopId}/{noteIdx}/{sid}`. При удалении заметки или последнего фото — вызывать `_clearNoteReactions(stopId, idx)`.

---

## Архив дней

- `archiveDay(d)` / `unarchiveDay(d)` — `DAYS_DATA[d].archived = true/false` + `saveData()`
- Архивные дни скрыты из табов, не рендерятся, не занимают индекс цвета
- `renderArchiveBtn()` вызывается из `pollCloud`

---

## Чат — Правила

### Firebase refs
- Групповой чат: `/chat/{msgId}`, presence: `/chat_presence/{uid}`
- ЛС: `/dm/{uid1_uid2}/messages/{msgId}`, read: `/dm/{uid1_uid2}/read/{uid}`
- Имена пользователей: `/users/{uid}/name`

### DM-комнаты
- Room ID: `[uid1, uid2].sort().join('_')` — всегда Firebase uid, не localStorage sessionId
- Только админы видят и создают DM
- Контакты: только `role === 'admin'`, не показывать себя, дедупликация по имени (оставлять самый свежий uid)

### Фото в чате
- Мультивыбор до 10 фото, pending-превью над инпутом
- Одно фото → `imgUrl` (обратная совместимость), 2+ → `imgUrls[]`
- Сжатие: 1600px, quality 0.85, fallback >400KB → 0.75× размер, quality 0.7

### Auth
- Firebase Anonymous Auth как базовый (uid для каждого устройства)
- Google Sign-In: `signInWithPopup` — НЕ redirect (redirect не работает на GitHub Pages + SW)
- `getSessionId()` приоритет: `window._firebaseUid` → `localStorage('travel_firebase_uid')` → `localStorage('travel_session_id')`
- При смене auth → чистить старые presence-записи (sessionId + prev firebase uid)

### Read receipts
- Presence хранит `{ts, name, role}`
- Галочки: серые = доставлено, amber = прочитано

---

## CSS — Частые ошибки

### transition: all
НЕ использовать — при back-navigation видны промежуточные кадры. Использовать конкретные свойства: `transition: color 0.15s`.

### Ховер на мобилках
- `.nav-day-btn:hover` и подобные — `var(--accent)` вместо хардкоженных цветов
- `@media (hover: none)` для мобильных fallback-ов

### Анимации при навигации
- Класс `.nav-restoring` на body → `* { transition: none !important; animation: none !important; }`
- Снимается через `requestAnimationFrame`

---

## Service Worker

### Кэширование
- Свои файлы: stale-while-revalidate (с нормализацией URL — убирать `?v=N`)
- Тайлы карты: cache-first
- Firebase/Auth/GitHub API: network-only (НЕ кэшировать)
- Passthrough: `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`

### Обновление
- `skipWaiting()` + `clients.claim()` для немедленной активации
- `register('./sw.js', { updateViaCache: 'none' })`

---

## Чеклист перед каждым деплоем

- [ ] Все JS файлы проходят `node --check`
- [ ] `APP_BUILD` в app.js совпадает с номером в sw.js — номер новый, не повторяет предыдущий
- [ ] Все `?v=` теги в index.html обновлены (кроме файлов с v=19)
- [ ] sw.js: `normalUrl.search = ''` в staleWhileRevalidate
- [ ] Новые stops содержат `notes: []`
- [ ] `currentDay` через `_pickVisibleDay()`, НЕ через `<= dayKeys().length`
- [ ] Новые admin-only элементы обёрнуты в `isAdmin()`
- [ ] hidden дни: читатель не видит
- [ ] Нет blur-обработчиков которые скрывают UI
- [ ] Нет тостов при автосохранении
- [ ] Кнопки рядом с textarea имеют `onmousedown="event.preventDefault()"`
- [ ] Кнопки ≥28px
- [ ] coords display в edit-форме: `display:'flex'` (не `'block'`)
- [ ] Темы: не срезать `</div>` и `<script>` при str_replace в index.html
