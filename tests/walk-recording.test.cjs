const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const read=file=>fs.readFileSync(require('node:path').join(__dirname,'../js',file),'utf8');
function setup(){
 const ctx=vm.createContext({window:{addEventListener(){}},localStorage:{getItem:()=>null},Date});
 vm.runInContext(read('map.js'),ctx);
 ctx.fetchRoadSegment=async (a,b,profile)=>{assert.equal(profile,'foot');return [[a.lat,a.lng],[b.lat,b.lng]]};
 ctx.haversineKm=(...p)=>ctx._haversineKmPts(...p);
 const source=read('local-preview.js');
 vm.runInContext(source.slice(source.indexOf('function acceptWalkGpsFix('),source.indexOf('function installWalkReview(')),ctx);
 return ctx;
}
const fix=(lat,time,accuracy=5)=>({coords:{latitude:lat,longitude:37,accuracy},timestamp:time});
test('background and cached fixes cannot append a spike; foreground waits for stable fresh GPS',()=>{
 const c=setup(),a={last:{point:[55,37],time:100000,accuracy:5},lastSignalAt:100000};
 assert.equal(c.acceptWalkGpsFix(a,fix(55.001,101000),true,101000),false);
 a.visibleAt=103000;
 assert.equal(c.acceptWalkGpsFix(a,fix(55.001,102000),false,103000),false);
 assert.equal(c.acceptWalkGpsFix(a,fix(55.001,104000),false,104000),false);
 assert.equal(c.acceptWalkGpsFix(a,fix(55.00001,105000),false,105000),false);
 assert.equal(c.acceptWalkGpsFix(a,fix(55.00002,108000),false,108000),true);
 assert.equal(a.recovering,false);
});
test('a stable but impossible jump, stale timestamp and poor accuracy are rejected on reacquisition',()=>{
 const c=setup(),a={last:{point:[55,37],time:100000,accuracy:5},recovering:true};
 for(const t of [101000,104000,107000]) assert.equal(c.acceptWalkGpsFix(a,fix(56,t),false,t),false);
 assert.equal(c.acceptWalkGpsFix(a,fix(55,108000,30),false,108000),false);
 assert.equal(c.acceptWalkGpsFix(a,fix(55,101000),false,109000),false);
});
test('initial GPS waits for confirmation without changing the ready route',()=>{
 const c=setup(),a={};
 assert.equal(c.acceptWalkGpsFix(a,fix(55,100000),false,100000),false);
 assert.equal(c.acceptWalkGpsFix(a,fix(55.00001,101000),false,101000),false);
 assert.equal(c.acceptWalkGpsFix(a,fix(55.00002,103000),false,103000),true);
});
test('moving recorded start and finish updates the line and distance without dropping middle samples',async()=>{
 const c=setup();
 const day={walkReview:{meters:300,segments:[[[55,37],[55.001,37],[55.002,37]]]}};
 const old=structuredClone(day);
 await c.moveRecordedWalkPoint(day,{lat:55,lng:37},{lat:54.999,lng:37},true);
 assert.deepEqual(Array.from(day.walkReview.segments[0][0]),[54.999,37]);
 assert.ok(day.walkReview.meters>410 && day.walkReview.meters<412);
 await c.moveRecordedWalkPoint(day,{lat:55.002,lng:37},{lat:55.003,lng:37},false,true);
 assert.deepEqual(Array.from(day.walkReview.segments[0].at(-1)),[55.003,37]);
 assert.deepEqual(Array.from(day.walkReview.segments[0][1]),old.walkReview.segments[0][1]);
 assert.ok(day.walkReview.meters>521 && day.walkReview.meters<524);
});
test('editing an interpolated checkpoint connects it to the trace and preserves pauses',async()=>{
 const c=setup();
 const day={walkReview:{meters:400,segments:[[[55,37],[55.002,37]],[[55.003,37],[55.004,37]]]}};
 await c.moveRecordedWalkPoint(day,{lat:55.001,lng:37},{lat:55.001,lng:37.001});
 assert.equal(day.walkReview.segments.length,2);
 assert.deepEqual(Array.from(day.walkReview.segments[0][1]),[55.001,37.001]);
 assert.ok(day.walkReview.meters>400);
 const meters=day.walkReview.meters;
 await c.moveRecordedWalkPoint(day,{lat:55.001,lng:37.001},{lat:55.001,lng:37.001});
 assert.equal(day.walkReview.meters,meters);
});
test('first accepted GPS fix keeps chosen start name, icon and coordinates',async()=>{
 const c=setup();
 const source=read('local-preview.js');
 vm.runInContext(source.slice(source.indexOf('  function setRecordedStart('),source.indexOf('  function addRecordedStop(')),c);
 const fields={};c.document={getElementById:id=>fields[id]||=( {classList:{remove(){}}})};
 c.startPointNameMarkup=s=>s.name;c.updateDayRoute=()=>{};c.redrawDay=()=>{};c.recordedTime=()=> '12:00';c.refreshWalkTrackLine=()=>{};c.updateRecordingReadout=()=>{};c.saveData=()=>{};
 c.DAYS_DATA={1:{start:{lat:55,lng:37,name:'Парк',icon:'graphic:parkTree'},walkReview:{startEdited:true,segments:[[[55.001,37]]],meters:0}}};
 c.setRecordedStart(1,{point:[55.001,37],time:100000});
 await new Promise(setImmediate);
 assert.equal(c.DAYS_DATA[1].start.name,'Парк');assert.equal(c.DAYS_DATA[1].start.icon,'graphic:parkTree');
 assert.equal(c.DAYS_DATA[1].start.lat,55);assert.equal(c.DAYS_DATA[1].walkReview.segments[0].length,2);
 assert.ok(c.DAYS_DATA[1].walkReview.meters>100);
});
test('moving the finish uses pedestrian road geometry and counts its detour, preserving earlier GPS samples',async()=>{
 const c=setup(),calls=[];
 const day={walkReview:{meters:300,segments:[[[55,37],[55.001,37],[55.002,37]]]}};
 c.fetchRoadSegment=async(a,b,p)=>{calls.push({a,b,p});return [[a.lat,a.lng],[55.001,37.002],[55.003,37.002],[b.lat,b.lng]]};
 assert.equal(await c.moveRecordedWalkPoint(day,{lat:55.002,lng:37},{lat:55.003,lng:37},false,true),true);
 assert.equal(calls.length,1);assert.equal(calls[0].p,'foot');
 assert.deepEqual(Array.from(day.walkReview.segments[0][0]),[55,37]);
 assert.ok(day.walkReview.segments[0].some(p=>p[1]===37.002));
 assert.ok(day.walkReview.meters>600);
});
test('failed road routing never writes a straight replacement or changes recorded length',async()=>{
 const c=setup();c.fetchRoadSegment=async()=>null;
 const day={walkReview:{meters:300,segments:[[[55,37],[55.001,37],[55.002,37]]]}};
 const before=JSON.stringify(day);
 assert.equal(await c.moveRecordedWalkPoint(day,{lat:55.002,lng:37},{lat:55.003,lng:37},false,true),false);
 assert.equal(JSON.stringify(day),before);
});
test('concurrent saves cannot bypass pending road routing with a direct connection',async()=>{
 const c=setup();let resolve;let requests=0;
 c.fetchRoadSegment=()=>{requests++;return new Promise(r=>{resolve=r})};
 const day={walkReview:{meters:300,segments:[[[55,37],[55.001,37],[55.002,37]]]}};
 const first=c.moveRecordedWalkPoint(day,{lat:55.002,lng:37},{lat:55.003,lng:37},false,true);
 assert.equal(await c.moveRecordedWalkPoint(day,{lat:55.002,lng:37},{lat:55.003,lng:37},false,true),false);
 assert.equal(requests,1);resolve([[55.001,37],[55.002,37.001],[55.003,37]]);assert.equal(await first,true);
});
