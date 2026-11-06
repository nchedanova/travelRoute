const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
function setup() {
  let saved;
  const fields=new Map();
  const ctx=vm.createContext({
    console:{log(){},error(e){throw e;}}, Blob, Date, JSON, Object, Number,
    DAYS_DATA:{},state:{actuals:{}},currentDay:1,layers:{},segmentLayers:{},DAY_COLORS:['red'],
    document:{getElementById:id=>fields.has(id)?{value:fields.get(id)}:null,querySelectorAll:()=>[]},
    localStorage:{setItem(k,v){saved=JSON.parse(v);}},
    isAdmin:()=>true,isViewer:()=>false,CLOUD_CONFIG:{canWrite:false},
    map:{hasLayer:()=>false,removeLayer(){}},L:{layerGroup:()=>({})},
    redrawDay(){},renderTabs(){},renderAllDays(){fields.clear();},renderArchiveBtn(){},
    snapshotForUndo(){},updateProgress(){},showToast(){},toggleArchive(){},
    switchDay(d){ctx.currentDay=d;},
    dayKeys(){return Object.keys(ctx.DAYS_DATA).map(Number);},
  });
  const storage=read('js/storage.js');
  vm.runInContext(storage.slice(storage.indexOf('function applyPayload('),storage.indexOf('// ── LOAD STATE')),ctx);
  vm.runInContext(storage.slice(storage.indexOf('function captureActualTimeInputs('),storage.indexOf('// ── AUTO-POLL')),ctx);
  vm.runInContext(storage.slice(storage.indexOf('function _pickVisibleDay('),storage.indexOf("document.addEventListener('input'")),ctx);
  const app=read('js/app.js');
  vm.runInContext(app.slice(app.indexOf('function swapDays('),app.indexOf('function renderArchiveBtn(')),ctx);
  return {ctx,fields,saved:()=>saved};
}
function fixtures() {
  const dates=['27.07.2026','28.07.2026','29.07.2026','30.07.2026','31.07.2026','01.08.2026'];
  return Object.fromEntries(dates.map((date,i)=>[i+1,{dateISO:date,departA:`0${i+1}:15`,start:{lat:i+1,lng:2},stops:[{id:`original${i}`,num:1,arrA:`1${i}:20`,depA:`1${i}:35`,notes:[]}]}]));
}
function timesByDate(days) {
  return Object.fromEntries(Object.values(days).map(d=>[d.dateISO,{departA:d.departA,stops:d.stops.map(s=>({id:s.id,arrA:s.arrA,depA:s.depA}))}]));
}
test('July 27 to August 1 history survives archive, reorder, restore, save and reload',()=>{
  const {ctx,saved}=setup();
  ctx.DAYS_DATA=fixtures();
  const expected=timesByDate(ctx.DAYS_DATA);
  ctx.archiveDay(1);
  ctx.swapDays(6,2);
  const archivedKey=ctx.dayKeys().find(k=>ctx.DAYS_DATA[k].dateISO==='27.07.2026');
  ctx.restoreDay(archivedKey);
  ctx.saveData();
  const payload=saved();
  // Simulate stale positional fields left over by an old build.
  payload.dep1='23:59';
  payload.actuals.original0={arrA:'23:59',depA:'23:58'};
  ctx.applyPayload(payload);
  assert.deepEqual(timesByDate(ctx.DAYS_DATA),expected);
});
test('archiving last active day preserves time including not-yet-blurred inputs',()=>{
  const {ctx,fields,saved}=setup();
  ctx.DAYS_DATA={1:fixtures()[1]};
  fields.set('d1-depart','04:12');
  fields.set('arr-original0','12:34');
  fields.set('dep-original0','12:56');
  ctx.archiveDay(1);
  const day=saved().daysData[1];
  assert.equal(day.departA,'04:12');
  assert.equal(day.stops[0].arrA,'12:34');
  assert.equal(day.stops[0].depA,'12:56');
  assert.equal(ctx.currentDay,0);
  ctx.applyPayload(saved());
  assert.equal(ctx.DAYS_DATA[1].departA,'04:12');
});
test('cleared modern facts stay cleared; legacy missing fields still migrate',()=>{
  const {ctx}=setup();
  ctx.DAYS_DATA=fixtures();
  const modern=fixtures();
  modern[1].departA='';modern[1].stops[0].arrA='';
  ctx.applyPayload({daysData:modern,dep1:'23:59',actuals:{original0:{arrA:'23:58'}}});
  assert.equal(ctx.DAYS_DATA[1].departA,'');
  assert.equal(ctx.DAYS_DATA[1].stops[0].arrA,'');
  delete modern[1].departA;delete modern[1].stops[0].arrA;
  ctx.applyPayload({daysData:modern,dep1:'03:21',actuals:{original0:{arrA:'04:32'}}});
  assert.equal(ctx.DAYS_DATA[1].departA,'03:21');
  assert.equal(ctx.DAYS_DATA[1].stops[0].arrA,'04:32');
});
