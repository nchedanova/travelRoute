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
  ctx.saveData = () => values.set('travel_preview_v1', JSON.stringify({ daysData: ctx.DAYS_DATA, spectatorPublications: ctx.spectatorPublications, actuals: ctx.state.actuals }));
  return {ctx, values};
}

function day() {
  return { date:'Old trip', departA:'09:00', start:{lat:1,lng:2,name:'Start'}, stops:[{id:'d1s1',name:'Old stop',lat:3,lng:4,arrA:'10:00',notes:[{text:'Public',public:true,images:[]},{text:'Private',public:false,images:[]}]}] };
}

test('publication survives source edits, archive, deletion and reload; only explicit update replaces it', async () => {
  const {ctx, values} = setup();
  ctx.DAYS_DATA[1] = day();
  await ctx.publishSpectatorDay(1);
  const id = ctx.DAYS_DATA[1].publicationId;
  assert.equal(Object.keys(ctx.spectatorPublications).length, 1);
  ctx.DAYS_DATA[1].stops[0].name = 'Changed stop';
  ctx.DAYS_DATA[1].archived = true;
  assert.equal(ctx.publicationChanged(1), true);
  assert.equal(ctx.spectatorPublications[id].day.stops[0].name, 'Old stop');
  await ctx.publishSpectatorDay(1);
  assert.equal(ctx.spectatorPublications[id].day.stops[0].name, 'Changed stop');
  assert.equal(ctx.publicationChanged(1), false);
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

test('published photos are independent of removable Firebase originals', async () => {
  const {ctx} = setup();
  const item = day();
  item.stops[0].notes[0].images = ['fb:photo'];
  ctx._fbImgCache = {photo:'data:image/png;base64,example'};
  const uploads=[];
  ctx._uploadNoteImgRetry=async data=>{uploads.push(data);return 'fb:published-photo';};
  ctx.DAYS_DATA[1]=item;
  await ctx.publishSpectatorDay(1);
  const entry = Object.values(ctx.spectatorPublications)[0];
  assert.equal(entry.day.stops[0].notes[0].images[0],'fb:published-photo');
  assert.deepEqual(uploads,['data:image/png;base64,example']);
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

test('Firebase upload failure never falls back to embedded photo data', async () => {
  const {ctx}=setup();
  ctx.DAYS_DATA[1]=day();
  await ctx.publishSpectatorDay(1);
  const before=JSON.stringify(ctx.spectatorPublications);
  ctx.DAYS_DATA[1].stops[0].notes[0].images=['fb:photo'];
  ctx._fbImgCache={photo:'data:image/png;base64,example'};
  ctx._uploadNoteImgRetry=async()=>{throw new Error('Firebase unavailable');};
  await ctx.publishSpectatorDay(1);
  assert.equal(JSON.stringify(ctx.spectatorPublications),before);
  assert.doesNotMatch(JSON.stringify(ctx.spectatorPublications),/data:image/);
});

test('unavailable photo leaves an existing publication unchanged', async () => {
  const {ctx} = setup();
  ctx.DAYS_DATA[1]=day();
  await ctx.publishSpectatorDay(1);
  const before = JSON.stringify(ctx.spectatorPublications);
  ctx.DAYS_DATA[1].stops[0].notes[0].images=['fb:missing'];
  await ctx.publishSpectatorDay(1);
  assert.equal(JSON.stringify(ctx.spectatorPublications),before);
});
