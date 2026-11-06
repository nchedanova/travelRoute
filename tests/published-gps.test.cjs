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
    fakeDb:{ref:p=>({set:value=>writes.push({path:p,value}),on:(event,callback)=>subscriptions.push({path:p,callback})})},
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
