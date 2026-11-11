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
let _gpsWatchFailed = false;
let _gpsMarker      = null;   // Leaflet marker — текущая позиция
let _gpsCourse = null;
let _gpsCourseAnchor = null;
let _gpsVehicleStyle = 'compact';
let _gpsRemoteVehicleStyle = null;
const GPS_WALK_LABELS = {person: 'Городской пешеход', dog: 'С собакой'};
const GPS_WALK_SEASONS = {summer:'Лето', autumn:'Осень', winter:'Зима', spring:'Весна'};
for (const base of ['person','dog']) for (const season of ['summer','winter','spring']) {
  GPS_WALK_LABELS[base + '-' + season] = GPS_WALK_LABELS[base] + ' · ' + GPS_WALK_SEASONS[season];
}
function walkStyleParts(style) {
  const [base, season = 'autumn'] = String(style || 'person').split('-');
  return {base:base === 'dog' ? 'dog' : 'person', season:Object.hasOwn(GPS_WALK_SEASONS, season) ? season : 'autumn'};
}
function walkStyleValue(base, season) { return base + (season === 'autumn' ? '' : '-' + season); }
function walkIconStyle(day) {
  const remote = typeof isAdmin === 'function' && !isAdmin();
  const target = day || DAYS_DATA[currentDay];
  const style = remote ? ((target === DAYS_DATA[currentDay] ? _gpsRemoteWalkStyle : null) || target?.gpsWalkStyle || 'person') : _gpsWalkStyle;
  return Object.hasOwn(GPS_WALK_LABELS, style) ? style : 'person';
}
function _rememberWalkStyle() {
  const day = DAYS_DATA[currentDay];
  if (!day?.walkMode || day.gpsWalkStyle === _gpsWalkStyle) return;
  day.gpsWalkStyle = _gpsWalkStyle;
  if (typeof saveData === 'function') saveData();
}
let _gpsWalkStyle = 'person';
let _gpsRemoteWalkStyle = null;
let _gpsWalkCourse = null;
let _gpsWalkCadence = 0;
let _gpsWalkIdleTimer = null;
try {
  const saved = localStorage.getItem('travel_gps_walker');
  if (Object.hasOwn(GPS_WALK_LABELS, saved)) _gpsWalkStyle = saved;
} catch {}
let _gpsBraking = false;
let _previousDrivingSpeed = null;
let _accuracyCircle = null;   // Leaflet circle — кружок погрешности
let _drivingMode    = false;  // владелец нажал "Еду"
let _walkGpsActive  = false;
let _hasOwnerFix    = false;
let _lastOwnerHintFix = null;
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

// Camera orientation is local to the administrator; it never writes route data.
let _courseUp = false;
try { _courseUp = localStorage.getItem('travel_course_up') === '1'; } catch {}
function _canRotateCamera() {
  return typeof isAdmin === 'function' && isAdmin() && _drivingMode && !DAYS_DATA[currentDay]?.walkMode;
}
function _renderBearingButton() {
  const btn = document.getElementById('gpsBearingBtn');
  if (!btn) return;
  btn.style.display = _canRotateCamera() ? 'flex' : 'none';
  btn.setAttribute('aria-pressed', String(_courseUp));
  btn.title = btn.ariaLabel = _courseUp ? 'Север сверху' : 'По ходу движения';
  btn.classList.toggle('course-up', _courseUp);
  const needle = btn.querySelector('svg');
  if (needle) needle.style.transform = `rotate(${map.getBearing?.() || 0}deg)`;
}
function toggleMapBearing() {
  if (!_canRotateCamera()) return;
  _courseUp = !_courseUp;
  try { localStorage.setItem('travel_course_up', _courseUp ? '1' : '0'); } catch {}
  resumeGpsFollow();
  _syncMapBearing();
}
function _syncMapBearing() {
  if (typeof map === 'undefined' || !map.setBearing) return;
  _renderBearingButton();
  if (!_canRotateCamera() || !_courseUp) {
    if (Math.abs(map.getBearing()) > .01) map.setBearing(0, {animate:true, duration:.6});
    return;
  }
  // Keep the last orientation while standing or inspecting the map manually.
  const fix = _lastOwnerHintFix?.coords;
  if (_userPanned || !_followCamera || !fix || !Number.isFinite(fix.speed) || fix.speed < .5 || !Number.isFinite(_gpsCourse)) return;
  const target = -_gpsCourse;
  const delta = ((target - map.getBearing() + 540) % 360 + 360) % 360 - 180;
  if (Math.abs(delta) >= 2) map.setBearing(map.getBearing() + delta, {animate:true, duration:.7});
}

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
  map.on('rotate', () => {
    if (_gpsMarker) _gpsMarker.setIcon(_makeCarIcon());
    _renderBearingButton();
  });
  let _followPauseTimer = null;
  map.on('dragstart', () => {
    if (!_followCamera) return;
    _userPanned = true;
    if (map.setBearing) map.setBearing(map.getBearing());
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
  if (_watchId !== null) navigator.geolocation.clearWatch(_watchId);
  _gpsWatchFailed = false;
  const watchId = navigator.geolocation.watchPosition(
    position => {
      if (_watchId !== watchId) return;
      _gpsWatchFailed = false;
      _onPosition(position);
    },
    err => {
      if (_watchId !== watchId) return;
      _gpsWatchFailed = true;
      console.warn('GPS:', err.message);
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
  _watchId = watchId;
}

function _onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy, speed, heading } = pos.coords;
  _hasOwnerFix = true;
  if (_walkGpsActive) return;
  _lastOwnerHintFix = {coords: pos.coords, at: Date.now()};
  const kmh = gpsSpeedKmh(speed);

  const braking = _drivingMode && _drivingBrakeLights(kmh);
  _updateGpsMarker(lat, lng, accuracy, false, heading, undefined, braking, kmh);
  _showEl('gpsFollowBtn');
  _highlightNearest(lat, lng);

  if (_drivingMode) {
    _updateDriveProgress(pos.coords);
    _checkRouteHints(pos.coords);
    _updateSpeedDisplay(kmh);
    const point = { lat, lng, speed: kmh, accuracy, ts: Date.now() };
    // Всегда пишем в IndexedDB (для GPX-экспорта и оффлайн)
    if (typeof saveGpsPoint === 'function') saveGpsPoint(point);
    // Пишем в Firebase (с оффлайн-буфером)
    if (typeof bufferGpsForSync === 'function' && bufferGpsForSync(point)) {
      // Буферизировано — нет сети
    } else {
      _writePosition(lat, lng, kmh, accuracy, _gpsCourse, braking);
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
    _updateGpsMarker(d.lat, d.lng, d.accuracy, true, d.heading, d.vehicleStyle, d.braking ?? d.speed === 0, d.speed, d.walkStyle);
    _applyRemoteDriveState(d);
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
    if (!sameRecordedWalk(existing, walk.day) || existing.walkReview.phase === 'finished') return false;
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
  if (day.walkReview && (day.walkReview.phase === 'finished' ||
      !sameRecordedWalk(day, walk.day) || compareWalkProgress(walk.day, day) <= 0)) return null;
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
  const {latitude: lat, longitude: lng, accuracy, speed, heading} = position.coords;
  const point = {lat, lng, accuracy, speed: gpsSpeedKmh(speed), ts: Date.now(), walkStyle: _gpsWalkStyle};
  if (Number.isFinite(heading) && heading >= 0 && heading < 360) point.heading = heading;
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
function _writePosition(lat, lng, speed, accuracy, heading, braking = false) {
  if (!_db) return;
  _lastOwnerPosition = { lat, lng, speed, accuracy, ts: Date.now(), dayId: currentDay, routeId: CLOUD_CONFIG.binId || null };
  const liveProgress = routeDriveState(currentDay);
  if (liveProgress) _lastOwnerPosition.driveProgress = {routeKey: liveProgress.routeKey, fraction: liveProgress.fraction};
  if (Number.isFinite(heading)) _lastOwnerPosition.heading = heading;
  if (!DAYS_DATA[currentDay]?.walkMode) {
    _lastOwnerPosition.vehicleStyle = _gpsVehicleStyle;
    _lastOwnerPosition.braking = braking;
  } else {
    _lastOwnerPosition.walkStyle = _gpsWalkStyle;
  }
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
  _updateGpsMarker(point.lat, point.lng, point.accuracy, true, point.heading, point.vehicleStyle, point.braking ?? point.speed === 0, point.speed, point.walkStyle);
  _applyRemoteDriveState(point);
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

function _updateGpsCourse(lat, lng, accuracy, heading) {
  if (Number.isFinite(heading) && heading >= 0 && heading < 360) {
    _gpsCourse = heading;
    _gpsCourseAnchor = {lat, lng, accuracy};
    return;
  }
  if (!Number.isFinite(accuracy) || accuracy > 50) return;
  if (!_gpsCourseAnchor || !Number.isFinite(_gpsCourseAnchor.accuracy) || _gpsCourseAnchor.accuracy > 50) {
    _gpsCourseAnchor = {lat, lng, accuracy};
    return;
  }
  const from = _gpsCourseAnchor;
  // Wait until movement exceeds the uncertainty of the two fixes.
  const distance = _haversineKmPts(from.lat, from.lng, lat, lng) * 1000;
  if (distance < Math.max(12, from.accuracy + accuracy)) return;
  const radians = Math.PI / 180;
  const east = (lng - from.lng) * Math.cos((lat + from.lat) / 2 * radians);
  _gpsCourse = (Math.atan2(east, lat - from.lat) / radians + 360) % 360;
  _gpsCourseAnchor = {lat, lng, accuracy};
}

const GPS_CAR_SHAPES = {
  compact: {
    body: 'M7 2.4q5-1.1 10 0c2.2.5 3.5 2.5 3.5 5.1l.1 17c0 2.6-1.4 4.5-3.7 5.1q-4.9.9-9.8 0c-2.3-.6-3.7-2.5-3.7-5.1l.1-17C3.5 4.9 4.8 2.9 7 2.4Z',
    lights: 'M5 5.5 8 6.2m8 0 3-.7',
    tailLights: 'M5.1 26.5 8 27.3m8 0 2.9-.8',
    details: `
      <path d="M4 10 1.7 11v1.5H4m16-2.5 2.3 1v1.5H20" fill="var(--gps-paint)" stroke="#202630" stroke-width=".65"/>
      <path d="M6.6 8.5q5.4-1.5 10.8 0l1.3 4.5q-6.7 1.8-13.4 0ZM6.6 21.2q5.4.8 10.8 0l.8 3.2q-6.2.9-12.4 0Z" fill="#192b36"/>
      <path d="M7 9.2q4-1 8-.7l-8.8 3.3Z" fill="#8daebf" opacity=".64"/>
      <path d="M5 14.5h1.1v5.9L5 19.7Zm14 0h-1.1v5.9l1.1-.7Z" fill="#24343e"/>
      <path d="M8 15.5q4-.7 8 0m-7 10.8h6" fill="none" stroke="#fff" stroke-opacity=".49" stroke-width=".65" stroke-linecap="round"/>`,
  },
  sport: {
    body: 'M8 2.5q4-1 8 0c3.7 1.1 5.2 4 5 7.2l-1.1 7.7 1.9 7.4c.6 2.4-.6 4.4-3 4.8H5.2c-2.4-.4-3.6-2.4-3-4.8l1.9-7.4L3 9.7C2.8 6.5 4.3 3.6 8 2.5Z',
    lights: 'M4.9 6.6 8 4.6m8 0 3.1 2',
    tailLights: 'M4.6 26.4h4m6.8 0h4',
    details: `
      <path d="M6.8 8.5q5.2-1.7 10.4 0l1.4 5.4q-6.6 1.2-13.2 0Z" fill="#1b2b36"/>
      <path d="M7.2 9.1q4.6-1.4 8.6-.7l-9.4 3.4Z" fill="#95bacb" opacity=".58"/>
      <path d="M8 19.8q4 .8 8 0l1.7 4.8q-5.7 1-11.4 0Z" fill="#25333d"/>
      <path d="m6 15-1 5m13-5 1 5M4.9 28.5h14.2" stroke="#212832" stroke-width="1.15" stroke-linecap="round"/>
      <path d="M9 16.1h6m-6 6h6m-6 1.2h6" stroke="#b7c4c9" stroke-opacity=".58" stroke-width=".55" stroke-linecap="round"/>`,
  },
  suv: {
    body: 'M5.1 2.7h13.8q2.2.3 2.5 2.9l.6 20.1q0 3.4-3 3.7H5q-3-.3-3-3.7l.6-20.1q.3-2.6 2.5-2.9Z',
    lights: 'M4.4 5.4h3m9.2 0h3',
    tailLights: 'M4.7 25.2v2.3m14.6-2.3v2.3',
    details: `
      <path d="M3.3 9.5 1 10.2v2.2h2.3m17.4-2.9 2.3.7v2.2h-2.3" fill="#29303a"/>
      <path d="M8.6 5.4h6.8M5.6 7.7h12.8l1 4.5H4.6ZM6 23h12v3.6H6Z" fill="#1b2b34" stroke="#3f4a50" stroke-width=".65"/>
      <path d="M6 8.1h10l-10.5 2.7Z" fill="#89a6b6" opacity=".62"/>
      <path d="M5.6 13.7v7.9m12.8-7.9v7.9" stroke="#d0d6d7" stroke-width="1.05" stroke-linecap="round"/>
      <path d="M7.5 15.4h9m-9 4.7h9" stroke="#384450" stroke-width=".85" stroke-linecap="round"/>`,
  },
  ix35: {
    body: 'M5 3.1Q12 .9 19 3.1c1.7 1 2.4 3.5 2.5 6.5l.4 13.9c0 3.5-1.7 5.7-4.8 6.3H6.9c-3.1-.6-4.8-2.8-4.8-6.3l.4-13.9C2.6 6.6 3.3 4.1 5 3.1Z',
    lights: 'M4.5 5.2q1.1.9 2.7 1.8m9.6 0q1.6-.9 2.7-1.8',
    tailLights: 'M4 25.9q1 1.5 2.8 1.8m10.4 0q1.8-.3 2.8-1.8',
    color: '#51352e',
    details: `
      <path d="M3.8 10.3 1 11.6q-.8 1.1.4 1.6l2.5-.3m16.3-2.6 2.8 1.3q.8 1.1-.4 1.6l-2.5-.3" fill="#6f5045" stroke="#251a19" stroke-width=".55"/>
      <path d="M8 4q4 .7 8 0M7 5.2l1.2 2.1m8.8-2.1-1.2 2.1" fill="none" stroke="#d5b8a6" stroke-opacity=".65" stroke-width=".55"/>
      <path d="M6.1 8.2q5.9-1.8 11.8 0l1 4.3q-6.9 1.7-13.8 0Z" fill="#18242c" stroke="#6b7d84" stroke-width=".5"/>
      <path d="M6.8 8.8q4.1-1.1 8.5-.7l-8.9 3.3Z" fill="#7d9ba9" opacity=".52"/>
      <path d="M4.5 13.8 5 22l1.3 1.4-.3-9.1Zm15 0L19 22l-1.3 1.4.3-9.1Z" fill="#1c232a"/>
      <path d="M7.3 14.7v7m9.4-7v7" stroke="#c8c2bb" stroke-width=".7" stroke-linecap="round"/>
      <path d="M7 23.8q5 1 10 0l.6 2.3q-5.6 1.4-11.2 0Z" fill="#1d252b"/>
      <path d="M9 28.4h6" stroke="#292322" stroke-width=".85" stroke-linecap="round"/>`,
  },
  arrow: {
    body: 'M12 3 22 27 12 22 2 27Z',
    details: `
      <path d="M12 4.6 12 22 3.5 25.9Z" fill="#fff" opacity=".22"/>
      <path d="M12 4.6 20.5 25.9 12 22Z" fill="#0b1525" opacity=".3"/>
      <path d="M12 6.2v14.6" stroke="#fff" stroke-opacity=".58" stroke-width=".7" stroke-linecap="round"/>`,
  },
};

const GPS_CAR_PROFILES = {
  compact: {
    body:'M3 24v-7l6-3 10-8h17l12 8 10 3 3 5-1 7H4Z',
    glass:'m11 14 9-6h15l10 6Z',
    roof:'m19 6 4-2h14l11 8-3 2-10-6H20Z',
    hood:'m45 14 4-2 11 5-2 3-12-3Z',
  },
  sport: {
    body:'M3 25v-5l12-4 11-9h12l11 8 10 3 3 5-2 6H4Z',
    glass:'m17 16 10-7h10l9 7Z',
    roof:'m26 7 3-2h10l10 8-3 3-9-7H27Z',
    hood:'m46 16 4-3 10 5-2 3Z',
  },
  suv: {
    body:'M3 26V9l4-4h30l11 9 11 3 3 6-2 6H4Z',
    glass:'M7 9h28l10 7H7Z',
    roof:'m7 5 4-2h28l9 9-3 4-10-7H7Z',
    hood:'m45 16 4-3 11 4-2 4Z',
  },
  ix35: {
    body:'M3 25V14l4-4 14-6h15l11 10 11 3 4 6-2 6H4Z',
    glass:'m8 15 14-9h13l9 9Z',
    roof:'m21 4 4-2h12l10 10-3 3-9-9H22Z',
    hood:'m44 15 4-3 11 5-2 4Z',
  },
};

// Shared progress is carried by the existing GPS message, never by Gist polling.
var _routeDriveStates = new Map();
function driveRouteKey(day) {
  if (!day) return '';
  return [day.walkMode ? 'foot' : 'driving', ...[day.start, ...(day.stops || [])].map(p => p ? p.lat + ',' + p.lng : '')].join('|');
}
function routeDriveState(dayId) {
  const saved = _routeDriveStates.get(Number(dayId));
  return saved?.routeKey === driveRouteKey(DAYS_DATA[dayId]) ? saved : null;
}
function routeDriveFraction(dayId) {
  return routeDriveState(dayId)?.fraction || 0;
}
function _storeDriveProgress(dayId, fraction, vehicleStyle) {
  const previous = routeDriveState(dayId);
  const next = {routeKey: driveRouteKey(DAYS_DATA[dayId]), fraction: Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : (previous?.fraction || 0),
    vehicleStyle: Object.hasOwn(GPS_CAR_SHAPES, vehicleStyle) ? vehicleStyle : previous?.vehicleStyle};
  _routeDriveStates.set(Number(dayId), next);
  return next;
}
function _rememberDriveVehicleStyle() {
  const day = DAYS_DATA[currentDay];
  if (!day || day.walkMode || day.gpsVehicleStyle === _gpsVehicleStyle) return;
  day.gpsVehicleStyle = _gpsVehicleStyle;
  _storeDriveProgress(currentDay, undefined, _gpsVehicleStyle);
  if (typeof saveData === 'function') saveData();
}
function _applyRemoteDriveState(point) {
  const day = DAYS_DATA[currentDay];
  if (!day || day.walkReview) return;
  const isSpectator = typeof SPECTATOR_MODE !== 'undefined' && SPECTATOR_MODE;
  if (point.routeId && point.routeId !== CLOUD_CONFIG.binId) return;
  if (isSpectator ? point.publicationId !== day.spectatorPublicationId : point.dayId != null && Number(point.dayId) !== Number(currentDay)) return;
  const progress = point.driveProgress;
  const sameRoute = progress?.routeKey === driveRouteKey(day);
  if (progress && !sameRoute) return;
  _storeDriveProgress(currentDay, sameRoute ? progress.fraction : undefined, point.vehicleStyle);
  refreshProgressVehicleIcons();
  if (sameRoute && Number.isFinite(progress.fraction)) {
    if (typeof updateRouteProgress === 'function') updateRouteProgress(currentDay);
  } else {
    // Older owners send coordinates only. Match cached geometry without fetching.
    _updateDriveProgress({latitude:point.lat, longitude:point.lng, accuracy:point.accuracy,
      heading:point.heading, speed:Number.isFinite(point.speed) ? point.speed / 3.6 : undefined});
  }
}

function progressVehicleGlyph(dayId = currentDay) {
  let style = routeDriveState(dayId)?.vehicleStyle || DAYS_DATA[dayId]?.gpsVehicleStyle || _gpsRemoteVehicleStyle || _gpsVehicleStyle;
  if (typeof LOCAL_PREVIEW !== 'undefined' && LOCAL_PREVIEW &&
      new URLSearchParams(location.search).get('sample') === 'route-progress') {
    const selected = localStorage.getItem('travel_gps_vehicle');
    style = Object.hasOwn(GPS_CAR_SHAPES, selected) ? selected : 'ix35';
  }
  if (style === 'arrow') {
    return '<svg viewBox="0 0 32 20" aria-hidden="true"><path d="m6 3 22 7-22 7 4-7Z" fill="currentColor"/><path d="m10 10 18 0-22 7Z" fill="#000" opacity=".28"/></svg>';
  }
  const profile = GPS_CAR_PROFILES[style] || GPS_CAR_PROFILES.ix35;
  const paint = GPS_CAR_SHAPES[style]?.color || 'var(--gps-theme-paint, var(--accent))';
  const uid = 'progress-car-' + (progressVehicleGlyph._serial = (progressVehicleGlyph._serial || 0) + 1);
  if (style === 'ix35') {
    return `<svg viewBox="0 0 84 40" aria-hidden="true">
      <defs>
        <linearGradient id="${uid}-ixbody" x2=".15" y2="1"><stop stop-color="#b7a59c"/><stop offset=".22" stop-color="#80665b"/><stop offset=".5" stop-color="#5a4038"/><stop offset=".72" stop-color="#362720"/><stop offset="1" stop-color="#76564a"/></linearGradient>
        <linearGradient id="${uid}-ixglass" x2=".8" y2="1"><stop stop-color="#9aafb1"/><stop offset=".18" stop-color="#31434a"/><stop offset=".7" stop-color="#101d26"/><stop offset="1" stop-color="#55666b"/></linearGradient>
        <radialGradient id="${uid}-ixrim" cx=".35" cy=".25" r=".8"><stop stop-color="#f6f3ed"/><stop offset=".55" stop-color="#a6adb0"/><stop offset="1" stop-color="#3b464f"/></radialGradient>
      </defs>
      <ellipse cx="43" cy="35" rx="39" ry="2.5" fill="#000" opacity=".42"/>
      <path d="M4 29 3 21l3-8 6-3q9-5 22-5h13q7 1 16 11l13 3q5 1 6 8l-1 5-8 2H11Z" fill="url(#${uid}-ixbody)" stroke="#baa69a" stroke-width=".7"/>
      <path d="m8 15 9-5q7-3 17-3h12q6 1 14 10l-29 .5Z" fill="url(#${uid}-ixglass)" stroke="#b3b4af" stroke-width=".8"/>
      <path d="m8 15 12 2 2-7-5 1ZM25 9l-2 8.5 12-.2-.2-9.5ZM38 8l.2 9.2 19-.3-11-9Z" fill="#15232c" opacity=".7"/>
      <path d="m13 13 16-4M39 9l10 5" stroke="#c4d9da" stroke-width="1.2" opacity=".4"/>
      <path d="M22 18.5 21 29M37 18l.5 12M58 18l-3 12" stroke="#291d19" stroke-width=".9"/>
      <path d="m8 20 24-.5 28-1M26 26l24 3 10-5" fill="none" stroke="#c8aca0" stroke-width=".8" opacity=".75"/>
      <path d="M7 28q10 3 15 2h36l19-3-2 6H11Z" fill="#151b20"/>
      <path d="M8 31q0-11 10-11t10 12M56 32q0-12 10-12t10 11" fill="#11171e"/>
      <path d="m60 17 4-1 14 4-3 2-14-2Z" fill="#c8b0a0" opacity=".35"/>
      <path d="m76 23 6 1-1 8-7 2Z" fill="#161c22"/><path d="m77 25 4 .5m-4 2 4 .5" stroke="#999ea0" stroke-width=".8"/>
      <path d="m64 18 13 2 2 2-12-1Z" fill="#e3eff0" stroke="#7b909a" stroke-width=".6"/>
      <path d="m5 17 5-1-1 6-5 1Z" fill="#d23e37" stroke="#ffa18c" stroke-width=".6"/>
      <path d="m55 15 5 1 1.2 2.7-6-.5Z" fill="#71544a" stroke="#c3b3a8" stroke-width=".7"/>
      <path d="M25 20h4M42 20h4M18 6l12-2h16l7 5" fill="none" stroke="#e0d7cd" stroke-width="1" stroke-linecap="round"/>
      ${[18,66].map(x=>`<g transform="translate(${x} 30)"><circle r="6.8" fill="#11171d" stroke="#30373e" stroke-width=".7"/><circle r="4.9" fill="url(#${uid}-ixrim)"/><path d="M0-4.4V4.4M-3.8-2.2l7.6 4.4M-3.8 2.2l7.6-4.4" stroke="#e6e6df" stroke-width="1.15"/><circle r="1.5" fill="#67727b"/></g>`).join('')}
    </svg>`;
  }
  const wheel = x => `<g transform="translate(${x} 27)"><ellipse rx="6.2" ry="6.5" fill="#0b1016"/><ellipse rx="4.5" ry="5" fill="url(#${uid}-rim)" stroke="#171f29" stroke-width=".7"/><path d="M0-4V4M-3.4-2l6.8 4M-3.4 2l6.8-4" stroke="#d8dfe5" stroke-width=".85"/><ellipse rx="1.3" ry="1.5" fill="#525c68"/><path d="M-3.8-3.8q4-3 7.4 0" fill="none" stroke="#6c737c" stroke-width=".7"/></g>`;
  return `<svg viewBox="0 0 64 36" aria-hidden="true">
    <defs>
      <linearGradient id="${uid}-body" x1="0" y1="0" x2=".15" y2="1"><stop stop-color="#fff" stop-opacity=".48"/><stop offset=".28" stop-color="#fff" stop-opacity=".09"/><stop offset=".52" stop-color="#000" stop-opacity=".08"/><stop offset=".74" stop-color="#000" stop-opacity=".44"/><stop offset="1" stop-color="#fff" stop-opacity=".16"/></linearGradient>
      <linearGradient id="${uid}-glass" x2=".8" y2="1"><stop stop-color="#10202d"/><stop offset=".5" stop-color="#536f7c"/><stop offset=".56" stop-color="#263d4b"/><stop offset="1" stop-color="#0c1720"/></linearGradient>
      <radialGradient id="${uid}-rim" cx=".35" cy=".25" r=".8"><stop stop-color="#f0f3f5"/><stop offset=".45" stop-color="#8895a2"/><stop offset="1" stop-color="#26313d"/></radialGradient>
    </defs>
    <ellipse cx="32" cy="31.7" rx="29" ry="2.2" fill="#000" opacity=".38"/>
    <path d="${profile.body}" fill="${paint}" stroke="#111c27" stroke-width="1" stroke-linejoin="round"/>
    <path d="${profile.body}" fill="url(#${uid}-body)"/>
    <path d="${profile.roof}" fill="#fff" opacity=".18"/>
    <path d="${profile.hood}" fill="#fff" opacity=".19"/>
    <path d="${profile.glass}" fill="url(#${uid}-glass)" stroke="#c5d0d7" stroke-width=".65"/>
    <path d="M28 7v8M12 16l28-.3M28 16v10M43 17l-2 8" stroke="#111e29" stroke-width="1" opacity=".8"/>
    <path d="m14 15 11-6M31 9l7 5" stroke="#d6eff4" stroke-width="1.1" opacity=".45"/>
    <path d="m6 19 35-1 15 4M9 26h32" stroke="#fff" stroke-width=".8" opacity=".32"/>
    <path d="M5 26h53l1 3H5Z" fill="#101b25" opacity=".78"/>
    <path d="M55 20l6 2-1 7-5 1Z" fill="#13202a" opacity=".48"/>
    <path d="m56 24 4 1M56 26l4 1" stroke="#b1bbc4" stroke-width=".75"/>
    <path d="m3 17 4-.8-.6 4-3 .6Z" fill="#e4524c" stroke="#ffaba1" stroke-width=".5"/>
    <path d="m52 18 7 2-1 2-6-1Z" fill="#eef4e5" stroke="#c1d6db" stroke-width=".5"/>
    <path d="m40 14 4 .3 1.3 2.2-4.3-.4Z" fill="${paint}" stroke="#cad3d9" stroke-width=".6"/>
    <path d="M20 18h3M34 18h3" stroke="#e8e7e0" stroke-width="1" stroke-linecap="round"/>
    ${style === 'suv' || style === 'ix35' ? '<path d="M16 4 24 2h13l5 5" fill="none" stroke="#a9b2b9" stroke-width=".9"/>' : ''}
    ${wheel(13)}${wheel(49)}
  </svg>`;
}

function refreshProgressVehicleIcons() {
  document.querySelectorAll('.progress-drive-vehicle').forEach(icon => { icon.innerHTML = progressVehicleGlyph(Number(icon.dataset?.progressDay) || currentDay); });
}

document.addEventListener('DOMContentLoaded', refreshProgressVehicleIcons);

function initGpsVehiclePicker() {
  const options = document.getElementById('gpsVehicleOptions');
  if (!options || options.childElementCount || !isAdmin()) return;
  try {
    const saved = localStorage.getItem('travel_gps_vehicle');
    if (Object.hasOwn(GPS_CAR_SHAPES, saved)) _gpsVehicleStyle = saved;
  } catch {}
  const labels = {compact:'Седан', sport:'Спорткар', suv:'Внедорожник', arrow:'Стрелка', ix35:'Hyundai ix35'};
  const currentLabel = document.getElementById('appearanceVehicleValue');
  if (currentLabel) currentLabel.textContent = labels[_gpsVehicleStyle];
  for (const [style, label] of Object.entries(labels)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-option gps-vehicle-option';
    button.setAttribute('aria-pressed', String(style === _gpsVehicleStyle));
    button.innerHTML = _gpsCarGlyph(style) + '<span>' + label + '</span>';
    button.onclick = () => {
      _gpsVehicleStyle = style;
      _rememberDriveVehicleStyle();
      if (currentLabel) currentLabel.textContent = label;
      try { localStorage.setItem('travel_gps_vehicle', style); } catch {}
      for (const option of options.children) {
        option.setAttribute('aria-pressed', String(option === button));
      }
      refreshGpsMarkerIcon();
      refreshProgressVehicleIcons();
    };
    options.append(button);
  }
  refreshGpsMarkerIcon();
  refreshProgressVehicleIcons();
}

let _gpsWalkerPaintId = 0;
function gpsWalkerGlyph(style) {
  const {base, season} = walkStyleParts(style);
  const withDog = base === 'dog';
  const summer = season === 'summer', winter = season === 'winter';
  const backLeg = summer ? '#c18d70' : winter ? '#7c8799' : season === 'spring' ? 'color-mix(in srgb,currentColor,#263139 38%)' : '#46536b';
  const frontLeg = summer ? '#e5b28e' : winter ? '#a7b3c4' : season === 'spring' ? 'currentColor' : '#72829c';
  const coat = summer ? ['#fff4dc','#ded4b9','#9c927b'] : winter ? ['#e2eaf0','#acbecd','#71889c'] : season === 'spring' ? ['#ced4a4','#929b72','#525d45'] : ['color-mix(in srgb,currentColor,white 44%)','currentColor','color-mix(in srgb,currentColor,#15121b 62%)'];
  const bodyPath = winter ? 'M10 12q6-4 13 1l-1 12q-8 3-14-1l1-9Z' : 'M12 12q4-3 9 1l-2 11q-5 2-10-1l1-8Z';
  const id = 'walker-paint-' + ++_gpsWalkerPaintId;
  return `<svg class="gps-walker" data-season="${season}" viewBox="0 0 ${withDog ? 54 : 32} 40" aria-hidden="true">
    <defs>
      <linearGradient id="${id}-coat" x2="1" y2=".75" gradientUnits="objectBoundingBox">
        <stop stop-color="${coat[0]}"/>
        <stop offset=".55" stop-color="${coat[1]}"/>
        <stop offset="1" stop-color="${coat[2]}"/>
      </linearGradient>
      <linearGradient id="${id}-accent" x2="1" y2="1"><stop stop-color="color-mix(in srgb,currentColor,white 28%)"/><stop offset="1" stop-color="currentColor"/></linearGradient>
      <radialGradient id="${id}-skin" cx=".34" cy=".26" r=".76">
        <stop stop-color="#ffe1bd"/><stop offset="1" stop-color="#a96346"/>
      </radialGradient>
      <linearGradient id="${id}-fur" x2=".45" y2="1">
        <stop stop-color="#a57e58"/><stop offset=".52" stop-color="#79513b"/><stop offset="1" stop-color="#3f2923"/>
      </linearGradient>
    </defs>
    <ellipse cx="15" cy="36" rx="13" ry="2.5" fill="#08090e" opacity=".55"/>
    <g class="gps-human-step gps-human-step-back" transform="translate(-2 0)" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path class="gps-human-leg" d="M15 24L13 30L10 34" stroke="#11151f" stroke-width="7"/>
      <path class="gps-human-leg" d="M15 24L13 30L10 34" stroke="${backLeg}" stroke-width="4.8"/>
      ${summer ? '<path d="M15 24l-2 5" stroke="color-mix(in srgb,currentColor,#263139 38%)" stroke-width="5.8"/>' : ''}
      <path class="gps-human-shoe" d="M9 35h3" stroke="${winter ? '#795642' : '#e0d9cb'}" stroke-width="${winter ? 4 : 3}"/>
    </g>
    <g class="gps-human-step" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path class="gps-human-leg" d="M15 24L20 28L24 34" stroke="#11151f" stroke-width="7"/>
      <path class="gps-human-leg" d="M15 24L20 28L24 34" stroke="${frontLeg}" stroke-width="4.8"/>
      ${summer ? '<path d="m15 24 5 4" stroke="currentColor" stroke-width="5.8"/>' : ''}
      <path class="gps-human-shoe" d="M9 35h4" transform="translate(14 0)" stroke="${winter ? '#b18b64' : '#e0d9cb'}" stroke-width="${winter ? 4 : 3}"/>
    </g>
    <path d="m15 13-6 3-3 5" fill="none" stroke="url(#${id}-coat)" stroke-width="4.5" stroke-linecap="round"/>
    <path d="${bodyPath}" fill="url(#${id}-coat)" stroke="#17141e" stroke-width="1"/>
    ${winter ? '<path d="M10 16h12m-13 4h13m-11 4h10" fill="none" stroke="#101824" stroke-opacity=".4" stroke-width=".8"/>' : ''}
    ${season === 'spring' ? '<path d="m17 12-2 12m-3-11 4 3 3-3" fill="none" stroke="#edf5ec" stroke-width=".7" opacity=".7"/>' : ''}
    <path d="M13 14q-2 3-2 6" stroke="#fff" opacity=".42" fill="none" stroke-linecap="round"/>
    <path d="m19 14 3 5 4 1" fill="none" stroke="#261d29" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="m19 14 3 5 4 1" fill="none" stroke="${summer ? `url(#${id}-skin)` : `url(#${id}-coat)`}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${summer ? `<path d="m19 14 2 3" fill="none" stroke="url(#${id}-coat)" stroke-width="4.8" stroke-linecap="round"/>` : ''}
    <circle cx="27" cy="20" r="1.6" fill="url(#${id}-skin)"/>
    <path d="M14 7q-1-5 4-5 5 0 5 5l1 2-2 1q-1 3-5 2l-2-2Z" fill="url(#${id}-skin)" stroke="#332226" stroke-width="1"/>
    <path d="M14 8q-2-5 3-6 5-2 6 3l-4 1-2 3Z" fill="#45332e"/>
    <path d="m16 4 4-1" stroke="#927061" stroke-linecap="round"/>
    ${winter ? `<path d="M14 11q4 2 8 0l1 3q-5 2-10-1Z" fill="url(#${id}-accent)"/><path d="m17 14 4 .3-2 7-3-1Z" fill="currentColor"/><path d="m17 19 2 1" stroke="color-mix(in srgb,currentColor,white 32%)" stroke-width=".6"/>` : ''}
    ${withDog ? `
      <path d="M28 20q6 6 16.5 5.7" fill="none" stroke="#ebdbc8" stroke-width="1"/>
      <g transform="translate(5.8 5.3) scale(.9 .85)">
      <ellipse cx="42" cy="36" rx="10" ry="2" fill="#08090e" opacity=".5"/>
      <path d="M34 28q-4 1-5-1t-2-6" fill="none" stroke="#52372b" stroke-width="3.3" stroke-linecap="round"/>
      <path d="M32 28q-3-1-4-5" fill="none" stroke="#967050" stroke-width="1" stroke-linecap="round"/>
      <g fill="none" stroke-linecap="round">
        <g class="gps-walk-step gps-dog-step" style="transform-origin:35px 30px"><path d="m35 30-1 4" stroke="#79523c" stroke-width="2.6"/><path d="M34 34h.6" stroke="#efe1cd" stroke-width="1.4"/></g>
        <g class="gps-walk-step gps-dog-step gps-walk-step-back" style="transform-origin:38px 31px"><path d="m38 31 1 4" stroke="#79523c" stroke-width="2.6"/><path d="M39 35h.7" stroke="#efe1cd" stroke-width="1.4"/></g>
        <g class="gps-walk-step gps-dog-step gps-walk-step-back" style="transform-origin:44px 31px"><path d="m44 31-1 4" stroke="#79523c" stroke-width="2.6"/><path d="M43 35h.6" stroke="#efe1cd" stroke-width="1.4"/></g>
        <g class="gps-walk-step gps-dog-step" style="transform-origin:47px 30px"><path d="m47 30 1 4" stroke="#79523c" stroke-width="2.6"/><path d="M48 34h.6" stroke="#efe1cd" stroke-width="1.4"/></g>
      </g>
      <path d="M32 27q2-4 11-3l1-3q3-3 6 0l1 2 2 1q0 3-4 3l-2 4q-7 2-13 0-3-1-2-4Z" fill="url(#${id}-fur)" stroke="#35241e" stroke-width="1"/>
      <path d="m44 22-1-6q2-2 5 5m0 0 1-5q2 0 2 6" fill="#9c634b" stroke="#35241e" stroke-width="1"/>
      <path d="m44.5 17 1.5 3m3.5-3 .4 3" stroke="#e8ab99" stroke-width=".8" stroke-linecap="round"/>
      <path d="m35 25-1 3m4-3-1 4m4-4-1 4" stroke="#4b302a" stroke-width="1.2" stroke-linecap="round"/>
      <path d="M43 23l1-2 1 .7-1 4.3-1.3 2-.8-.4Z" fill="#eee1d0"/>
      <path d="M48 24l2-.5 2 1.2-1.5 1.1-2 .2-1 3.5-1.4.6 1-4Z" fill="#f3e6d5"/>
      <path d="m47 20 .65.3.65 3-.8.2Z" fill="#fff4e6"/>
      <circle cx="49" cy="22.5" r=".75" fill="#251c19"/>
      <circle cx="52" cy="24.5" r="1" fill="#251c19"/>
      </g>` : ''}
  </svg>`;
}

function initGpsWalkPicker() {
  const options = document.getElementById('gpsWalkOptions');
  const seasons = document.getElementById('gpsWalkSeasonOptions');
  if (!options || !seasons || !isAdmin()) return;
  const selected = walkStyleParts(_gpsWalkStyle);
  const value = document.getElementById('appearanceWalkValue');
  if (value) value.textContent = (selected.base === 'dog' ? 'С корги' : 'Без собаки') + ' · ' + GPS_WALK_SEASONS[selected.season];
  const seasonValue = document.getElementById('gpsWalkSeasonValue');
  if (seasonValue) seasonValue.textContent = GPS_WALK_SEASONS[selected.season];
  function choose(base, season) {
    _gpsWalkStyle = walkStyleValue(base, season);
    try { localStorage.setItem('travel_gps_walker', _gpsWalkStyle); } catch {}
    const day = DAYS_DATA[currentDay];
    if (day?.walkMode && day.gpsWalkStyle !== _gpsWalkStyle) {day.gpsWalkStyle = _gpsWalkStyle; if(typeof saveData === 'function') saveData();}
    initGpsWalkPicker(); refreshGpsMarkerIcon();
    if(typeof renderAllDays === 'function') renderAllDays();
    if(typeof renderTabs === 'function') renderTabs();
    if(typeof redrawDay === 'function' && day?.walkMode) redrawDay(currentDay);
  }
  options.replaceChildren();
  for (const [base,label] of [['person','Без собаки'],['dog','С корги']]) {
    const button = document.createElement('button');button.type='button';button.className='theme-option gps-vehicle-option';
    button.setAttribute('aria-pressed',String(base === selected.base));
    button.innerHTML = gpsWalkerGlyph(walkStyleValue(base, selected.season)) + '<span>'+label+'</span>';
    button.onclick=()=>choose(base, selected.season);options.append(button);
  }
  seasons.replaceChildren();
  for(const [season,label] of Object.entries(GPS_WALK_SEASONS)) {
    const button=document.createElement('button');button.type='button';button.className='walk-season-option';
    button.setAttribute('aria-pressed',String(season === selected.season));
    button.innerHTML=gpsWalkerGlyph(walkStyleValue(selected.base,season))+'<span>'+label+'</span>';
    button.onclick=()=>choose(selected.base,season);seasons.append(button);
  }
}

let _gpsCarPaintId = 0;

function _gpsCarGlyph(style, course = 0, headlightsOn = false, braking = false) {
  const {body, lights, tailLights, details, color = lights ? 'var(--gps-theme-paint, var(--accent))' : 'var(--accent)'} = GPS_CAR_SHAPES[style];
  const paint = 'gps-car-paint-' + (++_gpsCarPaintId);
  const beam = lights && headlightsOn ? paint + '-beam' : null;
  // The headlights face the top of the SVG (north on the map).
  return `<svg class="gps-car" viewBox="0 0 24 32" width="20" height="27" aria-hidden="true"
      style="--gps-paint:${color};overflow:visible;transform:rotate(${course}deg);filter:drop-shadow(0 1px 2px #000)">
      <defs>
        <linearGradient id="${paint}" x1="0%" y1="22%" x2="100%" y2="78%">
          <stop stop-color="color-mix(in srgb,var(--gps-paint),#111827 42%)"/>
          <stop offset=".28" stop-color="color-mix(in srgb,var(--gps-paint),white ${details ? 25 : 44}%)"/>
          <stop offset=".57" stop-color="var(--gps-paint)"/>
          <stop offset="1" stop-color="color-mix(in srgb,var(--gps-paint),#111827 62%)"/>
        </linearGradient>
        ${beam ? `<linearGradient id="${beam}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="7" y2="-14">
          <stop stop-color="#fff3bf" stop-opacity=".72"/>
          <stop offset="1" stop-color="#fff3bf" stop-opacity="0"/>
        </linearGradient>` : ''}
      </defs>
      ${beam ? `<path d="M6 7 0-14h12L9 7Zm9 0-3-21h12L18 7Z" fill="url(#${beam})"/>` : ''}
      ${lights ? `<path d="${body}" fill="none" stroke="#14131a" stroke-width="2.8" stroke-linejoin="round"/>` : ''}
      <path d="${body}" fill="url(#${paint}) ${color}"
        stroke="color-mix(in srgb,var(--gps-paint),white 42%)" stroke-width="${details ? .85 : 1.4}" stroke-linejoin="round"/>
      ${details || ''}
      ${lights ? `<path d="${lights}" fill="none" stroke="#fff8de" stroke-width="${details ? 1.55 : 2}" stroke-linecap="round"/>` : ''}
      ${tailLights && braking ? `
        <path d="${tailLights}" fill="none" stroke="#4a111b" stroke-width="3.4" stroke-linecap="round"/>
        <path d="${tailLights}" fill="none" stroke="#ff263b" stroke-width="5" stroke-linecap="round" opacity=".7" style="filter:blur(1.5px)"/>` : ''}
      ${tailLights ? `<path d="${tailLights}" fill="none" stroke="${braking ? '#ff8c91' : '#a74742'}" stroke-width="${braking ? 2.2 : 1.4}" stroke-linecap="round"/>` : ''}
    </svg>`;
}

function _makeCarIcon() {
  const ringColor = _getDayColor();
  const isWalk = typeof currentDay !== 'undefined' && DAYS_DATA[currentDay]?.walkMode;
  const headlightsOn = _drivingMode || _gpsRemoteVehicleStyle !== null;
  if (isWalk) {
    const walkerStyle = _gpsRemoteWalkStyle ?? _gpsWalkStyle;
    const direction = _gpsWalkCourse === null ? '' :
      `<div class="gps-walk-direction" style="transform:rotate(${_gpsWalkCourse}deg)"><svg viewBox="0 0 12 10" aria-hidden="true"><path d="M1 9 6 1l5 8-5-2Z"/></svg></div>`;
    return L.divIcon({
      html: `<div class="gps-walk-marker${_gpsWalkCadence ? ' is-walking' : ''}${_gpsWalkCourse > 180 ? ' faces-left' : ''}" data-walk-style="${walkerStyle}" style="--walk-cycle-factor:${_gpsWalkCadence ? 3 / _gpsWalkCadence : 1}">${gpsWalkerGlyph(walkerStyle)}${direction}</div>`,
      className: '', iconSize: [44, 44], iconAnchor: [22, 22]
    });
  }
  const glyph = _gpsCarGlyph(_gpsRemoteVehicleStyle ?? _gpsVehicleStyle, (_gpsCourse ?? 0) + (map.getBearing?.() || 0), headlightsOn, headlightsOn && _gpsBraking);
  const html = `
    <div style="position:relative;width:44px;height:44px;">
      <div class="gps-ring" style="--gps-color:${ringColor};position:absolute;inset:0;border-radius:50%;background:${ringColor};opacity:0.25;"></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;line-height:1;">${glyph}</div>
    </div>`;
  return L.divIcon({
    html, className: '', iconSize: [44, 44], iconAnchor: [22, 22]
  });
}
function _updateGpsMarker(lat, lng, accuracy, isRemote, heading, vehicleStyle, braking = false, speed, walkStyle) {
  const walking = !!DAYS_DATA[currentDay]?.walkMode;
  if (walking && speed === 0) {
    _gpsCourse = null;
    _gpsCourseAnchor = null;
  } else if (!(speed === 0 && !walking && Number.isFinite(_gpsCourse))) {
    _updateGpsCourse(lat, lng, accuracy, heading);
  }
  _gpsWalkCourse = walking && speed !== 0 ? _gpsCourse : null;
  _gpsWalkCadence = walking && Number.isFinite(speed) ? Math.min(3, Math.max(0, Math.round(speed))) : 0;
  _gpsRemoteWalkStyle = isRemote ? (Object.hasOwn(GPS_WALK_LABELS, walkStyle) ? walkStyle : 'person') : null;
  _gpsBraking = braking === true;
  const previousStyle = _gpsRemoteVehicleStyle;
  _gpsRemoteVehicleStyle = isRemote
    ? (typeof vehicleStyle === 'string' && Object.hasOwn(GPS_CAR_SHAPES, vehicleStyle) ? vehicleStyle : 'compact')
    : null;
  if (previousStyle !== _gpsRemoteVehicleStyle) refreshProgressVehicleIcons();
  if (!map) return;
  clearTimeout(_gpsWalkIdleTimer);
  _gpsWalkIdleTimer = _gpsWalkCadence ? setTimeout(() => {
    _gpsWalkCadence = 0;
    _gpsMarker?.getElement()?.querySelector('.gps-walk-marker')?.classList.remove('is-walking');
  }, 10000) : null;
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

  if (_gpsMarker) {
    _gpsMarker.setLatLng([lat, lng]);
    const walker = walking ? _gpsMarker.getElement()?.querySelector('.gps-walk-marker') : null;
    const direction = walker?.querySelector('.gps-walk-direction');
    if (walker?.dataset.walkStyle === (_gpsRemoteWalkStyle ?? _gpsWalkStyle) &&
        !!direction === (_gpsWalkCourse !== null)) {
      walker.classList.toggle('is-walking', _gpsWalkCadence > 0);
      walker.style.setProperty('--walk-cycle-factor', _gpsWalkCadence ? 3 / _gpsWalkCadence : 1);
      walker.classList.toggle('faces-left', _gpsWalkCourse > 180);
      if (direction) direction.style.transform = `rotate(${_gpsWalkCourse}deg)`;
    } else {
      _gpsMarker.setIcon(_makeCarIcon());
    }
  } else {
    _gpsMarker = L.marker([lat, lng], { icon: _makeCarIcon(), zIndexOffset: 1000 }).addTo(map);
    _gpsMarker.bindTooltip(isRemote ? '🚗 Путешественник' : '📍 Вы здесь',
      { permanent: false, direction: 'top', offset: [0, -14] });
  }
}

// ── КАМЕРА ─────────────────────────────────────────────────────────────────────
function _panTo(lat, lng) {
  _syncMapBearing();
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

function _drivingBrakeLights(speed) {
  const braking = Number.isFinite(speed) &&
    (speed === 0 || (_previousDrivingSpeed !== null && speed < _previousDrivingSpeed));
  _previousDrivingSpeed = Number.isFinite(speed) ? speed : null;
  return braking;
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
  _gpsCourse = null;
  _gpsCourseAnchor = null;
  _gpsWalkCourse = null;
  _gpsWalkCadence = 0;
  clearTimeout(_gpsWalkIdleTimer);
  _gpsWalkIdleTimer = null;
  _gpsRemoteWalkStyle = null;
  _gpsRemoteVehicleStyle = null;
  _gpsBraking = false;
  _previousDrivingSpeed = null;
}

function setWalkGpsActive(active) {
  if (active) _rememberWalkStyle();
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
  const {latitude, longitude, accuracy, speed, heading} = position.coords;
  _updateGpsMarker(latitude, longitude, accuracy, false, heading, undefined, false, gpsSpeedKmh(speed));
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
  _driveProgressMatch = null;
  _gpsBraking = false;
  _previousDrivingSpeed = null;
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
  refreshGpsMarkerIcon();

  _setGpsControls(_drivingMode || _hasOwnerFix, _drivingMode);
  const followBtn = document.getElementById('gpsFollowBtn');
  followBtn?.classList.remove('paused');

  // Keep-alive: держим WebSocket живым для уведомлений
  if (_drivingMode) {
    _rememberDriveVehicleStyle();
    _rememberWalkStyle();
    startKeepAlive();
    if (!routeHintsPreviewEnabled()) {
      _refreshHintsFromOwnerFix();
      // The startup watch may have failed while location was disabled.
      _startGpsWatch();
      _acquireWakeLock();
    }
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
  if (_drivingMode && document.visibilityState === 'visible' && !routeHintsPreviewEnabled()) {
    if (_gpsWatchFailed) _startGpsWatch();
    if (!_wakeLock) _acquireWakeLock();
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
// Без этого иконка залипает до следующего Firebase-события.
function refreshGpsMarkerIcon() {
  const drivingButton = document.getElementById('drivingBtn');
  if (drivingButton && typeof dayActionIcon === 'function') {
    const walking = DAYS_DATA[currentDay]?.walkMode;
    drivingButton.innerHTML = dayActionIcon(_drivingMode ? 'stop' : walking ? 'walk' : 'car') + (_drivingMode ? ' Стоп' : walking ? ' Иду' : ' Еду');
  }
  _syncMapBearing();
  if (!_gpsMarker) return; // демо-режим или GPS ещё не запущен — ничего не делаем
  var isRemote = !_walkGpsActive && typeof CLOUD_CONFIG !== 'undefined' && !CLOUD_CONFIG.canWrite;
  var newIcon = _makeCarIcon();
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
let _activeRoutePlace = null;
const _routeHintShownIds = new Set();
const _pendingDrivingLegs = new Map();

function _refreshHintsFromOwnerFix() {
  if (_lastOwnerHintFix && Date.now() - _lastOwnerHintFix.at < 15000) {
    _checkRouteHints(_lastOwnerHintFix.coords);
  }
}
const _HINT_TYPES = { 'Заправка': 'fuel', 'Кафе': 'cafe', 'Магазин': 'cart' };
const ROUTE_HINT_DURATION_MS = 10000;
const MANEUVER_HINT_DISTANCE_M = 500;
const MANEUVER_MAX_GPS_ACCURACY_M = 120;
let _lastRouteDing = -Infinity;
const _CIRCLE_ENTRIES = new Set(['roundabout', 'rotary', 'roundabout turn']);
const _CIRCLE_EXITS = new Set(['exit roundabout', 'exit rotary']);

function routeHintsPreviewEnabled() {
  return typeof LOCAL_PREVIEW !== 'undefined' && LOCAL_PREVIEW && isAdmin() &&
    new URLSearchParams(location.search).get('sample') === 'route-hints';
}

function _setRouteHint(id, hint) {
  const panel = document.getElementById('routeHint');
  const row = document.getElementById(id);
  row.hidden = !hint;
  if (hint) {
    const icon = row.querySelector('.route-hint-icon');
    if (icon.dataset.name !== hint.icon) {
      icon.dataset.name = hint.icon;
      icon.innerHTML = dayActionIcon(hint.icon);
    }
    row.querySelector('strong').textContent = hint.title;
    const detail = row.querySelector('.route-hint-detail');
    detail.textContent = hint.detail;
    detail.hidden = !hint.detail;
  }
  panel.hidden = [...panel.children].every(child => child.hidden);
}

function _resetRouteHints() {
  clearTimeout(_routeHintTimer);
  _activeRoutePlace = null;
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
  const arrow = direction === 'налево' ? 'routeLeft' : direction ? 'routeRight' : 'routeStraight';
  const ramp = direction === 'налево' ? 'routeRampLeft' : direction ? 'routeRampRight' : 'routeStraight';
  if (_CIRCLE_ENTRIES.has(type) || _CIRCLE_EXITS.has(type)) {
    return ['routeCircle', exit ? exit + '-й съезд' : direction || 'Кольцо'];
  }
  if (modifier === 'uturn') return ['routeUturn', 'Разворот'];
  if (type === 'off ramp' || type === 'on ramp') {
    return [ramp, direction || (type === 'off ramp' ? 'Съезд' : 'Въезд')];
  }
  if (type === 'fork' || type === 'merge') return [ramp, direction || 'Прямо'];
  if (direction && ['turn', 'end of road', 'continue'].includes(type)) return [arrow, direction];
  return null;
}

function _nextDrivingManeuver(steps, {latitude, longitude, accuracy, heading}) {
  const xScale = 111320 * Math.cos(latitude * Math.PI / 180);
  const yScale = 111320;
  let along = 0;
  let closest = Math.min(55, Math.max(25, accuracy));
  let progress = null;
  const maneuvers = [];
  let circle = null;
  steps.forEach((step, index) => {
    const type = step.maneuver?.type;
    const label = _maneuverLabel(step.maneuver);
    if (_CIRCLE_EXITS.has(type) && circle) {
      circle.until = along;
      if (step.maneuver.exit) circle.label = label;
      maneuvers.length = maneuvers.indexOf(circle) + 1;
      circle = null;
    } else if (label) {
      const entry = {along, label, index};
      maneuvers.push(entry);
      if (_CIRCLE_ENTRIES.has(type)) circle = entry;
    }
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
    if (circle?.index === index) circle.until = along;
  });
  if (progress === null) return null;
  const next = maneuvers.find(item => (item.until ?? item.along + 12) >= progress &&
    item.along - progress <= MANEUVER_HINT_DISTANCE_M);
  return next && {...next, meters: Math.max(0, next.along - progress),
    onCircle: next.until !== undefined && progress >= next.along};
}

function _routePlaceType(stop) {
  const type = stop.type?.trim();
  if (Object.hasOwn(_HINT_TYPES, type)) return type;
  if (type && type !== 'Другое') return null;
  const icon = stop.icon?.replace(/^emoji:/, '').replace(/\uFE0F/g, '');
  if (['🛒', '🏪', '🛍', '🏬', 'type:Магазин'].includes(icon) ||
      (typeof POINT_GRAPHICS !== 'undefined' && POINT_GRAPHICS[icon?.replace(/^graphic:/, '')]?.[0] === 'Магазин')) return 'Магазин';
  return null;
}

function _measureDrivingLine(line, fix, maxProgress = Infinity) {
  const radians = Math.PI / 180;
  const eastScale = 111320 * Math.cos(fix.latitude * radians);
  let length = 0;
  let progress = null;
  let closest = Math.min(55, Math.max(25, fix.accuracy));
  for (let j = 1; j < line.length; j++) {
    const [lat, lng] = line[j - 1];
    const dx = (line[j][1] - lng) * eastScale;
    const dy = (line[j][0] - lat) * 111320;
    const segment = Math.hypot(dx, dy);
    if (!segment) continue;
    const x = (fix.longitude - lng) * eastScale;
    const y = (fix.latitude - lat) * 111320;
    const fraction = Math.max(0, Math.min(1, (x * dx + y * dy) / segment ** 2));
    const offset = Math.hypot(x - fraction * dx, y - fraction * dy);
    const bearing = Math.atan2(dx, dy);
    const along = length + fraction * segment;
    if (along <= maxProgress && offset < closest &&
        (!Number.isFinite(fix.heading) || Math.cos(fix.heading * radians - bearing) > 0)) {
      closest = offset;
      progress = along;
    }
    length += segment;
  }
  return {length, progress, closest};
}

function _drivingLeg(day, index) {
  const to = day.stops[index];
  const from = index > 0 ? day.stops[index - 1] : day.start;
  if (!to || !from || !(from.lat || from.lng) || !(to.lat || to.lng)) return null;
  return {from, to, key: `driving|${from.lat},${from.lng}|${to.lat},${to.lng}`};
}

let _driveProgressMatch = null;

function _updateDriveProgress(fix) {
  const day = DAYS_DATA[currentDay];
  const fill = document.getElementById('d' + currentDay + '-fill');
  if (!day || !fill || !Number.isFinite(fix.accuracy) || fix.accuracy > MANEUVER_MAX_GPS_ACCURACY_M) return;
  // An actual time confirms the preceding leg. GPS only refines the next leg.
  const reached = reachedRouteStopCount(day.stops);
  const leg = _drivingLeg(day, reached);
  if (!leg) return;
  const key = day.walkMode ? leg.key.replace('driving|', 'foot|') : leg.key;
  const line = _routeCache[key];
  if (!line || line.length < 2) return;
  if (_driveProgressMatch?.day !== currentDay || _driveProgressMatch.index !== reached || _driveProgressMatch.line !== line) {
    _driveProgressMatch = {day: currentDay, index: reached, line, meters: 0};
  }
  const matchFix = {
    latitude: fix.latitude,
    longitude: fix.longitude,
    accuracy: fix.accuracy,
    heading: fix.speed >= 1.5 || !Number.isFinite(fix.speed) ? fix.heading : undefined
  };
  let measured = _measureDrivingLine(line, matchFix);
  const previous = _driveProgressMatch.meters;
  const [startLat, startLng] = line[0];
  const [endLat, endLng] = line.at(-1);
  const nearStart = _haversineKmPts(startLat, startLng, fix.latitude, fix.longitude) < 0.12;
  const closedLeg = _haversineKmPts(startLat, startLng, endLat, endLng) < 0.12;
  if (closedLeg && nearStart && previous < measured.length / 2 && measured.progress > measured.length / 2) {
    measured = _measureDrivingLine(line, matchFix, measured.length / 2);
  }
  if (measured.progress === null || !measured.length) return;
  _driveProgressMatch.meters = Math.max(previous, measured.progress);
  const totalKm = getDayRouteKm(currentDay);
  if (!totalKm) return;
  const markedKm = getDayRouteKm(currentDay, reached);
  const nextKm = getDayRouteKm(currentDay, reached + 1);
  const distanceKm = markedKm + (nextKm - markedKm) * (_driveProgressMatch.meters / measured.length);
  _storeDriveProgress(currentDay, distanceKm / totalKm, typeof isAdmin === 'function' && isAdmin() ? _gpsVehicleStyle : undefined);
  updateRouteProgress(currentDay, distanceKm / totalKm);
}

function _findDrivingHintLeg(day, preferredIndex, fix) {
  const preferred = _drivingLeg(day, preferredIndex);
  const preferredLine = preferred && _routeCache[preferred.key];
  if (preferred && (!preferredLine || _measureDrivingLine(preferredLine, fix).progress !== null)) return preferred;
  let best = null;
  let closest = Infinity;
  for (let index = 0; index < day.stops.length; index++) {
    if (index === preferredIndex) continue;
    const leg = _drivingLeg(day, index);
    const line = leg && _routeCache[leg.key];
    if (!line) continue;
    const match = _measureDrivingLine(line, fix);
    if (match.progress === null || match.closest >= closest) continue;
    best = leg;
    closest = match.closest;
  }
  return best;
}

function* _upcomingRoadStops(day, index, fix) {
  if (index < 0) return;
  let remaining = 0;
  for (let i = index; i < day.stops.length; i++) {
    const from = i > 0 ? day.stops[i - 1] : day.start;
    const stop = day.stops[i];
    const line = _routeCache[`driving|${from.lat},${from.lng}|${stop.lat},${stop.lng}`];
    if (!line || line.length < 2) return;
    const {length, progress} = _measureDrivingLine(line, fix);
    if (i === index && progress === null) return;
    remaining += length - (i === index ? progress : 0);
    if (remaining > 1000) return;
    yield {stop, distance: remaining / 1000};
  }
}

function _checkRouteHints(fix) {
  const day = DAYS_DATA[currentDay];
  if (!_drivingMode || !isAdmin() || !day || day.walkMode || day.archived) return;
  const id = currentDay;
  const index = day.stops.findIndex(stop => !stop.arrA);
  // A stationary device may keep reporting the heading from its previous movement.
  const {latitude, longitude, accuracy, speed, heading} = fix;
  const maneuverFix = {
    latitude, longitude, accuracy,
    heading: Number.isFinite(speed) && speed < 1.5 ? undefined : heading,
  };
  const leg = Number.isFinite(fix.accuracy) && fix.accuracy <= MANEUVER_MAX_GPS_ACCURACY_M &&
    _findDrivingHintLeg(day, index, maneuverFix);
  let maneuver;
  if (leg) {
    const {key, from, to} = leg;
    if (!drivingSteps.has(key) && !routeHintsPreviewEnabled() && Date.now() >= osrmRetryAt &&
        Date.now() >= (_pendingDrivingLegs.get(key) || 0)) {
      _pendingDrivingLegs.set(key, Infinity);
      fetchRoadSegment(from, to, 'driving', true)
        .then(() => {
          if (drivingSteps.has(key) && _drivingMode && currentDay === id) _refreshHintsFromOwnerFix();
        })
        .catch(() => {})
        .finally(() => _pendingDrivingLegs.set(key, Date.now() + 120000));
    }
    maneuver = _nextDrivingManeuver(drivingSteps.get(key) || [], maneuverFix);
  }
  if (maneuver) {
    const maneuverId = id + ':' + leg.key + ':' + maneuver.index;
    _dingRouteHint(maneuverId);
    const [icon, title] = maneuver.label;
    const meters = Math.ceil(maneuver.meters / 10) * 10;
    const detail = maneuver.onCircle ? '' : meters ? meters + ' м' : 'Сейчас';
    _setRouteHint('routeManeuver', {icon, title, detail});
  } else _setRouteHint('routeManeuver', null);

  if (!Number.isFinite(fix.accuracy) || fix.accuracy > 50) return;
  for (const {stop, distance} of _upcomingRoadStops(day, index, fix)) {
    if (_activeRoutePlace) {
      if (stop.id !== _activeRoutePlace.id) continue;
      _showRoutePlace(_activeRoutePlace.type, distance);
      return;
    }
    const type = !stop.arrA && !_routeHintShownIds.has('place:' + stop.id) && _routePlaceType(stop);
    if (!type) continue;
    _activeRoutePlace = {id: stop.id, type};
    _showRoutePlace(type, distance);
    _dingRouteHint('place:' + stop.id);
    _routeHintTimer = setTimeout(() => {
      _activeRoutePlace = null;
      _setRouteHint('routePlace', null);
    }, ROUTE_HINT_DURATION_MS);
    return;
  }
  if (_activeRoutePlace) _setRouteHint('routePlace', null);
}

function _showRoutePlace(type, distanceKm) {
  const meters = Math.round(distanceKm * 100) * 10;
  const detail = meters >= 1000 ? (meters / 1000).toLocaleString('ru-RU') + ' км' : meters + ' м';
  _setRouteHint('routePlace', {icon: _HINT_TYPES[type], title: type, detail});
}

function _haversineKmPts(lat1, lng1, lat2, lng2) {
  var R = 6371;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
          Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
