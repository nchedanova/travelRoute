// Active published days are live. Archived/deleted days retain their final snapshot.
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
  var liveDays = {};
  Object.entries(payload.daysData || {}).forEach(function(pair) {
    if (pair[1].publicationId) {
      routeOrder[pair[1].publicationId] = Number(pair[0]);
      liveDays[pair[1].publicationId] = pair[1];
    }
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
    var live = liveDays[pair[0]];
    var isLive = !!live && !live.archived;
    var original = isLive ? live : (publication.status === 'completed' ? publication.day : live || publication.day);
    var day = publicationDayCopy(original);
    var source;
    try { source = JSON.parse(publication.source || 'null'); } catch(e) {}
    day.stops.forEach(function(stop, stopIndex) {
      var oldStop = original.stops[stopIndex];
      if (original.walkReview) stop._walkSourceId = oldStop.id;
      var sourceStop = source && source.stops.find(function(s) { return s.id === oldStop.id; });
      var liveStops = Object.values(payload.daysData || {}).flatMap(function(d) { return d.stops || []; });
      var liveStop = liveStops.find(function(s) { return s.id === oldStop.id; });
      stop.notes.forEach(function(note, noteIndex) {
        if (isLive || original !== publication.day || oldStop.notes[noteIndex]._reactionSource) return;
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
    day.spectatorPublicationId = pair[0];
    day.spectatorLive = isLive;
    (day.stops || []).forEach(function(stop, i) { stop.id = 'pub' + (index + 1) + 's' + (i + 1); });
    days[index + 1] = day;
  });
  return { daysData: days, actuals: {}, spectatorPublications: {} };
}

function routeStorageKey() {
  if (typeof LOCAL_PREVIEW === 'undefined' || !LOCAL_PREVIEW) return 'travel_tracker_v3';
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('sample') === 'route-hints') {
    return 'travel_route_hints_preview';
  }
  return typeof LOCAL_WALK_REVIEW !== 'undefined' && LOCAL_WALK_REVIEW ? 'travel_walk_review_v1' : 'travel_preview_v1';
}

function initializePublicationView() {
  var raw = localStorage.getItem(routeStorageKey());
  if (typeof LOCAL_PREVIEW !== 'undefined' && LOCAL_PREVIEW && !raw) {
    raw = (routeStorageKey() === 'travel_walk_review_v1' && localStorage.getItem('travel_preview_v1'))
      || JSON.stringify({ daysData: DAYS_DATA, actuals: {}, spectatorPublications: {} });
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

function syncSpectatorPublications() {
  dayKeys().forEach(function(d) {
    var day = DAYS_DATA[d];
    var entry = publicationEntry(d);
    if (!entry) return;
    if (day.archived && entry.status === 'completed') return;
    entry.day = publicationDayCopy(day);
    entry.source = JSON.stringify(entry.day);
    entry.order = Number(d);
    entry.status = day.archived ? 'completed' : 'live';
    if (day.archived) entry.completedAt = Date.now();
    else delete entry.completedAt;
  });
}

function isPublicationImagePinned(ref) {
  return Object.values(spectatorPublications).some(function(entry) {
    return entry.day.stops.some(function(stop) {
      return stop.notes.some(function(note) { return (note.images || []).includes(ref); });
    });
  });
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
    var id = original.publicationId || ('p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    var entry = { day: day, source: source, order: Number(d), publishedAt: Date.now(), status: original.archived ? 'completed' : 'live' };
    if (original.archived) entry.completedAt = Date.now();
    // Persist the full candidate first: a quota failure must leave the previous publication intact.
    var raw = JSON.parse(localStorage.getItem(routeStorageKey()) || '{}');
    raw.spectatorPublications = Object.assign({}, spectatorPublications, { [id]: entry });
    raw.daysData[d].publicationId = id;
    localStorage.setItem(routeStorageKey(), JSON.stringify(raw));
    original.publicationId = id;
    spectatorPublications[id] = entry;
    saveData();
    showToast('👁 День открыт зрителям');
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

function renderPublicationManager(selected) {
  var body = document.getElementById('publicationList');
  if (!body || !isAdmin()) return;
  var linked = new Set();
  var today = new Date();
  var todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  function row(day, html) {
    var date = day.dateISO && (day.dateISO.includes('.') ? parseDateDMY(day.dateISO) : new Date(day.dateISO + 'T00:00:00'));
    var utc = date ? Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) : NaN;
    return { distance: Number.isFinite(utc) ? Math.abs(utc - todayUtc) : Infinity, utc: utc, html: html };
  }
  var rows = dayKeys().map(function(d) {
    var day = DAYS_DATA[d];
    var entry = publicationEntry(d);
    if (entry) linked.add(day.publicationId);
    return row(day, '<article class="publication-row' + (selected === d ? ' publication-selected' : '') + '">'
      + '<div class="publication-title">' + _escHtml((day.dateISO || _dayLabel(d)) + (day.date ? ' · ' + day.date : '')) + '</div>'
      + '<div class="publication-meta">' + (day.archived ? '📦 В архиве · ' : '')
      + (!entry ? 'Не виден зрителям' : day.archived ? '👁 Доступен завершённый день' : '👁 Изменения и движение видны автоматически') + '</div>'
      + (entry ? '<div class="publication-meta">Опубликовано ' + new Date(entry.publishedAt).toLocaleString('ru-RU') + '</div>' : '')
      + '<div class="publication-actions">' + (!entry ? '<button class="publication-btn publication-primary" onclick="publishSpectatorDay(' + d + ')"' + (_publicationBusy ? ' disabled' : '') + '>'
      + (_publicationBusy ? 'Подождите…' : 'Опубликовать день') + '</button>' : '')
      + (entry ? '<button class="publication-btn" onclick="unpublishSpectatorDay(\'' + day.publicationId + '\')"' + (_publicationBusy ? ' disabled' : '') + '>Снять с публикации</button>' : '') + '</div></article>');
  });
  Object.entries(spectatorPublications).forEach(function(pair) {
    if (linked.has(pair[0])) return;
    var day = pair[1].day;
    rows.push(row(day, '<article class="publication-row"><div class="publication-title">' + _escHtml(day.dateISO || day.date || 'Опубликованный день')
      + (day.dateISO && day.date ? ' · ' + _escHtml(day.date) : '')
      + '</div><div class="publication-meta">Исходный день удалён · копия доступна зрителям</div><button class="publication-btn" onclick="unpublishSpectatorDay(\'' + pair[0] + '\')">Снять с публикации</button></article>'));
  });
  body.innerHTML = rows.sort(function(a, b) { return a.distance - b.distance || b.utc - a.utc; })
    .map(function(item) { return item.html; }).join('');
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
