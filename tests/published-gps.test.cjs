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
    console,Date,Number,SPECTATOR_MODE:spectator,DAYS_DATA:days,currentDay:1,
    CLOUD_CONFIG:{canWrite:!spectator},publicationEntry:d=>days[d]?.publicationId?{}:null,
    fakeDb:{ref:p=>({set:value=>{writes.push({path:p,value});return Promise.resolve();},on:(event,callback)=>subscriptions.push({path:p,callback})})},
    document:{addEventListener(){},body:{classList:{add(){},remove(){}}},getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[]},
    map:{removeLayer:m=>removed.push(m)},L:{divIcon:options=>options},calls,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/gps.js'),'utf8'),ctx);
  vm.runInContext('_db=fakeDb; _drivingMode=true; _followCamera=true; _updateGpsMarker=(...args)=>calls.push(["marker",...args]); _highlightNearest=()=>{}; _updateSpeedDisplay=v=>calls.push(["speed",v]); _panTo=(...args)=>calls.push(["pan",...args]);',ctx);
  return {ctx,writes,calls,removed,subscriptions,elements,run:code=>vm.runInContext(code,ctx)};
}
test('owner sends published GPS only for a published active day; reader GPS remains intact',()=>{
  const {ctx,writes}=setup(false);
  ctx._writePosition(10,20,30,4);
  assert.equal(writes[0].path,'gps');
  assert.equal(writes[0].value.lat,10);
  assert.equal(writes[0].value.spectator.publicationId,'p');
  ctx.currentDay=2;ctx._writePosition(11,21,31,4);
  assert.equal(writes[1].value.lat,11);
  assert.equal(writes[1].value.spectator,null);
  ctx.currentDay=1;ctx.DAYS_DATA[1].archived=true;ctx._writePosition(12,22,32,4);
  assert.equal(writes[2].value.spectator,null);
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
  ctx._lastSpectatorPosition={publicationId:'p',lat:10,lng:20,speed:30,accuracy:4,ts:Date.now()};
  ctx.refreshSpectatorGpsVisibility();
  assert.ok(calls.some(c=>c[0]==='marker'&&c[1]===10&&c[2]===20));
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
  assert.match(ctx._makeCarIcon(true).html,/🚗/);
  ctx.DAYS_DATA[1].walkMode=true;assert.match(ctx._makeCarIcon(true).html,/🚶/);
});
test('reader continues following the original GPS stream even when day is unpublished',()=>{
  const {ctx,calls,subscriptions}=setup(false);
  ctx._listenRemotePosition();
  assert.equal(subscriptions[0].path,'gps');
  subscriptions[0].callback({val:()=>({lat:10,lng:20,speed:30,accuracy:4,spectator:null})});
  assert.ok(calls.some(c=>c[0]==='marker'&&c[1]===10));
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
