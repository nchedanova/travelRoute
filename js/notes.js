// ── NOTES MODULE ───────────────────────────────────────────────────────────────
// Глобальные заметки → Firebase: /notes (массив записей {id, text, ts, author})
// Заметки к точке   → Gist data: stop.note (строка, сохраняется с маршрутом)

let _notesDb     = null;
let _notesRef    = null;
let _notesInited = false;

// ── INIT ───────────────────────────────────────────────────────────────────────
function initNotes() {
  if (_notesInited) return;
  if (typeof firebase === 'undefined' || !firebase.apps.length) return;

  _notesDb     = firebase.database();
  _notesRef    = _notesDb.ref('notes');
  _notesInited = true;
  _listenNotes();
}

// ── GLOBAL NOTES ───────────────────────────────────────────────────────────────
function _listenNotes() {
  if (!_notesRef) return;
  _notesRef.on('value', snap => {
    const data = snap.val() || {};
    _renderNotesList(data);
  });
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
    const canDelete = CLOUD_CONFIG.canWrite;
    const date = new Date(entry.ts).toLocaleString('ru', {
      day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'
    });
    const item = document.createElement('div');
    item.className = 'note-item';
    item.innerHTML = `
      <div class="note-meta">
        <span class="note-author">${_escNotes(entry.author || 'Аноним')}</span>
        <span class="note-date">${date}</span>
        ${canDelete ? `<button class="note-delete-btn" onclick="deleteNote('${entry.key}')" title="Удалить">×</button>` : ''}
      </div>
      <div class="note-text">${_escNotes(entry.text).replace(/\n/g,'<br>')}</div>
    `;
    list.appendChild(item);
  });
}

function addNote() {
  if (!_notesInited) { initNotes(); }
  const inp  = document.getElementById('noteInput');
  const text = inp ? inp.value.trim() : '';
  if (!text) return;

  const author = getChatName ? getChatName() : (localStorage.getItem('travel_chat_name') || 'Аноним');
  if (!author) {
    _showNicknameModal && _showNicknameModal(() => addNote());
    return;
  }

  _notesRef.push({ text, author, ts: Date.now() });
  inp.value = '';
  inp.style.height = 'auto';
}

function noteInputKeydown(e) {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    addNote();
  }
}

function deleteNote(key) {
  if (!_notesRef || !CLOUD_CONFIG.canWrite) return;
  _notesRef.child(key).remove();
}

function onNotesTabOpen() {
  if (!_notesInited) initNotes();
}

// ── PER-STOP NOTES ─────────────────────────────────────────────────────────────
// Заметка к точке хранится в stop.note (строка)
// Редактировать может только admin; зрители видят только если заметка непустая

function renderStopNote(stopId, day) {
  const s = DAYS_DATA[day]?.stops?.find(x => x.id === stopId);
  if (!s) return '';
  const canEdit = CLOUD_CONFIG.canWrite;
  const note    = s.note || '';

  if (!canEdit && !note) return '';

  return `
    <div class="stop-note-wrap" id="stop-note-wrap-${stopId}">
      ${canEdit
        ? `<textarea class="stop-note-input" id="stop-note-${stopId}"
             placeholder="Заметка к точке…"
             oninput="autoResizeNote(this)"
             onblur="saveStopNote('${stopId}',${day})"
           >${_escNotes(note)}</textarea>`
        : (note ? `<div class="stop-note-readonly">${_escNotes(note).replace(/\n/g,'<br>')}</div>` : '')
      }
    </div>`;
}

function saveStopNote(stopId, day) {
  const inp = document.getElementById('stop-note-' + stopId);
  if (!inp) return;
  const s = DAYS_DATA[day]?.stops?.find(x => x.id === stopId);
  if (!s) return;
  s.note = inp.value;
  saveData();
}

function autoResizeNote(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ── HELPERS ────────────────────────────────────────────────────────────────────
function _escNotes(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
