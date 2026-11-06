// Published days are independent snapshots. Archive/reorder/delete never mutates them.
var spectatorPublications = {};
var _publicationBusy = false;

function publicationDayCopy(day) {
  var copy = JSON.parse(JSON.stringify(day));
  delete copy.archived;
  delete copy.hidden;
  delete copy.publicationId;
  (copy.stops || []).forEach(function(stop) {
    stop.notes = (stop.notes || []).map(function(note, index) {
      if (!note._reactionSource) note._reactionSource = { stopId: stop.id, noteIndex: index };
      return note;
    }).filter(function(note) { return note.public === true; });
    delete stop.note;
    delete stop.noteImages;
  });
  return copy;
}

function spectatorPayload(payload) {
  var days = {};
  var routeOrder = {};
  Object.entries(payload.daysData || {}).forEach(function(pair) {
    if (pair[1].publicationId) routeOrder[pair[1].publicationId] = Number(pair[0]);
  });
  function order(pair) {
    if (routeOrder[pair[0]] !== undefined) return routeOrder[pair[0]];
    if (Number.isFinite(pair[1].order)) return pair[1].order;
    // Existing publications retain original stop IDs even though the spectator
    // DOM uses separate IDs. Recover their route position without republishing.
    var stop = pair[1].day && pair[1].day.stops && pair[1].day.stops[0];
    var match = stop && stop.id.match(/^d(\d+)s/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }
  Object.entries(payload.spectatorPublications || {}).sort(function(a,b) {
    return order(a) - order(b);
  }).forEach(function(pair, index) {
    var publication = pair[1];
    if (!publication || !publication.day) return;
    var original = publication.day;
    var day = publicationDayCopy(original);
    var source;
    try { source = JSON.parse(publication.source || 'null'); } catch(e) {}
    day.stops.forEach(function(stop, stopIndex) {
      var oldStop = original.stops[stopIndex];
      var sourceStop = source && source.stops.find(function(s) { return s.id === oldStop.id; });
      var liveStops = Object.values(payload.daysData || {}).flatMap(function(d) { return d.stops || []; });
      var liveStop = liveStops.find(function(s) { return s.id === oldStop.id; });
      stop.notes.forEach(function(note, noteIndex) {
        if (oldStop.notes[noteIndex]._reactionSource) return;
        // Build 91/92 publications did not retain original note indices. Recover
        // them by matching the original public note, never its filtered position.
        var originalNote = sourceStop && sourceStop.notes[noteIndex];
        var matches = [];
        if (liveStop && originalNote) liveStop.notes.forEach(function(n, i) {
          if (n.public && (n.text || '') === (originalNote.text || '') &&
              JSON.stringify(n.images || []) === JSON.stringify(originalNote.images || [])) matches.push(i);
        });
        note._reactionSource = matches.length === 1
          ? { stopId: liveStop.id, noteIndex: matches[0] }
          : { stopId: 'publication_' + pair[0] + '_' + oldStop.id, noteIndex: noteIndex };
      });
    });
    day.publishedAt = publication.publishedAt;
    (day.stops || []).forEach(function(stop, i) { stop.id = 'pub' + (index + 1) + 's' + (i + 1); });
    days[index + 1] = day;
  });
  return { daysData: days, actuals: {}, spectatorPublications: {} };
}

function routeStorageKey() {
  return typeof LOCAL_PREVIEW !== 'undefined' && LOCAL_PREVIEW ? 'travel_preview_v1' : 'travel_tracker_v3';
}

function initializePublicationView() {
  var raw = localStorage.getItem(routeStorageKey());
  if (typeof LOCAL_PREVIEW !== 'undefined' && LOCAL_PREVIEW && !raw) {
    raw = JSON.stringify({ daysData: DAYS_DATA, actuals: {}, spectatorPublications: {} });
    localStorage.setItem(routeStorageKey(), raw);
  }
  if (raw) {
    try { applyPayload(JSON.parse(raw)); } catch(e) { console.warn('Publication cache:', e); }
  } else if (SPECTATOR_MODE) {
    applyPayload({ daysData: {}, spectatorPublications: {} });
  }
}

function publicationEntry(d) {
  var day = DAYS_DATA[d];
  return day && day.publicationId ? spectatorPublications[day.publicationId] : null;
}

function publicationChanged(d) {
  var entry = publicationEntry(d);
  if (!entry) return false;
  function comparable(day) { return JSON.stringify(day, function(key, value) { return key === '_reactionSource' ? undefined : value; }); }
  try { return comparable(JSON.parse(entry.source)) !== comparable(publicationDayCopy(DAYS_DATA[d])); }
  catch(e) { return true; }
}

async function freezePublicationImages(day) {
  var refs = new Map();
  (day.stops || []).forEach(function(stop) {
    stop.notes.forEach(function(note) {
      (note.images || []).forEach(function(ref) { if (ref.startsWith('fb:')) refs.set(ref, null); });
    });
  });
  for (var ref of refs.keys()) {
    var key = ref.slice(3);
    var cached = typeof _fbImgCache !== 'undefined' && _fbImgCache[key];
    if (!cached) cached = sessionStorage.getItem('ni_' + key);
    if (!cached) {
      var db = typeof _noteImgDb === 'function' && _noteImgDb();
      if (!db) throw new Error('Для публикации фотографий подключитесь к Firebase');
      cached = await new Promise(function(resolve, reject) {
        var timeout = setTimeout(function() { reject(new Error('Не удалось загрузить фото. Попробуйте снова')); }, 10000);
        db.ref('note_imgs/' + key).once('value').then(function(snap) {
          clearTimeout(timeout);
          var value = snap.val();
          if (value && value.data) resolve(value.data);
          else reject(new Error('Фото недоступно. Публикация не изменена'));
        }, function(error) { clearTimeout(timeout); reject(error); });
      });
    }
    // Preserve the snapshot independently of deletable originals, but keep photo
    // bytes in Firebase. Only already-offline data: images remain embedded.
    if (typeof _uploadNoteImgRetry !== 'function') throw new Error('Загрузка фото в Firebase недоступна');
    var publishedRef = await _uploadNoteImgRetry(cached);
    if (typeof publishedRef !== 'string' || !publishedRef.startsWith('fb:')) {
      throw new Error('Фото не сохранено в Firebase. Публикация не изменена');
    }
    refs.set(ref, publishedRef);
  }
  day.stops.forEach(function(stop) { stop.notes.forEach(function(note) {
    note.images = (note.images || []).map(function(ref) { return refs.get(ref) || ref; });
  }); });
}

async function publishSpectatorDay(d) {
  if (!isAdmin() || !DAYS_DATA[d] || _publicationBusy) return;
  _publicationBusy = true;
  renderPublicationManager();
  try {
    saveData(); // Capture committed actual arrival/departure fields before taking a copy.
    var original = DAYS_DATA[d];
    var source = JSON.stringify(publicationDayCopy(original));
    var day = JSON.parse(source);
    await freezePublicationImages(day);
    var id = original.publicationId || ('p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    var entry = { day: day, source: source, order: Number(d), publishedAt: Date.now() };
    // Persist the full candidate first: a quota failure must leave the previous publication intact.
    var raw = JSON.parse(localStorage.getItem(routeStorageKey()) || '{}');
    raw.spectatorPublications = Object.assign({}, spectatorPublications, { [id]: entry });
    raw.daysData[d].publicationId = id;
    localStorage.setItem(routeStorageKey(), JSON.stringify(raw));
    original.publicationId = id;
    spectatorPublications[id] = entry;
    saveData();
    showToast('👁 Копия дня опубликована для зрителей');
  } catch(e) {
    showToast('⚠ ' + (e.name === 'QuotaExceededError' ? 'Недостаточно места для сохранения публикации' : e.message));
  } finally {
    _publicationBusy = false;
    renderPublicationManager();
    renderAllDays();
    renderArchiveBtn();
  }
}

function unpublishSpectatorDay(id) {
  if (!isAdmin() || _publicationBusy) return;
  delete spectatorPublications[id];
  saveData();
  renderPublicationManager();
  renderAllDays();
  renderArchiveBtn();
  showToast('День снят с публикации');
}

function openPublicationManager(d) {
  if (!isAdmin()) return;
  closeDayMenus();
  renderPublicationManager(d);
  document.getElementById('publicationModal').classList.add('show');
}
function closePublicationManager() {
  document.getElementById('publicationModal').classList.remove('show');
}
document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') closePublicationManager();
});

function refreshPublicationStatus() {
  if (!isAdmin()) return;
  document.querySelectorAll('.publication-day-status').forEach(function(button) {
    var d = Number(button.closest('.day-section').dataset.day);
    button.innerHTML = (publicationEntry(d) ? (publicationChanged(d) ? '👁 Зрителям: прежняя копия · есть изменения' : '👁 Зрителям: опубликованная копия') : '👁 Зрителям: не опубликован')
      + ' <span>Настроить →</span>';
  });
}
function renderPublicationManager(selected) {
  var body = document.getElementById('publicationList');
  if (!body || !isAdmin()) return;
  var linked = new Set();
  body.innerHTML = dayKeys().sort(function(a,b) { return Number(!!DAYS_DATA[a].archived) - Number(!!DAYS_DATA[b].archived); }).map(function(d) {
    var day = DAYS_DATA[d];
    var entry = publicationEntry(d);
    if (entry) linked.add(day.publicationId);
    var changed = publicationChanged(d);
    return '<article class="publication-row' + (selected === d ? ' publication-selected' : '') + '">'
      + '<div class="publication-title">' + _escHtml((day.dateISO || _dayLabel(d)) + (day.date ? ' · ' + day.date : '')) + '</div>'
      + '<div class="publication-meta">' + (day.archived ? '📦 В архиве · ' : '')
      + (!entry ? 'Не виден зрителям' : changed ? 'Есть изменения · зритель видит прежнюю копию' : '👁 Опубликованная копия актуальна') + '</div>'
      + (entry ? '<div class="publication-meta">Опубликовано ' + new Date(entry.publishedAt).toLocaleString('ru-RU') + '</div>' : '')
      + '<div class="publication-actions"><button class="publication-btn publication-primary" onclick="publishSpectatorDay(' + d + ')"' + (_publicationBusy ? ' disabled' : '') + '>'
      + (_publicationBusy ? 'Подождите…' : entry ? 'Обновить копию' : 'Опубликовать день') + '</button>'
      + (entry ? '<button class="publication-btn" onclick="unpublishSpectatorDay(\'' + day.publicationId + '\')"' + (_publicationBusy ? ' disabled' : '') + '>Снять с публикации</button>' : '') + '</div></article>';
  }).join('');
  Object.entries(spectatorPublications).forEach(function(pair) {
    if (linked.has(pair[0])) return;
    body.innerHTML += '<article class="publication-row"><div class="publication-title">' + _escHtml(pair[1].day.date || pair[1].day.dateISO || 'Опубликованный день')
      + '</div><div class="publication-meta">Исходный день удалён · копия доступна зрителям</div><button class="publication-btn" onclick="unpublishSpectatorDay(\'' + pair[0] + '\')">Снять с публикации</button></article>';
  });
  if (!body.innerHTML) body.innerHTML = '<div class="publication-row">Дней пока нет</div>';
  document.getElementById('publicationCount').textContent = Object.keys(spectatorPublications).length;
}

function previewSpectatorPublications() {
  var url = new URL(location.href);
  if (typeof LOCAL_PREVIEW !== 'undefined' && LOCAL_PREVIEW) {
    url.search = '?preview=spectator&chat=0';
  } else {
    url.search = '?chat=0';
    if (CLOUD_CONFIG.binId) url.searchParams.set('gist', CLOUD_CONFIG.binId);
  }
  window.open(url.toString(), '_blank', 'noopener');
}
