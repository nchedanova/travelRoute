const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function setup(spectator = false) {
  const values = new Map();
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Map, Set,
    SPECTATOR_MODE: spectator, LOCAL_PREVIEW: true,
    DAYS_DATA: {}, state: { actuals: {} },
    document: { addEventListener() {}, getElementById: () => null },
    localStorage: { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v) },
    sessionStorage: { getItem: () => null },
    isAdmin: () => !spectator,
    isViewer: () => spectator,
    dayKeys() { return Object.keys(ctx.DAYS_DATA).map(Number); },
    renderAllDays() {}, renderArchiveBtn() {}, showToast() {},
  });
  vm.runInContext(read('js/publishing.js'), ctx);
  const storage = read('js/storage.js');
  vm.runInContext(storage.slice(storage.indexOf('function applyPayload('), storage.indexOf('// ── LOAD STATE')), ctx);
  vm.runInContext(storage.slice(storage.indexOf('function _pickVisibleDay('), storage.indexOf("document.addEventListener('input'")), ctx);
  ctx.saveData = () => {ctx.syncSpectatorPublications();values.set('travel_preview_v1', JSON.stringify({ daysData: ctx.DAYS_DATA, spectatorPublications: ctx.spectatorPublications, actuals: ctx.state.actuals }));};
  return {ctx, values};
}

function day() {
  return { date:'Old trip', departA:'09:00', start:{lat:1,lng:2,name:'Start'}, stops:[{id:'d1s1',name:'Old stop',lat:3,lng:4,arrA:'10:00',notes:[{text:'Public',public:true,images:[]},{text:'Private',public:false,images:[]}]}] };
}

test('spectator follows route order regardless of publication order, including archived days',()=>{
  const {ctx}=setup(true);
  const payload={daysData:{18:{...day(),date:'22',publicationId:'p22'},19:{...day(),date:'23',publicationId:'p23'},20:{...day(),date:'24',archived:true,publicationId:'p24'}},spectatorPublications:{p23:{day:{...day(),date:'23'}},p24:{day:{...day(),date:'24'}},p22:{day:{...day(),date:'22'}}}};
  assert.deepEqual(Object.values(ctx.spectatorPayload(payload).daysData).map(d=>d.date),['22','23','24']);
});

test('legacy publication order recovers original route positions without republishing',()=>{
  const {ctx}=setup(true);
  const entries={};
  for(const number of [19,20,18]) { const d=day(); d.stops[0].id='d'+number+'s1'; d.date=String(number); entries['p'+number]={day:d}; }
  assert.deepEqual(Object.values(ctx.spectatorPayload({spectatorPublications:entries}).daysData).map(d=>d.date),['18','19','20']);
});

test('public note reactions keep original index after private notes are filtered',()=>{
  const {ctx}=setup(true);
  const d=day();d.stops[0].notes.unshift({text:'Private first',public:false,images:[]});
  const copy=ctx.publicationDayCopy(d);
  const result=ctx.spectatorPayload({spectatorPublications:{p:{day:copy}}});
  const note=result.daysData[1].stops[0].notes[0];
  assert.equal(note._reactionSource.stopId,'d1s1');
  assert.equal(note._reactionSource.noteIndex,1);
});

test('already-published notes recover existing reaction paths from their original source',()=>{
  const {ctx}=setup(true);
  const live=day();live.stops[0].notes.unshift({text:'Private first',public:false,images:[]});
  const legacy=structuredClone(live);legacy.stops[0].notes=legacy.stops[0].notes.filter(n=>n.public);
  legacy.stops[0].notes[0].images=['fb:published-photo'];
  const source=structuredClone(live);source.stops[0].notes=source.stops[0].notes.filter(n=>n.public);
  const result=ctx.spectatorPayload({daysData:{1:live},spectatorPublications:{p:{day:legacy,source:JSON.stringify(source)}}});
  assert.equal(result.daysData[1].stops[0].notes[0]._reactionSource.noteIndex,1);
  assert.equal(result.daysData[1].stops[0].notes[0]._reactionSource.stopId,'d1s1');
});

test('spectator renders existing reactions and writes to the original Firebase note',()=>{
  const subscriptions=[];const writes=[];
  function ref(path) {return {child:k=>ref(path+'/'+k),on(event,cb){subscriptions.push(path);cb({val:()=>({'❤️':['other']})});},set(value){writes.push({path,value});}};}
  const ctx=vm.createContext({SPECTATOR_MODE:true,isDemoMode:()=>false,_noteImgDb:()=>({ref}),_findStop:()=>({notes:[{_reactionSource:{stopId:'original-stop',noteIndex:2}}]}),getSessionId:()=> 'spectator-uid',_escN:x=>x,document:{getElementById:()=>null,removeEventListener(){}},console});
  const notes=read('js/notes.js');vm.runInContext(notes.slice(notes.indexOf('const NOTE_REACTIONS =')),ctx);
  const html=ctx.buildNoteReactHtml('pub1s1',0);
  assert.match(html.btn,/Реакция/);
  assert.match(ctx._buildReactRowHtml('pub1s1',0),/❤️ 1/);
  ctx.toggleNoteReaction('pub1s1',0,'❤️');
  assert.deepEqual(subscriptions,['note_reactions/original-stop/2']);
  assert.equal(writes[0].path,'note_reactions/original-stop/2');
  assert.ok(writes[0].value['❤️'].includes('spectator-uid'));
});

test('spectator markup has no publication metadata banner',()=>{
  assert.doesNotMatch(read('js/render.js'),/publication-view-note|Опубликованная копия/);
});

test('active publication updates automatically; archive freezes the final day and deletion preserves it', async () => {
  const {ctx, values} = setup();
  ctx.DAYS_DATA[1] = day();
  await ctx.publishSpectatorDay(1);
  const id = ctx.DAYS_DATA[1].publicationId;
  assert.equal(Object.keys(ctx.spectatorPublications).length, 1);
  ctx.DAYS_DATA[1].stops[0].name = 'Changed stop';
  ctx.saveData();
  let projected=ctx.spectatorPayload(JSON.parse(values.get('travel_preview_v1')));
  assert.equal(projected.daysData[1].stops[0].name,'Changed stop');
  assert.equal(projected.daysData[1].spectatorLive,true);
  ctx.DAYS_DATA[1].archived = true;
  ctx.saveData();
  assert.equal(ctx.spectatorPublications[id].day.stops[0].name, 'Changed stop');
  ctx.DAYS_DATA[1].stops[0].name='Edited after archive';
  ctx.saveData();
  projected=ctx.spectatorPayload(JSON.parse(values.get('travel_preview_v1')));
  assert.equal(projected.daysData[1].stops[0].name,'Changed stop');
  assert.equal(projected.daysData[1].spectatorLive,false);
  delete ctx.DAYS_DATA[1];
  ctx.saveData();
  const viewer = setup(true).ctx;
  viewer.applyPayload(JSON.parse(values.get('travel_preview_v1')));
  assert.equal(viewer.DAYS_DATA[1].stops[0].name, 'Changed stop');
  assert.equal(viewer.DAYS_DATA[1].archived, undefined);
  assert.equal(viewer.DAYS_DATA[1].stops[0].notes.length, 1);
  assert.equal(viewer.DAYS_DATA[1].stops[0].notes[0].text, 'Public');
  assert.equal(viewer.DAYS_DATA[1].stops[0].arrA, '10:00');
  ctx.unpublishSpectatorDay(id);
  viewer.applyPayload(JSON.parse(values.get('travel_preview_v1')));
  assert.equal(Object.keys(viewer.DAYS_DATA).length, 0);
  assert.equal(viewer._pickVisibleDay(1), 0);
});

test('spectator never falls back to live or legacy data, including actual times', () => {
  const {ctx} = setup(true);
  ctx.applyPayload({daysData:{1:day()},actuals:{d1s1:{arrA:'23:59'}}});
  assert.deepEqual(Object.keys(ctx.DAYS_DATA), []);
  ctx.applyPayload({ daysData:{2:day()}, actuals:{pub1s1:{arrA:'23:59'}}, spectatorPublications:{p1:{day:day(),publishedAt:1}} });
  assert.equal(ctx.DAYS_DATA[1].stops[0].arrA,'10:00');
  assert.equal(ctx.DAYS_DATA[2],undefined);
});

test('reader retains live days and archived flags without publication filtering', () => {
  const {ctx} = setup();
  ctx.DAYS_DATA[1] = day();
  ctx.applyPayload({daysData:{1:{...day(),archived:true},2:day()},actuals:{d1s1:{arrA:'23:59'}}});
  assert.equal(ctx.DAYS_DATA[1].archived,true);
  assert.equal(ctx.DAYS_DATA[2].stops[0].arrA,'10:00');
  assert.equal(ctx._pickVisibleDay(1),2);
  ctx.DAYS_DATA[2].archived=true;
  assert.equal(ctx._pickVisibleDay(2),0);
});

test('publishing pins Firebase references without downloading or embedding photos', async () => {
  const {ctx} = setup();
  const item = day();
  item.stops[0].notes[0].images = ['fb:photo'];
  ctx._fbImgCache = {photo:'data:image/png;base64,example'};
  const uploads=[];
  ctx._uploadNoteImgRetry=async data=>{uploads.push(data);return 'fb:published-photo';};
  ctx.DAYS_DATA[1]=item;
  await ctx.publishSpectatorDay(1);
  const entry = Object.values(ctx.spectatorPublications)[0];
  assert.equal(entry.day.stops[0].notes[0].images[0],'fb:photo');
  assert.deepEqual(uploads,[]);
  assert.equal(ctx.isPublicationImagePinned('fb:photo'),true);
  assert.equal(ctx.isPublicationImagePinned('fb:other'),false);
  assert.doesNotMatch(JSON.stringify(entry),/data:image/);
  assert.equal(item.stops[0].notes[0].images[0],'fb:photo');
});

test('explicitly offline photos stay offline without Firebase conversion', async () => {
  const {ctx}=setup();
  ctx.DAYS_DATA[1]=day();
  ctx.DAYS_DATA[1].stops[0].notes[0].images=['data:image/png;base64,offline'];
  ctx._uploadNoteImgRetry=async()=>assert.fail('Offline images should not upload');
  await ctx.publishSpectatorDay(1);
  assert.equal(Object.values(ctx.spectatorPublications)[0].day.stops[0].notes[0].images[0],'data:image/png;base64,offline');
});

test('publication works offline with existing Firebase references and never embeds cached bytes', async () => {
  const {ctx}=setup();
  ctx.DAYS_DATA[1]=day();
  await ctx.publishSpectatorDay(1);
  ctx.DAYS_DATA[1].stops[0].notes[0].images=['fb:photo'];
  ctx._fbImgCache={photo:'data:image/png;base64,example'};
  ctx._uploadNoteImgRetry=async()=>{throw new Error('Firebase unavailable');};
  await ctx.publishSpectatorDay(1);
  assert.equal(Object.values(ctx.spectatorPublications)[0].day.stops[0].notes[0].images[0],'fb:photo');
  assert.doesNotMatch(JSON.stringify(ctx.spectatorPublications),/data:image/);
});

test('original photo deletion is prevented while a completed publication references it', async () => {
  const {ctx} = setup();
  ctx.DAYS_DATA[1]=day();
  await ctx.publishSpectatorDay(1);
  ctx.DAYS_DATA[1].stops[0].notes[0].images=['fb:photo'];
  ctx.DAYS_DATA[1].archived=true;ctx.saveData();
  delete ctx.DAYS_DATA[1];ctx.saveData();
  let deletes=0;
  ctx._noteImgDb=()=>({ref:()=>({remove:()=>{deletes++;return Promise.resolve();}})});
  ctx._fbImgCache={};
  const notes=read('js/notes.js');
  vm.runInContext(notes.slice(notes.indexOf('function _deleteNoteImg('),notes.indexOf('// Вызывается из render.js._resolveImgsInEl')),ctx);
  ctx._deleteNoteImg('fb:photo');assert.equal(deletes,0);
  ctx._deleteNoteImg('fb:other');assert.equal(deletes,1);
});

test('publication controls exist only in settings and no manual copy update remains',()=>{
  assert.doesNotMatch(read('js/render.js'),/openPublicationManager|publication-day-status/);
  assert.doesNotMatch(read('js/publishing.js'),/Обновить копию/);
  assert.match(read('index.html'),/closeCloudSettings\(\);openPublicationManager\(\)/);
});

test('active published changes are visible even when hidden from ordinary readers',async()=>{
  const {ctx,values}=setup();ctx.DAYS_DATA[1]=day();ctx.DAYS_DATA[1].hidden=true;
  await ctx.publishSpectatorDay(1);
  ctx.DAYS_DATA[1].stops[0].arrA='11:22';ctx.DAYS_DATA[2]={...day(),date:'Unpublished'};
  ctx.saveData();
  const projected=ctx.spectatorPayload(JSON.parse(values.get('travel_preview_v1')));
  assert.equal(Object.keys(projected.daysData).length,1);
  assert.equal(projected.daysData[1].hidden,undefined);
  assert.equal(projected.daysData[1].stops[0].arrA,'11:22');
});
