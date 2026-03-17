// ── CHAT MODULE ────────────────────────────────────────────────────────────────
// Firebase /chat/{id}       → {name, role, text, imgUrl, ts, edited, reactions:{emoji:[sessionIds]}}
// Firebase /chat_presence/{sessionId} → timestamp (для статуса "прочитано")
// Фото: Imgur API (Client ID в localStorage: travel_imgur_client_id)

let _chatDb       = null;
let _chatRef      = null;
let _presenceRef  = null;
let _chatInited   = false;
let _chatUnread   = 0;
let _chatVisible  = false;
let _chatLoadTs   = 0;
let _otherReadTs  = 0;   // max ts когда кто-то ещё открывал чат
let _presenceTimer = null;

const REACTIONS = ['❤️','😂','😮','😢','👍','👎'];
const EMOJI_LIST = [
  '😀','😂','🥰','😍','🤩','😎','🥳','😇','🤔','😅',
  '😭','😤','🤯','😱','🥺','😴','🤗','😏','🙄','😬',
  '👍','👎','👏','🙏','💪','✌️','🤝','❤️','🔥','✨',
  '🎉','🎊','🏆','⭐','💯','🚗','📍','⛽','🍕','☕',
  '🌅','🏖','🏔','🌄','🛣','🗺','📸','🎶','😆','🤣'
];

// ── SESSION ID ─────────────────────────────────────────────────────────────────
function getSessionId() {
  let id = localStorage.getItem('travel_session_id');
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('travel_session_id', id); }
  return id;
}

// ── INIT ───────────────────────────────────────────────────────────────────────
function initChat() {
  if (_chatInited) return;
  if (typeof firebase === 'undefined' || !firebase.apps.length) return;
  _chatDb      = firebase.database();
  _chatRef     = _chatDb.ref('chat');
  _presenceRef = _chatDb.ref('chat_presence');
  _chatInited  = true;
  _listenPresence();
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
  const ov = document.getElementById('nicknameModal');
  if (!ov) { cb && cb(); return; }
  ov.classList.add('show');
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

// ── PRESENCE ───────────────────────────────────────────────────────────────────
function _listenPresence() {
  _presenceRef.on('value', snap => {
    const data = snap.val() || {};
    const myId = getSessionId();
    let maxOther = 0;
    Object.entries(data).forEach(([sid, ts]) => {
      if (sid !== myId && ts > maxOther) maxOther = ts;
    });
    _otherReadTs = maxOther;
    // Update tick status on visible messages
    document.querySelectorAll('.chat-msg.mine').forEach(el => {
      const ts = parseInt(el.dataset.ts || '0');
      _updateTicks(el.id.replace('msg-',''), ts);
    });
  });
}

function _writePresence() {
  if (!_presenceRef) return;
  _presenceRef.child(getSessionId()).set(Date.now());
}

// ── LISTEN MESSAGES ────────────────────────────────────────────────────────────
function _listenMessages() {
  if (!_chatRef) return;
  const lastSeen = parseInt(localStorage.getItem('travel_chat_last_seen') || '0');
  _chatLoadTs = Date.now();

  _chatRef.limitToLast(200).on('child_added', snap => {
    const msg = snap.val(); if (!msg) return;
    _appendMessage(snap.key, msg);
    if (!_chatVisible && msg.ts > lastSeen && msg.ts > _chatLoadTs - 200) {
      _chatUnread++; _updateUnreadBadge();
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
  const inp  = document.getElementById('chatInput');
  const text = inp ? inp.value.trim() : '';
  if (!text) return;
  if (!getChatName()) { _showNicknameModal(() => sendChatMessage()); return; }
  const ref = _chatRef.push();
  // Optimistic: show ✓ immediately
  const ts = Date.now();
  _appendMessage(ref.key, { name: getChatName(), role: getChatRole(), text, ts, _pending: true });
  ref.set({ name: getChatName(), role: getChatRole(), text, ts }).then(() => {
    const el = document.getElementById('msg-' + ref.key);
    if (el) el.querySelector('.chat-ticks')?.classList.remove('pending');
  });
  inp.value = ''; inp.style.height = 'auto';
  closeEmojiPicker();
}

function chatInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
}

// ── EDIT / DELETE ──────────────────────────────────────────────────────────────
function startEditMessage(key) {
  closeMsgMenu();
  const el = document.getElementById('msg-' + key);
  if (!el) return;
  const bubble = el.querySelector('.chat-bubble');
  if (!bubble) return;
  const currentText = bubble.dataset.text || '';
  bubble.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'chat-edit-input';
  ta.value = currentText;
  ta.oninput = () => { ta.style.height='auto'; ta.style.height=ta.scrollHeight+'px'; };
  ta.onkeydown = e2 => {
    if (e2.key === 'Enter' && !e2.shiftKey) { e2.preventDefault(); _commitEdit(key, ta.value); }
    if (e2.key === 'Escape') { _chatRef.child(key).once('value', s => { const ex=document.getElementById('msg-'+key); if(ex){ex.remove();} _appendMessage(key,s.val()); }); }
  };
  bubble.appendChild(ta);
  setTimeout(() => { ta.style.height=ta.scrollHeight+'px'; ta.focus(); }, 0);
}

function _commitEdit(key, newText) {
  const t = (newText||'').trim(); if (!t) return;
  _chatRef.child(key).update({ text: t, edited: true });
}

function deleteChatMessage(key) {
  closeMsgMenu(); _chatRef.child(key).remove();
}

// ── REACTIONS ─────────────────────────────────────────────────────────────────
function toggleReaction(key, emoji) {
  closeMsgMenu();
  const sid = getSessionId();
  _chatRef.child(key).once('value', snap => {
    const msg = snap.val() || {};
    const reactions = msg.reactions ? JSON.parse(JSON.stringify(msg.reactions)) : {};
    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(sid);
    if (idx >= 0) { reactions[emoji].splice(idx,1); if (!reactions[emoji].length) delete reactions[emoji]; }
    else reactions[emoji].push(sid);
    _chatRef.child(key).update({ reactions });
  });
}

// Double click / double tap → ❤️
function handleMsgDblClick(key) {
  toggleReaction(key, '❤️');
}

// ── MESSAGE CONTEXT MENU ───────────────────────────────────────────────────────
let _menuKey = null, _menuIsMine = false;

function openMsgMenu(e, key, isMine) {
  e.preventDefault(); e.stopPropagation();
  closeMsgMenu();
  _menuKey = key; _menuIsMine = isMine;

  const menu = document.getElementById('chatMsgMenu');
  if (!menu) return;

  // Build reaction buttons
  const reactionRow = menu.querySelector('.msg-menu-reactions');
  reactionRow.innerHTML = REACTIONS.map(em =>
    `<button class="msg-menu-emoji" onclick="toggleReaction('${key}','${em}')">${em}</button>`
  ).join('');

  // Show/hide edit+delete
  menu.querySelector('.msg-menu-actions').style.display = isMine ? 'flex' : 'none';
  if (isMine) {
    menu.querySelector('.msg-menu-edit').onclick  = () => startEditMessage(key);
    menu.querySelector('.msg-menu-delete').onclick = () => deleteChatMessage(key);
  }

  // Position near the element
  const rect = e.currentTarget ? e.currentTarget.getBoundingClientRect() : e.target.getBoundingClientRect();
  const sidebar = document.getElementById('sidebar');
  const sbRect  = sidebar.getBoundingClientRect();
  menu.style.display = 'block';
  let top  = rect.top - sbRect.top - menu.offsetHeight - 6;
  let left = isMine ? rect.right - sbRect.left - menu.offsetWidth : rect.left - sbRect.left;
  if (top < 4) top = rect.bottom - sbRect.top + 6;
  left = Math.max(4, Math.min(left, sbRect.width - menu.offsetWidth - 4));
  menu.style.top  = top + 'px';
  menu.style.left = left + 'px';
}

function closeMsgMenu() {
  const menu = document.getElementById('chatMsgMenu');
  if (menu) menu.style.display = 'none';
  _menuKey = null;
}

// ── PHOTO (IMGUR) ──────────────────────────────────────────────────────────────
function getImgurClientId() { return localStorage.getItem('travel_imgur_client_id') || ''; }

function openPhotoUpload() {
  if (!getImgurClientId()) { showToast('Укажи Imgur Client ID в настройках ⚙'); return; }
  document.getElementById('chatPhotoInput')?.click();
}

async function handlePhotoSelected(input) {
  const file = input.files && input.files[0]; if (!file) return; input.value='';
  if (!getChatName()) { _showNicknameModal(() => {}); return; }
  const clientId = getImgurClientId();
  if (!clientId) { showToast('Укажи Imgur Client ID в настройках ⚙'); return; }
  const tempKey = 'uploading-' + Date.now();
  _appendMessage(tempKey, { name:getChatName(), role:getChatRole(), uploading:true, ts:Date.now() });
  _scrollToBottom();
  try {
    const fd = new FormData(); fd.append('image', file);
    const r    = await fetch('https://api.imgur.com/3/image', { method:'POST', headers:{ Authorization:'Client-ID '+clientId }, body:fd });
    const json = await r.json();
    if (!json.success) throw new Error(json.data?.error || 'Imgur ошибка');
    document.getElementById('msg-'+tempKey)?.remove();
    const caption = document.getElementById('chatInput')?.value.trim() || '';
    await _chatRef.push({ name:getChatName(), role:getChatRole(), text:caption, imgUrl:json.data.link, ts:Date.now() });
    if (caption) document.getElementById('chatInput').value = '';
  } catch(err) { document.getElementById('msg-'+tempKey)?.remove(); showToast('Ошибка: '+err.message); }
}

// ── EMOJI PICKER ───────────────────────────────────────────────────────────────
function toggleEmojiPicker() {
  const picker = document.getElementById('emojiPicker');
  if (!picker) return;
  const visible = picker.style.display !== 'none';
  if (visible) { picker.style.display='none'; return; }
  if (!picker.dataset.built) {
    picker.innerHTML = EMOJI_LIST.map(e => `<button class="emoji-pick-btn" onclick="insertEmoji('${e}')">${e}</button>`).join('');
    picker.dataset.built = '1';
  }
  picker.style.display = 'grid';
}

function closeEmojiPicker() {
  const p = document.getElementById('emojiPicker'); if (p) p.style.display='none';
}

function insertEmoji(e) {
  const inp = document.getElementById('chatInput'); if (!inp) return;
  const pos = inp.selectionStart || inp.value.length;
  inp.value = inp.value.slice(0,pos) + e + inp.value.slice(pos);
  inp.focus(); inp.selectionStart = inp.selectionEnd = pos + e.length;
}

// ── RENDER ─────────────────────────────────────────────────────────────────────
function _appendMessage(key, msg) { _appendMessageAt(key, msg, null); }

function _appendMessageAt(key, msg, beforeNode) {
  const list = document.getElementById('chatMessages');
  if (!list || document.getElementById('msg-'+key)) return;

  const sid    = getSessionId();
  const isMine = (msg.name === getChatName() && msg.role === getChatRole());
  const time   = msg.ts ? new Date(msg.ts).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'}) : '';
  const badge  = msg.role === 'admin' ? '✏' : '👁';

  const wrap = document.createElement('div');
  wrap.id          = 'msg-' + key;
  wrap.className   = 'chat-msg ' + (isMine ? 'mine' : 'theirs');
  wrap.dataset.ts  = msg.ts || 0;

  // Double-tap / double-click → ❤️
  let tapTimer = null, tapCount = 0;
  wrap.addEventListener('click', e => {
    if (e.target.closest('button,a,textarea,img')) return;
    tapCount++;
    if (tapCount === 1) tapTimer = setTimeout(() => { tapCount=0; }, 350);
    if (tapCount === 2) { clearTimeout(tapTimer); tapCount=0; handleMsgDblClick(key); }
  });

  // Long press / right-click → context menu
  let pressTimer = null;
  wrap.addEventListener('contextmenu', e => { openMsgMenu(e, key, isMine); });
  wrap.addEventListener('touchstart',  e => { pressTimer = setTimeout(() => openMsgMenu(e.touches[0], key, isMine), 500); }, {passive:true});
  wrap.addEventListener('touchend',    () => clearTimeout(pressTimer));
  wrap.addEventListener('touchmove',   () => clearTimeout(pressTimer));

  let inner = '';
  if (!isMine) inner += `<div class="chat-author">${_esc(msg.name)} ${badge}</div>`;

  if (msg.uploading) {
    inner += `<div class="chat-bubble"><span class="chat-uploading">Загрузка фото…</span></div>`;
  } else if (msg.imgUrl) {
    inner += `<div class="chat-bubble chat-bubble-img" data-text="">
      <img src="${_esc(msg.imgUrl)}" class="chat-photo" onclick="openChatPhoto('${_esc(msg.imgUrl)}')" alt="фото">
      ${msg.text ? `<div class="chat-photo-caption">${_esc(msg.text)}</div>` : ''}
    </div>`;
  } else {
    inner += `<div class="chat-bubble" data-text="${_esc(msg.text||'')}">${_esc(msg.text||'')}${msg.edited ? '<span class="chat-edited"> (ред.)</span>' : ''}</div>`;
  }

  // Reactions
  inner += _renderReactions(key, msg.reactions||{}, sid);

  // Time + ticks
  inner += `<div class="chat-time-row">
    <span class="chat-time">${time}</span>
    ${isMine && !msg.uploading ? `<span class="chat-ticks ${msg._pending?'pending':''}" id="ticks-${key}">✓✓</span>` : ''}
  </div>`;

  wrap.innerHTML = inner;
  if (beforeNode) list.insertBefore(wrap, beforeNode);
  else list.appendChild(wrap);

  if (isMine) _updateTicks(key, msg.ts);
  _scrollToBottom();
}

function _renderReactions(key, reactions, sid) {
  const entries = Object.entries(reactions);
  if (!entries.length) return `<div class="chat-reactions" id="reactions-${key}"></div>`;
  const btns = entries.map(([em, sids]) => {
    const active = sids.includes(sid) ? ' active' : '';
    return `<button class="reaction-btn${active}" onclick="toggleReaction('${key}','${em}')">${em} ${sids.length}</button>`;
  }).join('');
  return `<div class="chat-reactions" id="reactions-${key}">${btns}</div>`;
}

function _updateTicks(key, ts) {
  const el = document.getElementById('ticks-' + key);
  if (!el) return;
  el.classList.remove('pending','delivered','read');
  if (ts && _otherReadTs >= ts) { el.textContent='✓✓'; el.classList.add('read'); }
  else { el.textContent='✓✓'; el.classList.add('delivered'); }
}

function _esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _scrollToBottom() {
  const l = document.getElementById('chatMessages'); if (l) l.scrollTop = l.scrollHeight;
}

// ── PHOTO VIEWER ───────────────────────────────────────────────────────────────
function openChatPhoto(url) {
  const ov=document.getElementById('photoViewerOverlay'), img=document.getElementById('photoViewerImg');
  if (ov&&img) { img.src=url; ov.classList.add('show'); }
}
function closePhotoViewer() { document.getElementById('photoViewerOverlay')?.classList.remove('show'); }

// ── UNREAD BADGE ───────────────────────────────────────────────────────────────
function _updateUnreadBadge() {
  const dot = document.getElementById('chatTabDot');
  if (dot) dot.style.display = _chatUnread > 0 ? 'block' : 'none';
}

function onChatTabOpen() {
  _chatVisible = true; _chatUnread = 0; _updateUnreadBadge();
  localStorage.setItem('travel_chat_last_seen', Date.now().toString());
  _writePresence();
  clearInterval(_presenceTimer);
  _presenceTimer = setInterval(_writePresence, 30000);
  if (!_chatInited) initChat();
  setTimeout(_scrollToBottom, 50);
  renderChatHeader();
}

function onChatTabClose() {
  _chatVisible = false;
  clearInterval(_presenceTimer);
}

function renderChatHeader() {
  const el = document.getElementById('chatNameDisplay');
  if (el) el.textContent = getChatName() ? getChatName()+' '+getRoleBadge() : '';
}

function changeChatName() {
  localStorage.removeItem('travel_chat_name');
  _showNicknameModal(() => renderChatHeader());
}
