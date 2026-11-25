// Integration test using Firebase 10.12.0 and the local Database Emulator.
// Pass the absolute path to the locally installed Firebase package directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const firebaseDir = process.argv[2];
if (!firebaseDir || !path.isAbsolute(firebaseDir)) throw Error('Pass the absolute Firebase package directory');
const firebase = require(path.join(firebaseDir, 'compat/app'));
require(path.join(firebaseDir, 'compat/database'));
const {JSDOM} = require(path.join(firebaseDir, '..', 'jsdom'));

const ns = 'demo-travel-route-live-gps';
const endpoint = 'http://127.0.0.1:9019';
const gpsSource = fs.readFileSync(path.join(__dirname, '../js/gps.js'), 'utf8');
const renderSource = fs.readFileSync(path.join(__dirname, '../js/render.js'), 'utf8');
const apps = [], clients = [], warnings = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label) {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return;
    await wait(25);
  }
  throw Error('Timeout: ' + label);
}

async function setRules(allowWrite) {
  const response = await fetch(endpoint + '/.settings/rules.json?ns=' + ns, {
    method:'PUT', headers:{Authorization:'Bearer owner','Content-Type':'application/json'},
    body:JSON.stringify({rules:{gps:{'.read':true,'.write':allowWrite}}})
  });
  assert.ok(response.ok);
}

function session(role, skew) {
  const app = firebase.initializeApp({databaseURL:'https://' + ns + '.firebaseio.com'}, role);
  apps.push(app);
  const db = app.database();
  db.useEmulator('127.0.0.1', 9019);
  const dom = new JSDOM('<body><div id="speedDisplay"><span class="spd-val"></span><span id="gpsShareStatus" hidden></span></div><div><div id="d1-fill"></div></div><div id="d1-pct"></div><div id="gpsFollowBtn"></div></body>');
  const {document} = dom.window;
  let marker = null, writes = 0, holdNextAck = null;
  class DeviceDate extends Date { static now() { return Date.now() + skew; } }
  const database = {ref(key) {
    const ref = db.ref(key);
    if (key === '.info/serverTimeOffset') {
      // The real SDK runs in this Node process, so emulate the offset that it
      // would calculate using the simulated phone clock.
      return {on(event, callback) { ref.on(event, snap => callback({val:() => snap.val() - skew})); }};
    }
    if (key === 'gps' && role === 'admin') {
      return {
        set(value) {
          writes++;
          const ack = ref.set(value);
          const hold = holdNextAck;
          holdNextAck = null;
          return hold ? ack.then(() => hold) : ack;
        },
        remove:() => ref.remove()
      };
    }
    return ref;
  }};
  const day = {start:{lat:55,lng:37}, stops:[{lat:55,lng:37.02,arrA:''}], publicationId:'p',
    spectatorLive:true,spectatorPublicationId:'p'};
  const context = vm.createContext({
    Date:DeviceDate, document, navigator:{onLine:true}, map:null, setInterval(){},
    setTimeout(fn, ms) { const timer = setTimeout(fn,ms); timer.unref(); return timer; },
    clearTimeout, console:{warn(...args){warnings.push(args[0]);}},
    CLOUD_CONFIG:{binId:'test-route',canRead:true,canWrite:role==='admin'}, SPECTATOR_MODE:role==='spectator',
    DAYS_DATA:{1:day}, currentDay:1, isAdmin:() => role==='admin', isDemoMode:() => false,
    dayKeys:() => [1], publicationEntry:() => ({}), reachedRouteStopCount:() => 0,
    getDayRouteKm:(id,count=1) => count, _routeCache:{'driving|55,37|55,37.02':[[55,37],[55,37.02]]},
    database, firebase:{apps:[{}],database:Object.assign(() => database,{ServerValue:firebase.database.ServerValue})},
    draw(lat,lng) {marker=[lat,lng];}, clear() {marker=null;}
  });
  const run = script => vm.runInContext(script,context);
  run(gpsSource);
  run(renderSource.slice(renderSource.indexOf('function updateRouteProgress('),renderSource.indexOf('function updateProgress()')));
  run('_db=database; _updateGpsMarker=draw; _clearGpsMarker=clear; _panTo=()=>{}; _highlightNearest=()=>{}; _followCamera=false;');
  if (role === 'spectator') context.initSpectatorPhotos();
  else {
    context._monitorGpsTransport();
    if (role === 'reader') context._listenRemotePosition();
  }
  const client = {db,document,run,context, get writes(){return writes;}, get marker(){return marker;},
    delayAcknowledgement() {
      let release;
      holdNextAck = new Promise(resolve => { release = resolve; });
      return release;
    },
    fix(lng, msAgo=0) {
      context._onPosition({timestamp:DeviceDate.now()-msAgo,
        coords:{latitude:55,longitude:lng,speed:8,accuracy:6,heading:90}});
    },
    stop() {
      run('stopKeepAlive=()=>{}; _releaseWakeLock=()=>{}; refreshGpsMarkerIcon=()=>{}; toggleDrivingMode();');
    }
  };
  clients.push(dom);
  return client;
}

async function main() {
  await setRules(true);
  const response = await fetch(endpoint + '/gps.json?ns=' + ns, {
    method:'DELETE', headers:{Authorization:'Bearer owner'}
  });
  assert.ok(response.ok);
  const admin = session('admin', -180000), reader = session('reader', 180000), spectator = session('spectator', 240000);
  await until(() => admin.run('_gpsConnected && _gpsServerOffset !== null') &&
    reader.run('_gpsServerOffset !== null') && spectator.run('_gpsServerOffset !== null'), 'connected and clocks aligned');
  admin.run('_drivingMode=true; _gpsVehicleStyle="ix35"; _checkRouteHints=()=>{throw Error("test hint error");};');
  admin.fix(37.005);
  await until(() => reader.marker?.[1] === 37.005 && spectator.marker?.[1] === 37.005, 'first GPS despite clock skew and hint error');
  assert.ok(Math.abs(reader.context.routeDriveFraction(1)-.25)<.00001);
  assert.match(reader.context.progressVehicleGlyph(1), /data-vehicle-style="ix35"/);
  assert.equal(admin.writes,1);
  const first = (await admin.db.ref('gps').get()).val();
  assert.ok(Math.abs(first.ts-Date.now())<5000,'Firebase resolves the server timestamp');
  assert.ok(Math.abs(first.capturedAt-Date.now())<5000,'Adjusted capture time');
  admin.fix(37.01);
  await until(() => reader.marker?.[1] === 37.01 && reader.context.routeDriveFraction(1)>.49, 'live marker and progress advance');
  assert.equal(admin.writes,2);

  admin.run('_updateDriveProgress=()=>{throw Error("test progress error");}; _updateGpsMarker=()=>{throw Error("test marker error");};');
  admin.fix(37.011);
  await until(() => reader.marker?.[1] === 37.011 && !admin.run('_driveWrite'), 'position survives marker and progress errors');
  assert.equal(admin.writes,3);
  admin.db.goOffline();
  await until(() => !admin.run('_gpsConnected'), 'offline status');
  admin.fix(37.012);
  assert.equal(admin.writes,3);
  assert.equal(admin.document.getElementById('gpsShareStatus').textContent,'Позиция пока не передаётся');
  admin.db.goOnline();
  await until(() => admin.run('_gpsConnected'), 'reconnect');
  admin.fix(37.013, 20000);
  assert.equal(admin.writes,3,'No stale or buffered fix published on reconnect');
  admin.fix(37.014);
  await until(() => reader.marker?.[1] === 37.014 && admin.document.getElementById('gpsShareStatus').hidden, 'next fresh fix acknowledged');

  const release = admin.delayAcknowledgement();
  const writesBeforeDelay = admin.writes;
  admin.fix(37.0141);
  await until(() => reader.marker?.[1] === 37.0141, 'position reached readers while the sender waits for acknowledgement');
  admin.fix(37.0142);
  await wait(admin.run('GPS_SHARE_ACK_WAIT_MS') + 50);
  assert.equal(admin.document.getElementById('gpsShareStatus').hidden,false,'Delayed acknowledgement is visible');
  admin.fix(37.0143);
  assert.equal(admin.writes,writesBeforeDelay+1);
  release();
  await until(() => reader.marker?.[1] === 37.0143 && !admin.run('_driveWrite'), 'only the latest pending fix is sent');
  assert.equal(admin.writes,writesBeforeDelay+2);
  assert.equal(admin.document.getElementById('gpsShareStatus').hidden,true);

  await admin.db.ref('gps').set({
    ...first, ts:firebase.database.ServerValue.TIMESTAMP, capturedAt:Date.now()-121000,
    spectator:{...first.spectator, ts:firebase.database.ServerValue.TIMESTAMP, capturedAt:Date.now()-121000}
  });
  await until(() => !reader.marker && !spectator.marker, 'new server timestamp cannot revive an old fix');
  admin.fix(37.016);
  await until(() => reader.marker?.[1] === 37.016 && spectator.marker?.[1] === 37.016, 'post-reconnect position');
  admin.stop();
  await until(() => !reader.marker && !spectator.marker, 'Stop clears both roles');
  assert.equal((await admin.db.ref('gps').get()).val(),null);

  await setRules(false);
  admin.run('_drivingMode=true;');
  admin.fix(37.017);
  await until(() => warnings.includes('GPS write:') && !admin.document.getElementById('gpsShareStatus').hidden, 'server rejects GPS write');
  assert.equal(admin.run('_drivingMode'),true);
  assert.equal((await admin.db.ref('gps').get()).val(),null);
  console.log('Firebase Emulator passed: clock skew, live map and progress, UI errors, disconnect, stale fix, reconnect, delayed acknowledgement, Stop and denied writes.');
}

main().catch(error => {console.error(error);process.exitCode=1;}).finally(async () => {
  clients.forEach(dom => dom.window.close());
  for (const app of apps) {app.database().goOffline(); await app.delete();}
});
