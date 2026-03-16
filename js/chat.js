// ── CHAT MODULE ────────────────────────────────────────────────────────────────
// Сообщения: Firebase /chat/{pushId} → {name, role, text, imgUrl, ts, edited}
// Фото: Imgur anonymous upload (Client ID из localStorage: travel_imgur_client_id)
// Никнейм: localStorage travel_chat_name

let _chatDb      = null;
let _chatRef     = null;
let _chatInited  = false;
let _chatUnread  = 0;
let _chatVisible = false;
let _chatLoadTs  = 0;

// ── INIT ───────────────────────────────────────────────────────────────────────
function initChat() {
  if (_chatInited) return;
  if (typeof firebase === 'undefined' || !firebase.apps.length) return;
  _chatDb    = firebase.database();
  _chatRef   = _chatDb.ref('chat');
  _chatInited = true;
  _ensureNickname(() => _listenMessages());
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

function nicknameKeydown(e) { if (e.key === 'Enter') saveNickname(); }

// ── LISTEN ─────────────────────────────────────────────────────────────────────
function _listenMessages() {
  if (!_chatRef) return;
  const lastSeen = parseInt(localStorage.getItem('travel_chat_last_seen') || '0');
  _chatLoadTs = Date.now();

  _chatRef.limitToLast(200).on('child_added', snap => {
    const msg = snap.val();
    if (!msg) return;
    _appendMessage(snap.key, msg);
    // Новое только если: чат закрыт + новее last seen + пришло после загрузки страницы
    if (!_chatVisible && msg.ts > lastSeen && msg.ts > _chatLoadTs - 200) {
      _chatUnread++;
      _updateUnreadBadge();
    }
  });

  _chatRef.on('child_removed', snap => {
    document.getElementById('msg-' + snap.key)?.remove();
  });

  _chatRef.on('child_changed', snap => {
    const el = document.getElementById('msg-' + snap.key);
    if (el) { el.remove(); _appendMessage(snap.key, snap.val()); }
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
  _chatRef.push({ name, role: getChatRole(), text, ts: Date.now() });
  inp.value = '';
  inp.style.height = 'auto';
}

function chatInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
}

// ── EDIT / DELETE ──────────────────────────────────────────────────────────────
function startEditMessage(key, currentText) {
  const bubble = document.querySelector('#msg-' + key + ' .chat-bubble');
  if (!bubble) return;
  bubble.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'chat-edit-input';
  ta.value = currentText;
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEditMessage(key, ta.value); }
    if (e.key === 'Escape') { _chatRef.child(key).once('value', s => { const el = document.getElementById('msg-' + key); if (el) { el.remove(); _appendMessage(key, s.val()); } }); }
  };
  bubble.appendChild(ta);
  ta.focus();
  setTimeout(() => { ta.style.height = ta.scrollHeight + 'px'; }, 0);
}

function commitEditMessage(key, newText) {
  const text = (newText || '').trim();
  if (!text) return;
  _chatRef.child(key).update({ text, edited: true });
}

function deleteChatMessage(key) {
  _chatRef.child(key).remove();
}

// ── PHOTO (IMGUR) ──────────────────────────────────────────────────────────────
function getImgurClientId() { return localStorage.getItem('travel_imgur_client_id') || ''; }

function openPhotoUpload() {
  if (!getImgurClientId()) { showToast('Укажи Imgur Client ID в настройках ⚙'); return; }
  document.getElementById('chatPhotoInput')?.click();
}

async function handlePhotoSelected(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = '';
  if (!getChatName()) { _showNicknameModal(() => {}); return; }
  const clientId = getImgurClientId();
  if (!clientId) { showToast('Укажи Imgur Client ID в настройках ⚙'); return; }

  const tempKey = 'uploading-' + Date.now();
  _appendMessage(tempKey, { name: getChatName(), role: getChatRole(), uploading: true, ts: Date.now() });
  _scrollChatToBottom();

  try {
    const fd = new FormData();
    fd.append('image', file);
    const r    = await fetch('https://api.imgur.com/3/image', {
      method: 'POST', headers: { Authorization: 'Client-ID ' + clientId }, body: fd
    });
    const json = await r.json();
    if (!json.success) throw new Error(json.data?.error || 'Imgur ошибка');
    document.getElementById('msg-' + tempKey)?.remove();
    const caption = document.getElementById('chatInput')?.value.trim() || '';
    await _chatRef.push({ name: getChatName(), role: getChatRole(), text: caption, imgUrl: json.data.link, ts: Date.now() });
    if (caption) document.getElementById('chatInput').value = '';
  } catch (err) {
    document.getElementById('msg-' + tempKey)?.remove();
    showToast('Ошибка загрузки: ' + err.message);
  }
}

// ── RENDER ─────────────────────────────────────────────────────────────────────
function _appendMessage(key, msg) {
  const list = document.getElementById('chatMessages');
  if (!list || document.getElementById('msg-' + key)) return;

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
    inner += `<div class="chat-bubble">${_esc(msg.text)}${msg.edited ? '<span class="chat-edited"> (ред.)</span>' : ''}</div>`;
  }

  // actions bar
  let actions = '';
  if (isMine && !msg.uploading) {
    if (!msg.imgUrl) actions += `<button class="chat-action-btn" onclick="startEditMessage('${key}', ${JSON.stringify(msg.text || '')})" title="Редактировать">✎</button>`;
    actions += `<button class="chat-action-btn danger" onclick="deleteChatMessage('${key}')" title="Удалить">×</button>`;
  }

  inner += `<div class="chat-time-row">
    <span class="chat-time">${time}</span>
    ${actions ? '<span class="chat-msg-actions">' + actions + '</span>' : ''}
  </div>`;

  wrap.innerHTML = inner;
  list.appendChild(wrap);
  _scrollChatToBottom();
}

function _esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  document.getElementById('photoViewerOverlay')?.classList.remove('show');
}

// ── UNREAD ─────────────────────────────────────────────────────────────────────
function _updateUnreadBadge() {
  const dot = document.getElementById('chatTabDot');
  if (dot) dot.style.display = _chatUnread > 0 ? 'block' : 'none';
}

function onChatTabOpen() {
  _chatVisible = true;
  _chatUnread  = 0;
  _updateUnreadBadge();
  localStorage.setItem('travel_chat_last_seen', Date.now().toString());
  if (!_chatInited) initChat();
  setTimeout(_scrollChatToBottom, 50);
  renderChatHeader();
}

function onChatTabClose() { _chatVisible = false; }

function renderChatHeader() {
  const el = document.getElementById('chatNameDisplay');
  if (el) el.textContent = getChatName() ? getChatName() + ' ' + getRoleBadge() : '';
}

function changeChatName() {
  localStorage.removeItem('travel_chat_name');
  _showNicknameModal(() => renderChatHeader());
}
