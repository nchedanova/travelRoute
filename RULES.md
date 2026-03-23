# Дорожный журнал — Правила разработки

## Архитектура

Чистый JS/HTML/CSS, без фреймворков. PWA на GitHub Pages. Firebase Realtime DB для чата, заметок, GPS. Gist API для маршрутных данных.

### Файлы и порядок загрузки
```
config.js → data.js → storage.js → offline.js → map.js → render.js → app.js → gps.js → chat.js → notes.js → gpx.js
```
Функции из chat.js (например `_compressToBase64`) доступны в notes.js, но НЕ наоборот. Если нужна функция из файла который грузится позже — это баг.

### Роли
- `isAdmin()` = canWrite (токен + gist ID) ИЛИ демо (нет gist ID вообще)
- `isViewer()` = !isAdmin() = есть gist ID без токена = читатель
- Читатель НЕ видит: заметки (ни к точкам, ни вкладку), DM-табы, кнопку добавления фото в заметки, кнопку редактирования маршрута, любые admin-only элементы
- Перед добавлением любого UI-элемента спроси: "Видит ли это читатель?" — если нет, оберни в `isAdmin()` проверку

---

## Версионирование — КРИТИЧЕСКИ ВАЖНО

При КАЖДОМ деплое обновляй ВСЕ ТРИ места:

1. `sw.js` → `const CACHE_STATIC = 'travel-static-vN';`
2. `js/app.js` → `var APP_BUILD = N;`
3. `index.html` → ВСЕ теги `<script src="js/xxx.js?v=N">`

Номер N должен совпадать везде. Без этого пользователи получают старый код из кэша SW и браузера.

---

## Мобилки и PWA — ВСЕГДА УЧИТЫВАЙ

### Blur-события
- НИКОГДА не вешай на blur: скрытие элемента, переключение режимов, показ тостов
- Blur может сработать при клике на ЛЮБУЮ соседнюю кнопку — кнопка исчезнет до срабатывания onclick
- Если кнопка рядом с textarea — добавь `onmousedown="event.preventDefault()"` чтобы предотвратить потерю фокуса

### Display-состояния вложенных элементов
- При скрытии контейнера (wrap) → дочерние элементы (edit, preview) тоже скрыты
- При повторном показе контейнера → ОБЯЗАТЕЛЬНО явно установи display нужных дочерних элементов
- Типичный баг: скрыл wrap + edit + preview, показал wrap → внутри всё ещё display:none

### Тосты
- Тост «Сохранено» показывай ТОЛЬКО при явном действии пользователя (нажатие кнопки ✓)
- НЕ показывай тост при автосохранении, blur, фоновой синхронизации
- Один тост на одно действие, не серию

### Скролл
- При открытии чата — scroll-to-bottom минимум 4 раза (0ms, 50ms, 200ms, 500ms) чтобы перебить браузерное восстановление позиции
- Тот же подход при переключении комнат

### CSS на мобилках
- `outline: none; -webkit-tap-highlight-color: transparent` на кнопках
- `touch-action: auto` на textarea внутри draggable-контейнеров
- `event.stopPropagation()` на touch/mouse для textarea в draggable-карточках
- Кнопки-иконки — минимум 28×28px для комфортного тапа
- Одинаковый размер для кнопок в одном ряду — никаких 26px рядом с 28px

---

## Заметки к точкам — Правила UX

### Режимы
- **Edit**: textarea + фото внутри одного бабла (`.stop-note-bubble`), кнопки 📷 и ✓ справа
- **Preview**: текст + фото в `.stop-note-display`, клик → обратно в edit

### Сохранение
- ТОЛЬКО по кнопке ✓ (`commitStopNote`)
- onblur — ничего не делает (no-op)
- Фото хранятся в `_pendingStopImages[stopId]` до нажатия ✓
- При пустой заметке (нет текста, нет фото) → полная очистка: `s.note = ''`, `delete s.noteImages`

### toggleStopNote (меню ··· → Заметка)
- Есть контент → показать preview
- Пусто → показать edit с фокусом

---

## Чат — Правила

### Firebase refs
- Групповой чат: `/chat/{msgId}`, presence: `/chat_presence/{uid}`
- ЛС: `/dm/{uid1_uid2}/messages/{msgId}`, read: `/dm/{uid1_uid2}/read/{uid}`
- Имена пользователей: `/users/{uid}/name`

### DM-комнаты
- Room ID: `[uid1, uid2].sort().join('_')` — всегда используй Firebase uid, не localStorage sessionId
- Только админы видят и создают DM
- Читатель не видит полоску комнат вообще (`display:none` в HTML по умолчанию)
- Контакты фильтруются: только `role === 'admin'`, не показывать себя (`c.name === myName`), дедупликация по имени (оставлять самый свежий uid)

### Фото в чате
- Мультивыбор до 10 фото, pending-превью над инпутом
- Одно фото → `imgUrl` (обратная совместимость), 2+ → `imgUrls[]`
- Сжатие: 1200px, quality 0.7, лимит 300KB base64
- Галерея: свайп/стрелки между фото, back-button закрывает

### Auth
- Firebase Anonymous Auth как базовый (uid для каждого устройства)
- Google Sign-In: `signInWithPopup` — НЕ redirect (redirect не работает на GitHub Pages + SW)
- На мобилках popup тоже может не работать (блокируется) — это известное ограничение, не пытайся обходить через redirect
- `getSessionId()` приоритет: `window._firebaseUid` → `localStorage('travel_firebase_uid')` → `localStorage('travel_session_id')`
- При смене auth → чистить старые presence-записи (sessionId + prev firebase uid)
- Имя через ✎ — inline-edit в хедере, НЕ модал. Для Google-юзеров синхронизируется через `/users/{uid}/name`

### Read receipts
- Presence хранит `{ts, name, role}`
- Галочки: серые = доставлено, amber = прочитано
- Тап по amber-галочкам → popup с именами

---

## CSS — Частые ошибки

### transition: all
НЕ используй `transition: all` на элементах которые программно меняют состояние (табы, карточки). При back-navigation видны промежуточные кадры перехода. Используй конкретные свойства: `transition: color 0.15s`.

### Ховер на мобилках
- `.nav-day-btn:hover` и подобные — используй `var(--accent)` вместо хардкоженных цветов
- `@media (hover: none)` для мобильных fallback-ов

### Анимации при навигации
- Класс `.nav-restoring` на body при `_navRestore` → `* { transition: none !important; animation: none !important; }`
- Снимается через `requestAnimationFrame`

---

## Service Worker

### Кэширование
- Свои файлы: stale-while-revalidate
- Тайлы карты: cache-first
- Firebase/Auth/GitHub API: network-only (НЕ кэшировать)
- Обязательно в passthrough: `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`

### Обновление
- Bump `CACHE_STATIC` при любом изменении
- `skipWaiting()` + `clients.claim()` для немедленной активации

---

## Чеклист перед каждым деплоем

- [ ] Все JS файлы проходят `node -c`
- [ ] `APP_BUILD` в app.js совпадает с номером в sw.js
- [ ] Все `?v=` теги в index.html обновлены
- [ ] Новые фичи скрыты от читателя (`isAdmin()` проверки)
- [ ] Нет blur-обработчиков которые скрывают UI
- [ ] Нет тостов при автосохранении
- [ ] Кнопки рядом с textarea имеют `onmousedown="event.preventDefault()"`
- [ ] Фото используют pending-систему (не сохраняются до явного коммита)
- [ ] Мобильная вёрстка проверена (размеры кнопок ≥28px, tap targets)
