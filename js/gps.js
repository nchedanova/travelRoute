// ── GPS MODULE ─────────────────────────────────────────────────────────────────
// Роли:
//   Владелец (canWrite): видит свой GPS маркер, кнопка "Еду" → пишет в Firebase + следит камера
//   Зритель  (canRead, !canWrite): читает позицию из Firebase, камера следит автоматически

const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyC73GrtMCW0Uq5COCHQ8QM6yeJA1TAJ1Bk',
  authDomain:        'travel-route-83d06.firebaseapp.com',
  databaseURL:       'https://travel-route-83d06-default-rtdb.firebaseio.com',
  projectId:         'travel-route-83d06',
  storageBucket:     'travel-route-83d06.firebasestorage.app',
  messagingSenderId: '880747819905',
  appId:             '1:880747819905:web:376879499a62d9b7f0ee80'
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

// ── INIT ───────────────────────────────────────────────────────────────────────
function initGps() {
  if (typeof firebase === 'undefined') {
    console.warn('Firebase SDK не загружен');
    return;
  }

  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  _db = firebase.database();

  if (CLOUD_CONFIG.canWrite) {
    // Владелец: запускаем GPS-слежение устройства
    _startGpsWatch();
    _showEl('drivingBtn');
  } else if (CLOUD_CONFIG.canRead) {
    // Зритель: слушаем Firebase, камера сразу следит
    _listenRemotePosition();
    _followCamera = true;
    _showEl('gpsFollowBtn');
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
    _writePosition(lat, lng, kmh, accuracy);
    if (_followCamera && !_userPanned) _panTo(lat, lng);
  }
}

// ── FIREBASE READ — зрители ────────────────────────────────────────────────────
function _listenRemotePosition() {
  if (!_db) return;
  _db.ref('gps').on('value', snap => {
    const d = snap.val();
    if (!d) {
      // путешественник остановился — убираем подсветку
      document.body.classList.remove('driving-active');
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
function _makeCarIcon(isRemote) {
  // Коричневая машинка (вид сверху) для владельца и зрителей
  const color    = isRemote ? '#c0783a' : '#8B5E3C';  // оттенки коричневого
  const outline  = isRemote ? '#7a4820' : '#5c3d20';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
    <!-- Кузов -->
    <rect x="7" y="8" width="18" height="16" rx="4" fill="${color}" stroke="${outline}" stroke-width="1"/>
    <!-- Крыша / салон -->
    <rect x="10" y="11" width="12" height="8" rx="2" fill="${outline}" opacity="0.45"/>
    <!-- Фары передние -->
    <rect x="8" y="8" width="4" height="2.5" rx="1" fill="#ffe98a" opacity="0.9"/>
    <rect x="20" y="8" width="4" height="2.5" rx="1" fill="#ffe98a" opacity="0.9"/>
    <!-- Фонари задние -->
    <rect x="8" y="21.5" width="4" height="2.5" rx="1" fill="#f87171" opacity="0.85"/>
    <rect x="20" y="21.5" width="4" height="2.5" rx="1" fill="#f87171" opacity="0.85"/>
    <!-- Колёса -->
    <rect x="5" y="9.5" width="4" height="5" rx="1.5" fill="#222"/>
    <rect x="23" y="9.5" width="4" height="5" rx="1.5" fill="#222"/>
    <rect x="5" y="17.5" width="4" height="5" rx="1.5" fill="#222"/>
    <rect x="23" y="17.5" width="4" height="5" rx="1.5" fill="#222"/>
  </svg>`;
  return L.divIcon({
    html: `<div class="gps-car" style="--gps-color:${color}">${svg}</div>`,
    className: '', iconSize: [32, 32], iconAnchor: [16, 16]
  });
}
function _updateGpsMarker(lat, lng, accuracy, isRemote) {
  if (!map) return;
  const color = isRemote ? '#c0783a' : '#8B5E3C';

  // Кружок погрешности
  if (_accuracyCircle) {
    _accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy || 20);
  } else {
    _accuracyCircle = L.circle([lat, lng], {
      radius: accuracy || 20,
      color, fillColor: color,
      fillOpacity: 0.07, weight: 1, opacity: 0.25
    }).addTo(map);
  }

  const icon = _makeCarIcon(isRemote);

  if (_gpsMarker) {
    _gpsMarker.setLatLng([lat, lng]).setIcon(icon);
  } else {
    _gpsMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
    _gpsMarker.bindTooltip(isRemote ? '🚗 Путешественник' : '📍 Вы здесь',
      { permanent: false, direction: 'top', offset: [0, -12] });
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

  if (!_drivingMode) {
    _updateSpeedDisplay(null);
    if (_db) _db.ref('gps').remove(); // убираем маркер у зрителей
  }
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
