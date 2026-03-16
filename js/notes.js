// ── NOTES MODULE ───────────────────────────────────────────────────────────────
// Глобальные заметки → Firebase /notes/{pushId} → {text, author, ts}
// Заметки к точке   → stop.note (строка, в Gist)

let _notesDb     = null;
let _notesRef    = null;
let _notesInited = false;

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
  if (!_notesRef) return;
  _notesRef.on('value', snap => _renderNotesList(snap.val() || {}));
}

function _renderNotesList(data) {
  const list = document.getElementById('notesList');
  if (!list) return;
  list.innerHTML = '';

  const entries = Object.entries(data)
    .map(([k, v]) => ({ key: k, ...v }))
    .sort((a, b) => b.ts - a.ts);

  if (!entries.length) {
    list.innerHTML = '<div class="notes-empty">Заметок пока нет</div>';
    return;
  }

  entries.forEach(entry => {
    const isOwn    = entry.author === (getChatName ? getChatName() : '');
    const canDelete = CLOUD_CONFIG.canWrite || isOwn;
    const date = new Date(entry.ts).toLocaleString('ru', {
      day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
    });

    const item = document.createElement('div');
    item.className = 'note-item';
    item.id = 'note-' + entry.key;
    item.innerHTML = `
      <div class="note-meta">
        <span class="note-author">${_escN(entry.author || 'Аноним')}</span>
        <span class="note-date">${date}</span>
        ${isOwn ? `<button class="note-action-btn" onclick="startEditNote('${entry.key}')" title="Редактировать">✎</button>` : ''}
        ${canDelete ? `<button class="note-action-btn danger" onclick="deleteNote('${entry.key}')" title="Удалить">×</button>` : ''}
      </div>
      <div class="note-text" id="note-text-${entry.key}">${_escN(entry.text).replace(/\n/g,'<br>')}</div>
      <div class="note-edit-wrap" id="note-edit-${entry.key}" style="display:none">
        <textarea class="notes-textarea" id="note-edit-ta-${entry.key}" style="min-height:52px">${_escN(entry.text)}</textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
          <button class="notes-send-btn" style="border-color:var(--muted);color:var(--muted)" onclick="cancelEditNote('${entry.key}')">Отмена</button>
          <button class="notes-send-btn" onclick="commitEditNote('${entry.key}')">Сохранить</button>
        </div>
      </div>`;
    list.appendChild(item);
  });
}

// ── ADD ────────────────────────────────────────────────────────────────────────
function addNote() {
  if (!_notesInited) initNotes();
  const inp  = document.getElementById('noteInput');
  const text = inp ? inp.value.trim() : '';
  if (!text) return;
  const author = (typeof getChatName === 'function' ? getChatName() : '') || 'Аноним';
  if (!author || author === 'Аноним') {
    if (typeof _showNicknameModal === 'function') { _showNicknameModal(() => addNote()); return; }
  }
  _notesRef.push({ text, author, ts: Date.now() });
  inp.value = '';
  inp.style.height = 'auto';
}

function noteInputKeydown(e) {
  if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); addNote(); }
}

// ── EDIT ───────────────────────────────────────────────────────────────────────
function startEditNote(key) {
  document.getElementById('note-text-' + key).style.display = 'none';
  const wrap = document.getElementById('note-edit-' + key);
  if (wrap) { wrap.style.display = 'block'; }
  const ta = document.getElementById('note-edit-ta-' + key);
  if (ta) { autoResizeNote(ta); ta.focus(); }
}

function cancelEditNote(key) {
  document.getElementById('note-text-' + key).style.display = '';
  document.getElementById('note-edit-' + key).style.display = 'none';
}

function commitEditNote(key) {
  const ta = document.getElementById('note-edit-ta-' + key);
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  _notesRef.child(key).update({ text });
}

function deleteNote(key) {
  if (!_notesRef) return;
  _notesRef.child(key).remove();
}

function onNotesTabOpen() { if (!_notesInited) initNotes(); }

// ── STOP NOTES ─────────────────────────────────────────────────────────────────
function saveStopNote(stopId, day) {
  const inp = document.getElementById('stop-note-' + stopId);
  if (!inp) return;
  const s = DAYS_DATA[day]?.stops?.find(x => x.id === stopId);
  if (!s) return;
  s.note = inp.value.trim();
  // Спрятать поле если текст удалён
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

function _escN(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
