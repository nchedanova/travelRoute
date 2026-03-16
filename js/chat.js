// ── CHAT MODULE ────────────────────────────────────────────────────────────────
// Сообщения хранятся в Firebase: /chat/{pushId} → {name, role, text, imgUrl, ts}
// Фото → Firebase Storage: chat-photos/{ts}-{random}
// Никнейм → localStorage: travel_chat_name
// Роль определяется автоматически: canWrite → 'admin', иначе → 'viewer'

let _chatDb        = null;
let _chatStorage   = null;
let _chatRef       = null;
let _chatInited    = false;
let _chatUnread    = 0;
let _chatVisible   = false;
let _lastMsgKey    = null;

// ── INIT ───────────────────────────────────────────────────────────────────────
function initChat() {
  if (_chatInited) return;
  if (typeof firebase === 'undefined' || !firebase.apps.length) {
    console.warn('Chat: Firebase не инициализирован');
    return;
  }
  _chatDb      = firebase.database();
  _chatStorage = firebase.storage ? firebase.storage() : null;
  _chatRef     = _chatDb.ref('chat');
  _chatInited  = true;

  _ensureNickname(() => {
    _listenMessages();
  });
}

// ── NICKNAME ───────────────────────────────────────────────────────────────────
function getChatName()  { return localStorage.getItem('travel_chat_name') || ''; }
function getChatRole()  { return CLOUD_CONFIG.canWrite ? 'admin' : 'viewer'; }
function getRoleBadge() { return CLOUD_CONFIG.canWrite ? '✏' : '👁'; }

function _ensureNickname(cb) {
  if (getChatName()) { cb && cb(); return; }
  _showNicknameModal(cb);
}

function _showNicknameModal(cb) {
  const overlay = document.getElementById('nicknameModal');
  if (!overlay) { cb && cb(); return; }
  overlay.classList.add('show');
  const inp = document.getElementById('nicknameInput');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 120); }

  window._nicknameModalCb = cb;
}

function saveNickname() {
  const inp  = document.getElementById('nicknameInput');
  const name = inp ? inp.value.trim() : '';
  if (!name) { inp && inp.focus(); return; }
  localStorage.setItem('travel_chat_name', name);
  document.getElementById('nicknameModal').classList.remove('show');
  renderChatHeader();
  if (window._nicknameModalCb) { window._nicknameModalCb(); window._nicknameModalCb = null; }
}

function nicknameKeydown(e) {
  if (e.key === 'Enter') saveNickname();
}

// ── LISTEN ─────────────────────────────────────────────────────────────────────
function _listenMessages() {
  if (!_chatRef) return;
  // Грузим последние 200 сообщений
  _chatRef.limitToLast(200).on('child_added', snap => {
    const msg = snap.val();
    if (!msg) return;

    _appendMessage(snap.key, msg);

    if (!_chatVisible) {
      _chatUnread++;
      _updateUnreadBadge();
    }
    _lastMsgKey = snap.key;
  });
}

// ── SEND ───────────────────────────────────────────────────────────────────────
function sendChatMessage() {
  if (!_chatInited) { initChat(); return; }
  const inp  = document.getElementById('chatInput');
  const text = inp ? inp.value.trim() : '';
  if (!text) return;

  const name = getChatName();
  if (!name) { _showNicknameModal(() => sendChatMessage()); return; }

  _chatRef.push({
    name, role: getChatRole(), text,
    ts: Date.now()
  });
  inp.value = '';
  inp.style.height = 'auto';
}

function chatInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

// ── PHOTO UPLOAD ───────────────────────────────────────────────────────────────
function openPhotoUpload() {
  const el = document.getElementById('chatPhotoInput');
  if (el) el.click();
}

async function handlePhotoSelected(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = '';

  if (!_chatStorage) {
    showToast('Firebase Storage недоступен');
    return;
  }
  if (!getChatName()) { _showNicknameModal(() => handlePhotoSelected({ files: [file] })); return; }

  // Превью-плейсхолдер пока грузим
  const tempKey = 'uploading-' + Date.now();
  _appendMessage(tempKey, {
    name: getChatName(), role: getChatRole(),
    text: '', imgUrl: null, uploading: true, ts: Date.now()
  });
  _scrollChatToBottom();

  try {
    const ext  = file.name.split('.').pop() || 'jpg';
    const path = `chat-photos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const ref  = _chatStorage.ref(path);
    await ref.put(file);
    const url  = await ref.getDownloadURL();

    // Удаляем плейсхолдер
    const placeholder = document.getElementById('msg-' + tempKey);
    if (placeholder) placeholder.remove();

    const caption = document.getElementById('chatInput')?.value.trim() || '';

    await _chatRef.push({
      name: getChatName(), role: getChatRole(),
      text: caption, imgUrl: url, ts: Date.now()
    });
    if (caption && document.getElementById('chatInput'))
      document.getElementById('chatInput').value = '';

  } catch (err) {
    console.error('Фото не загружено:', err);
    const placeholder = document.getElementById('msg-' + tempKey);
    if (placeholder) placeholder.remove();
    showToast('Ошибка загрузки фото');
  }
}

// ── RENDER ─────────────────────────────────────────────────────────────────────
function _appendMessage(key, msg) {
  const list = document.getElementById('chatMessages');
  if (!list) return;

  const isMine = (msg.name === getChatName() && msg.role === getChatRole());
  const time   = msg.ts ? new Date(msg.ts).toLocaleTimeString('ru', { hour:'2-digit', minute:'2-digit' }) : '';
  const badge  = msg.role === 'admin' ? '✏' : '👁';

  const wrap = document.createElement('div');
  wrap.id        = 'msg-' + key;
  wrap.className = 'chat-msg ' + (isMine ? 'mine' : 'theirs');

  let inner = '';
  if (!isMine) inner += `<div class="chat-author">${_esc(msg.name)} ${badge}</div>`;

  if (msg.uploading) {
    inner += `<div class="chat-bubble"><span class="chat-uploading">Загрузка фото…</span></div>`;
  } else if (msg.imgUrl) {
    inner += `<div class="chat-bubble chat-bubble-img">
      <img src="${_esc(msg.imgUrl)}" class="chat-photo" onclick="openChatPhoto('${_esc(msg.imgUrl)}')" alt="фото">
      ${msg.text ? `<div class="chat-photo-caption">${_esc(msg.text)}</div>` : ''}
    </div>`;
  } else {
    inner += `<div class="chat-bubble">${_esc(msg.text)}</div>`;
  }

  inner += `<div class="chat-time">${time}</div>`;
  wrap.innerHTML = inner;
  list.appendChild(wrap);
  _scrollChatToBottom();
}

function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function _scrollChatToBottom() {
  const list = document.getElementById('chatMessages');
  if (list) list.scrollTop = list.scrollHeight;
}

function openChatPhoto(url) {
  const ov = document.getElementById('photoViewerOverlay');
  const img = document.getElementById('photoViewerImg');
  if (ov && img) { img.src = url; ov.classList.add('show'); }
}

function closePhotoViewer() {
  const ov = document.getElementById('photoViewerOverlay');
  if (ov) { ov.classList.remove('show'); }
}

// ── UNREAD BADGE ───────────────────────────────────────────────────────────────
function _updateUnreadBadge() {
  const dot = document.getElementById('chatTabDot');
  if (dot) dot.style.display = _chatUnread > 0 ? 'block' : 'none';
}

function onChatTabOpen() {
  _chatVisible = true;
  _chatUnread  = 0;
  _updateUnreadBadge();
  if (!_chatInited) initChat();
  setTimeout(_scrollChatToBottom, 50);
  renderChatHeader();
}

function onChatTabClose() {
  _chatVisible = false;
}

function renderChatHeader() {
  const el = document.getElementById('chatNameDisplay');
  if (!el) return;
  const name = getChatName();
  el.textContent = name ? `${name} ${getRoleBadge()}` : '';
}

function changeChatName() {
  localStorage.removeItem('travel_chat_name');
  _showNicknameModal(() => renderChatHeader());
}
