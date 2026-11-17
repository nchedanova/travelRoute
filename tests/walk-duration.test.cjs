const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/render.js'),'utf8');
const ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function recordedWalkDurationMinutes('),source.indexOf('function fmtDelta(')),ctx);
const duration=ctx.recordedWalkDurationMinutes;
function day(start,end){return {departP:'11:00',departA:start,stops:[{id:'finish',arrP:'11:40',arrA:end}],walkReview:{phase:'finished',startedAt:100000,finishedAt:2020000}}}
test('completed walk uses corrected actual start and finish: 11:01–11:39 is 38 minutes, not recorder 32',()=>{
 assert.equal(duration(day('11:01','11:39')),38);
});
test('readout immediately uses edited fields before saved state catches up',()=>{
 assert.equal(duration(day('11:01','11:39'),(id,saved)=>id==='arr-finish'?'11:45':saved),44);
});
test('actual walk duration crosses midnight and includes a rest stop',()=>{
 const d=day('23:50','00:30');d.stops.unshift({id:'rest',arrA:'23:59',depA:'00:10'});
 assert.equal(duration(d),40);
});
test('legacy missing actual times falls back to recorder timestamps, never planned times',()=>{
 assert.equal(duration(day('','')),32);
 const d=day('11:01','11:39');d.walkReview.phase='recording';d.walkReview.lastAt=700000;delete d.walkReview.finishedAt;
 assert.equal(duration(d),10);
});
