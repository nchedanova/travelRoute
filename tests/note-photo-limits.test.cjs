const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/notes.js'),'utf8');

test('general notes accept more than five photos',()=>{
  const ctx=vm.createContext({showToast(){throw new Error('Unexpected photo limit');}});
  vm.runInContext(source.slice(source.indexOf('const MAX_STOP_NOTE_IMAGES'),source.indexOf('// ── NOTE TAB PHOTO BUTTON')),ctx);
  ctx._renderNoteTabPending=()=>{};
  for(let i=0;i<12;i++)ctx._addNoteTabImage('photo-'+i);
  assert.equal(vm.runInContext('_noteTabPendingImages.length',ctx),12);
});

test('point notes count saved and pending photos together and reject the sixth',()=>{
  const pending={},stop={notes:[{images:['a','b','c','d']}]};let rejected=0;
  const ctx=vm.createContext({MAX_STOP_NOTE_IMAGES:5,_pendingStopImages:pending,_stopNoteImageDrafts:{},
    _pendingKey:(id,idx)=>id+'-'+idx,_findStop:()=>stop,_renderStopNoteEditImages(){},showToast(){rejected++;}});
  vm.runInContext(source.slice(source.indexOf('function _stopNoteEditImages('),source.indexOf('function cancelStopNoteEdit(')),ctx);
  vm.runInContext(source.slice(source.indexOf('function addPendingStopImage('),source.indexOf('function removePendingStopImage(')),ctx);
  ctx.addPendingStopImage('s',0,'e');ctx.addPendingStopImage('s',0,'f');
  assert.equal(pending['s-0'].length,1);assert.equal(stop.notes[0].images.length,4);assert.equal(rejected,1);
});

test('closing a point-note draft restores saved text and photos without deleting remote images',()=>{
  const stop={notes:[{text:'Saved text',images:['fb:a','fb:b'],public:true}]};
  let renders=0;
  const ctx=vm.createContext({_pendingStopImages:{'s-0':['new-photo']},_pendingStopOffline:{'s-0':true},
    _stopNoteImageDrafts:{},_savingStopNotes:{},_pendingKey:(id,idx)=>id+'-'+idx,_findStop:()=>stop,
    _renderStopNoteEditImages(){},_deleteNoteImg(){throw new Error('Draft must not delete remote photos');},
    renderStops(){renders++;},document:{getElementById(){return null;}}});
  vm.runInContext(source.slice(source.indexOf('function _stopNoteEditImages('),source.indexOf('function setStopNoteOffline(')),ctx);
  vm.runInContext(source.slice(source.indexOf('function removePendingStopImage('),source.indexOf('function _renderStopNoteEditImages(')),ctx);
  ctx.removePendingStopImage('s',0,0);
  assert.equal(ctx._stopNoteImageDrafts['s-0'].length,1);
  assert.equal(stop.notes[0].images.length,2);
  ctx.cancelStopNoteEdit('s',1,0);
  assert.equal(stop.notes[0].text,'Saved text');assert.deepEqual(stop.notes[0].images,['fb:a','fb:b']);
  assert.equal(ctx._pendingStopImages['s-0'],undefined);assert.equal(ctx._stopNoteImageDrafts['s-0'],undefined);
  assert.equal(renders,1);
});
