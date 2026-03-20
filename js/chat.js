// ── CHAT MODULE ────────────────────────────────────────────────────────────────
// Firebase /chat/{id} → {name, role, text, imgUrl, ts, edited, reactions:{emoji:[sids]}}
// Firebase /chat_presence/{sessionId} → timestamp

let _chatDb       = null;
let _chatRef      = null;
let _presenceRef  = null;
let _chatInited   = false;
let _chatUnread   = 0;
let _chatVisible  = false;
let _chatLoadTs   = 0;
let _otherReadTs  = 0;
let _presenceTimer = null;
let _editingKey   = null;   // key сообщения в режиме редактирования
let _replyingTo   = null;   // { key, name, text } — цитируемое сообщение

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
  let id = localStorage.getItem('travel_session_id');
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
  _chatDb      = firebase.database();
  _chatRef     = _chatDb.ref('chat');
  _presenceRef = _chatDb.ref('chat_presence');
  _chatInited  = true;
  _listenPresence();
  _ensureNickname(() => _listenMessages());
  _monitorConnection();
  _monitorVisibility();
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

// ── NICKNAME ───────────────────────────────────────────────────────────────────
function getChatName()  { return localStorage.getItem('travel_chat_name') || ''; }
function getChatRole()  { return (typeof isAdmin === 'function' && isAdmin()) ? 'admin' : 'viewer'; }
function getRoleBadge() { return (typeof isAdmin === 'function' && isAdmin()) ? '✏' : '👁'; }

function _ensureNickname(cb) {
  if (getChatName()) { cb && cb(); return; }
  _showNicknameModal(cb);
}
function _showNicknameModal(cb) {
  const ov = document.getElementById('nicknameModal');
  if (!ov) { cb && cb(); return; }
  ov.classList.add('show');
  const inp = document.getElementById('nicknameInput');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 120); }
  window._nicknameModalCb = cb;
}
function saveNickname() {
  const inp = document.getElementById('nicknameInput');
  const name = inp ? inp.value.trim() : '';
  if (!name) { inp && inp.focus(); return; }
  localStorage.setItem('travel_chat_name', name);
  document.getElementById('nicknameModal').classList.remove('show');
  renderChatHeader();
  if (window._nicknameModalCb) { window._nicknameModalCb(); window._nicknameModalCb = null; }
}
function nicknameKeydown(e) { if (e.key === 'Enter') saveNickname(); }

// ── PRESENCE ───────────────────────────────────────────────────────────────────
function _listenPresence() {
  _presenceRef.on('value', snap => {
    const data = snap.val() || {};
    const myId = getSessionId();
    let maxOther = 0;
    Object.entries(data).forEach(([sid, ts]) => { if (sid !== myId && ts > maxOther) maxOther = ts; });
    _otherReadTs = maxOther;
    document.querySelectorAll('.chat-msg.mine[data-ts]').forEach(el => {
      _updateTicks(el.id.replace('msg-',''), parseInt(el.dataset.ts));
    });
  });
}
function _writePresence() {
  if (_presenceRef) _presenceRef.child(getSessionId()).set(Date.now());
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

// ── PHOTO UPLOAD ──────────────────────────────────────────────────────────────
function triggerPhotoUpload() {
  if (!_chatInited) { initChat(); return; }
  if (!getChatName()) { _showNicknameModal(() => triggerPhotoUpload()); return; }
  let inp = document.getElementById('chatPhotoInput');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.id = 'chatPhotoInput'; inp.style.display = 'none';
    inp.onchange = () => { if (inp.files[0]) _uploadPhoto(inp.files[0]); inp.value = ''; };
    document.body.appendChild(inp);
  }
  inp.click();
}

async function _uploadPhoto(file) {
  if (!navigator.onLine) { showToast('📴 Для фото нужен интернет'); return; }
  const ts = Date.now();
  const pendingKey = 'photo-' + ts;
  _appendMessage(pendingKey, { name: getChatName(), role: getChatRole(), ts, uploading: true });

  try {
    // Сжимаем через canvas → base64 (без Firebase Storage)
    const base64url = await _compressToBase64(file, 800, 0.6);
    const caption = document.getElementById('chatInput')?.value.trim() || '';
    document.getElementById('chatInput').value = '';
    document.getElementById('msg-' + pendingKey)?.remove();
    const ref = _chatRef.push();
    const msgData = { name: getChatName(), role: getChatRole(), text: caption, imgUrl: base64url, ts };
    ref.set(msgData);
  } catch(e) {
    console.error('Photo upload error:', e);
    document.getElementById('msg-' + pendingKey)?.remove();
    showToast('⚠ Ошибка загрузки фото');
  }
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
      if (sizeKB > 200) {
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

  // Position — используем элемент сообщения, а не event target
  const msgEl  = document.getElementById('msg-' + key);
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

  const sid    = getSessionId();
  const isMine = (msg.name === getChatName() && msg.role === getChatRole());
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
  } else if (msg.imgUrl) {
    inner += `<div class="chat-bubble chat-bubble-img">
      <img src="${_esc(msg.imgUrl)}" class="chat-photo" onclick="openChatPhoto('${_esc(msg.imgUrl)}')" alt="фото">
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
  el.classList.add(ts && _otherReadTs >= ts ? 'read' : 'delivered');
}

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

function openChatPhoto(url) {
  const ov = document.getElementById('photoViewerOverlay'), img = document.getElementById('photoViewerImg');
  if (ov && img) { img.src = url; ov.classList.add('show'); }
}
function closePhotoViewer() { document.getElementById('photoViewerOverlay')?.classList.remove('show'); }

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
  if (el) el.textContent = getChatName() ? getChatName() + ' ' + getRoleBadge() : '';
  // Кнопка "Очистить чат" — только для Admin (canWrite)
  const clearBtn = document.getElementById('chatClearBtn');
  if (clearBtn) clearBtn.style.display = (typeof isAdmin === 'function' && isAdmin()) ? 'inline-flex' : 'none';
}
function changeChatName() { localStorage.removeItem('travel_chat_name'); _showNicknameModal(() => renderChatHeader()); }
