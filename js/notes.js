// ── NOTES MODULE ────────────────────────────────────────────────────────────────
// Firebase /notes/{id} → {type, text, items:[{id,text,done}], author, ts}
// Только для админа (canWrite)

const NOTE_TYPES = {
  buy:   { emoji:'🛒', label:'Купить',  color:'#e05c3a' },
  take:  { emoji:'📦', label:'Взять',   color:'#378add' },
  todo:  { emoji:'☑️', label:'Сделать', color:'#1d9e75' },
  other: { emoji:'📝', label:'Другое',  color:null }
};

let _notesDb     = null;
let _notesRef    = null;
let _notesInited = false;
let _notesFilter = 'all';
let _notesData   = {};
let _noteType    = 'other'; // выбранный тип в форме

function initNotes() {
  if (_notesInited) return;
  if (typeof firebase === 'undefined' || !firebase.apps.length) return;
  _notesDb     = firebase.database();
  _notesRef    = _notesDb.ref('notes');
  _notesInited = true;
  _listenNotes();
}

// ── LISTEN ─────────────────────────────────────────────────────────────────────
function _listenNotes() {
  _notesRef.on('value', snap => {
    _notesData = snap.val() || {};
    _renderNotesList();
  });
}

// ── RENDER ─────────────────────────────────────────────────────────────────────
function _renderNotesList() {
  const list = document.getElementById('notesList');
  if (!list) return;
  list.innerHTML = '';

  const entries = Object.entries(_notesData)
    .map(([k,v]) => ({key:k,...v}))
    .sort((a,b) => b.ts - a.ts)
    .filter(e => _notesFilter === 'all' || e.type === _notesFilter);

  if (!entries.length) {
    list.innerHTML = '<div class="notes-empty">' + (_notesFilter === 'all' ? 'Заметок пока нет' : 'Нет заметок этого типа') + '</div>';
    return;
  }

  entries.forEach(entry => {
    const t    = NOTE_TYPES[entry.type] || NOTE_TYPES.other;
    const date = new Date(entry.ts).toLocaleString('ru',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    const hasItems = entry.type !== 'other' && entry.items && entry.items.length;
    const borderColor = t.color || 'var(--border)';

    const item = document.createElement('div');
    item.className = 'note-item';
    item.id = 'note-' + entry.key;
    item.style.borderLeftColor = borderColor;

    let itemsHtml = '';
    if (hasItems) {
      itemsHtml = '<div class="note-checklist" id="note-checklist-' + entry.key + '">' +
        entry.items.map(it => `
          <label class="note-check-row">
            <input type="checkbox" ${it.done?'checked':''} onchange="toggleNoteItem('${entry.key}','${it.id}',this.checked)" style="accent-color:var(--amber)">
            <span class="${it.done?'note-item-done':''}">${_escN(it.text)}</span>
          </label>`).join('') +
        '</div>';
    } else if (entry.type === 'other') {
      itemsHtml = `<div class="note-text" id="note-text-${entry.key}">${_escN(entry.text||'').replace(/\n/g,'<br>')}</div>`;
    }

    item.innerHTML = `
      <div class="note-meta">
        <span class="note-type-badge">${t.emoji} ${t.label}</span>
        <span class="note-date">${date}</span>
        <button class="note-action-btn" onclick="startEditNote('${entry.key}')" title="Редактировать">✎</button>
        <button class="note-action-btn danger" onclick="deleteNote('${entry.key}')" title="Удалить">×</button>
      </div>
      ${itemsHtml}
      <div class="note-edit-wrap" id="note-edit-${entry.key}" style="display:none">
        <textarea class="notes-textarea" id="note-edit-ta-${entry.key}" style="min-height:52px">${_escN(entry.type==='other' ? (entry.text||'') : (entry.items||[]).map(i=>i.text).join('\n'))}</textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
          <button class="notes-send-btn" style="border-color:var(--muted);color:var(--muted)" onclick="cancelEditNote('${entry.key}')">Отмена</button>
          <button class="notes-send-btn" onclick="commitEditNote('${entry.key}')">Сохранить</button>
        </div>
      </div>`;
    list.appendChild(item);
  });
}

// ── FILTER ─────────────────────────────────────────────────────────────────────
function setNotesFilter(type) {
  _notesFilter = type;
  document.querySelectorAll('.notes-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  _renderNotesList();
}

// ── ADD ────────────────────────────────────────────────────────────────────────
function setNoteType(type) {
  _noteType = type;
  document.querySelectorAll('.note-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  const inp = document.getElementById('noteInput');
  if (inp) inp.placeholder = type === 'other'
    ? 'Текст заметки…'
    : 'Каждая строка — отдельный пункт списка…';
}

function addNote() {
  if (!_notesInited) initNotes();
  const inp  = document.getElementById('noteInput');
  const text = inp ? inp.value.trim() : '';
  if (!text) return;
  const author = (typeof getChatName === 'function' ? getChatName() : '') || 'Админ';

  let payload = { type: _noteType, author, ts: Date.now() };

  if (_noteType === 'other') {
    payload.text = text;
  } else {
    payload.items = text.split('\n').filter(l=>l.trim()).map(l => ({
      id: Math.random().toString(36).slice(2),
      text: l.trim(),
      done: false
    }));
    if (!payload.items.length) return;
  }

  _notesRef.push(payload);
  inp.value = ''; inp.style.height = 'auto';
}

function noteInputKeydown(e) {
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); addNote(); }
}

// ── CHECKBOX TOGGLE ────────────────────────────────────────────────────────────
function toggleNoteItem(noteKey, itemId, done) {
  const entry = _notesData[noteKey]; if (!entry || !entry.items) return;
  const items = entry.items.map(i => i.id === itemId ? {...i, done} : i);
  _notesRef.child(noteKey).update({ items });
}

// ── EDIT ───────────────────────────────────────────────────────────────────────
function startEditNote(key) {
  const entry = _notesData[key]; if (!entry) return;
  const textWrap = document.getElementById('note-text-' + key);
  const checklist = document.getElementById('note-checklist-' + key);
  if (textWrap)   textWrap.style.display = 'none';
  if (checklist)  checklist.style.display = 'none';
  const wrap = document.getElementById('note-edit-' + key);
  if (wrap) wrap.style.display = 'block';
  const ta = document.getElementById('note-edit-ta-' + key);
  if (ta) { autoResizeNote(ta); ta.focus(); }
}

function cancelEditNote(key) {
  const textWrap  = document.getElementById('note-text-' + key);
  const checklist = document.getElementById('note-checklist-' + key);
  if (textWrap)  textWrap.style.display = '';
  if (checklist) checklist.style.display = '';
  const wrap = document.getElementById('note-edit-' + key);
  if (wrap) wrap.style.display = 'none';
}

function commitEditNote(key) {
  const ta    = document.getElementById('note-edit-ta-' + key); if (!ta) return;
  const text  = ta.value.trim(); if (!text) return;
  const entry = _notesData[key]; if (!entry) return;

  if (entry.type === 'other') {
    _notesRef.child(key).update({ text });
  } else {
    const items = text.split('\n').filter(l=>l.trim()).map((l,i) => {
      const old = entry.items && entry.items[i];
      return { id: (old && old.id) || Math.random().toString(36).slice(2), text: l.trim(), done: (old && old.done) || false };
    });
    _notesRef.child(key).update({ items });
  }
}

function deleteNote(key) {
  if (!_notesRef) return;
  _notesRef.child(key).remove();
}

function onNotesTabOpen() { if (!_notesInited) initNotes(); }

// ── STOP NOTES (admin only) ────────────────────────────────────────────────────
function saveStopNote(stopId, day) {
  const inp = document.getElementById('stop-note-' + stopId); if (!inp) return;
  const s   = DAYS_DATA[day]?.stops?.find(x => x.id === stopId); if (!s) return;
  s.note = inp.value.trim();
  if (!s.note) {
    const wrap = document.getElementById('stop-note-wrap-' + stopId);
    if (wrap) wrap.style.display = 'none';
  }
  saveData();
}

function autoResizeNote(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function _escN(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
