const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function setup(spectator) {
  const writes=[],calls=[],removed=[],subscriptions=[];
  const elements=new Map(['gpsFollowBtn','speedDisplay'].map(id=>[id,{style:{}}]));
  const days={1:{publicationId:'p',spectatorPublicationId:'p',spectatorLive:true,walkMode:false,stops:[]},2:{stops:[]}};
  const ctx=vm.createContext({
    console,Date,Number,setInterval(){},clearTimeout(){},SPECTATOR_MODE:spectator,DAYS_DATA:days,currentDay:1,
    CLOUD_CONFIG:{canWrite:!spectator},publicationEntry:d=>days[d]?.publicationId?{}:null,
    fakeDb:{ref:p=>({set:value=>{writes.push({path:p,value});return Promise.resolve();},on:(event,callback)=>subscriptions.push({path:p,callback})})},
    document:{addEventListener(){},body:{classList:{add(){},remove(){}}},getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[]},
    map:{removeLayer:m=>removed.push(m)},L:{divIcon:options=>options},calls,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/gps.js'),'utf8'),ctx);
  ctx.realUpdateGpsMarker = ctx._updateGpsMarker;
  vm.runInContext('_db=fakeDb; _drivingMode=true; _followCamera=true; _updateGpsMarker=(...args)=>calls.push(["marker",...args]); _highlightNearest=()=>{}; _updateSpeedDisplay=v=>calls.push(["speed",v]); _panTo=(...args)=>calls.push(["pan",...args]);',ctx);
  return {ctx,writes,calls,removed,subscriptions,elements,run:code=>vm.runInContext(code,ctx)};
}
test('pressing Drive restarts a GPS watch that started before location was enabled', () => {
  const {ctx, calls, run, elements} = setup(false);
  const watches = [];
  const cleared = [];
  ctx.isAdmin = () => true;
  ctx.document.body.classList.toggle = () => {};
  elements.get('gpsFollowBtn').classList = {remove() {}};
  ctx.navigator = {geolocation: {
    watchPosition: (success, failure) => watches.push({success, failure}) - 1,
    clearWatch: id => cleared.push(id),
  }};
  ctx.clearTimeout = () => {};
  run('_drivingMode=false; _resetRouteHints=()=>{}; startKeepAlive=()=>{}; _acquireWakeLock=()=>{}; _checkRouteHints=()=>{}');
  ctx._startGpsWatch();
  watches[0].failure({message:'Location disabled'});
  ctx.toggleDrivingMode();
  assert.deepEqual(cleared, [0]);
  assert.equal(watches.length, 2);
  watches[0].success({coords:{latitude:1,longitude:2}});
  assert.equal(calls.some(call => call[0] === 'marker'), false);
  watches[1].success({coords:{latitude:10,longitude:20,accuracy:5,speed:3}});
  assert.ok(calls.some(call => call[0] === 'marker' && call[1] === 10 && call[2] === 20));
  assert.ok(calls.some(call => call[0] === 'pan' && call[1] === 10 && call[2] === 20));
});
test('GPS cannot jump to the return leg of a loop before the intermediate stop is confirmed', () => {
  const {ctx} = setup(false);
  const fractions = [];
  const start = {lat:55, lng:37};
  const stop = {lat:55, lng:37.02, arrA:''};
  ctx.DAYS_DATA[1] = {start, stops:[stop, {...start}]};
  ctx.document.getElementById = () => ({});
  ctx.reachedRouteStopCount = stops => stops.findLastIndex(point => point.arrA) + 1;
  ctx.getDayRouteKm = (_, count = 2) => count;
  ctx.updateRouteProgress = (_, fraction) => fractions.push(fraction);
  ctx._haversineKmPts = (lat, lng, toLat, toLng) => Math.hypot(toLat - lat, toLng - lng) * 100;
  ctx._routeCache = {
    'driving|55,37|55,37.02': [[55,37],[55,37.02]],
    'driving|55,37.02|55,37': [[55,37.02],[55,37]],
  };
  const gps = (longitude, heading) => ctx._updateDriveProgress({latitude:55, longitude, heading, speed:8, accuracy:10});
  gps(37, 270);
  gps(37.01, 90);
  gps(37, 270);
  assert.equal(fractions.length, 1);
  assert.ok(Math.abs(fractions[0] - 0.25) < 0.001);
  stop.arrA = '10:15';
  gps(37, 270);
  gps(37.01, 270);
  assert.deepEqual(fractions.slice(1), [1, 1]);
});

test('a single loop leg cannot match its finish when starting with a reverse heading', () => {
  const {ctx} = setup(false);
  const fractions = [];
  const start = {lat:55, lng:37};
  ctx.DAYS_DATA[1] = {start, stops:[{...start}]};
  ctx.document.getElementById = () => ({});
  ctx.reachedRouteStopCount = () => 0;
  ctx.getDayRouteKm = (_, count = 1) => count;
  ctx.updateRouteProgress = (_, fraction) => fractions.push(fraction);
  ctx._haversineKmPts = (lat, lng, toLat, toLng) => Math.hypot(toLat - lat, toLng - lng) * 100;
  ctx._routeCache = {'driving|55,37|55,37': [[55,37],[55,37.02],[55,37]]};
  const gps = (longitude, heading) => ctx._updateDriveProgress({latitude:55, longitude, heading, speed:8, accuracy:10});
  gps(37, 270);
  gps(37, 90);
  gps(37, 270);
  assert.deepEqual(fractions, [0]);
  gps(37.01, 270);
  gps(37, 270);
  assert.equal(fractions.at(-1), 1);
});

test('owner sends published GPS only for a published active day; reader GPS remains intact',()=>{
  const {ctx,writes,run}=setup(false);
  run('_gpsVehicleStyle = "arrow"');
  ctx._writePosition(10,20,30,4,270,true);
  assert.equal(writes[0].path,'gps');
  assert.equal(writes[0].value.lat,10);
  assert.equal(writes[0].value.spectator.publicationId,'p');
  assert.equal(writes[0].value.heading,270);
  assert.equal(writes[0].value.spectator.heading,270);
  assert.equal(writes[0].value.braking,true);
  assert.equal(writes[0].value.spectator.braking,true);
  assert.equal(writes[0].value.vehicleStyle,'arrow');
  assert.equal(writes[0].value.spectator.vehicleStyle,'arrow');
  ctx.currentDay=2;ctx._writePosition(11,21,31,4);
  assert.equal(writes[1].value.lat,11);
  assert.equal(writes[1].value.spectator,null);
  ctx.currentDay=1;ctx.DAYS_DATA[1].archived=true;ctx._writePosition(12,22,32,4);
  assert.equal(writes[2].value.spectator,null);
});
test('brake lights come on when slowing or stopped and turn off when accelerating', () => {
  const {ctx} = setup(false);
  assert.deepEqual([40, 15, 0, 0, 12, 12, null, 8].map(ctx._drivingBrakeLights),
    [false, true, true, true, false, false, false, false]);
});
test('driving alerts use distance along the road and ignore an off-route or opposite-heading fix', () => {
  const {ctx} = setup(false);
  const steps = [
    {maneuver:{type:'depart'}, geometry:{coordinates:[[0,0],[0.004,0],[0.004,0.004],[0,0.004]]}},
    {maneuver:{type:'off ramp', modifier:'right'}, geometry:{coordinates:[[0,0.004],[0,0.006]]}},
  ];
  assert.equal(ctx._nextDrivingManeuver(steps, {longitude:0,latitude:0.001,accuracy:10,heading:90}), null);
  assert.equal(ctx._nextDrivingManeuver(steps, {longitude:0,latitude:0,accuracy:10,heading:90}), undefined);
  const fix = {longitude:0.003,latitude:0.004,accuracy:10,heading:270};
  const alert = ctx._nextDrivingManeuver(steps, fix);
  assert.ok(alert.meters > 330 && alert.meters < 340);
  assert.equal(alert.label[1], 'направо');
  const approach = {longitude:0.004,latitude:0.0038,accuracy:10,heading:0};
  assert.ok(ctx._nextDrivingManeuver(steps, approach).meters > 400);
  assert.equal(ctx._nextDrivingManeuver(steps, {...approach, latitude:0.0034}), undefined);
  assert.equal(ctx._nextDrivingManeuver(steps, {...fix, heading:90}), null);
});
test('the second exit stays selected inside a roundabout and a legacy cart is a shop', () => {
  const {ctx} = setup(false);
  const steps = [
    {maneuver:{type:'roundabout', exit:2}, geometry:{coordinates:[[0,0],[0.001,0]]}},
    {maneuver:{type:'turn', modifier:'right'}, geometry:{coordinates:[[0.001,0],[0.002,0]]}},
    {maneuver:{type:'exit roundabout'}, geometry:{coordinates:[[0.002,0],[0.004,0]]}},
  ];
  const fix = {longitude:0.0015,latitude:0,accuracy:10,heading:90};
  const alert = ctx._nextDrivingManeuver(steps, fix);
  assert.equal(alert.label[1], '2-й съезд');
  assert.equal(alert.onCircle, true);
  assert.equal(ctx._nextDrivingManeuver(steps, {...fix, longitude:0.003}), undefined);
  assert.equal(ctx._routePlaceType({type:'Другое', icon:'🛒'}), 'Магазин');
});
test('stationary GPS can show a nearby turn despite a stale heading and wider accuracy radius', () => {
  const {ctx} = setup(false);
  ctx.isAdmin = () => true;
  const day = ctx.DAYS_DATA[1];
  day.start = {lat:55,lng:37};
  day.stops = [{lat:55.003,lng:37.003}];
  const key = 'driving|55,37|55.003,37.003';
  ctx._routeCache = {[key]: [[55,37],[55.003,37],[55.003,37.003]]};
  ctx.drivingSteps = new Map([[key, [
    {maneuver:{type:'depart'},geometry:{coordinates:[[37,55],[37,55.003]]}},
    {maneuver:{type:'turn',modifier:'right'},geometry:{coordinates:[[37,55.003],[37.003,55.003]]}},
  ]]]);
  const hints = new Map();
  ctx._setRouteHint = (id, hint) => hints.set(id, hint);
  const coords = {latitude:55.001,longitude:37,accuracy:85,speed:0,heading:180};
  ctx._checkRouteHints(Object.create(coords));
  assert.equal(hints.get('routeManeuver').title, 'направо');
  ctx._checkRouteHints({...coords, longitude:37.002});
  assert.equal(hints.get('routeManeuver'), null);
  ctx._checkRouteHints({...coords, accuracy:130});
  assert.equal(hints.get('routeManeuver'), null);
});

test('driving hints can match a completed leg when the first unvisited stop is elsewhere', () => {
  const {ctx} = setup(false);
  const day = {start:{lat:55,lng:37}, stops:[
    {lat:55.01,lng:37,arrA:'10:00'}, {lat:55.01,lng:37.02},
  ]};
  const first = 'driving|55,37|55.01,37';
  ctx._routeCache = {[first]: [[55,37],[55.01,37]], 'driving|55.01,37|55.01,37.02': [[55.01,37],[55.01,37.02]]};
  const fix = {latitude:55.005,longitude:37,accuracy:5,heading:0};
  assert.equal(ctx._findDrivingHintLeg(day, 1, fix).key, first);
  assert.equal(ctx._findDrivingHintLeg(day, -1, fix).key, first);
  assert.equal(ctx._findDrivingHintLeg(day, -1, {...fix, longitude:37.02}), null);
});

test('stop hints count road bends and wait until the remaining route is within one kilometer', () => {
  const {ctx} = setup(false);
  ctx._routeCache = {'driving|0,0|0,0.001': [[0,0],[0.006,0],[0.006,0.001],[0,0.001]]};
  const day = {start:{lat:0,lng:0}, stops:[{lat:0,lng:0.001}]};
  const fix = {latitude:0,longitude:0,accuracy:5,heading:0};
  assert.deepEqual([...ctx._upcomingRoadStops(day, 0, fix)], []);
  const [hint] = ctx._upcomingRoadStops(day, 0, {...fix, latitude:0.005});
  assert.ok(hint.distance > 0.88 && hint.distance < 0.90);
  assert.deepEqual([...ctx._upcomingRoadStops(day, 0, {...fix, longitude:0.003})], []);
});
test('stopping, unpublishing or switching to an unpublished day clears the spectator branch',()=>{
  for(const action of ['_drivingMode=false','DAYS_DATA[1].publicationId=null','currentDay=2']) {
    const {ctx,writes,run}=setup(false);ctx._writePosition(10,20,30,4);run(action);
    ctx.refreshSpectatorGpsVisibility();
    assert.equal(writes.at(-1).path,'gps/spectator');assert.equal(writes.at(-1).value,null);
  }
});
test('spectator sees live movement, but not archived, unpublished, different-day or stale positions',()=>{
  const {ctx,calls,removed,elements,run}=setup(true);
  ctx._lastSpectatorPosition={publicationId:'p',lat:10,lng:20,speed:30,accuracy:4,vehicleStyle:'sport',ts:Date.now()};
  ctx.refreshSpectatorGpsVisibility();
  assert.ok(calls.some(c=>c[0]==='marker'&&c[1]===10&&c[2]===20&&c[6]==='sport'));
  assert.ok(calls.some(c=>c[0]==='pan'));
  for(const action of ['DAYS_DATA[1].spectatorLive=false','currentDay=2','_lastSpectatorPosition.publicationId="other"','_lastSpectatorPosition.ts=Date.now()-120001']) {
    ctx.currentDay=1;ctx.DAYS_DATA[1].spectatorLive=true;ctx._lastSpectatorPosition.publicationId='p';ctx._lastSpectatorPosition.ts=Date.now();
    run('_gpsMarker={name:"marker"};_accuracyCircle={name:"accuracy"};');calls.length=0;run(action);
    ctx.refreshSpectatorGpsVisibility();
    assert.equal(calls.some(c=>c[0]==='marker'),false);
    assert.equal(elements.get('gpsFollowBtn').style.display,'none');
  }
  assert.equal(removed.length,8);
});
test('published walking day uses the walking icon, driving day uses the car',()=>{
  const {ctx}=setup(true);
  assert.match(ctx._makeCarIcon().html,/class="gps-car"/);
  ctx.DAYS_DATA[1].walkMode = true;
  assert.match(ctx._makeCarIcon().html, /class="gps-walker"/);
  ctx.map = null;
  ctx.realUpdateGpsMarker(55, 37, 8, true, 90, undefined, false, 4, 'dog');
  const walking = ctx._makeCarIcon().html;
  assert.match(walking, /viewBox="0 0 54 40"/);
  assert.match(walking, /gps-walk-marker is-walking/);
  assert.match(walking, /--walk-cycle-factor:1"/);
  assert.match(walking, /class="gps-walk-direction" style="transform:rotate\(90deg\)"/);
  assert.doesNotMatch(walking, /faces-left/);
  ctx.realUpdateGpsMarker(55, 37, 8, true, 270, undefined, false, 4, 'dog');
  assert.match(ctx._makeCarIcon().html, /faces-left/);
  ctx.realUpdateGpsMarker(55, 37, 8, true, 90, undefined, false, 1, 'dog');
  assert.match(ctx._makeCarIcon().html, /--walk-cycle-factor:3"/);
  ctx.realUpdateGpsMarker(55, 37, 8, true, 90, undefined, false, 2, 'dog');
  assert.match(ctx._makeCarIcon().html, /--walk-cycle-factor:1\.5"/);
  ctx.realUpdateGpsMarker(55, 37, 8, true, 90, undefined, false, 0, 'dog');
  assert.doesNotMatch(ctx._makeCarIcon().html, /is-walking/);
  assert.doesNotMatch(ctx._makeCarIcon().html, /gps-walk-direction/);
});
test('car faces its GPS course and ignores position jitter without a heading', () => {
  const {ctx} = setup(false);
  ctx._updateGpsCourse(55, 37, 5, 270);
  assert.match(ctx._makeCarIcon().html, /rotate\(270deg\)/);
  ctx._updateGpsCourse(55, 37.00001, 5, null);
  assert.match(ctx._makeCarIcon().html, /rotate\(270deg\)/);
  ctx._updateGpsCourse(55, 37.0005, 5, null);
  assert.match(ctx._makeCarIcon().html, /rotate\(90deg\)/);
  ctx._updateGpsCourse(54.9995, 37.0005, 5, null);
  assert.match(ctx._makeCarIcon().html, /rotate\(180deg\)/);
});
test('reader continues following the original GPS stream even when day is unpublished',()=>{
  const {ctx,calls,subscriptions}=setup(false);
  ctx._listenRemotePosition();
  assert.equal(subscriptions[0].path,'gps');
  subscriptions[0].callback({val:()=>({lat:10,lng:20,speed:30,accuracy:4,vehicleStyle:'arrow',spectator:null})});
  assert.ok(calls.some(c=>c[0]==='marker'&&c[1]===10&&c[6]==='arrow'));
});
test('published track reaches an already open spectator even with no checkpoints yet', () => {
  const owner = setup(false);
  owner.ctx.CLOUD_CONFIG.binId = 'route';
  Object.assign(owner.ctx.DAYS_DATA[1], {
    start: {lat:10,lng:20,name:'Start'},
    walkReview: {id:'walk',phase:'recording',lastAt:10,segments:[[[10,20],[10,21]]]},
  });
  owner.run('_drivingMode=false; _walkGpsActive=true');
  owner.ctx.broadcastWalkPosition(1,{coords:{latitude:10,longitude:21,accuracy:4,speed:1}});
  const live = owner.writes[0].value;
  // RTDB omits empty arrays and undefined values.
  delete live.walk.day.stops;
  delete live.spectator.walk.day.stops;
  const reader = setup(false);
  reader.ctx.CLOUD_CONFIG = {canWrite:false,binId:'route'};
  delete reader.ctx.DAYS_DATA[1];
  reader.run('renderRemoteWalk = id => calls.push(["track", id])');
  reader.ctx._listenRemotePosition();
  reader.subscriptions[0].callback({val:() => live});
  assert.equal(reader.ctx.DAYS_DATA[1].stops.length, 0);
  assert.ok(reader.calls.some(c => c[0] === 'track'));

  const spectator = setup(true);
  const ctx = spectator.ctx;
  ctx.CLOUD_CONFIG.binId = 'route';
  ctx.dayKeys = () => [1, 2];
  ctx.isDemoMode = () => false;
  ctx.firebase = {apps:[{}],database:() => ctx.fakeDb};
  spectator.run('renderRemoteWalk = id => calls.push(["track", id])');
  ctx.initSpectatorPhotos();
  const listener = spectator.subscriptions[0].callback;
  listener({val:() => live.spectator});
  assert.equal(JSON.stringify(ctx.DAYS_DATA[1].walkReview.segments), '[[[10,20],[10,21]]]');
  assert.ok(spectator.calls.some(c => c[0] === 'track'));

  owner.ctx.stopWalkBroadcast();
  owner.ctx.DAYS_DATA[1].walkReview.phase = 'finished';
  owner.ctx.stopWalkBroadcast(1);
  const final = owner.writes.at(-1).value.spectator;
  assert.equal(final.lat, undefined);
  listener({val:() => final});
  assert.equal(ctx.DAYS_DATA[1].walkReview.phase, 'finished');
  ctx.DAYS_DATA[1].spectatorLive = false;
  delete ctx.DAYS_DATA[1].walkReview;
  listener({val:() => final});
  assert.equal(ctx.DAYS_DATA[1].walkReview, undefined);
});
test('live walks reach the reader over Firebase without private notes or a Gist snapshot',()=>{
  const owner=setup(false);
  owner.ctx.CLOUD_CONFIG.binId='route';
  Object.assign(owner.ctx.DAYS_DATA[1], {
    dateISO:'07.11.2026', start:{lat:10,lng:20,name:'Старт'},
    walkReview:{id:'walk-1',phase:'recording',segments:[[[10,20],[10,21]]]},
    stops:[{id:'stop',lat:10,lng:21,notes:[{text:'private'}]}]
  });
  owner.run('_drivingMode=false; _walkGpsActive=true');
  owner.ctx.broadcastWalkPosition(1,{coords:{latitude:10,longitude:21,accuracy:4,speed:1}});
  const live=owner.writes[0].value;
  assert.equal(owner.writes[0].path,'gps');
  assert.equal(live.walk.day.stops[0].notes,undefined);
  const reader=setup(false);
  reader.ctx.CLOUD_CONFIG={canWrite:false,binId:'route'};
  delete reader.ctx.DAYS_DATA[1];
  assert.equal(reader.ctx.mergeReaderWalk(live.walk),true);
  assert.equal(reader.ctx.DAYS_DATA[1].walkReview.segments[0].length,2);
  assert.equal(reader.ctx.mergeReaderWalk({...live.walk,routeId:'other'}),false);
  assert.equal(reader.ctx.mergeReaderWalk(live.walk,live.walk.updatedAt),false);
  reader.ctx.DAYS_DATA[1].hidden=true;
  assert.equal(reader.ctx.mergeReaderWalk(live.walk),false);
  owner.ctx.stopWalkBroadcast();
  assert.equal(owner.writes.at(-1).value.lat,undefined);
  assert.equal(owner.writes.at(-1).value.walk.day.walkReview.id,'walk-1');
});
test('an unfinished build 3 walk can be shared immediately after upgrade',()=>{
  const owner=setup(false);
  owner.ctx.CLOUD_CONFIG.binId='route';
  owner.ctx.dayKeys=()=>[1,2];
  let update;
  owner.ctx.fakeDb.ref=()=>({transaction:callback=>{update=callback;return Promise.resolve();}});
  Object.assign(owner.ctx.DAYS_DATA[1],{
    start:{lat:10,lng:20,name:'Старт'},
    walkReview:{phase:'paused',startedAt:100,lastAt:200,segments:[[[10,20],[10,21]]]},
  });
  owner.run('_drivingMode=false; publishRecoveredWalk()');
  assert.equal(update(null).walk.day.walkReview.id,'legacy-1-100');
  assert.equal(update(null).walk.day.walkReview.segments[0].length,2);
  assert.equal(update({lat:10,ts:Date.now()}),undefined);
  owner.ctx.DAYS_DATA[1].hidden=true;
  assert.equal(update(null),undefined);
});

test('a late recovery snapshot cannot replace a completed reader route',()=>{
  const {ctx}=setup(false);
  ctx.CLOUD_CONFIG={canWrite:false,binId:'route'};
  const short={dateISO:'07.11.2026',walkReview:{id:'walk',phase:'paused',startedAt:100,lastAt:200,segments:[[[10,20],[10,21]]]},stops:[{id:'500'}]};
  const full={...short,walkReview:{...short.walkReview,phase:'finished',lastAt:400,finishedAt:410},stops:[{id:'500'},{id:'finish',notes:[{text:'photo'}]}]};
  ctx.DAYS_DATA[1]=full;
  assert.equal(ctx.mergeReaderWalk({routeId:'route',dayId:1,updatedAt:900,day:short},800),false);
  assert.equal(ctx.DAYS_DATA[1].stops.length,2);
  ctx.DAYS_DATA[1]=short;
  assert.equal(ctx.mergeReaderWalk({routeId:'route',dayId:1,updatedAt:800,day:full},900),true);
  assert.equal(ctx.DAYS_DATA[1].stops.length,2);
});

test('a saved correction replaces a reader’s finished track even if its finish time is earlier', () => {
  const {ctx, run} = setup(false);
  const storage = fs.readFileSync(path.join(__dirname, '../js/storage.js'), 'utf8');
  run(storage.slice(storage.indexOf('function applyPayload('), storage.indexOf('// ── LOAD STATE')));
  run("CLOUD_CONFIG = {canWrite:false,binId:'route'}; var state = {}; var dayKeys = () => [1];");
  const corrected = {
    walkReview: {id:'walk',phase:'finished',finishedAt:400,segments:[[[10,20],[10,21],[10,22]]]},
    stops: [{id:'500',notes:[{text:'photo'}]},{id:'1000',notes:[]},{id:'finish',notes:[]}]
  };
  const wrong = {
    walkReview: {id:'walk',phase:'finished',finishedAt:500,segments:[[[10,20],[11,21]]]},
    stops: [{id:'500',notes:[]},{id:'finish',notes:[]}]
  };
  ctx.DAYS_DATA[1] = wrong;
  ctx.lateWalk = {routeId:'route',dayId:1,updatedAt:700,day:wrong};
  run('_readerWalk = lateWalk');
  ctx.applyPayload({_savedAt:600,daysData:{1:corrected}}, true);
  assert.equal(ctx.restoreReaderWalk(600), false);
  assert.equal(ctx.mergeReaderWalk(ctx.lateWalk, 600), false);
  assert.deepEqual(ctx.DAYS_DATA[1].walkReview.segments, corrected.walkReview.segments);
  assert.deepEqual(ctx.DAYS_DATA[1].stops, corrected.stops);
});
