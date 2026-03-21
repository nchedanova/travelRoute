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

  // ── ДЕМО-РЕЖИМ: заметки в localStorage ───────────────────────────────────
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    _notesInited = true;
    _loadDemoNotes();
    return;
  }

  if (typeof firebase === 'undefined' || !firebase.apps.length) return;
  _notesDb     = firebase.database();
  _notesRef    = _notesDb.ref('notes');
  _notesInited = true;
  _listenNotes();
}

// ── DEMO NOTES (localStorage) ─────────────────────────────────────────────
function _isDemoNotes() { return _notesInited && !_notesRef; }

function _loadDemoNotes() {
  try {
    _notesData = JSON.parse(localStorage.getItem('travel_demo_notes') || '{}');
  } catch { _notesData = {}; }
  _renderNotesList();
}

function _saveDemoNotes() {
  localStorage.setItem('travel_demo_notes', JSON.stringify(_notesData));
  _renderNotesList();
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
          <label class="note-check-row" onclick="if(event.target.tagName==='A')event.preventDefault()">
            <input type="checkbox" ${it.done?'checked':''} onchange="toggleNoteItem('${entry.key}','${it.id}',this.checked)" style="accent-color:var(--amber)">
            <span class="${it.done?'note-item-done':''}">${_linkifyN(it.text)}</span>
          </label>`).join('') +
        '</div>';
    } else if (entry.type === 'other') {
      itemsHtml = `<div class="note-text" id="note-text-${entry.key}">${_linkifyN(entry.text||'').replace(/\n/g,'<br>')}</div>`;
    }

    item.innerHTML = `
      <div class="note-meta">
        <span class="note-type-badge">${t.emoji} ${t.label}</span>
        <span class="note-date">${date}</span>
        <button class="note-action-btn" onclick="startEditNote('${entry.key}')" title="Редактировать">✎</button>
        <button class="note-action-btn danger" onclick="deleteNote('${entry.key}')" title="Удалить">×</button>
      </div>
      ${itemsHtml}
`;
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
    const isActive = b.dataset.type === type;
    b.classList.toggle('active', isActive);
  });
  const inp = document.getElementById('noteInput');
  if (inp) inp.placeholder = type === 'other'
    ? 'Текст заметки…'
    : 'Каждая строка — отдельный пункт списка…';
}

function addNote() {
  // If editing — commit the edit
  if (_editingNoteKey) { commitEditNote(_editingNoteKey); return; }

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

  if (_isDemoNotes()) { _demoAddNote(payload); } else { _notesRef.push(payload); }
  inp.value = ''; inp.style.height = 'auto';
}

// Demo-mode addNote fallback
function _demoAddNote(payload) {
  const key = 'd' + Date.now().toString(36);
  _notesData[key] = payload;
  _saveDemoNotes();
}

function noteInputKeydown(e) {
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); addNote(); }
}

// ── CHECKBOX TOGGLE ────────────────────────────────────────────────────────────
function toggleNoteItem(noteKey, itemId, done) {
  const entry = _notesData[noteKey]; if (!entry || !entry.items) return;
  const items = entry.items.map(i => i.id === itemId ? {...i, done} : i);
  if (_isDemoNotes()) { _notesData[noteKey].items = items; _saveDemoNotes(); }
  else { _notesRef.child(noteKey).update({ items }); }
}

// ── EDIT (Telegram-style) ─────────────────────────────────────────────────────
let _editingNoteKey = null;

function startEditNote(key) {
  const entry = _notesData[key]; if (!entry) return;
  _editingNoteKey = key;

  // Fill input with current content
  const inp = document.getElementById('noteInput');
  if (inp) {
    if (entry.type === 'other') {
      inp.value = entry.text || '';
    } else {
      inp.value = (entry.items || []).map(i => i.text).join('\n');
    }
    autoResizeNote(inp);
    inp.focus();
  }

  // Set type
  setNoteType(entry.type || 'other');

  // Show banner
  const banner = document.getElementById('noteEditBanner');
  if (banner) banner.style.display = 'flex';
  const preview = document.getElementById('noteEditPreview');
  if (preview) {
    const txt = entry.type === 'other' ? (entry.text||'') : (entry.items||[]).map(i=>i.text).join(', ');
    preview.textContent = txt.slice(0, 50);
  }

  // Change + btn to checkmark
  const btn = document.getElementById('noteAddBtn');
  if (btn) { btn.textContent = '✓'; btn.style.background = 'rgba(245,166,35,0.2)'; btn.style.borderColor = 'var(--amber)'; btn.style.color = 'var(--amber)'; }
}

function cancelEditNote() {
  _editingNoteKey = null;
  const inp = document.getElementById('noteInput');
  if (inp) { inp.value = ''; inp.style.height = 'auto'; }
  const banner = document.getElementById('noteEditBanner');
  if (banner) banner.style.display = 'none';
  const btn = document.getElementById('noteAddBtn');
  if (btn) { btn.textContent = '+'; btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = ''; }
}

function commitEditNote(key) {
  const inp  = document.getElementById('noteInput'); if (!inp) return;
  const text = inp.value.trim(); if (!text) return;
  const entry = _notesData[key]; if (!entry) return;

  if (entry.type === 'other') {
    if (_isDemoNotes()) { _notesData[key].text = text; _saveDemoNotes(); }
    else { _notesRef.child(key).update({ text }); }
  } else {
    const items = text.split('\n').filter(l=>l.trim()).map((l,i) => {
      const oldItem = entry.items && entry.items[i];
      return { id: (oldItem && oldItem.id) || Math.random().toString(36).slice(2), text: l.trim(), done: (oldItem && oldItem.done) || false };
    });
    if (_isDemoNotes()) { _notesData[key].items = items; _saveDemoNotes(); }
    else { _notesRef.child(key).update({ items }); }
  }
  cancelEditNote();
}

let _deleteNoteKey = null;

function deleteNote(key) {
  _deleteNoteKey = key;
  document.getElementById('deleteNoteModal')?.classList.add('show');
}
function closeDeleteNoteModal() {
  _deleteNoteKey = null;
  document.getElementById('deleteNoteModal')?.classList.remove('show');
}
function doDeleteNote() {
  if (!_deleteNoteKey) return;
  if (_isDemoNotes()) { delete _notesData[_deleteNoteKey]; _saveDemoNotes(); }
  else if (_notesRef) { _notesRef.child(_deleteNoteKey).remove(); }
  closeDeleteNoteModal();
}

function onNotesTabOpen() { if (!_notesInited) initNotes(); }

// ── STOP NOTES (admin only) ────────────────────────────────────────────────────
function saveStopNote(stopId, day) {
  // В демо-режиме — сохраняем локально
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    saveStopNoteDemo(stopId, day); return;
  }
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

function updateStopNotePreview(stopId) {
  var ta = document.getElementById('stop-note-' + stopId);
  var preview = document.getElementById('stop-note-preview-' + stopId);
  if (!ta || !preview) return;
  var text = ta.value.trim();
  var row = ta.closest('.stop-note-input-row');
  if (text) {
    preview.innerHTML = _linkifyN(text).replace(/\n/g, '<br>');
    preview.style.display = 'block';
    if (row) row.style.display = 'none';
  } else {
    preview.style.display = 'none';
    if (row) row.style.display = '';
  }
}

function _escN(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Делает URL кликабельными в тексте заметок
function _linkifyN(s) {
  if (!s) return '';
  return _escN(s).replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="note-link" onclick="event.stopPropagation()">$1</a>'
  );
}

// ── STOP NOTE DEMO SUPPORT ────────────────────────────────────────────────────
// В демо-режиме заметки к точкам хранятся в DAYS_DATA и localStorage

function saveStopNoteDemo(stopId, day) {
  const inp = document.getElementById('stop-note-' + stopId);
  const d   = DAYS_DATA[day]; if (!d) return;
  const s   = (d.stops || []).find(x => x.id === stopId); if (!s) return;
  s.note = inp ? inp.value.trim() : '';
  // Скрыть wrap если заметка пустая и нет фокуса
  if (!s.note) {
    const wrap = document.getElementById('stop-note-wrap-' + stopId);
    if (wrap) wrap.style.display = 'none';
  }
  // Сохраняем в localStorage для демо
  try {
    const stored = JSON.parse(localStorage.getItem('travel_demo_stop_notes') || '{}');
    stored[stopId] = s.note;
    localStorage.setItem('travel_demo_stop_notes', JSON.stringify(stored));
  } catch(e) {}
}

function loadDemoStopNotes() {
  try {
    const stored = JSON.parse(localStorage.getItem('travel_demo_stop_notes') || '{}');
    Object.entries(stored).forEach(([stopId, note]) => {
      // Найти точку во всех днях
      Object.keys(DAYS_DATA).forEach(day => {
        const s = (DAYS_DATA[day].stops || []).find(x => x.id === stopId);
        if (s) s.note = note;
      });
    });
  } catch(e) {}
}


// ✓ кнопка в заметке точки — сохранить заметку
function saveStopNoteBtn(stopId, day) {
  saveStopNote(stopId, day);
  const btn = document.querySelector('[data-note-save="' + stopId + '"]');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.style.color = 'var(--green, #34d399)';
    btn.style.borderColor = 'var(--green, #34d399)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.style.borderColor = ''; }, 1200);
  }
  typeof showToast === 'function' && showToast('💾 Сохранено');
}

