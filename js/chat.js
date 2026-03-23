// ── CHAT MODULE ────────────────────────────────────────────────────────────────
// Firebase /chat/{id} → {name, role, text, imgUrl, ts, edited, reactions:{emoji:[sids]}}
// Firebase /chat_presence/{sessionId} → {ts, name}
// Firebase /dm/{roomId}/messages/{id} → same as chat
// Firebase /dm/{roomId}/read/{sessionId} → {ts, name}

let _chatDb       = null;
let _chatRef      = null;
let _presenceRef  = null;
let _globalPresRef = null; // always points to /chat_presence (for contacts)
let _chatInited   = false;
let _chatUnread   = 0;
let _chatVisible  = false;
let _chatLoadTs   = 0;
let _otherReadTs  = 0;
let _presenceTimer = null;
let _editingKey   = null;
let _replyingTo   = null;

// ── DM STATE ──────────────────────────────────────────────────────────────────
let _currentRoom    = 'group';       // 'group' | 'dm_{uid1}_{uid2}'
let _knownContacts  = [];            // [{uid, name, ts}] from presence
let _savedDmRooms   = [];            // [{roomId, name, uid}] from localStorage
let _dmUnread       = {};            // {roomId: count}
let _dmListeners    = {};            // {roomId: ref} for background unread tracking

const REACTIONS = ['👍','❤️','🆗','🙂','🥰','👀','💯','🤝','🎉','😱','😔'];
const EMOJI_LIST = [
  // Ряд 1 — стандартные (как просили)
  '😊','🙂','😂','🥰','❤️','😁','🤗','💯','😆','👀','🙏🏻','😔','🤝','😎','😱','🎉','🚗','📍',
  // Ряд 2 — ещё популярные
  '😍','🥳','🤩','😅','😭','😤','🤯','🥺','😴','😏','🙄','😬','🤔','😇','🤣','✅️','🫡','🫶',
  // Ряд 3 — жесты и символы
  '👍','👎','👏','🙌','💪','✌️','🤌','🔥','✨','💥','⭐','🌟','🆗','❗','💬','📸','🎶','☕',
  // Ряд 4 — дорога и путешествия
  '🔆','⛽','🌙','🛏️','💤','⛱️','🌅','🌄','🎯','🗺️','🏝️','🌊','🌍','✈️','🚂','💻','📸','🥂',
  // Ряд 5 - еда и другое
  '🎊','🏆','📍','🍳','🍽️','🥞','🍜','🧇','🫐','🍒','🥐','🍔','🍕'
];

// ── SESSION ID ─────────────────────────────────────────────────────────────────
function getSessionId() {
  // Prefer Firebase Anonymous Auth uid (server-side, survives cache clear)
  if (window._firebaseUid) return window._firebaseUid;
  // Fallback: cached uid from previous auth
  var cached = localStorage.getItem('travel_firebase_uid');
  if (cached) return cached;
  // Last resort: random localStorage id (demo/offline)
  var id = localStorage.getItem('travel_session_id');
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('travel_session_id', id); }
  return id;
}

// ── SOUND & NOTIFICATION MODE ─────────────────────────────────────────────────
// 3 состояния: 'on' = 🔔 обычные, 'off' = 🔕 выключены, 'pin' = 📌 keep-alive
function getNotifyMode() {
  return localStorage.getItem('travel_chat_notify') || 'on';
}
function isSoundEnabled() { return getNotifyMode() !== 'off'; }

function toggleChatSound() {
  const modes = ['on', 'off', 'pin'];
  const cur = getNotifyMode();
  const next = modes[(modes.indexOf(cur) + 1) % modes.length];
  localStorage.setItem('travel_chat_notify', next);
  _updateSoundBtn();
  // Keep-alive management
  if (next === 'pin') {
    if (typeof startKeepAlive === 'function') startKeepAlive();
  } else if (cur === 'pin') {
    // Выключаем keep-alive только если "Еду" не активен
    if (typeof _drivingMode !== 'undefined' && !_drivingMode && typeof stopKeepAlive === 'function') {
      stopKeepAlive();
    }
  }
}

function _updateSoundBtn() {
  const btn = document.getElementById('chatSoundBtn');
  if (!btn) return;
  const mode = getNotifyMode();
  btn.textContent = mode === 'off' ? '🔕' : mode === 'pin' ? '📌' : '🔔';
  btn.title = mode === 'off' ? 'Уведомления выключены' : mode === 'pin' ? 'Не засыпать (keep-alive)' : 'Звук уведомлений';
}

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
let _titleBlinkTimer = null;
const _originalTitle = document.title;

function _requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function _showNotification(name, text) {
  if (getNotifyMode() === 'off') return;
  // Browser Notification (works when tab is in background)
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('🧭 ' + name, {
        body: text || '',
        icon: './icon.svg',
        tag: 'travel-chat-' + Date.now(),
        silent: false
      });
    } catch(e) {} // iOS Safari may throw
  }
  // Vibrate
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  // Title blink (desktop)
  _startTitleBlink(name, text);
  // PWA badge
  if (navigator.setAppBadge) {
    navigator.setAppBadge(_chatUnread).catch(() => {});
  }
}

function _startTitleBlink(name, text) {
  if (_titleBlinkTimer) return; // already blinking
  let on = true;
  _titleBlinkTimer = setInterval(() => {
    document.title = on ? `💬 ${name}: ${(text || '').slice(0, 30)}` : _originalTitle;
    on = !on;
  }, 1000);
}

function _stopTitleBlink() {
  if (_titleBlinkTimer) { clearInterval(_titleBlinkTimer); _titleBlinkTimer = null; }
  document.title = _originalTitle;
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
}

// ── SHARED AUDIO CONTEXT ──────────────────────────────────────────────────────
// Мобильные браузеры убивают новые AudioContext без жеста пользователя.
// Создаём один раз, переиспользуем всегда.
let _dingCtx = null;

function _ensureAudioCtx() {
  if (_dingCtx && _dingCtx.state !== 'closed') return _dingCtx;
  // Если keep-alive уже создал контекст — переиспользуем его
  if (typeof _keepAliveCtx !== 'undefined' && _keepAliveCtx && _keepAliveCtx.state !== 'closed') {
    _dingCtx = _keepAliveCtx;
    return _dingCtx;
  }
  try {
    _dingCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch(e) {}
  return _dingCtx;
}

// Инициализируем AudioContext при первом касании (жест пользователя)
document.addEventListener('click', function _initAudio() {
  const ctx = _ensureAudioCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume();
  document.removeEventListener('click', _initAudio);
}, { once: true });

function _playDing() {
  if (!isSoundEnabled()) return;
  try {
    const ctx = _ensureAudioCtx();
    if (!ctx) return;
    // Resume если suspended (обязательно на мобилках)
    if (ctx.state === 'suspended') ctx.resume();
    // First tone
    const o1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    o1.connect(g1); g1.connect(ctx.destination);
    o1.type = 'sine'; o1.frequency.setValueAtTime(880, ctx.currentTime);
    g1.gain.setValueAtTime(0.25, ctx.currentTime);
    g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o1.start(ctx.currentTime); o1.stop(ctx.currentTime + 0.3);
    // Second tone (harmony)
    const o2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    o2.connect(g2); g2.connect(ctx.destination);
    o2.type = 'sine'; o2.frequency.setValueAtTime(1100, ctx.currentTime + 0.08);
    g2.gain.setValueAtTime(0, ctx.currentTime);
    g2.gain.setValueAtTime(0.15, ctx.currentTime + 0.08);
    g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o2.start(ctx.currentTime + 0.08); o2.stop(ctx.currentTime + 0.4);
  } catch(e) { console.warn('_playDing error:', e); }
}

// ── INIT ───────────────────────────────────────────────────────────────────────
let _fbConnected   = true;
let _lastMsgTs     = 0;       // timestamp последнего полученного сообщения
let _pollFallback  = null;    // interval для polling-фоллбека
let _reconnectTimer = null;

function initChat() {
  if (_chatInited) return;

  // ── ДЕМО-РЕЖИМ ──────────────────────────────────────────────────────────────
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    _chatInited = true;
    _renderDemoChat();
    return;
  }

  if (typeof firebase === 'undefined' || !firebase.apps.length) return;
  _chatDb         = firebase.database();
  _chatRef        = _chatDb.ref('chat');
  _presenceRef    = _chatDb.ref('chat_presence');
  _globalPresRef  = _chatDb.ref('chat_presence');
  _chatInited     = true;
  _currentRoom    = 'group';

  // Load saved DM rooms from localStorage
  try { _savedDmRooms = JSON.parse(localStorage.getItem('travel_dm_rooms') || '[]'); } catch(e) { _savedDmRooms = []; }

  _listenPresence();
  _ensureNickname(() => _listenMessages());
  _monitorConnection();
  _monitorVisibility();
  _startDmUnreadListeners();
}

function _renderDemoChat() {
  const list = document.getElementById('chatMessages');
  if (!list) return;
  // Устанавливаем демо-имя чтобы часть сообщений были "мои"
  if (typeof DEMO_MY_NAME !== 'undefined') localStorage.setItem('travel_chat_name', DEMO_MY_NAME);
  // Баннер
  list.innerHTML = '<div style="text-align:center;padding:10px 12px;font-size:11px;color:var(--muted);background:var(--surface2);border-radius:8px;margin:8px 12px;">📱 Демо · Настройте ⚙ для реального чата</div>';
  // Фейковые сообщения
  if (typeof DEMO_CHAT === 'undefined') return;
  DEMO_CHAT.forEach((msg, i) => {
    _appendMessage('demo-' + i, msg);
  });
  // Блокируем ввод
  const inp = document.getElementById('chatInput');
  if (inp) { inp.placeholder = 'Настройте ⚙'; inp.disabled = true; }
  const sendBtn = document.querySelector('.chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;
  const nameEl = document.getElementById('chatNameDisplay');
  if (nameEl) nameEl.textContent = 'Демо 📱';
}

// ── CONNECTION MONITORING ──────────────────────────────────────────────────────
// Firebase WebSocket умирает на мобилке в фоне. Детектим и переподключаем.

function _monitorConnection() {
  if (!_chatDb) return;
  try {
    _chatDb.ref('.info/connected').on('value', snap => {
      const wasConnected = _fbConnected;
      _fbConnected = snap.val() === true;
      console.log('[chat] Firebase connected:', _fbConnected);
      if (_fbConnected && !wasConnected) {
        console.log('[chat] Reconnected — checking missed messages');
        _checkMissedMessages();
      }
      if (!_fbConnected) {
        _startPollFallback();
      } else {
        _stopPollFallback();
      }
    });
  } catch(e) { console.warn('[chat] monitorConnection error:', e); }
}

// Когда вкладка снова в фокусе — проверяем пропущенные
function _monitorVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      console.log('[chat] Tab visible — checking missed');
      _checkMissedMessages();
      // Resume AudioContext (мобильный Chrome требует)
      try {
        const ctx = _ensureAudioCtx();
        if (ctx && ctx.state === 'suspended') ctx.resume();
      } catch(e) {}
    }
  });
}

// Проверяем пропущенные сообщения
function _checkMissedMessages() {
  if (!_chatRef || !_lastMsgTs) return;
  try {
    _chatRef.orderByChild('ts').startAt(_lastMsgTs + 1).once('value', snap => {
      const data = snap.val();
      if (!data) return;
      let count = 0;
      Object.entries(data).forEach(([key, msg]) => {
        if (document.getElementById('msg-' + key)) return;
        _appendMessage(key, msg);
        if (!_chatVisible && msg.ts > _lastMsgTs) {
          _chatUnread++; count++;
          _showNotification(msg.name, msg.text);
        }
      });
      if (count > 0) {
        _updateUnreadBadge();
        _playDing();
      }
    });
  } catch(e) { console.warn('[chat] checkMissed error:', e); }
}

// Polling-фоллбек: если WebSocket мёртв, проверяем раз в 15 сек
function _startPollFallback() {
  if (_pollFallback) return;
  console.log('[chat] Starting poll fallback');
  _pollFallback = setInterval(() => _checkMissedMessages(), 15000);
}

function _stopPollFallback() {
  if (_pollFallback) {
    clearInterval(_pollFallback);
    _pollFallback = null;
    console.log('[chat] Stopped poll fallback');
  }
}

// ── NICKNAME / AUTH ───────────────────────────────────────────────────────────
function getChatName()  { return localStorage.getItem('travel_chat_name') || ''; }
function getChatRole()  { return (typeof isAdmin === 'function' && isAdmin()) ? 'admin' : 'viewer'; }
function getRoleBadge() { return (typeof isAdmin === 'function' && isAdmin()) ? '✏' : '👁'; }
function isGoogleUser() {
  var u = firebase.auth && firebase.auth().currentUser;
  return u && u.providerData && u.providerData.some(function(p) { return p.providerId === 'google.com'; });
}

function _ensureNickname(cb) {
  if (getChatName()) { cb && cb(); return; }
  // If returning from Google redirect — wait for result before showing modal
  if (localStorage.getItem('travel_auth_redirect_pending')) {
    // Wait up to 5s for redirect result
    var waited = 0;
    var check = setInterval(function() {
      waited += 200;
      if (getChatName()) {
        clearInterval(check);
        localStorage.removeItem('travel_auth_redirect_pending');
        cb && cb();
      } else if (waited >= 5000) {
        clearInterval(check);
        localStorage.removeItem('travel_auth_redirect_pending');
        _showNicknameModal(cb); // redirect failed, show modal
      }
    }, 200);
    return;
  }
  _showNicknameModal(cb);
}

function _showNicknameModal(cb) {
  const ov = document.getElementById('nicknameModal');
  if (!ov) { cb && cb(); return; }
  // Reset to auth choice step
  showAuthChoiceStep();
  ov.classList.add('show');
  window._nicknameModalCb = cb;
}

function showAuthChoiceStep() {
  var s1 = document.getElementById('authChoiceStep');
  var s2 = document.getElementById('anonNameStep');
  if (s1) s1.style.display = '';
  if (s2) s2.style.display = 'none';
  var err = document.getElementById('authError');
  if (err) err.style.display = 'none';
}

function showAnonNameStep() {
  var s1 = document.getElementById('authChoiceStep');
  var s2 = document.getElementById('anonNameStep');
  if (s1) s1.style.display = 'none';
  if (s2) s2.style.display = '';
  var inp = document.getElementById('nicknameInput');
  if (inp) { inp.value = ''; setTimeout(function() { inp.focus(); }, 120); }
}

function signInWithGoogle() {
  if (typeof firebase === 'undefined' || !firebase.auth) return;
  var provider = new firebase.auth.GoogleAuthProvider();
  var user = firebase.auth().currentUser;
  var isMobile = window.innerWidth <= 700 || /Mobi|Android/i.test(navigator.userAgent);

  if (isMobile) {
    // Mobile/PWA: always use redirect (popups are blocked)
    localStorage.setItem('travel_auth_redirect_pending', '1');
    if (user && user.isAnonymous) {
      user.linkWithRedirect(provider).catch(function() { firebase.auth().signInWithRedirect(provider); });
    } else {
      firebase.auth().signInWithRedirect(provider);
    }
    return;
  }

  // Desktop: try popup
  var popupFn = (user && user.isAnonymous)
    ? user.linkWithPopup.bind(user, provider)
    : firebase.auth().signInWithPopup.bind(firebase.auth(), provider);

  popupFn().then(function(result) {
    _handleGoogleResult(result);
  }).catch(function(err) {
    if (err.code === 'auth/credential-already-in-use' || err.code === 'auth/email-already-in-use') {
      firebase.auth().signInWithPopup(provider).then(_handleGoogleResult).catch(_showAuthError);
    } else if (err.code === 'auth/popup-blocked') {
      // Fallback to redirect
      firebase.auth().signInWithRedirect(provider);
    } else if (err.code !== 'auth/popup-closed-by-user') {
      _showAuthError(err);
    }
  });
}

function _handleGoogleResult(result) {
  if (!result || !result.user) return;
  var u = result.user;
  window._firebaseUid = u.uid;
  localStorage.setItem('travel_firebase_uid', u.uid);
  localStorage.setItem('travel_auth_provider', 'google');
  var name = u.displayName || u.email?.split('@')[0] || 'User';
  // Check for custom name
  if (_chatDb) {
    _chatDb.ref('users/' + u.uid + '/name').once('value').then(function(snap) {
      if (snap.val()) name = snap.val();
      localStorage.setItem('travel_chat_name', name);
      renderChatHeader();
    });
  } else {
    localStorage.setItem('travel_chat_name', name);
  }
  document.getElementById('nicknameModal')?.classList.remove('show');
  renderChatHeader();
  console.log('[auth] Google sign-in ok, uid:', u.uid);
  if (window._nicknameModalCb) { window._nicknameModalCb(); window._nicknameModalCb = null; }
}

function _showAuthError(err) {
  console.error('[auth] Google sign-in error:', err);
  var errEl = document.getElementById('authError');
  if (errEl) {
    errEl.textContent = 'Ошибка: ' + (err.message || err.code);
    errEl.style.display = 'block';
  }
}

function saveNickname() {
  const inp = document.getElementById('nicknameInput');
  const name = inp ? inp.value.trim() : '';
  if (!name) { inp && inp.focus(); return; }
  localStorage.setItem('travel_chat_name', name);
  localStorage.setItem('travel_auth_provider', 'anonymous');
  document.getElementById('nicknameModal').classList.remove('show');
  renderChatHeader();
  if (window._nicknameModalCb) { window._nicknameModalCb(); window._nicknameModalCb = null; }
}
function nicknameKeydown(e) { if (e.key === 'Enter') saveNickname(); }

// ── PRESENCE ───────────────────────────────────────────────────────────────────
let _otherReaders = []; // [{name, ts, sid}]

function _listenPresence() {
  // Always listen to global presence for contact list
  _globalPresRef.on('value', snap => {
    const data = snap.val() || {};
    const myId = getSessionId();
    _knownContacts = [];
    Object.entries(data).forEach(([sid, val]) => {
      if (sid === myId) return;
      const ts   = typeof val === 'object' ? (val.ts || 0) : (val || 0);
      const name = typeof val === 'object' ? (val.name || '?') : '?';
      const role = typeof val === 'object' ? (val.role || 'viewer') : 'viewer';
      _knownContacts.push({ uid: sid, name, ts, role });
    });
    _renderRoomTabs();

    // If currently in group chat, update readers from global presence
    if (_currentRoom === 'group') {
      _otherReaders = _knownContacts.map(c => ({ sid: c.uid, name: c.name, ts: c.ts }));
      _otherReadTs = _otherReaders.reduce((max, r) => Math.max(max, r.ts), 0);
      document.querySelectorAll('.chat-msg.mine[data-ts]').forEach(el => {
        _updateTicks(el.id.replace('msg-',''), parseInt(el.dataset.ts));
      });
    }
  });

  // If in a DM, also listen to DM-specific read receipts
  if (_currentRoom !== 'group') {
    _listenDmPresence();
  }
}

function _listenDmPresence() {
  if (_currentRoom === 'group' || !_chatDb) return;
  var dmReadRef = _chatDb.ref('dm/' + _currentRoom.replace('dm_','') + '/read');
  dmReadRef.on('value', snap => {
    var data = snap.val() || {};
    var myId = getSessionId();
    _otherReaders = [];
    _otherReadTs = 0;
    Object.entries(data).forEach(([sid, val]) => {
      if (sid === myId) return;
      var ts   = typeof val === 'object' ? (val.ts || 0) : (val || 0);
      var name = typeof val === 'object' ? (val.name || '?') : '?';
      if (ts > _otherReadTs) _otherReadTs = ts;
      _otherReaders.push({ sid, name, ts });
    });
    document.querySelectorAll('.chat-msg.mine[data-ts]').forEach(el => {
      _updateTicks(el.id.replace('msg-',''), parseInt(el.dataset.ts));
    });
  });
}

function _writePresence() {
  var payload = { ts: Date.now(), name: getChatName() || '?', role: getChatRole() };
  // Always write to global presence (for contacts list)
  if (_globalPresRef) _globalPresRef.child(getSessionId()).set(payload);
  // Also write to DM-specific read ref if in a DM
  if (_currentRoom !== 'group' && _chatDb) {
    _chatDb.ref('dm/' + _currentRoom.replace('dm_','') + '/read/' + getSessionId()).set(payload);
  }
}

// ── LISTEN ─────────────────────────────────────────────────────────────────────
function _listenMessages() {
  if (!_chatRef) return;
  _requestNotificationPermission();
  const lastSeen = parseInt(localStorage.getItem('travel_chat_last_seen') || '0');
  _chatLoadTs = Date.now();
  _chatRef.limitToLast(200).on('child_added', snap => {
    const msg = snap.val(); if (!msg) return;
    if (msg.ts > _lastMsgTs) _lastMsgTs = msg.ts; // отслеживаем для reconnect
    _appendMessage(snap.key, msg);
    if (!_chatVisible && msg.ts > lastSeen && msg.ts > _chatLoadTs - 200) {
      _chatUnread++; _updateUnreadBadge();
      _playDing();
      _showNotification(msg.name, msg.text);
    }
  });
  _chatRef.on('child_removed', snap => { document.getElementById('msg-' + snap.key)?.remove(); });
  _chatRef.on('child_changed', snap => {
    const el = document.getElementById('msg-' + snap.key);
    if (el) { const next = el.nextSibling; el.remove(); _appendMessageAt(snap.key, snap.val(), next); }
  });
}

// ── SEND ───────────────────────────────────────────────────────────────────────
function sendChatMessage() {
  if (!_chatInited) { initChat(); return; }

  // Если редактируем — сохраняем изменение
  if (_editingKey) { _commitEdit(_editingKey); return; }

  // Если есть pending-фото — отправляем фото-сообщение
  if (_pendingImages.length) { _sendPendingImages(); return; }

  const inp  = document.getElementById('chatInput');
  const text = inp ? inp.value.trim() : '';
  if (!text) return;
  if (!getChatName()) { _showNicknameModal(() => sendChatMessage()); return; }

  const ts = Date.now();
  const msgData = { name: getChatName(), role: getChatRole(), text, ts };
  if (_replyingTo) { msgData.replyTo = _replyingTo; cancelReply(); }

  if (!navigator.onLine) {
    // Оффлайн: сохраняем в очередь, показываем локально
    if (typeof queueChatMessage === 'function') queueChatMessage(msgData);
    _appendMessage('pending-' + ts, { ...msgData, _pending: true });
    showToast && showToast('📴 Сообщение отправится при появлении сети');
  } else {
    const ref = _chatRef.push();
    _appendMessage(ref.key, { ...msgData, _pending: true });
    ref.set(msgData).then(() => {
      document.getElementById('ticks-' + ref.key)?.classList.remove('pending');
    });
  }
  inp.value = ''; inp.style.height = 'auto';
  closeEmojiPicker();
}

// ── PHOTO UPLOAD (multi-photo + paste) ────────────────────────────────────────
const MAX_PENDING_IMAGES = 10;
let _pendingImages = []; // [{blob, thumbUrl}]

function triggerPhotoUpload() {
  if (!_chatInited) { initChat(); return; }
  if (!getChatName()) { _showNicknameModal(() => triggerPhotoUpload()); return; }
  let inp = document.getElementById('chatPhotoInput');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.id = 'chatPhotoInput'; inp.style.display = 'none';
    inp.onchange = () => {
      if (inp.files.length) _addPendingFiles(Array.from(inp.files));
      inp.value = '';
    };
    document.body.appendChild(inp);
  }
  inp.click();
}

function _addPendingFiles(files) {
  const room = MAX_PENDING_IMAGES - _pendingImages.length;
  if (room <= 0) { showToast('📷 Максимум ' + MAX_PENDING_IMAGES + ' фото'); return; }
  const batch = files.slice(0, room);
  if (files.length > room) showToast('📷 Добавлено ' + batch.length + ' из ' + files.length + ' (макс ' + MAX_PENDING_IMAGES + ')');
  batch.forEach(file => {
    const thumbUrl = URL.createObjectURL(file);
    _pendingImages.push({ blob: file, thumbUrl });
  });
  _renderPendingPreview();
  // Focus chat input so user can type caption
  const inp = document.getElementById('chatInput');
  if (inp) inp.focus();
}

function _addPendingBlob(blob) {
  if (_pendingImages.length >= MAX_PENDING_IMAGES) { showToast('📷 Максимум ' + MAX_PENDING_IMAGES + ' фото'); return; }
  const thumbUrl = URL.createObjectURL(blob);
  _pendingImages.push({ blob, thumbUrl });
  _renderPendingPreview();
}

function removePendingImage(idx) {
  if (_pendingImages[idx]) {
    URL.revokeObjectURL(_pendingImages[idx].thumbUrl);
    _pendingImages.splice(idx, 1);
    _renderPendingPreview();
  }
}

function _renderPendingPreview() {
  const bar = document.getElementById('chatPendingImages');
  if (!bar) return;
  if (!_pendingImages.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = _pendingImages.map((p, i) =>
    `<div class="pending-thumb-wrap">
      <img src="${p.thumbUrl}" class="pending-thumb" alt="">
      <button class="pending-thumb-remove" onclick="removePendingImage(${i})">×</button>
    </div>`
  ).join('') + `<div class="pending-thumb-count">${_pendingImages.length}/${MAX_PENDING_IMAGES}</div>`;
}

function _clearPending() {
  _pendingImages.forEach(p => URL.revokeObjectURL(p.thumbUrl));
  _pendingImages = [];
  _renderPendingPreview();
}

async function _sendPendingImages() {
  if (!_pendingImages.length) return;
  if (!navigator.onLine) { showToast('📴 Для фото нужен интернет'); return; }

  const ts = Date.now();
  const pendingKey = 'photo-' + ts;
  const caption = document.getElementById('chatInput')?.value.trim() || '';
  document.getElementById('chatInput').value = '';
  document.getElementById('chatInput').style.height = 'auto';

  _appendMessage(pendingKey, { name: getChatName(), role: getChatRole(), ts, uploading: true });

  try {
    const urls = [];
    for (const p of _pendingImages) {
      urls.push(await _compressToBase64(p.blob, 1200, 0.7));
    }
    _clearPending();
    document.getElementById('msg-' + pendingKey)?.remove();

    const ref = _chatRef.push();
    const msgData = { name: getChatName(), role: getChatRole(), ts, text: caption };
    if (urls.length === 1) {
      msgData.imgUrl = urls[0]; // обратная совместимость
    } else {
      msgData.imgUrls = urls;
    }
    if (_replyingTo) { msgData.replyTo = _replyingTo; cancelReply(); }
    ref.set(msgData);
  } catch(e) {
    console.error('Photo upload error:', e);
    document.getElementById('msg-' + pendingKey)?.remove();
    _clearPending();
    showToast('⚠ Ошибка загрузки фото');
  }
}

// Legacy single-file upload (kept for offline queue compatibility)
async function _uploadPhoto(file) {
  _addPendingFiles([file]);
  await _sendPendingImages();
}

function _compressToBase64(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      // Проверка размера (~100KB лимит для Realtime DB)
      const sizeKB = Math.round(dataUrl.length * 0.75 / 1024);
      if (sizeKB > 300) {
        // Пережимаем сильнее
        canvas.width = Math.round(w * 0.7); canvas.height = Math.round(h * 0.7);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.5));
      } else {
        resolve(dataUrl);
      }
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ── CLIPBOARD PASTE (chat) ────────────────────────────────────────────────────
function _handleChatPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageItems = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) imageItems.push(items[i]);
  }
  if (!imageItems.length) return;
  e.preventDefault();
  if (!_chatInited) { initChat(); return; }
  if (!getChatName()) { _showNicknameModal(); return; }
  imageItems.forEach(item => {
    const blob = item.getAsFile();
    if (blob) _addPendingBlob(blob);
  });
}

function chatInputKeydown(e) {
  const isMobile = window.innerWidth <= 700;
  if (e.key === 'Enter') {
    if (isMobile) return; // на мобилке Enter = новая строка
    if (!e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  }
  if (e.key === 'Escape' && _editingKey) { cancelEdit(); }
}

// ── CLEAR CHAT (только Admin) ──────────────────────────────────────────────────
function openClearChatConfirm() {
  const ov = document.getElementById('clearChatModal');
  if (ov) ov.classList.add('show');
}
function closeClearChatConfirm() {
  const ov = document.getElementById('clearChatModal');
  if (ov) ov.classList.remove('show');
}
function confirmClearChat() {
  if (!_chatRef || !CLOUD_CONFIG.canWrite) return;
  closeClearChatConfirm();
  _chatRef.remove().then(() => {
    const list = document.getElementById('chatMessages');
    if (list) list.innerHTML = '';
    showToast && showToast('🗑 Чат очищен');
  }).catch(e => {
    console.error('[chat] clearChat error:', e);
    showToast && showToast('⚠ Ошибка очистки чата');
  });
}

// ── REPLY TO MESSAGE ──────────────────────────────────────────────────────────
function startReply(key, name, text) {
  closeMsgMenu();
  _replyingTo = { key, name, text };
  // Cancel any active edit
  if (_editingKey) cancelEdit();

  const banner = document.getElementById('chatReplyBanner');
  if (banner) {
    banner.style.display = 'flex';
    const nameEl = banner.querySelector('.reply-banner-name');
    const prevEl = banner.querySelector('.reply-banner-preview');
    if (nameEl) nameEl.textContent = name;
    if (prevEl) prevEl.textContent = (text || '').slice(0, 80);
  }
  const inp = document.getElementById('chatInput');
  if (inp) { inp.focus(); }
}

function cancelReply() {
  _replyingTo = null;
  const banner = document.getElementById('chatReplyBanner');
  if (banner) banner.style.display = 'none';
}


function startEditMessage(key) {
  closeMsgMenu();
  _chatRef.child(key).once('value', snap => {
    const msg = snap.val();
    if (!msg || (!CLOUD_CONFIG.canWrite && msg.name !== getChatName())) return;

    _editingKey = key;
    const inp = document.getElementById('chatInput');
    if (inp) {
      inp.value = msg.text || '';
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
      inp.focus();
    }

    // Show edit banner
    const banner = document.getElementById('chatEditBanner');
    if (banner) {
      banner.style.display = 'flex';
      const preview = banner.querySelector('.edit-banner-preview');
      if (preview) preview.textContent = (msg.text || '').slice(0, 60);
    }
  });
}

function cancelEdit() {
  _editingKey = null;
  const inp = document.getElementById('chatInput');
  if (inp) { inp.value = ''; inp.style.height = 'auto'; }
  const banner = document.getElementById('chatEditBanner');
  if (banner) banner.style.display = 'none';
}

function _commitEdit(key) {
  const inp  = document.getElementById('chatInput');
  const text = (inp ? inp.value : '').trim();
  if (!text) return;
  _chatRef.child(key).update({ text, edited: true });
  cancelEdit();
}

// ── DELETE ─────────────────────────────────────────────────────────────────────
function deleteChatMessage(key) {
  closeMsgMenu();
  // Admin can delete anything; viewers only their own
  _chatRef.child(key).once('value', snap => {
    const msg = snap.val();
    if (!msg) return;
    if (CLOUD_CONFIG.canWrite || (msg.name === getChatName() && msg.role === getChatRole())) {
      _chatRef.child(key).remove();
    }
  });
}

// ── REACTIONS ──────────────────────────────────────────────────────────────────
function toggleReaction(key, emoji) {
  closeMsgMenu();
  const sid = getSessionId();
  _chatRef.child(key).once('value', snap => {
    const msg = snap.val() || {};
    const r   = msg.reactions ? JSON.parse(JSON.stringify(msg.reactions)) : {};
    if (!r[emoji]) r[emoji] = [];
    const idx = r[emoji].indexOf(sid);
    if (idx >= 0) { r[emoji].splice(idx, 1); if (!r[emoji].length) delete r[emoji]; }
    else r[emoji].push(sid);
    _chatRef.child(key).update({ reactions: r });
  });
}


// ── CONTEXT MENU ───────────────────────────────────────────────────────────────
let _menuKey = null;

function openMsgMenu(e, key, isMine) {
  if (e.preventDefault) e.preventDefault();
  if (e.stopPropagation) e.stopPropagation();
  closeMsgMenu();
  _menuKey = key;
  const menu = document.getElementById('chatMsgMenu');
  if (!menu) return;

  // Reactions row
  menu.querySelector('.msg-menu-reactions').innerHTML = REACTIONS.map(em =>
    `<button class="msg-menu-emoji" onclick="toggleReaction('${key}','${em}')">${em}</button>`
  ).join('');

  // Actions — admin sees all; viewer sees own only
  const canEdit   = isMine;
  const canDelete = (typeof isAdmin === 'function' && isAdmin()) || isMine;
  const actions   = menu.querySelector('.msg-menu-actions');
  actions.innerHTML = '';

  // Reply — доступно всем, читаем данные из DOM (уже отрендерено)
  const msgEl = document.getElementById('msg-' + key);
  const replyName = msgEl?.querySelector('.chat-author')?.textContent?.replace(/[✏👁]/g,'').trim()
    || getChatName() || '?';
  const replyText = msgEl?.querySelector('.chat-bubble')?.textContent?.trim() || '';
  const replyBtn = document.createElement('button');
  replyBtn.className = 'msg-menu-item';
  replyBtn.textContent = '↩ Ответить';
  replyBtn.onclick = () => startReply(key, replyName, replyText);
  actions.appendChild(replyBtn);

  if (canEdit) {
    const btn = document.createElement('button');
    btn.className = 'msg-menu-item';
    btn.textContent = '✎ Редактировать';
    btn.onclick = () => startEditMessage(key);
    actions.appendChild(btn);
  }
  if (canDelete) {
    const btn = document.createElement('button');
    btn.className = 'msg-menu-item danger';
    btn.textContent = '× Удалить';
    btn.onclick = () => deleteChatMessage(key);
    actions.appendChild(btn);
  }
  // Блок всегда виден — Reply доступен всем
  actions.style.display = 'flex';

  // Position — используем элемент сообщения (msgEl уже объявлен выше)
  const anchor = msgEl || e.currentTarget || e.target;
  const rect   = anchor.getBoundingClientRect();
  const panel  = menu.closest('.chat-panel') || document.getElementById('sidebar');
  const panelRect = panel.getBoundingClientRect();
  menu.style.display = 'block';
  let top  = rect.top - panelRect.top - menu.offsetHeight - 6;
  let left = isMine ? rect.right - panelRect.left - menu.offsetWidth : rect.left - panelRect.left;
  if (top < 4) top = rect.bottom - panelRect.top + 6;
  const maxTop = panelRect.height - menu.offsetHeight - 4;
  if (top > maxTop) top = maxTop;
  if (top < 4) top = 4;
  left = Math.max(4, Math.min(left, panelRect.width - menu.offsetWidth - 4));
  menu.style.top = top + 'px'; menu.style.left = left + 'px';
}

function closeMsgMenu() {
  const m = document.getElementById('chatMsgMenu');
  if (m) m.style.display = 'none';
  _menuKey = null;
}

// ── EMOJI PICKER ───────────────────────────────────────────────────────────────
function toggleEmojiPicker() {
  const p = document.getElementById('emojiPicker');
  if (!p) return;
  if (p.style.display !== 'none') { p.style.display = 'none'; return; }
  if (!p.dataset.built) {
    p.innerHTML = EMOJI_LIST.map(e => `<button class="emoji-pick-btn" onclick="insertEmoji('${e}')">${e}</button>`).join('');
    p.dataset.built = '1';
  }
  p.style.display = 'grid';
}
function closeEmojiPicker() { const p = document.getElementById('emojiPicker'); if (p) p.style.display = 'none'; }
function insertEmoji(e) {
  const inp = document.getElementById('chatInput'); if (!inp) return;
  const pos = inp.selectionStart || inp.value.length;
  inp.value = inp.value.slice(0, pos) + e + inp.value.slice(pos);
  inp.focus(); inp.selectionStart = inp.selectionEnd = pos + e.length;
}

// ── RENDER ─────────────────────────────────────────────────────────────────────
function _appendMessage(key, msg) { _appendMessageAt(key, msg, null); }

function _appendMessageAt(key, msg, beforeNode) {
  const list = document.getElementById('chatMessages');
  if (!list || document.getElementById('msg-' + key)) return;

  // Remove empty-state placeholder on first message
  var emptyEl = document.getElementById('chatEmptyState');
  if (emptyEl) emptyEl.remove();

  const sid    = getSessionId();
  // В демо-режиме совпадение только по имени (роль в DEMO_CHAT может отличаться)
  const isMine = (msg.name === getChatName()) &&
    (msg.role === getChatRole() || (typeof isDemoMode === 'function' && isDemoMode()));
  const time   = msg.ts ? new Date(msg.ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }) : '';
  const badge  = msg.role === 'admin' ? '✏' : '👁';

  const wrap       = document.createElement('div');
  wrap.id          = 'msg-' + key;
  wrap.className   = 'chat-msg ' + (isMine ? 'mine' : 'theirs');
  wrap.dataset.ts  = msg.ts || 0;

  // Double tap/click → копировать текст
  let tapCount = 0, tapTimer = null;
  wrap.addEventListener('click', e => {
    if (e.target.closest('button,a,textarea,img')) return;
    tapCount++;
    if (tapCount === 1) tapTimer = setTimeout(() => { tapCount = 0; }, 350);
    if (tapCount === 2) {
      clearTimeout(tapTimer); tapCount = 0;
      const text = msg.text || '';
      if (!text) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => { showToast && showToast('📋 Скопировано'); }).catch(() => {});
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); showToast && showToast('📋 Скопировано'); } catch(e) {}
        document.body.removeChild(ta);
      }
    }
  });
  // Long press / right-click → menu
  let pressTimer = null;
  wrap.addEventListener('contextmenu', e => openMsgMenu(e, key, isMine));
  wrap.addEventListener('touchstart',  e => { pressTimer = setTimeout(() => openMsgMenu(e.touches[0], key, isMine), 500); }, { passive: true });
  wrap.addEventListener('touchend',    () => clearTimeout(pressTimer));
  wrap.addEventListener('touchmove',   () => clearTimeout(pressTimer));

  let inner = '';
  if (!isMine) inner += `<div class="chat-author">${_esc(msg.name)} ${badge}</div>`;

  // Цитата (ответ на сообщение)
  if (msg.replyTo) {
    inner += `<div class="chat-reply-quote" onclick="scrollToMessage('${_esc(msg.replyTo.key)}')">
      <span class="chat-reply-quote-name">${_esc(msg.replyTo.name)}</span>
      <span class="chat-reply-quote-text">${_esc((msg.replyTo.text || '').slice(0, 80))}</span>
    </div>`;
  }

  if (msg.uploading) {
    inner += `<div class="chat-bubble"><span class="chat-uploading">Загрузка фото…</span></div>`;
  } else if (msg.imgUrls && msg.imgUrls.length) {
    // Multi-photo grid
    const cnt = msg.imgUrls.length;
    const cols = cnt === 1 ? 1 : cnt <= 4 ? 2 : 3;
    inner += `<div class="chat-bubble chat-bubble-img"><div class="chat-photo-grid chat-photo-grid-${cols}" data-count="${cnt}">`;
    msg.imgUrls.forEach((url, i) => {
      inner += `<img src="${_esc(url)}" class="chat-photo-grid-item" onclick="openChatPhoto(this)" alt="фото ${i+1}">`;
    });
    inner += `</div>${msg.text ? `<div class="chat-photo-caption">${_linkify(msg.text)}</div>` : ''}</div>`;
  } else if (msg.imgUrl) {
    inner += `<div class="chat-bubble chat-bubble-img">
      <img src="${_esc(msg.imgUrl)}" class="chat-photo" onclick="openChatPhoto(this)" alt="фото">
      ${msg.text ? `<div class="chat-photo-caption">${_linkify(msg.text)}</div>` : ''}
    </div>`;
  } else {
    inner += `<div class="chat-bubble">${_linkify(msg.text || '')}${msg.edited ? '<span class="chat-edited"> (ред.)</span>' : ''}</div>`;
  }

  inner += _renderReactions(key, msg.reactions || {}, sid);
  inner += `<div class="chat-time-row">
    <span class="chat-time">${time}</span>
    ${isMine && !msg.uploading ? `<span class="chat-ticks${msg._pending ? ' pending' : ''}" id="ticks-${key}"><svg class="tick-svg" viewBox="0 0 18 9" fill="none"><polyline points="1,4 5,8 11,1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><polyline points="7,8 13,1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : ''}
  </div>`;

  wrap.innerHTML = inner;
  if (beforeNode) list.insertBefore(wrap, beforeNode); else list.appendChild(wrap);
  if (isMine) _updateTicks(key, msg.ts);
  _scrollToBottom();
}

function _renderReactions(key, reactions, sid) {
  const entries = Object.entries(reactions);
  if (!entries.length) return `<div class="chat-reactions" id="reactions-${key}"></div>`;
  const btns = entries.map(([em, sids]) =>
    `<button class="reaction-btn${sids.includes(sid) ? ' active' : ''}" onclick="toggleReaction('${key}','${em}')">${em} ${sids.length}</button>`
  ).join('');
  return `<div class="chat-reactions" id="reactions-${key}">${btns}</div>`;
}

function _updateTicks(key, ts) {
  const el = document.getElementById('ticks-' + key); if (!el) return;
  el.classList.remove('pending', 'delivered', 'read');

  const readers = _otherReaders.filter(r => r.ts >= ts);
  const isRead  = readers.length > 0;

  el.classList.add(ts && isRead ? 'read' : 'delivered');

  // Store reader names for tap popup (no visible badge)
  if (isRead) {
    el.dataset.readers = readers.map(r => r.name).join(', ');
  } else {
    delete el.dataset.readers;
  }
}

// ── Read-by popup ─────────────────────────────────────────────────────────────
let _readPopupEl = null;

function _showReadPopup(el) {
  const names = el.dataset.readers;
  if (!names) return;
  _closeReadPopup();

  _readPopupEl = document.createElement('div');
  _readPopupEl.className = 'read-popup';
  _readPopupEl.textContent = '👁 ' + names;

  // Position near the ticks element
  const rect  = el.getBoundingClientRect();
  const panel = el.closest('.chat-panel') || document.getElementById('sidebar');
  const pRect = panel ? panel.getBoundingClientRect() : { left:0, top:0 };

  _readPopupEl.style.position = 'absolute';
  _readPopupEl.style.bottom   = (pRect.bottom - rect.top + 4) + 'px';
  _readPopupEl.style.right    = (pRect.right - rect.right) + 'px';

  if (panel) { panel.style.position = 'relative'; panel.appendChild(_readPopupEl); }
  else document.body.appendChild(_readPopupEl);

  // Auto-close
  setTimeout(_closeReadPopup, 3000);
}

function _closeReadPopup() {
  if (_readPopupEl) { _readPopupEl.remove(); _readPopupEl = null; }
}

// Tap on ticks → show who read
document.addEventListener('click', e => {
  const ticks = e.target.closest('.chat-ticks.read');
  if (ticks && ticks.dataset.readers) {
    e.stopPropagation();
    _showReadPopup(ticks);
    return;
  }
  // Close popup on outside click
  if (_readPopupEl && !e.target.closest('.read-popup')) _closeReadPopup();
});

function _esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Превращает URL в кликабельные ссылки (после экранирования HTML)
function _linkify(s) {
  if (!s) return '';
  const escaped = _esc(s);
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>'
  );
}
function _scrollToBottom() { const l = document.getElementById('chatMessages'); if (l) l.scrollTop = l.scrollHeight; }

function scrollToMessage(key) {
  const el = document.getElementById('msg-' + key);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1500);
}

// ── PHOTO GALLERY VIEWER ──────────────────────────────────────────────────────
let _viewerPhotos = [];
let _viewerIndex  = 0;
let _viewerOpen   = false;

function openChatPhoto(elOrUrl) {
  let url;
  let photos = [];

  if (typeof elOrUrl === 'string') {
    // Legacy: plain URL string
    url = elOrUrl;
    photos = [url];
  } else if (elOrUrl && elOrUrl.src) {
    // DOM img element — find sibling photos in container
    url = elOrUrl.src;
    const container = elOrUrl.closest('.chat-photo-grid, .note-images-inline, .chat-bubble-img');
    if (container) {
      photos = Array.from(container.querySelectorAll('img')).map(i => i.src).filter(Boolean);
    }
    if (!photos.length) photos = [url];
  } else {
    return;
  }

  _viewerPhotos = photos;
  _viewerIndex  = Math.max(0, photos.indexOf(url));
  _viewerOpen   = true;
  _showViewerPhoto();

  const ov = document.getElementById('photoViewerOverlay');
  if (ov) ov.classList.add('show');

  // Push history state so mobile back button closes the viewer
  history.pushState({ photoViewer: true }, '');
}

function closePhotoViewer() {
  const ov = document.getElementById('photoViewerOverlay');
  if (ov) ov.classList.remove('show');
  if (_viewerOpen) {
    _viewerOpen = false;
    // If we pushed a state, pop it silently
    // (if user pressed back, the popstate handler already called us)
  }
  _viewerPhotos = [];
}

function _showViewerPhoto() {
  const img     = document.getElementById('photoViewerImg');
  const counter = document.getElementById('pvCounter');
  const prev    = document.getElementById('pvPrev');
  const next    = document.getElementById('pvNext');
  if (!img) return;

  img.src = _viewerPhotos[_viewerIndex] || '';
  const multi = _viewerPhotos.length > 1;
  if (counter) {
    counter.textContent = multi ? (_viewerIndex + 1) + ' / ' + _viewerPhotos.length : '';
    counter.style.display = multi ? '' : 'none';
  }
  if (prev) prev.style.display = multi ? '' : 'none';
  if (next) next.style.display = multi ? '' : 'none';
}

function viewerPrev() {
  if (_viewerPhotos.length <= 1) return;
  _viewerIndex = (_viewerIndex - 1 + _viewerPhotos.length) % _viewerPhotos.length;
  _showViewerPhoto();
}

function viewerNext() {
  if (_viewerPhotos.length <= 1) return;
  _viewerIndex = (_viewerIndex + 1) % _viewerPhotos.length;
  _showViewerPhoto();
}

// Swipe support for gallery
(function() {
  let sx = 0, sy = 0, moving = false;
  const wrap = () => document.getElementById('pvImgWrap');

  document.addEventListener('touchstart', e => {
    if (!_viewerOpen) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; moving = true;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!moving || !_viewerOpen) return;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!moving || !_viewerOpen) return;
    moving = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return; // too short or vertical
    if (dx < 0) viewerNext();
    else viewerPrev();
  }, { passive: true });

  // Keyboard arrows
  document.addEventListener('keydown', e => {
    if (!_viewerOpen) return;
    if (e.key === 'ArrowLeft')  { viewerPrev(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { viewerNext(); e.preventDefault(); }
    if (e.key === 'Escape')     { closePhotoViewer(); e.preventDefault(); }
  });
})();

// ── Back button integration ──────────────────────────────────────────────────
// Intercept popstate to close viewer on mobile back
window.addEventListener('popstate', function(e) {
  if (_viewerOpen) {
    closePhotoViewer();
    // Don't let _navRestore also run — we consumed this event
    return;
  }
  // Otherwise delegate to existing _navRestore
  if (typeof _navRestore === 'function') _navRestore(e.state);
});

// ── UNREAD ─────────────────────────────────────────────────────────────────────
function _updateUnreadBadge() {
  const show = _chatUnread > 0;
  const dot     = document.getElementById('chatTabDot');
  const headerDot = document.getElementById('chatHeaderDot');
  if (dot)       dot.style.display       = show ? 'block' : 'none';
  if (headerDot) headerDot.style.display = show ? 'block' : 'none';
}

function onChatTabOpen() {
  _chatVisible = true; _chatUnread = 0; _updateUnreadBadge();
  _stopTitleBlink();
  _updateSoundBtn();
  localStorage.setItem('travel_chat_last_seen', Date.now().toString());
  _writePresence();
  clearInterval(_presenceTimer);
  _presenceTimer = setInterval(_writePresence, 30000);
  if (!_chatInited) initChat();
  setTimeout(_scrollToBottom, 50);
  renderChatHeader();
}
function onChatTabClose() { _chatVisible = false; clearInterval(_presenceTimer); }

function renderChatHeader() {
  const el = document.getElementById('chatNameDisplay');
  var _isGoogle = isGoogleUser();
  if (el) {
    var gBadge = _isGoogle ? ' <span class="google-badge" title="Google">G</span>' : '';
    el.innerHTML = getChatName() ? _esc(getChatName()) + ' ' + getRoleBadge() + gBadge : '';
  }
  // Google sign-in button — hide if already signed in with Google
  var gBtn = document.getElementById('chatGoogleBtn');
  if (gBtn) gBtn.style.display = _isGoogle ? 'none' : '';
  // Clear chat — admin only
  const clearBtn = document.getElementById('chatClearBtn');
  if (clearBtn) clearBtn.style.display = (typeof isAdmin === 'function' && isAdmin()) ? 'inline-flex' : 'none';
}
function changeChatName() {
  var el = document.getElementById('chatNameDisplay');
  if (!el) return;
  var current = getChatName();
  var inp = document.createElement('input');
  inp.type = 'text';
  inp.value = current;
  inp.maxLength = 24;
  inp.className = 'chat-name-edit';
  inp.style.cssText = 'background:var(--surface2);border:1px solid var(--amber);border-radius:4px;color:var(--text);font-family:inherit;font-size:12px;padding:2px 6px;width:100px;outline:none;';
  el.innerHTML = '';
  el.appendChild(inp);
  inp.focus();
  inp.select();
  var commit = function() {
    var name = inp.value.trim() || current;
    localStorage.setItem('travel_chat_name', name);
    // Sync to Firebase for cross-device (Google users)
    if (isGoogleUser() && _chatDb && window._firebaseUid) {
      _chatDb.ref('users/' + window._firebaseUid + '/name').set(name);
    }
    renderChatHeader();
    _writePresence();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') inp.blur();
    if (e.key === 'Escape') { inp.value = current; inp.blur(); }
  });
}

// ── PASTE LISTENER (chat) ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const chatInp = document.getElementById('chatInput');
  if (chatInp) chatInp.addEventListener('paste', _handleChatPaste);
});

// ── DM: ROOM SWITCHING ───────────────────────────────────────────────────────
function _dmRoomId(otherUid) {
  // Always use Firebase uid for room IDs (required for security rules)
  var myUid = window._firebaseUid || getSessionId();
  return [myUid, otherUid].sort().join('_');
}

function _saveDmRooms() {
  try { localStorage.setItem('travel_dm_rooms', JSON.stringify(_savedDmRooms)); } catch(e) {}
}

function openDmWith(uid, name, role) {
  if (!_chatInited || !_chatDb) return;
  if (typeof isAdmin === 'function' && !isAdmin()) return; // viewers can't create DMs
  if (!window._firebaseUid) { showToast('⏳ Подождите, авторизация…'); return; }
  var roomId = _dmRoomId(uid);
  // Save to known DM rooms
  if (!_savedDmRooms.find(r => r.roomId === roomId)) {
    _savedDmRooms.push({ roomId: roomId, name: name, uid: uid, role: role || 'viewer' });
    _saveDmRooms();
    _startDmRoomListener(roomId);
  }
  switchChatRoom('dm_' + roomId);
}

function deleteDmRoom(roomKey) {
  var roomId = roomKey.replace('dm_', '');
  _savedDmRooms = _savedDmRooms.filter(function(r) { return r.roomId !== roomId; });
  _saveDmRooms();
  // Detach listener
  if (_dmListeners[roomId]) { _dmListeners[roomId].off(); delete _dmListeners[roomId]; }
  delete _dmUnread[roomKey];
  // If currently in this DM, switch to group
  if (_currentRoom === roomKey) switchChatRoom('group');
  else _renderRoomTabs();
  showToast('🗑 Чат удалён');
}

function switchChatRoom(roomId) {
  if (!_chatDb || _currentRoom === roomId) return;

  // Detach old listeners
  if (_chatRef) _chatRef.off();
  // Detach DM presence listener
  if (_currentRoom !== 'group') {
    try { _chatDb.ref('dm/' + _currentRoom.replace('dm_','') + '/read').off(); } catch(e) {}
  }

  // Cancel any editing/reply state
  if (_editingKey) cancelEdit();
  if (_replyingTo) cancelReply();
  if (typeof _clearPending === 'function') _clearPending();

  // Save last-seen for current room
  var lsKey = 'travel_chat_seen_' + _currentRoom;
  try { localStorage.setItem(lsKey, Date.now().toString()); } catch(e) {}

  _currentRoom = roomId;
  _lastMsgTs = 0;
  _otherReaders = [];
  _otherReadTs = 0;

  // Set new refs
  if (roomId === 'group') {
    _chatRef     = _chatDb.ref('chat');
    _presenceRef = _globalPresRef;
  } else {
    var fbRoom   = roomId.replace('dm_', '');
    _chatRef     = _chatDb.ref('dm/' + fbRoom + '/messages');
    _presenceRef = _chatDb.ref('dm/' + fbRoom + '/read');
    _listenDmPresence();
  }

  // Clear messages and re-listen
  var list = document.getElementById('chatMessages');
  if (list) {
    list.innerHTML = '';
    if (roomId !== 'group') {
      // Show empty-state placeholder (will be replaced when messages arrive)
      list.innerHTML = '<div class="chat-empty-state" id="chatEmptyState">Начните переписку 💬</div>';
    }
  }
  _listenMessages();
  _writePresence();

  // Clear unread for this room
  _dmUnread[roomId] = 0;

  // Update UI
  _renderRoomTabs();
  _updateRoomHeader();
}

function _updateRoomHeader() {
  var clearBtn = document.getElementById('chatClearBtn');
  if (_currentRoom === 'group') {
    if (clearBtn) clearBtn.style.display = (typeof isAdmin === 'function' && isAdmin()) ? 'inline-flex' : 'none';
  } else {
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

// ── DM: ROOM TABS RENDERING ─────────────────────────────────────────────────
function _renderRoomTabs() {
  var container = document.getElementById('chatRoomTabs');
  if (!container) return;

  var _isAdm = typeof isAdmin === 'function' && isAdmin();

  var html = '';
  // Group tab — always visible
  var groupActive = _currentRoom === 'group' ? ' active' : '';
  var groupUnread = (_dmUnread['group'] || 0) > 0 && _currentRoom !== 'group';
  html += '<button class="chat-room-tab' + groupActive + '" data-room="group" onclick="switchChatRoom(\'group\')">'
       + '💬 Общий' + (groupUnread ? '<span class="room-unread-dot"></span>' : '') + '</button>';

  // DMs — only for admin
  if (_isAdm) {
    // Saved DM rooms (only show admin contacts)
    _savedDmRooms.forEach(function(dm) {
      var contact = _knownContacts.find(function(c) { return c.uid === dm.uid; });
      var role    = contact ? contact.role : (dm.role || 'viewer');
      if (role !== 'admin') return; // skip viewer DMs
      var roomKey = 'dm_' + dm.roomId;
      var active  = _currentRoom === roomKey ? ' active' : '';
      var unread  = (_dmUnread[roomKey] || 0) > 0 && _currentRoom !== roomKey;
      var name    = contact ? contact.name : dm.name;
      html += '<button class="chat-room-tab' + active + '" onclick="switchChatRoom(\'' + roomKey + '\')">'
           + _esc(name) + '<span class="room-role-badge"> ✏</span>'
           + (unread ? '<span class="room-unread-dot"></span>' : '')
           + '</button>';
    });

    // Online admin contacts (deduplicated by name — same person on 2 devices = 1 entry)
    var savedUids = {};
    _savedDmRooms.forEach(function(dm) { savedUids[dm.uid] = true; });
    var recentThreshold = Date.now() - 1800000; // 30 minutes
    var myName = getChatName();
    var bestByName = {}; // name → {uid, ts, ...} — keep most recent per name
    _knownContacts.forEach(function(c) {
      if (savedUids[c.uid]) return;
      if (c.ts < recentThreshold) return;
      if (c.name === '?' || !c.name) return;
      if (c.role !== 'admin') return;
      if (c.name === myName) return; // don't show yourself
      if (!bestByName[c.name] || c.ts > bestByName[c.name].ts) {
        bestByName[c.name] = c;
      }
    });
    Object.values(bestByName).forEach(function(c) {
      html += '<button class="chat-room-tab contact" onclick="openDmWith(\'' + _esc(c.uid) + '\',\'' + _esc(c.name) + '\',\'' + _esc(c.role) + '\')">'
           + '+ ' + _esc(c.name) + '<span class="room-role-badge"> ✏</span></button>';
    });
  }

  container.innerHTML = html;

  // Hide tabs bar for viewers entirely
  container.style.display = _isAdm ? '' : 'none';

  // Long-press on DM tabs to delete (admin only)
  if (_isAdm) {
    container.querySelectorAll('.chat-room-tab[onclick^="switchChatRoom(\'dm_"]').forEach(function(btn) {
      var roomKey = btn.getAttribute('onclick').match(/switchChatRoom\('([^']+)'\)/)?.[1];
      if (!roomKey) return;
      var pressTimer = null;
      btn.addEventListener('contextmenu', function(e) { e.preventDefault(); _confirmDeleteDm(roomKey); });
      btn.addEventListener('touchstart', function() { pressTimer = setTimeout(function() { _confirmDeleteDm(roomKey); }, 600); }, { passive: true });
      btn.addEventListener('touchend', function() { clearTimeout(pressTimer); });
      btn.addEventListener('touchmove', function() { clearTimeout(pressTimer); });
    });
  }
}

function _confirmDeleteDm(roomKey) {
  var dm = _savedDmRooms.find(function(r) { return 'dm_' + r.roomId === roomKey; });
  var name = dm ? dm.name : 'этот чат';
  if (confirm('Удалить переписку с ' + name + '?')) {
    deleteDmRoom(roomKey);
  }
}

// ── DM: BACKGROUND UNREAD TRACKING ──────────────────────────────────────────
function _startDmUnreadListeners() {
  if (!_chatDb) return;
  // Listen to group chat for unread when in DM
  var groupRef = _chatDb.ref('chat');
  groupRef.orderByChild('ts').startAt(Date.now()).on('child_added', function(snap) {
    if (_currentRoom !== 'group') {
      _dmUnread['group'] = (_dmUnread['group'] || 0) + 1;
      _renderRoomTabs();
      if (_chatVisible) _playDing();
    }
  });

  // Listen to saved DM rooms for unread
  _savedDmRooms.forEach(function(dm) {
    _startDmRoomListener(dm.roomId);
  });
}

function _startDmRoomListener(roomId) {
  if (_dmListeners[roomId] || !_chatDb) return;
  var ref = _chatDb.ref('dm/' + roomId + '/messages');
  _dmListeners[roomId] = ref;
  ref.orderByChild('ts').startAt(Date.now()).on('child_added', function(snap) {
    var roomKey = 'dm_' + roomId;
    if (_currentRoom !== roomKey) {
      _dmUnread[roomKey] = (_dmUnread[roomKey] || 0) + 1;
      _renderRoomTabs();
      if (_chatVisible) _playDing();
      var msg = snap.val();
      if (msg) _showNotification(msg.name, msg.text);
    }
  });
}

