// ── ИМПОРТ МАРШРУТА ИЗ КАРТ ───────────────────────────────────────────────────
// Поддерживаемые форматы:
//   Яндекс Карты:  ?rtext=lat,lng~lat,lng~...
//   Google Maps:   /dir/lat,lng/lat,lng/...  или  /maps/dir/.../@lat,lng
//   2GIS:          ?m=lng,lat~lng,lat  (порядок: lng,lat !)
//   OsmAnd:        ?pin=lat,lng (одна точка) или gpx (не поддерживаем)
//   Универсальный: просто список lat,lng через запятую/перенос строки

var _importDay = null; // день, в который импортируем (null = новый)

// ── ПАРСЕР ССЫЛОК ─────────────────────────────────────────────────────────────
function parseMapLink(url) {
  url = url.trim();

  // 1. Яндекс Карты — rtext=lat,lng~lat,lng~...
  var ytMatch = url.match(/[?&]rtext=([^&]+)/);
  if (ytMatch) {
    var parts = decodeURIComponent(ytMatch[1]).split('~');
    var points = parts.map(function(p) {
      var c = p.trim().split(',');
      var lat = parseFloat(c[0]), lng = parseFloat(c[1]);
      return (isNaN(lat) || isNaN(lng)) ? null : { lat: lat, lng: lng };
    }).filter(Boolean);
    if (points.length) return { service: 'Яндекс Карты', points: points };
  }

  // 2. Google Maps — /dir/place/lat,lng/lat,lng или @lat,lng,zoom
  //    Формат: maps.google.com/maps/dir/from/to или maps.google.com/maps/dir/lat,lng/lat,lng
  var googleDir = url.match(/maps\.google\.[^/]+\/maps\/dir\/([^?#]+)/);
  if (googleDir) {
    var segments = googleDir[1].split('/').filter(function(s) { return s && s !== 'data'; });
    var points = [];
    segments.forEach(function(seg) {
      var m = seg.match(/^(-?\d+\.?\d*),(-?\d+\.?\d*)$/);
      if (m) points.push({ lat: parseFloat(m[1]), lng: parseFloat(m[2]) });
    });
    if (points.length) return { service: 'Google Maps', points: points };
  }

  // 2b. Google Maps новый формат: /maps/dir/...  (google.com/maps/dir/...)
  var googleDir2 = url.match(/google\.[^/]+\/maps\/dir\/([^?@#]+)/);
  if (googleDir2) {
    var segments2 = googleDir2[1].split('/').filter(Boolean);
    var pts2 = [];
    segments2.forEach(function(seg) {
      var m = seg.match(/^(-?\d+\.?\d*),(-?\d+\.?\d*)$/);
      if (m) pts2.push({ lat: parseFloat(m[1]), lng: parseFloat(m[2]) });
    });
    if (pts2.length) return { service: 'Google Maps', points: pts2 };
  }

  // 3. 2GIS — маршрут через m= или routePoints (lng,lat — обратный порядок!)
  var dgisMatch = url.match(/2gis\.[^/]+[^?]*\?([^#]*)/);
  if (dgisMatch) {
    var qstr = dgisMatch[1];
    // routePoints=lng,lat~lng,lat
    var rp = qstr.match(/routePoints=([^&]+)/);
    if (rp) {
      var pts3 = decodeURIComponent(rp[1]).split('~').map(function(p) {
        var c = p.trim().split(',');
        var lng = parseFloat(c[0]), lat = parseFloat(c[1]); // 2GIS: lng first!
        return (isNaN(lat) || isNaN(lng)) ? null : { lat: lat, lng: lng };
      }).filter(Boolean);
      if (pts3.length) return { service: '2GIS', points: pts3 };
    }
  }

  // 4. OsmAnd share — ?pin=lat%2Clng (одна точка)
  var osmPin = url.match(/[?&]pin=([^&]+)/);
  if (osmPin) {
    var coords = decodeURIComponent(osmPin[1]).split(/[,;]/);
    var lat4 = parseFloat(coords[0]), lng4 = parseFloat(coords[1]);
    if (!isNaN(lat4) && !isNaN(lng4)) {
      return { service: 'OsmAnd', points: [{ lat: lat4, lng: lng4 }] };
    }
  }

  // 5. Универсальный: пробуем вытащить все пары lat,lng из текста
  //    Ищем паттерн: число,число (широта от -90 до 90, долгота от -180 до 180)
  var raw = url.replace(/%2C/gi, ',').replace(/%7E/gi, '~');
  var universal = [];
  var re = /(-?\d{1,3}\.\d{3,})[,\s]+(-?\d{1,3}\.\d{3,})/g;
  var match;
  while ((match = re.exec(raw)) !== null) {
    var a = parseFloat(match[1]), b = parseFloat(match[2]);
    if (a >= -90 && a <= 90 && b >= -180 && b <= 180) {
      universal.push({ lat: a, lng: b });
    }
  }
  if (universal.length >= 2) return { service: 'Универсальный', points: universal };

  return null;
}

// ── MODAL OPEN/CLOSE ──────────────────────────────────────────────────────────
function openImportModal(day) {
  _importDay = day || null;
  var modal = document.getElementById('importModal');
  if (!modal) return;
  // Reset state — restore all hidden elements from previous import
  document.getElementById('importUrlInput').value = '';
  document.getElementById('importFormArea').style.display = 'block';
  document.getElementById('importPreview').style.display = 'none';
  document.getElementById('importActionsMain').style.display = 'none';
  document.getElementById('importActionsCancel').style.display = 'flex';
  document.getElementById('importProgress').style.display = 'none';
  document.getElementById('importError').style.display = 'none';
  modal.classList.add('show');
  setTimeout(function() {
    document.getElementById('importUrlInput').focus();
  }, 100);
}

function closeImportModal() {
  document.getElementById('importModal').classList.remove('show');
  _importDay = null;
}

// ── LIVE PARSE ON INPUT ───────────────────────────────────────────────────────
function onImportInput() {
  var val = document.getElementById('importUrlInput').value.trim();
  var preview = document.getElementById('importPreview');
  var actions = document.getElementById('importActionsMain');
  var errEl   = document.getElementById('importError');

  errEl.style.display = 'none';

  if (!val) {
    preview.style.display = 'none';
    actions.style.display = 'none';
    return;
  }

  var result = parseMapLink(val);
  if (!result || result.points.length < 1) {
    preview.style.display = 'none';
    actions.style.display = 'none';
    if (val.length > 20) {
      errEl.textContent = 'Не удалось распознать ссылку. Поддерживаются Яндекс, Google Maps, 2GIS, OsmAnd.';
      errEl.style.display = 'block';
    }
    return;
  }

  // Show preview
  var pts = result.points;
  var previewList = document.getElementById('importPreviewList');
  var html = '';
  var showMax = 3;
  pts.forEach(function(p, i) {
    if (i === 0) {
      html += '<div class="imp-pt"><span class="imp-pt-n imp-pt-start">🚩</span><span class="imp-pt-label imp-pt-start-text">Старт</span><span class="imp-pt-coord">' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + '</span></div>';
    } else if (i <= showMax) {
      html += '<div class="imp-pt"><span class="imp-pt-n">' + i + '</span><span class="imp-pt-coord">' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + '</span></div>';
    }
  });
  if (pts.length > showMax + 1) {
    html += '<div class="imp-pt imp-pt-more">··· ещё ' + (pts.length - showMax - 1) + ' точек</div>';
  }

  document.getElementById('importServiceName').textContent = result.service;
  document.getElementById('importPointCount').textContent = pts.length + ' (' + (pts.length > 1 ? '1 старт + ' + (pts.length - 1) + ' остановок' : '1 точка') + ')';
  previewList.innerHTML = html;

  preview.style.display = 'block';
  actions.style.display = 'flex';
}

// ── REVERSE GEOCODING ─────────────────────────────────────────────────────────
async function _reverseGeocode(lat, lng) {
  try {
    var url = 'https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lng + '&format=json&accept-language=ru';
    var r = await fetch(url, { headers: { 'Accept-Language': 'ru' } });
    var data = await r.json();
    if (data && data.display_name) {
      // Try to get a short name: shop, amenity, road name, village
      var a = data.address || {};
      var name = a.amenity || a.shop || a.tourism || a.leisure ||
                 a.road || a.suburb || a.village || a.town || a.city ||
                 data.display_name.split(',')[0];
      var locality = a.city || a.town || a.village || a.suburb || '';
      return locality ? name + ' · ' + locality : name;
    }
  } catch(e) {}
  return null;
}

// ── DO IMPORT ─────────────────────────────────────────────────────────────────
async function doImport(mode) {
  // mode: 'new' = новый день, 'current' = в _importDay
  var val = document.getElementById('importUrlInput').value.trim();
  var result = parseMapLink(val);
  if (!result || !result.points.length) return;

  var pts = result.points;

  // Hide form, show progress
  document.getElementById('importFormArea').style.display = 'none';
  document.getElementById('importActionsMain').style.display = 'none';
  document.getElementById('importActionsCancel').style.display = 'none';
  document.getElementById('importProgress').style.display = 'block';

  var progressList = document.getElementById('importProgressList');
  var progressFill = document.getElementById('importProgressFill');
  var progressCount = document.getElementById('importProgressCount');

  // Build initial progress rows
  function buildProgressRows(names) {
    var html = '';
    pts.forEach(function(p, i) {
      var label = names[i] || (p.lat.toFixed(4) + ', ' + p.lng.toFixed(4));
      var cls = names[i] ? 'imp-prog-done' : (i === names.length ? 'imp-prog-active' : 'imp-prog-wait');
      html += '<div class="imp-prog-item ' + cls + '" id="imp-prog-' + i + '">';
      if (i === names.length) html += '<span class="imp-spinner"></span>';
      else if (names[i]) html += '✓ ';
      else html += '— ';
      html += label + '</div>';
    });
    return html;
  }

  var resolvedNames = [];
  progressList.innerHTML = buildProgressRows(resolvedNames);

  // Resolve names one by one (1 req/sec to respect Nominatim rate limit)
  for (var i = 0; i < pts.length; i++) {
    var name = await _reverseGeocode(pts[i].lat, pts[i].lng);
    resolvedNames.push(name || (pts[i].lat.toFixed(4) + ', ' + pts[i].lng.toFixed(4)));

    // Update progress UI
    progressList.innerHTML = buildProgressRows(resolvedNames);
    var pct = Math.round((resolvedNames.length / pts.length) * 100);
    progressFill.style.width = pct + '%';
    progressCount.textContent = resolvedNames.length + ' / ' + pts.length;

    if (i < pts.length - 1) await new Promise(function(res) { setTimeout(res, 1100); });
  }

  // Build day data
  var startPt   = pts[0];
  var stopPts   = pts.slice(1);
  var startName = resolvedNames[0];
  var stopNames = resolvedNames.slice(1);

  if (mode === 'new') {
    // Create a new day
    var keys    = dayKeys();
    var newD    = Math.max.apply(null, keys) + 1;
    var colIdx  = keys.length % DAY_COLORS.length;

    // Auto date: next day after last
    var newDateISO = '';
    var lastDay = DAYS_DATA[keys[keys.length - 1]];
    if (lastDay && lastDay.dateISO && typeof parseDateDMY === 'function') {
      var dt = parseDateDMY(lastDay.dateISO);
      if (dt) { dt.setDate(dt.getDate() + 1); newDateISO = fmtDateDMY(dt); }
    }

    var stops = stopPts.map(function(p, i) {
      return {
        id: 'd' + newD + 's' + (i + 1),
        num: i + 1,
        icon: '📍', type: 'Другое',
        name: stopNames[i],
        lat: p.lat, lng: p.lng,
        arrP: '', depP: '', arrA: '', depA: ''
      };
    });

    DAYS_DATA[newD] = {
      color: DAY_COLORS[colIdx],
      dateISO: newDateISO,
      date: startName + (stops.length ? ' → ' + stops[stops.length - 1].name : ''),
      departP: '', departA: '',
      start: { lat: startPt.lat, lng: startPt.lng, name: startName, icon: '📍' },
      stops: stops
    };

    layers[newD]        = L.layerGroup();
    segmentLayers[newD] = [];
    renderTabs();
    document.getElementById('daySections').appendChild(renderDaySection(newD));
    renderStops(newD);
    updateDayRoute(newD);
    redrawDay(newD);
    switchDay(newD);

  } else {
    // Add to existing day _importDay
    var day = _importDay;
    if (!day || !DAYS_DATA[day]) day = currentDay;

    snapshotForUndo('Импорт точек в день ' + day);

    // If day has default empty start, replace it
    if (!DAYS_DATA[day].start.lat) {
      DAYS_DATA[day].start = { lat: startPt.lat, lng: startPt.lng, name: startName, icon: '📍' };
    }

    // Append stops
    var existingCount = DAYS_DATA[day].stops.length;
    stopPts.forEach(function(p, i) {
      DAYS_DATA[day].stops.push({
        id: 'd' + day + 's' + Date.now() + i,
        num: existingCount + i + 1,
        icon: '📍', type: 'Другое',
        name: stopNames[i],
        lat: p.lat, lng: p.lng,
        arrP: '', depP: '', arrA: '', depA: ''
      });
    });

    renderStops(day);
    updateDayRoute(day);
    redrawDay(day);
    switchDay(day);
  }

  saveData();
  closeImportModal();
  showToast('✅ Импортировано ' + pts.length + ' точек');
}
