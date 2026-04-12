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
  // Резолвим fb: ссылки на уже отрендеренных карточках (Firebase теперь готов)
  if (typeof _resolveAllNoteImgs === 'function') _resolveAllNoteImgs();
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
        <button class="note-action-btn" onclick="startEditNote('${entry.key}')" title="Редактировать">✏️</button>
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

async function addNote() {
  // If editing — commit the edit
  if (_editingNoteKey) { commitEditNote(_editingNoteKey); return; }

  if (!_notesInited) initNotes();
  const inp  = document.getElementById('noteInput');
  const text = inp ? inp.value.trim() : '';
  const hasImages = typeof _noteTabPendingImages !== 'undefined' && _noteTabPendingImages.length > 0;
  if (!text && !hasImages) return;
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
    if (!payload.items.length && !hasImages) return;
  }

  if (hasImages) {
    var uploaded = await Promise.all(_noteTabPendingImages.map(_uploadNoteImg));
    payload.images = uploaded;
    _noteTabPendingImages = [];
    if (typeof _renderNoteTabPending === 'function') _renderNoteTabPending();
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
  // Чистим фото из Firebase перед удалением
  var entry = _notesData[_deleteNoteKey];
  if (entry && entry.images) entry.images.forEach(_deleteNoteImg);
  if (_isDemoNotes()) { delete _notesData[_deleteNoteKey]; _saveDemoNotes(); }
  else if (_notesRef) { _notesRef.child(_deleteNoteKey).remove(); }
  closeDeleteNoteModal();
}

function onNotesTabOpen() { if (!_notesInited) initNotes(); }

// ── NOTE IMAGE FIREBASE HELPERS ───────────────────────────────────────────────
// _noteImgTag и _resolveImgsInEl/_resolveAllNoteImgs определены в render.js.
// Здесь только Firebase-специфичная часть: кэш, upload, download, delete.

var _fbImgCache = {};

function _noteImgDb() {
  return (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length)
    ? firebase.database() : null;
}

async function _uploadNoteImg(dataUrl) {
  var db = _noteImgDb();
  if (!db) return dataUrl;
  try {
    var ref = db.ref('note_imgs').push();
    await ref.set({ data: dataUrl, ts: Date.now() });
    _fbImgCache[ref.key] = dataUrl;
    return 'fb:' + ref.key;
  } catch(e) {
    console.error('Note img upload error:', e);
    return dataUrl;
  }
}

function _deleteNoteImg(ref) {
  if (!ref || !ref.startsWith('fb:')) return;
  var db = _noteImgDb();
  if (!db) return;
  var key = ref.slice(3);
  db.ref('note_imgs/' + key).remove().catch(function() {});
  delete _fbImgCache[key];
}

// Вызывается из render.js._resolveImgsInEl и _resolveAllNoteImgs
function _resolveNoteImg(ref, imgEl) {
  if (!ref || !imgEl) return;
  if (!ref.startsWith('fb:')) { imgEl.src = ref; return; }
  var key = ref.slice(3);
  if (_fbImgCache[key]) { imgEl.src = _fbImgCache[key]; return; }
  imgEl.style.opacity = '0.3';
  var db = _noteImgDb();
  if (!db) return;
  db.ref('note_imgs/' + key).once('value').then(function(snap) {
    var d = snap.val();
    if (d && d.data) { _fbImgCache[key] = d.data; imgEl.src = d.data; imgEl.style.opacity = ''; }
  }).catch(function(e) { console.warn('Note img resolve:', e); });
}

// ── STOP NOTES (notes[] array) ────────────────────────────────────────────────
var _pendingStopImages = {}; // key: 'stopId-noteIdx' → [dataUrl, ...] (base64 до commit)

function _findStop(stopId) {
  var result = null;
  dayKeys().forEach(function(d) {
    var s = DAYS_DATA[d]?.stops?.find(function(x) { return x.id === stopId; });
    if (s) result = s;
  });
  return result;
}

function _pendingKey(stopId, idx) { return stopId + '-' + idx; }

// No-op quiet save — blur does nothing now (save only on ✓)
function saveStopNoteQuiet() {}
function saveStopNote(stopId, day) { saveStopNoteQuiet(); }

// ── ADD NOTE ──
function addStopNote(stopId, day) {
  var s = _findStop(stopId);
  if (!s) return;
  if (!s.notes) s.notes = [];
  var idx = s.notes.length;
  s.notes.push({ text: '', images: [], public: false });
  // Re-render the card to show new note in edit mode
  renderStops(day);
  // Focus the new textarea
  var ta = document.getElementById('stop-note-' + stopId + '-' + idx);
  if (ta) { autoResizeNote(ta); setTimeout(function() { ta.focus(); }, 80); }
}

// ── TOGGLE PUBLIC ──
function toggleNotePublic(stopId, idx, day) {
  var s = _findStop(stopId);
  if (!s || !s.notes || !s.notes[idx]) return;
  s.notes[idx].public = !s.notes[idx].public;
  saveData();
  renderStops(day);
  showToast(s.notes[idx].public ? '👁 Видна читателю' : '🔒 Скрыта от читателя');
}

// ── DELETE NOTE ──
function deleteStopNote(stopId, day, idx) {
  var s = _findStop(stopId);
  if (!s || !s.notes || !s.notes[idx]) return;
  // Чистим фото из Firebase
  var note = s.notes[idx];
  if (note.images) note.images.forEach(_deleteNoteImg);
  s.notes.splice(idx, 1);
  delete _pendingStopImages[_pendingKey(stopId, idx)];
  saveData();
  renderStops(day);
  showToast('🗑️ Заметка удалена');
}

// ── COMMIT (save) ──
async function commitStopNote(stopId, day, idx) {
  var s = _findStop(stopId);
  if (!s || !s.notes) return;
  var note = s.notes[idx];
  if (!note) return;
  var inp = document.getElementById('stop-note-' + stopId + '-' + idx);

  note.text = inp ? inp.value.trim() : '';

  // Загружаем pending фото в Firebase, кладём "fb:key" вместо base64
  var pk = _pendingKey(stopId, idx);
  if (_pendingStopImages[pk] && _pendingStopImages[pk].length) {
    if (!note.images) note.images = [];
    var uploaded = await Promise.all(_pendingStopImages[pk].map(_uploadNoteImg));
    note.images = note.images.concat(uploaded);
    delete _pendingStopImages[pk];
  }

  var hasContent = note.text || (note.images && note.images.length);

  // If empty — remove the note entirely
  if (!hasContent) {
    s.notes.splice(idx, 1);
    delete _pendingStopImages[pk];
  }

  // Re-enable drag
  var card = inp?.closest('.stop-card');
  if (card) card.draggable = true;

  saveData();
  renderStops(day);
  typeof showToast === 'function' && showToast('💾 Сохранено');
}

// ── OPEN EDIT ──
function openStopNoteEdit(stopId, idx) {
  var edit = document.getElementById('stop-note-edit-' + stopId + '-' + idx);
  var preview = document.getElementById('stop-note-preview-' + stopId + '-' + idx);
  if (edit) edit.style.display = 'block';
  if (preview) preview.style.display = 'none';
  _renderStopNoteEditImages(stopId, idx);
  var ta = document.getElementById('stop-note-' + stopId + '-' + idx);
  if (ta) { autoResizeNote(ta); setTimeout(function() { ta.focus(); }, 50); }
}

// ── PENDING IMAGES ──
function addPendingStopImage(stopId, idx, dataUrl) {
  var pk = _pendingKey(stopId, idx);
  if (!_pendingStopImages[pk]) _pendingStopImages[pk] = [];
  var s = _findStop(stopId);
  var saved = (s && s.notes && s.notes[idx]) ? (s.notes[idx].images || []) : [];
  if (_pendingStopImages[pk].length + saved.length >= MAX_NOTE_IMAGES) {
    showToast('📷 Максимум ' + MAX_NOTE_IMAGES + ' фото');
    return;
  }
  _pendingStopImages[pk].push(dataUrl);
  _renderStopNoteEditImages(stopId, idx);
}

function removePendingStopImage(stopId, noteIdx, imgIdx) {
  var s = _findStop(stopId);
  var note = (s && s.notes) ? s.notes[noteIdx] : null;
  var saved = note ? (note.images || []) : [];
  var pk = _pendingKey(stopId, noteIdx);
  var pending = _pendingStopImages[pk] || [];

  if (imgIdx < saved.length) {
    _deleteNoteImg(saved[imgIdx]); // чистим из Firebase если fb: ссылка
    saved.splice(imgIdx, 1);
    if (note) note.images = saved;
  } else {
    pending.splice(imgIdx - saved.length, 1);
    _pendingStopImages[pk] = pending;
  }
  _renderStopNoteEditImages(stopId, noteIdx);
}

function _renderStopNoteEditImages(stopId, idx) {
  var container = document.getElementById('stop-note-edit-images-' + stopId + '-' + idx);
  if (!container) return;
  var s = _findStop(stopId);
  var note = (s && s.notes) ? s.notes[idx] : null;
  var saved = note ? (note.images || []) : [];
  var pk = _pendingKey(stopId, idx);
  var pending = _pendingStopImages[pk] || [];
  var all = saved.concat(pending);
  if (!all.length) { container.innerHTML = ''; return; }
  container.innerHTML = all.map(function(ref, i) {
    return '<div class="note-img-thumb-wrap">' + _noteImgTag(ref, ' onclick="event.stopPropagation();openChatPhoto(this)"') + '<button class="pending-thumb-remove" onclick="event.stopPropagation();removePendingStopImage(\'' + _escN(stopId) + '\',' + idx + ',' + i + ')">×</button></div>';
  }).join('');
  _resolveImgsInEl(container);
}

function _renderStopNotePreviewImages(stopId, idx) {
  var container = document.getElementById('stop-note-images-' + stopId + '-' + idx);
  if (!container) return;
  var s = _findStop(stopId);
  var note = (s && s.notes) ? s.notes[idx] : null;
  var imgs = note ? (note.images || []) : [];
  container.innerHTML = imgs.map(function(ref) {
    return '<div class="note-img-thumb-wrap">' + _noteImgTag(ref, ' onclick="event.stopPropagation();openChatPhoto(this)"') + '</div>';
  }).join('');
  _resolveImgsInEl(container);
}

function triggerStopNotePhoto(stopId, day, noteIdx) {
  var inp = document.getElementById('_stopNotePhotoInput');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.id = '_stopNotePhotoInput'; inp.style.display = 'none';
    document.body.appendChild(inp);
  }
  inp.onchange = function() {
    if (!inp.files.length) return;
    var files = Array.from(inp.files).slice(0, MAX_NOTE_IMAGES);
    files.forEach(function(file) {
      if (typeof _compressToBase64 === 'function') {
        _compressToBase64(file, 800, 0.65).then(function(dataUrl) {
          addPendingStopImage(stopId, noteIdx, dataUrl);
        }).catch(function(err) { console.error('Stop note photo error:', err); });
      }
    });
    inp.value = '';
  };
  inp.click();
}

// Legacy compat
function _renderStopNoteImages(stopId) {}

function autoResizeNote(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// Legacy — no longer used, kept for compat
function updateStopNotePreview() {}
function toggleStopNote() {}

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
// В демо-режиме заметки к точкам хранятся в DAYS_DATA и localStorage (notes[] формат)

function saveStopNoteDemo(stopId, day) {}

function loadDemoStopNotes() {
  try {
    var stored = JSON.parse(localStorage.getItem('travel_demo_stop_notes_v2') || '{}');
    Object.keys(stored).forEach(function(stopId) {
      Object.keys(DAYS_DATA).forEach(function(day) {
        var s = (DAYS_DATA[day].stops || []).find(function(x) { return x.id === stopId; });
        if (s) s.notes = stored[stopId];
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

// ── PASTE IMAGES INTO NOTES ──────────────────────────────────────────────────
// Shared: вставка фото из буфера в заметки (вкладка + точки)
const MAX_NOTE_IMAGES = 5;

function _handleNotePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageItems = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) imageItems.push(items[i]);
  }
  if (!imageItems.length) return;
  e.preventDefault();

  // Определяем контекст: заметки-вкладка или заметка-точки
  const target = e.target;
  const isNoteTab = target.id === 'noteInput';
  const stopMatch = target.id?.match(/^stop-note-(.+)$/);

  imageItems.forEach(item => {
    const blob = item.getAsFile();
    if (!blob) return;
    // Сжимаем с тем же алгоритмом что и чат
    if (typeof _compressToBase64 === 'function') {
      _compressToBase64(blob, 800, 0.65).then(dataUrl => {
        if (isNoteTab) {
          _addNoteTabImage(dataUrl);
        } else if (stopMatch) {
          _addStopNoteImage(stopMatch[1], dataUrl);
        }
      }).catch(err => console.error('Note paste error:', err));
    }
  });
}

// ── Note Tab Images ──────────────────────────────────────────────────────────
let _noteTabPendingImages = [];

function _addNoteTabImage(dataUrl) {
  if (_noteTabPendingImages.length >= MAX_NOTE_IMAGES) { showToast('📷 Максимум ' + MAX_NOTE_IMAGES + ' фото'); return; }
  _noteTabPendingImages.push(dataUrl);
  _renderNoteTabPending();
}

function removeNoteTabImage(idx) {
  _noteTabPendingImages.splice(idx, 1);
  _renderNoteTabPending();
}

function _renderNoteTabPending() {
  let bar = document.getElementById('noteTabPendingImages');
  if (!bar) {
    const wrap = document.getElementById('noteInput')?.parentElement;
    if (!wrap) return;
    bar = document.createElement('div');
    bar.id = 'noteTabPendingImages';
    bar.className = 'pending-images-bar';
    wrap.parentElement.insertBefore(bar, wrap);
  }
  if (!_noteTabPendingImages.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';
  bar.innerHTML = _noteTabPendingImages.map((url, i) =>
    `<div class="pending-thumb-wrap"><img src="${url}" class="pending-thumb" alt=""><button class="pending-thumb-remove" onclick="removeNoteTabImage(${i})">×</button></div>`
  ).join('');
}

// ── NOTE TAB PHOTO BUTTON ───────────────────────────────────────────────────
function triggerNoteTabPhoto() {
  var inp = document.getElementById('_noteTabPhotoInput');
  if (!inp) {
    inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.id = '_noteTabPhotoInput'; inp.style.display = 'none';
    document.body.appendChild(inp);
  }
  inp.onchange = function() {
    if (!inp.files.length) return;
    var files = Array.from(inp.files).slice(0, MAX_NOTE_IMAGES - _noteTabPendingImages.length);
    files.forEach(function(file) {
      if (typeof _compressToBase64 === 'function') {
        _compressToBase64(file, 800, 0.65).then(function(dataUrl) {
          _addNoteTabImage(dataUrl);
        }).catch(function(err) { console.error('Note tab photo error:', err); });
      }
    });
    inp.value = '';
  };
  inp.click();
}

// Patch _renderNotesList to show images inside note cards
const _origRenderNotesList = _renderNotesList;
_renderNotesList = function() {
  _origRenderNotesList();
  Object.entries(_notesData).forEach(([key, entry]) => {
    if (!entry.images || !entry.images.length) return;
    const noteEl = document.getElementById('note-' + key);
    if (!noteEl) return;
    // Find or create inline images container inside the card
    let imgContainer = noteEl.querySelector('.note-images-inline');
    if (!imgContainer) {
      imgContainer = document.createElement('div');
      imgContainer.className = 'note-images-inline';
      noteEl.appendChild(imgContainer);
    }
    imgContainer.innerHTML = entry.images.map(ref =>
      `<div class="note-img-thumb-wrap">${_noteImgTag(ref, ' onclick="openChatPhoto(this)"')}</div>`
    ).join('');
    _resolveImgsInEl(imgContainer);
  });
};

// ── PASTE LISTENERS INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Notes tab
  const noteInp = document.getElementById('noteInput');
  if (noteInp) noteInp.addEventListener('paste', _handleNotePaste);
});

// Delegated paste for stop notes (dynamic textareas)
document.addEventListener('paste', e => {
  if (e.target.id?.startsWith('stop-note-')) {
    _handleNotePaste(e);
  }
});

// ── STOP NOTE REACTIONS ──────────────────────────────────────────────────────
// Хранение: Firebase /note_reactions/{stopId}/{noteIdx}/{sid} = 'emoji' | null
// Читатель может ставить/снимать. Все видят чужие реакции в реальном времени.
// Формат: reactions[emoji] = [sid, sid, ...]  — аналогично чату.

const NOTE_REACTIONS = ['👍','❤️','🥰','😂','😱','🔥','💯','👀','🎉','😔'];
var _noteReactDb  = null;
var _noteReactRef = null;
var _noteReactData = {}; // {stopId_idx: {emoji:[sid,...]}}
var _noteReactListeners = {}; // {stopId_idx: true}
var _openReactPicker = null; // {stopId, idx} — открытый пикер

function _noteReactKey(stopId, idx) { return stopId + '_' + idx; }

function initNoteReactions() {
  if (_noteReactDb) return;
  var db = _noteImgDb();
  if (!db) return;
  _noteReactDb  = db;
  _noteReactRef = db.ref('note_reactions');
}

// Подписываемся на реакции конкретной заметки (при рендере карточки читателем)
function _listenNoteReactions(stopId, idx) {
  initNoteReactions();
  if (!_noteReactRef) return;
  var k = _noteReactKey(stopId, idx);
  if (_noteReactListeners[k]) return;
  _noteReactListeners[k] = true;
  _noteReactRef.child(stopId).child(String(idx)).on('value', function(snap) {
    _noteReactData[k] = snap.val() || {};
    _reRenderNoteReactions(stopId, idx);
  });
}

function _reRenderNoteReactions(stopId, idx) {
  var el = document.getElementById('note-react-row-' + stopId + '-' + idx);
  if (!el) return;
  el.innerHTML = _buildReactRowHtml(stopId, idx);
}

function _buildReactRowHtml(stopId, idx) {
  var k   = _noteReactKey(stopId, idx);
  var r   = _noteReactData[k] || {};
  var sid = typeof getSessionId === 'function' ? getSessionId() : '';
  var btns = Object.entries(r).filter(function(e){ return e[1] && e[1].length; }).map(function(entry) {
    var em   = entry[0], sids = entry[1];
    var mine = sids.indexOf(sid) >= 0;
    return '<button class="reaction-btn' + (mine ? ' active' : '') + '" onmousedown="event.preventDefault()" onclick="event.stopPropagation();toggleNoteReaction(\'' + _escN(stopId) + '\',' + idx + ',\'' + em + '\')" title="' + em + '">' + em + ' ' + sids.length + '</button>';
  }).join('');
  return btns;
}

function toggleNoteReaction(stopId, idx, emoji) {
  initNoteReactions();
  if (!_noteReactRef) return;
  var sid = typeof getSessionId === 'function' ? getSessionId() : '';
  if (!sid) return;
  var k    = _noteReactKey(stopId, idx);
  var r    = _noteReactData[k] ? JSON.parse(JSON.stringify(_noteReactData[k])) : {};
  if (!r[emoji]) r[emoji] = [];
  var pos  = r[emoji].indexOf(sid);
  if (pos >= 0) { r[emoji].splice(pos, 1); if (!r[emoji].length) delete r[emoji]; }
  else r[emoji].push(sid);
  _noteReactRef.child(stopId).child(String(idx)).set(Object.keys(r).length ? r : null);
  closeNoteReactPicker();
}

function openNoteReactPicker(btn, stopId, idx) {
  // Закрыть предыдущий
  closeNoteReactPicker();
  // Построить пикер
  var picker = document.createElement('div');
  picker.id  = 'note-react-picker';
  picker.className = 'note-react-picker';
  picker.innerHTML = NOTE_REACTIONS.map(function(em) {
    return '<button class="pick-em" onmousedown="event.preventDefault()" onclick="event.stopPropagation();toggleNoteReaction(\'' + _escN(stopId) + '\',' + idx + ',\'' + em + '\')">' + em + '</button>';
  }).join('');
  btn.style.position = 'relative';
  btn.parentNode.style.position = 'relative';
  btn.parentNode.appendChild(picker);
  _openReactPicker = { stopId: stopId, idx: idx };
  // Закрыть по клику вне
  setTimeout(function() {
    document.addEventListener('click', _closeNotePickerOutside);
  }, 0);
}

function _closeNotePickerOutside(e) {
  var p = document.getElementById('note-react-picker');
  if (p && !p.contains(e.target)) closeNoteReactPicker();
}

function closeNoteReactPicker() {
  var p = document.getElementById('note-react-picker');
  if (p) p.remove();
  _openReactPicker = null;
  document.removeEventListener('click', _closeNotePickerOutside);
}

// Строит HTML кнопки-реакции + ряда реакций для читателя
function buildNoteReactHtml(stopId, idx) {
  var k   = _noteReactKey(stopId, idx);
  var r   = _noteReactData[k] || {};
  var sid = typeof getSessionId === 'function' ? getSessionId() : '';
  var hasOwn = Object.values(r).some(function(sids){ return sids && sids.indexOf(sid) >= 0; });
  var btn = '<button class="note-vis-btn' + (hasOwn ? ' note-react-active' : '') + '" '
    + 'onmousedown="event.preventDefault()" '
    + 'onclick="event.stopPropagation();var b=this;if(document.getElementById(\'note-react-picker\')){closeNoteReactPicker();}else{openNoteReactPicker(b,\'' + _escN(stopId) + '\',' + idx + ');}" '
    + 'title="Реакция">❤️</button>';
  var row = '<div class="chat-reactions" id="note-react-row-' + _escN(stopId) + '-' + idx + '">'
    + _buildReactRowHtml(stopId, idx)
    + '</div>';
  // Запускаем слушатель Firebase
  _listenNoteReactions(stopId, idx);
  return { btn: btn, row: row };
}

