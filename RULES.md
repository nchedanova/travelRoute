# Дорожный журнал — Правила разработки

## Аккаунт GitHub и отправка изменений

- Для репозитория `nchedanova/travelRoute` использовать **только аккаунт `nchedanova`**.
- Аккаунт `nchedanovaTedu` относится к другому проекту. Не использовать его для операций с travelRoute.
- **Перед каждым пушем** проверять авторизацию: `gh auth status` и `gh api user --jq .login`. Продолжать только если активный аккаунт — `nchedanova`.
- Отправлять изменения через проверенную авторизацию GitHub CLI, явно переопределяя системный credential helper, который может выбрать другой аккаунт:
  ```powershell
  git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main
  ```
  При отправке другой ветки заменить `main` на её имя.
- Если авторизация отсутствует или выбран другой аккаунт — остановить пуш и восстановить авторизацию `nchedanova`; не пробовать отправку через другой аккаунт.

## Архитектура

### Тексты интерфейса

- Использовать нейтральные формулировки без предположений о поле пользователя: «Точки и время задаются вручную», а не «Сама добавляешь». Правило применяется и к прототипам, и к финальному интерфейсу.

Чистый JS/HTML/CSS, без фреймворков. PWA на GitHub Pages. Firebase Realtime DB для чата, заметок, GPS, реакций к фото. Gist API для маршрутных данных.

- Поток GPS и живой трек прогулки идут через Firebase. Точки GPS сохраняются локально в процессе записи, а завершённый маршрут сохраняется в Gist. Не запускать Gist PATCH на каждом обновлении GPS.
- Для чтения публичного Gist использовать raw URL. При ответе API о лимите выдерживать паузу по `Retry-After` или `X-RateLimit-Reset`, не повторять запросы в каждом цикле поллинга.

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

**Текущая версия: v3.0.0 build 7**

При КАЖДОМ деплое обновляй ВСЕ ТРИ места одновременно:

1. `sw.js` → `const APP_BUILD = N;` + `const APP_VERSION = 'X.Y.Z';`
2. `js/app.js` → `var APP_BUILD = N;`
3. `index.html` → ВСЕ локальные скрипты и CSS: `?v=X.Y.Z-N`, например `?v=2.9.1-1`.

Версия и build должны совпадать в приложении и service worker. Внутри одной версии build увеличивается; при переходе на новую версию может начинаться с 1. Ключ ресурсов содержит и версию, и build: не оставлять старые `?v=19` у изменённых файлов.

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
- Архивирование не стирает `departA`, `arrA`, `depA`. Перед удалением полей из DOM сохранять их через `captureActualTimeInputs()`.
- ID остановки постоянен: при перестановке дней не переназначать `stop.id` по позиции.
- В современном `daysData` фактическое время хранится в самом дне/остановке. Старые `actuals` и `depN` используются только для отсутствующих полей, а не для перезаписи истории.

## Публикации для зрителей

- Единственное место управления: настройки → «Дни для зрителей». В сайдбаре и меню «Ещё» нет публикаций.
- Активный опубликованный день берётся из актуального `daysData`. Изменения приходят с тем же опросом Gist (10 секунд), что у читателя; ручного обновления копии нет.
- `spectatorPublications` связан с исходным днём через `publicationId` и хранит последнюю версию. При архивировании `saveData()` фиксирует её как `completed`; последующие правки архивного дня не меняют завершённую публикацию. При восстановлении из архива день снова живой. Удаление исходника сохраняет последнюю записанную версию.
- Фото остаются в Firebase под существующими `fb:`-ссылками. Фото, на которые ссылается публикация, защищены от удаления `_deleteNoteImg`. Публикация не скачивает и не перекодирует фото; только явно сохранённые офлайн фото могут быть встроены в Gist.
- GPS читателя — прежний канал `gps`. Зритель подписывается только на `gps/spectator`: владелец заполняет его в режиме «Еду/Иду» только для опубликованного неархивного текущего дня. Неопубликованный день даёт `null`; «Стоп» очищает GPS. Зритель дополнительно проверяет `publicationId`, актуальность дня и давность позиции (120 секунд). Геопозиция из другого дня не отображается.
- Firebase также используется для реакций к публичным заметкам. Реакции привязаны к исходному ID остановки и исходному индексу заметки через `_reactionSource`, даже если приватные заметки отфильтрованы. Чат и текущая погода зрителя не включаются. Читатель сохраняет актуальные нескрытые дни вне архива и прежнюю логику GPS.
- Порядок опубликованных дней соответствует порядку исходного маршрута, включая архив, а не времени публикации. Метаданные копии зрителю не показывать.
- Настройки читателя и зрителя: только настройки облака, версия/обновление и «Закрыть». Ссылки для передачи маршрута и управление публикациями доступны только администратору.
- Локальная проверка: `node tools/serve-local.cjs`, адрес `http://localhost:4173/?preview=admin`. Роли переключаются в верхней панели. Данные изолированы в `travel_preview_v1`; облачная запись отключена.
- `local-data/` содержит локальные резервные копии и исключён из Git. Не публиковать эти файлы.

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
- [ ] `APP_VERSION` и `APP_BUILD` совпадают в app.js и sw.js; сочетание версии и build новое
- [ ] Все локальные `?v=` теги в index.html обновлены до `X.Y.Z-N`
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
