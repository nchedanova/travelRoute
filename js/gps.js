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
let _followCamera   = false;  // камера следит за позицией
let _userPanned     = false;  // пользователь двигал карту вручную
let _nearestStopId  = null;   // id ближайшей остановки
let _keepAliveCtx   = null;   // AudioContext для keep-alive
let _keepAliveOsc   = null;

// ── INIT ───────────────────────────────────────────────────────────────────────
function initGps() {
  // ── ДЕМО-РЕЖИМ ──────────────────────────────────────────────────────────────
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    initChat && initChat();
    initNotes && initNotes();
    _showEl('drivingBtn');
    return;
  }

  if (typeof firebase === 'undefined') {
    console.warn('Firebase SDK не загружен');
    return;
  }

  if (!firebase.apps.length) {
    const cfg = Object.assign({}, FIREBASE_CONFIG, { apiKey: localStorage.getItem('travel_firebase_key') || '' });
    firebase.initializeApp(cfg);
  }

  // Auth — use existing session (Google/anonymous) or create anonymous
  if (firebase.auth) {
    // Handle redirect result from Google Sign-In
    firebase.auth().getRedirectResult().then(function(result) {
      if (result && result.user) {
        var u = result.user;
        window._firebaseUid = u.uid;
        localStorage.setItem('travel_firebase_uid', u.uid);
        var name = u.displayName || u.email?.split('@')[0] || 'User';
        // Check for custom name in Firebase
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
        console.log('[auth] Google redirect ok, uid:', u.uid, 'name:', name);
        // Close nickname modal if open
        var modal = document.getElementById('nicknameModal');
        if (modal) modal.classList.remove('show');
        if (typeof renderChatHeader === 'function') renderChatHeader();
      }
    }).catch(function(err) {
      console.warn('[auth] redirect result error:', err.code);
      // If credential-already-in-use during link, sign in directly
      if (err.code === 'auth/credential-already-in-use') {
        var provider = new firebase.auth.GoogleAuthProvider();
        firebase.auth().signInWithRedirect(provider);
      }
    });

    firebase.auth().onAuthStateChanged(user => {
      if (user) {
        var newUid = user.uid;
        window._firebaseUid = newUid;
        localStorage.setItem('travel_firebase_uid', newUid);
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
          localStorage.setItem('travel_auth_provider', 'google');
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
        // No user → sign in anonymously for immediate uid
        firebase.auth().signInAnonymously().catch(e => console.warn('[auth] anonymous sign-in failed:', e));
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
  } else if (CLOUD_CONFIG.canRead) {
    // Зритель: слушаем Firebase, камера сразу следит
    _listenRemotePosition();
    _followCamera = true;
    _showEl('gpsFollowBtn');
    _showEl('speedDisplay');
  }

  // Пауза слежения при ручном движении карты
  map.on('mousedown touchstart', () => {
    if (!_followCamera) return;
    _userPanned = true;
    document.getElementById('gpsFollowBtn')?.classList.add('paused');
  });
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
  const kmh = speed != null ? Math.round(speed * 3.6) : null;

  _updateGpsMarker(lat, lng, accuracy, false);
  _highlightNearest(lat, lng);

  if (_drivingMode) {
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
    if (!d) {
      // путешественник остановился — убираем подсветку и скорость
      document.body.classList.remove('driving-active');
      _updateSpeedDisplay(null);
      const speedEl = document.getElementById('speedDisplay');
      if (speedEl && !CLOUD_CONFIG.canWrite) speedEl.style.display = 'none';
      return;
    }
    // есть позиция — включаем подсветку как в режиме "Еду"
    document.body.classList.add('driving-active');
    _updateGpsMarker(d.lat, d.lng, d.accuracy, true);
    _highlightNearest(d.lat, d.lng);
    _updateSpeedDisplay(d.speed);
    if (_followCamera && !_userPanned) _panTo(d.lat, d.lng);
  });
}

// ── FIREBASE WRITE — владелец едет ────────────────────────────────────────────
function _writePosition(lat, lng, speed, accuracy) {
  if (!_db) return;
  _db.ref('gps').set({ lat, lng, speed, accuracy, ts: Date.now() });
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
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;line-height:1;">🚗</div>
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
  _userPanned    = false;
  _followCamera  = true;
  document.getElementById('gpsFollowBtn')?.classList.remove('paused');
  if (_gpsMarker) {
    const ll = _gpsMarker.getLatLng();
    _panTo(ll.lat, ll.lng);
  }
}

// ── РЕЖИМ "ЕДУ" — только владелец ─────────────────────────────────────────────
function toggleDrivingMode() {
  if (typeof isDemoMode === 'function' && isDemoMode()) {
    showToast && showToast('📱 Это демо-режим. Настройте Firebase в ⚙ для GPS-трекинга');
    return;
  }
  _drivingMode  = !_drivingMode;
  _followCamera = _drivingMode;
  _userPanned   = false;

  const btn = document.getElementById('drivingBtn');
  if (btn) {
    btn.classList.toggle('active', _drivingMode);
    btn.innerHTML = _drivingMode ? '🛑 Стоп' : '🚗 Еду';
  }
  document.body.classList.toggle('driving-active', _drivingMode);

  const speedEl = document.getElementById('speedDisplay');
  if (speedEl) speedEl.style.display = _drivingMode ? 'flex' : 'none';

  const followBtn = document.getElementById('gpsFollowBtn');
  if (followBtn) {
    followBtn.style.display = _drivingMode ? 'flex' : 'none';
    followBtn.classList.remove('paused');
  }

  // Keep-alive: держим WebSocket живым для уведомлений
  if (_drivingMode) {
    startKeepAlive();
  } else {
    stopKeepAlive();
    _updateSpeedDisplay(null);
    if (_db) _db.ref('gps').remove();
  }
}

// ── KEEP-ALIVE (AudioContext) ─────────────────────────────────────────────────
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

  let minDist = Infinity, nearestId = null;
  dayData.stops.forEach(s => {
    if (!s.lat || !s.lng) return;
    const d = Math.hypot(s.lat - lat, s.lng - lng);
    if (d < minDist) { minDist = d; nearestId = s.id; }
  });

  if (nearestId === _nearestStopId) return;
  _nearestStopId = nearestId;

  document.querySelectorAll('.stop-card').forEach(el => el.classList.remove('gps-nearest'));
  if (nearestId) {
    const card = document.getElementById('card-' + nearestId);
    if (card) {
      card.classList.add('gps-nearest');
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
