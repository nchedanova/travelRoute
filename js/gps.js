// ── GPS MODULE ─────────────────────────────────────────────────────────────────
// Роли:
//   Владелец (canWrite): видит свой GPS маркер, кнопка "Еду" → пишет в Firebase + следит камера
//   Зритель  (canRead, !canWrite): читает позицию из Firebase, камера следит автоматически

const FIREBASE_CONFIG = {
  authDomain:          'travel-route-83d06.firebaseapp.com',
  databaseURL:         'https://travel-route-83d06-default-rtdb.firebaseio.com',
  projectId:           'travel-route-83d06',
  storageBucket:       'travel-route-83d06.firebasestorage.app',
  messagingSenderId:   '880747819905',
  appId:               '1:880747819905:web:376879499a62d9b7f0ee80'
};

// ── STATE ──────────────────────────────────────────────────────────────────────
let _db             = null;
let _watchId        = null;   // navigator.geolocation watchId
let _gpsMarker      = null;   // Leaflet marker — текущая позиция
let _accuracyCircle = null;   // Leaflet circle — кружок погрешности
let _drivingMode    = false;  // владелец нажал "Еду"
let _walkGpsActive  = false;
let _hasOwnerFix    = false;
let _followCamera   = false;  // камера следит за позицией
let _userPanned     = false;  // пользователь двигал карту вручную
let _nearestStopId  = null;   // id ближайшей остановки
let _keepAliveCtx   = null;   // AudioContext для keep-alive
let _keepAliveOsc   = null;
var _lastSpectatorPosition = null;
let _lastSpectatorWalk = null;
let _spectatorWalkRender = null;
var _lastOwnerPosition = null;
var _spectatorGpsListening = false;
let _lastWalkBroadcastAt = 0;
let _broadcastWalkDay = null;
let _readerWalk = null;
let _readerCloudSavedAt = 0;

// ── INIT ───────────────────────────────────────────────────────────────────────
function initGps() {
  _initFollowPause();
  // Spectators receive only the published-day GPS branch, photos and reactions.
  if (SPECTATOR_MODE) { initSpectatorPhotos(); return; }
  // ── ДЕМО-РЕЖИМ ──────────────────────────────────────────────────────────────
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    initChat && initChat();
    initNotes && initNotes();
    if (isAdmin()) _showEl('drivingBtn');
    return;
  }

  if (typeof firebase === 'undefined') {
    console.warn('Firebase SDK не загружен');
    return;
  }

  if (!firebase.apps.length) {
    const cfg = Object.assign({}, FIREBASE_CONFIG, { apiKey: localStorage.getItem('travel_firebase_key') || '' });
    firebase.initializeApp(cfg);
    // Enable offline persistence BEFORE any .database() call
    try { firebase.database().setPersistenceEnabled(true); } catch(e) {}
    // Инициируем заметки сразу после Firebase — не ждём открытия вкладки
    if (typeof initNotes === 'function') setTimeout(initNotes, 0);
  }

  // Auth — use existing session (Google/anonymous) or create anonymous
  if (firebase.auth) {
    // Handle redirect result from Google Sign-In (fallback for popup-blocked)
    if (isChatEnabled()) firebase.auth().getRedirectResult().then(function(result) {
      if (result && result.user) {
        var u = result.user;
        window._firebaseUid = u.uid;
        localStorage.setItem('travel_firebase_uid', u.uid);
        localStorage.removeItem('travel_auth_redirect_pending');
        var name = u.displayName || u.email?.split('@')[0] || 'User';
        console.log('[auth] redirect ok:', name);
        if (firebase.database) {
          firebase.database().ref('users/' + u.uid + '/name').once('value').then(function(snap) {
            if (snap.val()) name = snap.val();
            localStorage.setItem('travel_chat_name', name);
            if (typeof renderChatHeader === 'function') renderChatHeader();
          });
        } else {
          localStorage.setItem('travel_chat_name', name);
        }
        localStorage.setItem('travel_auth_provider', 'google');
        var modal = document.getElementById('nicknameModal');
        if (modal) modal.classList.remove('show');
        if (typeof renderChatHeader === 'function') renderChatHeader();
      } else {
        localStorage.removeItem('travel_auth_redirect_pending');
      }
    }).catch(function(err) {
      console.warn('[auth] redirect error:', err.code);
      localStorage.removeItem('travel_auth_redirect_pending');
    });

    firebase.auth().onAuthStateChanged(user => {
      if (user) {
        var newUid = user.uid;
        window._firebaseUid = newUid;
        localStorage.setItem('travel_firebase_uid', newUid);
        // GPS и заметкам нужен uid, но зритель не участвует в чате.
        if (!isChatEnabled()) return;
        var provider = user.providerData?.length ? user.providerData[0].providerId : 'anonymous';
        console.log('[auth] uid:', newUid, '(' + provider + ')');

        // Clean up ALL old presence entries (localStorage sessionId + old firebase uid)
        if (firebase.database) {
          var db = firebase.database();
          var oldSessionId = localStorage.getItem('travel_session_id');
          var oldFirebaseUid = localStorage.getItem('travel_prev_firebase_uid');
          if (oldSessionId && oldSessionId !== newUid) {
            try { db.ref('chat_presence/' + oldSessionId).remove(); } catch(e) {}
          }
          if (oldFirebaseUid && oldFirebaseUid !== newUid) {
            try { db.ref('chat_presence/' + oldFirebaseUid).remove(); } catch(e) {}
          }
          // Save current uid as "prev" for next migration
          localStorage.setItem('travel_prev_firebase_uid', newUid);
        }

        // If Google user, fetch custom name or use profile name
        if (provider === 'google.com' && firebase.database) {
          localStorage.removeItem('travel_auth_redirect_pending');
          localStorage.setItem('travel_auth_provider', 'google');
          // Set name immediately so chat modal polling sees it
          if (user.displayName && !getChatName()) {
            localStorage.setItem('travel_chat_name', user.displayName);
          }
          firebase.database().ref('users/' + user.uid + '/name').once('value').then(function(snap) {
            var customName = snap.val();
            if (customName) {
              localStorage.setItem('travel_chat_name', customName);
            } else if (user.displayName) {
              localStorage.setItem('travel_chat_name', user.displayName);
            }
            if (typeof renderChatHeader === 'function') renderChatHeader();
          });
        }
        if (typeof renderChatHeader === 'function') renderChatHeader();
      } else {
        // No user — but don't create anonymous if Google redirect is pending
        if (isChatEnabled() && localStorage.getItem('travel_auth_redirect_pending')) {
          console.log('[auth] waiting for redirect result, skipping anonymous sign-in');
        } else {
          firebase.auth().signInAnonymously().catch(e => console.warn('[auth] anonymous sign-in failed:', e));
        }
      }
    });
  }

  _db = firebase.database();

  // Запускаем чат и заметки
  initChat && initChat();
  initNotes && initNotes();

  if (CLOUD_CONFIG.canWrite) {
    // Владелец: запускаем GPS-слежение устройства
    _startGpsWatch();
    _showEl('drivingBtn');
    if (typeof firebase.auth === 'function') {
      const unsubscribe = firebase.auth().onAuthStateChanged(user => {
        if (!user) return;
        unsubscribe();
        publishRecoveredWalk();
      });
    } else publishRecoveredWalk();
  } else if (CLOUD_CONFIG.canRead) {
    // Зритель: слушаем Firebase, камера сразу следит
    _listenRemotePosition();
    _followCamera = true;
  }

}

function _initFollowPause() {
  let _followPauseTimer = null;
  map.on('dragstart', () => {
    if (!_followCamera) return;
    _userPanned = true;
    clearTimeout(_followPauseTimer);
    document.getElementById('gpsFollowBtn')?.classList.add('paused');
  });
  map.on('dragend', () => {
    if (!_followCamera || !_userPanned) return;
    clearTimeout(_followPauseTimer);
    _followPauseTimer = setTimeout(() => {
      if (_userPanned) resumeGpsFollow();
    }, 7000);
  });
}

function initSpectatorPhotos() {
  if (isDemoMode() || typeof firebase === 'undefined') return;
  if (!firebase.apps.length) {
    firebase.initializeApp(Object.assign({}, FIREBASE_CONFIG, {apiKey: localStorage.getItem('travel_firebase_key') || ''}));
  }
  function resolvePhotos() {
    if (typeof firebase.auth === 'function' && firebase.auth().currentUser) {
      window._firebaseUid = firebase.auth().currentUser.uid;
    }
    if (typeof _resolveAllNoteImgs === 'function') _resolveAllNoteImgs();
    if (typeof initNoteReactions === 'function') initNoteReactions();
    if (typeof _setupAllNoteReactListeners === 'function') _setupAllNoteReactListeners();
    _db = firebase.database();
    if (!_spectatorGpsListening) {
      _spectatorGpsListening = true;
      _followCamera = true;
      _db.ref('gps/spectator').on('value', function(snap) {
        _lastSpectatorPosition = snap.val();
        if (_lastSpectatorPosition?.walk) _lastSpectatorWalk = _lastSpectatorPosition;
        const id = mergeSpectatorWalk(_lastSpectatorPosition);
        if (id != null) {
          const walk = _lastSpectatorPosition.walk;
          const key = _lastSpectatorPosition.publicationId + ':' + id;
          const structure = renderRemoteWalk(id, walk, _spectatorWalkRender?.key !== key, _spectatorWalkRender?.structure);
          _spectatorWalkRender = {key, structure};
        }
        refreshSpectatorGpsVisibility();
      });
      setInterval(refreshSpectatorGpsVisibility, 5000);
    }
  }
  if (firebase.auth) {
    firebase.auth().onAuthStateChanged(function(user) {
      if (user) resolvePhotos();
      else firebase.auth().signInAnonymously().catch(function(error) { console.warn('Published photo auth:', error); });
    });
  } else resolvePhotos();
}

// ── GPS WATCH — только владелец ───────────────────────────────────────────────
function _startGpsWatch() {
  if (!navigator.geolocation) {
    showToast('GPS недоступен в этом браузере');
    return;
  }
  _watchId = navigator.geolocation.watchPosition(
    _onPosition,
    err => console.warn('GPS:', err.message),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

function _onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy, speed } = pos.coords;
  _hasOwnerFix = true;
  if (_walkGpsActive) return;
  const kmh = gpsSpeedKmh(speed);

  _updateGpsMarker(lat, lng, accuracy, false);
  _showEl('gpsFollowBtn');
  _highlightNearest(lat, lng);

  if (_drivingMode) {
    _checkRouteHints(pos.coords);
    _updateSpeedDisplay(kmh);
    const point = { lat, lng, speed: kmh, accuracy, ts: Date.now() };
    // Всегда пишем в IndexedDB (для GPX-экспорта и оффлайн)
    if (typeof saveGpsPoint === 'function') saveGpsPoint(point);
    // Пишем в Firebase (с оффлайн-буфером)
    if (typeof bufferGpsForSync === 'function' && bufferGpsForSync(point)) {
      // Буферизировано — нет сети
    } else {
      _writePosition(lat, lng, kmh, accuracy);
    }
    if (_followCamera && !_userPanned) _panTo(lat, lng);
  }
}

// ── FIREBASE READ — зрители ────────────────────────────────────────────────────
function _listenRemotePosition() {
  if (!_db) return;
  _db.ref('gps').on('value', snap => {
    const d = snap.val();
    if (d?.walk && d.walk.routeId === CLOUD_CONFIG.binId) applyReaderWalk(d.walk);
    if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lng) ||
        (d.walk && (currentDay !== d.walk.dayId || Date.now() - d.ts > 120000))) {
      // путешественник остановился — убираем подсветку и скорость
      document.body.classList.remove('driving-active');
      _updateSpeedDisplay(null);
      _clearGpsMarker();
      _setGpsControls(false, false);
      return;
    }
    // есть позиция — включаем подсветку как в режиме "Еду"
    document.body.classList.add('driving-active');
    _setGpsControls(true, true);
    _updateGpsMarker(d.lat, d.lng, d.accuracy, true);
    _highlightNearest(d.lat, d.lng);
    _updateSpeedDisplay(d.speed);
    if (_followCamera && !_userPanned) _panTo(d.lat, d.lng);
  });
}

function sameRecordedWalk(a, b) {
  if (!a?.walkReview || !b?.walkReview) return false;
  const first = a.walkReview;
  const second = b.walkReview;
  if (first.id && second.id) return first.id === second.id;
  if (first.startedAt && second.startedAt) return first.startedAt === second.startedAt;
  return a.dateISO === b.dateISO;
}

// Compare progress for this walk, not the save time of the whole journal.
function compareWalkProgress(a, b) {
  const first = a.walkReview;
  const second = b.walkReview;
  const points = walk => (walk.segments || []).reduce((total, segment) => total + segment.length, 0);
  return (Number(first.phase === 'finished') - Number(second.phase === 'finished')) ||
    ((first.finishedAt || first.lastAt || 0) - (second.finishedAt || second.lastAt || 0)) ||
    (points(first) - points(second)) ||
    ((a.stops || []).length - (b.stops || []).length);
}

function mergeReaderWalk(walk, cloudSavedAt = 0) {
  if (!walk || CLOUD_CONFIG.canWrite || SPECTATOR_MODE || walk.routeId !== CLOUD_CONFIG.binId ||
      !Number.isSafeInteger(walk.dayId) || walk.dayId < 1 || !walk.day?.walkReview?.id) return false;
  const existing = DAYS_DATA[walk.dayId];
  if (existing?.hidden || existing?.archived) return false;
  if (existing) {
    if (!sameRecordedWalk(existing, walk.day)) return false;
    const progress = compareWalkProgress(walk.day, existing);
    if (progress < 0 || (progress === 0 && cloudSavedAt >= walk.updatedAt)) return false;
  } else if (cloudSavedAt >= walk.updatedAt) return false;
  const notes = new Map(existing?.stops.map(stop => [stop.id, stop.notes]));
  DAYS_DATA[walk.dayId] = {...existing, ...walk.day,
    stops: (walk.day.stops || []).map(stop => ({...stop, notes: notes.get(stop.id) || []}))};
  return true;
}

function applyReaderWalk(walk) {
  if (!mergeReaderWalk(walk, _readerCloudSavedAt)) return;
  const id = walk.dayId;
  const structure = renderRemoteWalk(id, walk, _readerWalk?.dayId !== id, _readerWalk?.structure);
  _readerWalk = {...walk, structure};
}

function renderRemoteWalk(id, walk, force, previousStructure) {
  const structure = JSON.stringify([walk.day.start, walk.day.departA, walk.day.stops]);
  if (!force && previousStructure === structure && walkTrackLines[id]) {
    refreshWalkTrackLine(id);
    return structure;
  }
  redrawDay(id);
  if (!DAYS_DATA[currentDay] || DAYS_DATA[currentDay].archived || DAYS_DATA[currentDay].hidden) switchDay(id);
  else if (force && currentDay === id && !_userPanned) fitDayMap(id);
  if (!map.hasLayer(layers[id]) && currentDay === id) layers[id].addTo(map);
  renderTabs();
  renderAllDays();
  updateProgress();
  return structure;
}

function mergeSpectatorWalk(point = _lastSpectatorWalk) {
  if (!SPECTATOR_MODE) return null;
  const walk = point?.walk;
  if (!walk?.day?.walkReview?.id || walk.routeId !== CLOUD_CONFIG.binId) return null;
  const id = dayKeys().find(id => DAYS_DATA[id].spectatorLive &&
    DAYS_DATA[id].spectatorPublicationId === point.publicationId);
  if (id == null) return null;
  const day = DAYS_DATA[id];
  if (day.walkReview && (!sameRecordedWalk(day, walk.day) || compareWalkProgress(walk.day, day) <= 0)) return null;
  const existing = new Map(day.stops.map(stop => [stop._walkSourceId, stop]));
  Object.assign(day, {
    walkReview: walk.day.walkReview, start: walk.day.start, departA: walk.day.departA, departP: walk.day.departP,
    stops: (walk.day.stops || []).map((stop, index) => ({
      ...stop, id: 'pub' + id + 's' + (index + 1), _walkSourceId: stop.id,
      notes: existing.get(stop.id)?.notes || []
    }))
  });
  return id;
}

function restoreReaderWalk(cloudSavedAt) {
  _readerCloudSavedAt = Math.max(_readerCloudSavedAt, cloudSavedAt);
  const merged = mergeReaderWalk(_readerWalk, cloudSavedAt);
  if (!merged && _readerWalk && cloudSavedAt >= _readerWalk.updatedAt) _readerWalk = null;
  return merged;
}

function walkBroadcastPayload(id, spectator = false) {
  const day = DAYS_DATA[id];
  if (!day?.walkReview?.id || (!spectator && day.hidden) || day.archived) return null;
  const {lat, lng, name, icon} = day.start;
  return JSON.parse(JSON.stringify({
    routeId: CLOUD_CONFIG.binId, dayId: id, updatedAt: Date.now(),
    day: {
      date: day.date, dateISO: day.dateISO, color: day.color, icon: day.icon,
      start: {lat, lng, name, icon}, walkMode: true, departA: day.departA, departP: day.departP,
      walkReview: {...day.walkReview},
      stops: day.stops.map(({id, num, name, lat, lng, type, icon, arrA, arrP, depA, depP}) =>
        ({id, num, name, lat, lng, type, icon, arrA, arrP, depA, depP}))
    }
  }));
}

function publishRecoveredWalk() {
  if (!_db || !CLOUD_CONFIG.canWrite || _drivingMode || _walkGpsActive) return;
  const candidates = dayKeys().filter(id => {
    const day = DAYS_DATA[id];
    const walk = day.walkReview;
    return !day.hidden && !day.archived && walk?.startedAt && walk.lastAt &&
      (walk.phase === 'paused' || walk.phase === 'recording') && walk.segments?.some(segment => segment.length);
  });
  const id = candidates.includes(currentDay) ? currentDay : candidates.sort((a, b) =>
    DAYS_DATA[b].walkReview.lastAt - DAYS_DATA[a].walkReview.lastAt)[0];
  if (id == null) return;
  const recording = DAYS_DATA[id].walkReview;
  recording.id ||= 'legacy-' + id + '-' + recording.startedAt;
  const walk = walkBroadcastPayload(id);
  _db.ref('gps').transaction(existing => {
    if (_drivingMode || _walkGpsActive || DAYS_DATA[id]?.walkReview !== recording ||
        DAYS_DATA[id].hidden || DAYS_DATA[id].archived) return;
    if (existing?.lat != null && Date.now() - existing.ts < 120000) return;
    if (existing?.walk?.routeId === walk.routeId &&
        existing.walk.day?.walkReview?.lastAt > recording.lastAt) return;
    return {walk, spectator: spectatorWalkPayload(id)};
  }).catch(error => console.warn('Recovered walk GPS:', error));
}

function broadcastWalkPosition(id, position) {
  if (!_db || !CLOUD_CONFIG.canWrite || Date.now() - _lastWalkBroadcastAt < 5000) return;
  const walk = walkBroadcastPayload(id);
  const spectatorWalk = spectatorWalkPayload(id);
  if (!walk && !spectatorWalk) { stopWalkBroadcast(); return; }
  _lastWalkBroadcastAt = Date.now();
  _broadcastWalkDay = id;
  const {latitude: lat, longitude: lng, accuracy, speed} = position.coords;
  const point = {lat, lng, accuracy, speed: gpsSpeedKmh(speed), ts: Date.now()};
  const spectator = spectatorWalk && {...point, ...spectatorWalk};
  _db.ref('gps').set(walk ? {...point, walk, spectator} : {spectator}).catch(error => console.warn('Walk GPS:', error));
}

function spectatorWalkPayload(id) {
  const day = DAYS_DATA[id];
  if (!day?.publicationId || !publicationEntry(id)) return null;
  const walk = walkBroadcastPayload(id, true);
  return walk && {publicationId: day.publicationId, walkMode: true, walk};
}

function stopWalkBroadcast(id = _broadcastWalkDay) {
  if (id === null || !_db || !CLOUD_CONFIG.canWrite || _drivingMode ||
      (_broadcastWalkDay !== null && _broadcastWalkDay !== id)) return;
  const walk = walkBroadcastPayload(id);
  const spectator = spectatorWalkPayload(id);
  _broadcastWalkDay = null;
  _lastWalkBroadcastAt = 0;
  _db.ref('gps').set(walk || spectator ? {walk, spectator} : null).catch(error => console.warn('Walk GPS:', error));
}

// ── FIREBASE WRITE — владелец едет ────────────────────────────────────────────
function _writePosition(lat, lng, speed, accuracy) {
  if (!_db) return;
  _lastOwnerPosition = { lat, lng, speed, accuracy, ts: Date.now() };
  _db.ref('gps').set(Object.assign({}, _lastOwnerPosition, { spectator: spectatorGpsPayload(_lastOwnerPosition) }));
}

function spectatorGpsPayload(point, dayId = currentDay) {
  var day = DAYS_DATA[dayId];
  if ((!_drivingMode && !_walkGpsActive) || !day || day.archived || !day.publicationId || !publicationEntry(dayId)) return null;
  return Object.assign({}, point, { publicationId: day.publicationId, walkMode: !!day.walkMode });
}

function refreshSpectatorGpsVisibility() {
  if (!SPECTATOR_MODE) {
    if (CLOUD_CONFIG.canWrite && _db && _lastOwnerPosition) {
      _db.ref('gps/spectator').set(spectatorGpsPayload(_lastOwnerPosition));
    }
    return;
  }
  var point = _lastSpectatorPosition;
  var day = DAYS_DATA[currentDay];
  var visible = !!point && !!day && day.spectatorLive &&
    day.spectatorPublicationId === point.publicationId &&
    Number.isFinite(point.lat) && Number.isFinite(point.lng) && Date.now() - point.ts < 120000;
  if (!visible) {
    _clearGpsMarker();
    document.body.classList.remove('driving-active');
    _updateSpeedDisplay(null);
    _setGpsControls(false, false);
    document.querySelectorAll('.stop-card.gps-nearest').forEach(function(el) { el.classList.remove('gps-nearest'); el.style.borderLeftColor = ''; el.style.background = ''; });
    return;
  }
  _setGpsControls(true, true);
  document.body.classList.add('driving-active');
  _updateGpsMarker(point.lat, point.lng, point.accuracy, true);
  _highlightNearest(point.lat, point.lng);
  _updateSpeedDisplay(point.speed);
  if (_followCamera && !_userPanned) _panTo(point.lat, point.lng);
}

// ── GPS МАРКЕР ─────────────────────────────────────────────────────────────────
function _getDayColor() {
  if (typeof currentDay !== 'undefined' && typeof DAYS_DATA !== 'undefined') {
    return DAYS_DATA[currentDay]?.color || '#f5a623';
  }
  return '#f5a623';
}

function _makeCarIcon(isRemote) {
  const ringColor = _getDayColor();
  const html = `
    <div style="position:relative;width:44px;height:44px;">
      <div class="gps-ring" style="--gps-color:${ringColor};position:absolute;inset:0;border-radius:50%;background:${ringColor};opacity:0.25;"></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;line-height:1;">${(typeof currentDay!=="undefined"&&DAYS_DATA[currentDay]?.walkMode)?"🚶":"🚗"}</div>
    </div>`;
  return L.divIcon({
    html, className: '', iconSize: [44, 44], iconAnchor: [22, 22]
  });
}
function _updateGpsMarker(lat, lng, accuracy, isRemote) {
  if (!map) return;
  const ringColor = _getDayColor();

  if (_accuracyCircle) {
    _accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy || 20);
    _accuracyCircle.setStyle({ color: ringColor, fillColor: ringColor });
  } else {
    _accuracyCircle = L.circle([lat, lng], {
      radius: accuracy || 20,
      color: ringColor, fillColor: ringColor,
      fillOpacity: 0.07, weight: 1, opacity: 0.25
    }).addTo(map);
  }

  const icon = _makeCarIcon(isRemote);

  if (_gpsMarker) {
    _gpsMarker.setLatLng([lat, lng]).setIcon(icon);
  } else {
    _gpsMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
    _gpsMarker.bindTooltip(isRemote ? '🚗 Путешественник' : '📍 Вы здесь',
      { permanent: false, direction: 'top', offset: [0, -14] });
  }
}

// ── КАМЕРА ─────────────────────────────────────────────────────────────────────
function _panTo(lat, lng) {
  map.panTo([lat, lng], { animate: true, duration: 0.8, easeLinearity: 0.5 });
}

// Кнопка "вернуться к позиции" после ручного движения
function resumeGpsFollow() {
  if (typeof _followPauseTimer !== 'undefined') clearTimeout(_followPauseTimer);
  _userPanned    = false;
  _followCamera  = true;
  document.getElementById('gpsFollowBtn')?.classList.remove('paused');
  if (_gpsMarker) {
    const ll = _gpsMarker.getLatLng();
    _panTo(ll.lat, ll.lng);
  }
}

function gpsSpeedKmh(speed) {
  return Number.isFinite(speed) && speed >= 0 ? Math.round(speed * 3.6) : null;
}

function _setGpsControls(follow, speed) {
  const followBtn = document.getElementById('gpsFollowBtn');
  const speedEl = document.getElementById('speedDisplay');
  if (followBtn) followBtn.style.display = follow ? 'flex' : 'none';
  if (speedEl) speedEl.style.display = speed ? 'flex' : 'none';
}

function _clearGpsMarker() {
  if (_gpsMarker && map) map.removeLayer(_gpsMarker);
  if (_accuracyCircle && map) map.removeLayer(_accuracyCircle);
  _gpsMarker = null;
  _accuracyCircle = null;
}

function setWalkGpsActive(active) {
  _walkGpsActive = active;
  _followCamera = active;
  _userPanned = false;
  document.getElementById('gpsFollowBtn')?.classList.remove('paused');
  _updateSpeedDisplay(null);
  const showOwnerFix = !active && _hasOwnerFix && !!_gpsMarker;
  _setGpsControls(showOwnerFix, active);
  if (!active && !showOwnerFix) _clearGpsMarker();
}

function updateWalkGpsControls(position) {
  const {latitude, longitude, accuracy, speed} = position.coords;
  _updateGpsMarker(latitude, longitude, accuracy, false);
  _showEl('gpsFollowBtn');
  _updateSpeedDisplay(gpsSpeedKmh(speed));
  if (_followCamera && !_userPanned) _panTo(latitude, longitude);
}

// ── РЕЖИМ "ЕДУ" — только владелец ─────────────────────────────────────────────
function toggleDrivingMode() {
  if (_walkGpsActive || !isAdmin()) return;
  if (typeof isDemoMode === 'function' && isDemoMode() && !routeHintsPreviewEnabled()) {
    showToast && showToast('📱 Это демо-режим. Настройте Firebase в ⚙ для GPS-трекинга');
    return;
  }
  _drivingMode  = !_drivingMode;
  _lastOwnerPosition = null;
  _followCamera = _drivingMode;
  _userPanned   = false;
  _resetRouteHints();

  const btn = document.getElementById('drivingBtn');
  if (btn) {
    btn.classList.toggle('active', _drivingMode);
    const _isWalk = typeof currentDay!=='undefined'&&DAYS_DATA[currentDay]?.walkMode;
    btn.innerHTML = dayActionIcon(_drivingMode ? 'stop' : (_isWalk ? 'walk' : 'car')) + (_drivingMode ? ' Стоп' : (_isWalk ? ' Иду' : ' Еду'));
  }
  document.body.classList.toggle('driving-active', _drivingMode);

  _setGpsControls(_drivingMode || _hasOwnerFix, _drivingMode);
  const followBtn = document.getElementById('gpsFollowBtn');
  followBtn?.classList.remove('paused');

  // Keep-alive: держим WebSocket живым для уведомлений
  if (_drivingMode) {
    startKeepAlive();
    if (!routeHintsPreviewEnabled()) _acquireWakeLock();
  } else {
    stopKeepAlive();
    _releaseWakeLock();
    _updateSpeedDisplay(null);
    if (_db) _db.ref('gps').remove();
    // Снять подсветку ближайшей точки
    _nearestStopId = null;
    document.querySelectorAll('.stop-card.gps-nearest').forEach(function(el) {
      el.classList.remove('gps-nearest');
      el.style.borderLeftColor = '';
      el.style.background = '';
      var num = el.querySelector('.stop-num');
      if (num) num.style.background = '';
    });
  }
}

// ── WAKE LOCK — держит экран активным в режиме «Еду» ─────────────────────────
let _wakeLock = null;

async function _acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch(e) {
    // Недостаточно заряда или документ не в фокусе — не критично
    console.warn('[gps] WakeLock not acquired:', e.message);
  }
}

function _releaseWakeLock() {
  if (_wakeLock) { _wakeLock.release(); _wakeLock = null; }
}

// Перезахватываем Wake Lock если браузер/ОС сам отпустил его (экран погас и снова включился)
document.addEventListener('visibilitychange', function() {
  if (_drivingMode && document.visibilityState === 'visible' && !_wakeLock) {
    _acquireWakeLock();
  }
});
// Тихий осциллятор не даёт браузеру заморозить вкладку.
// Включается при "Еду" или вручную через 📌 в чате.
// Переиспользует общий AudioContext из chat.js (_dingCtx) если есть.

function startKeepAlive() {
  if (_keepAliveCtx) return; // уже запущен
  try {
    // Переиспользуем общий AudioContext если есть (chat.js создаёт его)
    if (typeof _dingCtx !== 'undefined' && _dingCtx && _dingCtx.state !== 'closed') {
      _keepAliveCtx = _dingCtx;
    } else {
      _keepAliveCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Делаем доступным для chat.js
      if (typeof _dingCtx !== 'undefined') _dingCtx = _keepAliveCtx;
    }
    if (_keepAliveCtx.state === 'suspended') _keepAliveCtx.resume();
    _keepAliveOsc = _keepAliveCtx.createOscillator();
    const gain    = _keepAliveCtx.createGain();
    gain.gain.value = 0.001; // практически беззвучно
    _keepAliveOsc.connect(gain);
    gain.connect(_keepAliveCtx.destination);
    _keepAliveOsc.start();
    console.log('[keep-alive] Started');
  } catch(e) { console.warn('[keep-alive] Failed:', e); }
}

function stopKeepAlive() {
  if (!_keepAliveOsc) return;
  try {
    _keepAliveOsc.stop();
  } catch(e) {}
  _keepAliveOsc = null;
  // НЕ закрываем AudioContext — он нужен для звука уведомлений
  _keepAliveCtx = null;
  console.log('[keep-alive] Stopped');
}

function isKeepAliveActive() {
  return !!_keepAliveCtx;
}

// ── БЛИЖАЙШАЯ ТОЧКА ────────────────────────────────────────────────────────────
function _highlightNearest(lat, lng) {
  if (typeof currentDay === 'undefined' || typeof DAYS_DATA === 'undefined') return;
  const dayData = DAYS_DATA[currentDay];
  if (!dayData?.stops?.length) return;

  // Ищем первую непосещённую точку (без arrA) — это текущая цель
  var firstUnvisited = -1;
  for (var fi = 0; fi < dayData.stops.length; fi++) {
    if (!dayData.stops[fi].arrA) { firstUnvisited = fi; break; }
  }

  var nearestId = firstUnvisited >= 0 ? dayData.stops[firstUnvisited].id : null;

  if (nearestId === _nearestStopId) return;
  _nearestStopId = nearestId;

  document.querySelectorAll('.stop-card').forEach(el => {
    el.classList.remove('gps-nearest');
    el.style.borderLeftColor = '';
    el.style.background = '';
    var num = el.querySelector('.stop-num');
    if (num) num.style.background = '';
  });
  if (nearestId) {
    const card = document.getElementById('card-' + nearestId);
    const color = dayData.color || '#f5a623';
    if (card) {
      card.classList.add('gps-nearest');
      card.style.borderLeftColor = color;
      card.style.background = color + '0f';
      var num = card.querySelector('.stop-num');
      if (num) num.style.background = color;
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

// ── СПИДОМЕТР ──────────────────────────────────────────────────────────────────
function _updateSpeedDisplay(kmh) {
  const el = document.getElementById('speedDisplay');
  if (!el) return;
  const val = kmh != null ? kmh : '—';
  el.innerHTML = `<span class="spd-val">${val}</span><span class="spd-unit">км/ч</span>`;
}

// ── HELPERS ────────────────────────────────────────────────────────────────────
function _showEl(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

// ── ПУБЛИЧНЫЙ МЕТОД: обновить иконку маркера при смене дня ────────────────────
// Вызывается из switchDay() в app.js когда пользователь переключает вкладку дня.
// Без этого иконка 🚗/🚶 залипает до следующего Firebase-события.
function refreshGpsMarkerIcon() {
  if (!_gpsMarker) return; // демо-режим или GPS ещё не запущен — ничего не делаем
  var isRemote = !_walkGpsActive && typeof CLOUD_CONFIG !== 'undefined' && !CLOUD_CONFIG.canWrite;
  var newIcon = _makeCarIcon(isRemote);
  _gpsMarker.setIcon(newIcon);
  // Обновляем тултип — он создаётся один раз при первом появлении маркера
  var isWalk = typeof currentDay !== 'undefined' && DAYS_DATA[currentDay]?.walkMode;
  var label = isRemote
    ? (isWalk ? '🚶 Путешественник' : '🚗 Путешественник')
    : '📍 Вы здесь';
  _gpsMarker.unbindTooltip();
  _gpsMarker.bindTooltip(label, { permanent: false, direction: 'top', offset: [0, -14] });
}

// ── ROUTE HINTS ────────────────────────────────────────────────────────────────
var _routeHintTimer      = null;
const _routeHintShownIds = new Set();
const _pendingDrivingLegs = new Map();
const _HINT_TYPES = { 'Заправка': '⛽', 'Кафе': '☕', 'Магазин': '🛒' };
const ROUTE_HINT_DURATION_MS = 10000;
let _lastRouteDing = -Infinity;
let _maneuverExpiry = null;
let _visibleManeuverId = null;

function routeHintsPreviewEnabled() {
  return typeof LOCAL_PREVIEW !== 'undefined' && LOCAL_PREVIEW && isAdmin() &&
    new URLSearchParams(location.search).get('sample') === 'route-hints';
}

function _setRouteHint(id, hint) {
  const panel = document.getElementById('routeHint');
  const row = document.getElementById(id);
  row.hidden = !hint;
  if (hint) {
    row.querySelector('.route-hint-icon').textContent = hint.icon;
    row.querySelector('strong').textContent = hint.title;
    row.querySelector('.route-hint-detail').textContent = hint.detail;
  }
  panel.hidden = [...panel.children].every(child => child.hidden);
}

function _resetRouteHints() {
  clearTimeout(_routeHintTimer);
  clearTimeout(_maneuverExpiry);
  _visibleManeuverId = null;
  _routeHintShownIds.clear();
  _lastRouteDing = -Infinity;
  _setRouteHint('routeManeuver', null);
  _setRouteHint('routePlace', null);
}

function _dingRouteHint(id) {
  if (_routeHintShownIds.has(id)) return;
  _routeHintShownIds.add(id);
  if (Date.now() - _lastRouteDing < 2000) return;
  _lastRouteDing = Date.now();
  if (typeof _playDing === 'function') _playDing();
}

function _maneuverLabel(maneuver) {
  const {type, modifier, exit} = maneuver || {};
  const direction = modifier?.endsWith('left') ? 'налево' : modifier?.endsWith('right') ? 'направо' : '';
  const arrow = direction === 'налево' ? '↰' : direction ? '↱' : '↑';
  if (modifier === 'uturn') return ['↶', 'Разворот'];
  if (/roundabout|rotary/.test(type || '')) return ['↻', exit ? 'Кольцо · съезд ' + exit : 'Кольцо'];
  if (type === 'off ramp' || type === 'on ramp') {
    return [arrow, [type === 'off ramp' ? 'Съезд' : 'Въезд', direction].filter(Boolean).join(' ')];
  }
  if (type === 'fork' || type === 'merge') return [arrow, direction ? 'Держитесь ' + direction : 'Держитесь прямо'];
  if (direction && ['turn', 'end of road', 'continue'].includes(type)) return [arrow, 'Поворот ' + direction];
  return null;
}

function _nextDrivingManeuver(steps, {latitude, longitude, accuracy, heading}) {
  const xScale = 111320 * Math.cos(latitude * Math.PI / 180);
  const yScale = 111320;
  let along = 0;
  let closest = Math.min(55, Math.max(25, accuracy));
  let progress = null;
  const maneuvers = [];
  steps.forEach((step, index) => {
    const label = _maneuverLabel(step.maneuver);
    if (label) maneuvers.push({along, label, index, street: step.name});
    const line = step.geometry?.coordinates || [];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const dx = (b[0] - a[0]) * xScale, dy = (b[1] - a[1]) * yScale;
      const length = Math.hypot(dx, dy);
      if (!length) continue;
      const x = (longitude - a[0]) * xScale, y = (latitude - a[1]) * yScale;
      const ratio = Math.max(0, Math.min(1, (x * dx + y * dy) / (length * length)));
      const offset = Math.hypot(x - ratio * dx, y - ratio * dy);
      const bearing = Math.atan2(dx, dy) * 180 / Math.PI;
      const aligned = !Number.isFinite(heading) || Math.cos((heading - bearing) * Math.PI / 180) > 0;
      if (aligned && offset < closest) {
        closest = offset;
        progress = along + ratio * length;
      }
      along += length;
    }
  });
  if (progress === null) return null;
  const next = maneuvers.find(item => item.along >= progress && item.along - progress <= 400);
  return next && {...next, meters: next.along - progress};
}

function _checkRouteHints(fix) {
  const day = DAYS_DATA[currentDay];
  if (!_drivingMode || !isAdmin() || !day || day.walkMode || day.archived) return;
  const id = currentDay;
  const index = day.stops.findIndex(stop => !stop.arrA);
  const to = day.stops[index];
  const from = index > 0 ? day.stops[index - 1] : day.start;
  const key = to && `driving|${from.lat},${from.lng}|${to.lat},${to.lng}`;
  let maneuver;
  if (key && (from.lat || from.lng) && (to.lat || to.lng) && fix.accuracy <= 50) {
    if (!drivingSteps.has(key) && !routeHintsPreviewEnabled() && Date.now() >= osrmRetryAt &&
        Date.now() >= (_pendingDrivingLegs.get(key) || 0)) {
      _pendingDrivingLegs.set(key, Infinity);
      fetchRoadSegment(from, to, 'driving', true).catch(() => {}).finally(() => {
        _pendingDrivingLegs.set(key, Date.now() + 120000);
      });
    }
    maneuver = _nextDrivingManeuver(drivingSteps.get(key) || [], fix);
  }
  if (maneuver) {
    const maneuverId = id + ':' + key + ':' + maneuver.index;
    if (!_routeHintShownIds.has(maneuverId)) {
      clearTimeout(_maneuverExpiry);
      _visibleManeuverId = maneuverId;
      _dingRouteHint(maneuverId);
      _maneuverExpiry = setTimeout(() => {
        _visibleManeuverId = null;
        _setRouteHint('routeManeuver', null);
      }, ROUTE_HINT_DURATION_MS);
    }
    const [icon, title] = maneuver.label;
    const meters = Math.min(400, Math.ceil(maneuver.meters / 10) * 10);
    const detail = (meters ? 'Через ' + meters + ' м' : 'Сейчас') + (maneuver.street ? ' · ' + maneuver.street : '');
    _setRouteHint('routeManeuver', _visibleManeuverId === maneuverId ? {icon, title, detail} : null);
  } else _setRouteHint('routeManeuver', null);

  if (!Number.isFinite(fix.accuracy) || fix.accuracy > 50) return;
  const place = day.stops.find(stop => _HINT_TYPES[stop.type] && !stop.arrA &&
    !_routeHintShownIds.has('place:' + stop.id) && (stop.lat || stop.lng) &&
    _haversineKmPts(fix.latitude, fix.longitude, stop.lat, stop.lng) <= 1);
  if (!place || !document.getElementById('routePlace').hidden) return;
  _setRouteHint('routePlace', {icon: _HINT_TYPES[place.type], title: place.type, detail: 'В пределах 1 км'});
  _dingRouteHint('place:' + place.id);
  _routeHintTimer = setTimeout(() => _setRouteHint('routePlace', null), ROUTE_HINT_DURATION_MS);
}

function _haversineKmPts(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
          Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
