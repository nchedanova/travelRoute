const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const copy=v=>v===undefined?null:JSON.parse(JSON.stringify(v));
function backend(){
 const data={'.info':{connected:true,serverTimeOffset:0}},listeners=[],writes=[];
 const get=p=>p.split('/').reduce((v,k)=>v?.[k],data);
 function set(p,value){const parts=p.split('/');let node=data;for(const k of parts.slice(0,-1))node=node[k]||=( {});node[parts.at(-1)]=copy(value);writes.push({path:p,value:copy(value)});for(const l of [...listeners])if(p===l.p||p.startsWith(l.p+'/')||l.p.startsWith(p+'/'))l.cb({val:()=>copy(get(l.p))});}
 const ref=p=>({
  child:k=>ref(p+'/'+k),
  on:(type,cb)=>{listeners.push({p,cb});cb({val:()=>copy(get(p))})},
  off:()=>{for(let i=listeners.length-1;i>=0;i--)if(listeners[i].p===p)listeners.splice(i,1)},
  once:async()=>({val:()=>copy(get(p))}),set:async v=>set(p,v),
  transaction:async fn=>{
   const next=fn(copy(get(p)));
   if(next===undefined)return {committed:false,snapshot:{val:()=>copy(get(p))}};
   set(p,next);return {committed:true,snapshot:{val:()=>copy(get(p))}};
  }
 });
 return {db:{ref},data,writes,set,get};
}
const walkDay=()=>({date:'Прогулка',dateISO:'18.11.2026',start:{lat:55,lng:37,name:'Старт'},walkMode:true,departA:'10:00',walkReview:{id:'walk-one',phase:'recording',startedAt:100000,lastAt:100000,segments:[[[55,37]]],meters:0},stops:[{id:'s1',num:1,name:'Остановка',lat:55.001,lng:37,notes:[]}]});
function client(server,id,options={}){
 const events=[],toasts=[],saved=[],cards=new Map(),editors=[],timers=[],cache=new Map();
 const list={appendChild(c){cards.set(c.id,c)},replaceChildren(){cards.clear()},querySelectorAll:()=>[]};
 const section={querySelector:()=>({}),querySelectorAll:()=>[]};
 const document={activeElement:null,dispatchEvent:e=>events.push(e.type),addEventListener(){},querySelectorAll:()=>editors,querySelector:()=>null,getElementById:key=>key==='day1'?section:key==='d1-stops'?list:cards.get(key)||null};
 const ctx=vm.createContext({console,Date:options.Date||Date,localStorage:{setItem:(k,v)=>cache.set(k,v)},crypto:{randomUUID:()=>id},Event:class{constructor(type){this.type=type}},setInterval(fn,ms){timers.push({fn,ms})},CLOUD_CONFIG:{canWrite:options.admin!==false,binId:'route'},SPECTATOR_MODE:false,DAYS_DATA:{1:walkDay()},currentDay:1,document,fetch:()=>{throw Error('Unexpected HTTP request')},saveData:()=>saved.push(true),showToast:s=>toasts.push(s),
  sameRecordedWalk:(a,b)=>a.walkReview?.id===b.walkReview?.id,redrawDay(){},renderTabs(){},updateDayRoute(){},updateProgress(){},switchDay(){},fitDayMap(){},map:{hasLayer:()=>true},layers:{1:{}},_walkGpsActive:false,_drivingMode:false,
  _updateGpsMarker(){},_setGpsControls(){},_updateSpeedDisplay(){},spectatorWalkPayload:()=>null,walkBroadcastPayload:()=>({routeId:'route',dayId:1,updatedAt:Date.now(),day:walkDay()}),
  makeStopCard:(s,d)=>({id:'card-'+s.id,replaceWith(c){cards.set(c.id,c)}})});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/walk-collaboration.js'),'utf8'),ctx);
 ctx.walkCollaboration.bind(server.db);
 return {ctx,api:ctx.walkCollaboration,events,toasts,saved,cards,editors,timers,cache};
}
const drain=async()=>{for(let i=0;i<10;i++)await new Promise(setImmediate)};
function payload(c){return {routeId:'route',dayId:1,updatedAt:Date.now(),day:copy(c.ctx.DAYS_DATA[1])}}
test('only one recorder claims a session; explicit takeover fences the old device',async()=>{
 const s=backend(),a=client(s,'a'),b=client(s,'b');
 assert.equal(await a.api.claim(1),true);assert.equal(await b.api.claim(1),false);
 assert.equal(b.api.hasRemoteRecorder(),true);assert.equal(a.api.isOwner(),true);
 assert.equal(await b.api.claim(1,true),true);assert.equal(a.api.isOwner(),false);
 assert.ok(a.events.includes('walk-recorder-lost'));
 a.api.publish(1,payload(a),{lat:55,lng:37},null);await drain();
 assert.equal(s.get('walkRecorders/route')?.live,undefined);
 b.api.publish(1,payload(b),{lat:55,lng:37},null);await drain();
 assert.equal(s.get('walkRecorders/route')?.live.ownerId,'b');
});
test('second admin sees new live checkpoints without replacing an open note editor',async()=>{
 const s=backend(),a=client(s,'a'),b=client(s,'b');await a.api.claim(1);
 const editor={id:'stop-note-edit-s1-0',style:{display:'block'},value:'Черновик'};b.editors.push(editor);
 b.ctx.DAYS_DATA[1].stops[0].notes.push({id:'draft',text:'Черновик',images:[]});
 a.ctx.DAYS_DATA[1].stops.push({id:'s2',num:2,name:'500 м',lat:55.002,lng:37,notes:[]});
 a.ctx.DAYS_DATA[1].walkReview.segments[0].push([55.002,37]);
 a.api.publish(1,payload(a),{lat:55.002,lng:37},null);await drain();
 assert.equal(b.ctx.DAYS_DATA[1].stops.length,2);
 assert.equal(b.ctx.DAYS_DATA[1].walkReview.segments[0].length,2);
 assert.equal(b.ctx.DAYS_DATA[1].stops[0].notes[0].text,'Черновик');
 assert.equal(b.editors[0],editor);assert.equal(editor.value,'Черновик');
 assert.ok(b.cards.has('card-s2'));
});
test('different notes and Firebase photo references merge, and later GPS cannot erase them',async()=>{
 const s=backend(),a=client(s,'a'),b=client(s,'b');await a.api.claim(1);
 a.api.publish(1,payload(a),{lat:55,lng:37},null);await drain();
 await Promise.all([
  a.api.saveNote(1,a.ctx.DAYS_DATA[1].stops[0],'note-a',{id:'note-a',text:'Скамейка',images:[],public:true}),
  b.api.saveNote(1,b.ctx.DAYS_DATA[1].stops[0],'note-b',{id:'note-b',text:'Фото',images:['fb:photo-one'],public:true})]);
 a.api.flush();b.api.flush();
 for(const c of [a,b])assert.equal(c.ctx.DAYS_DATA[1].stops[0].notes.length,2);
 const noteSaves=a.saved.length;
 assert.ok(noteSaves>0);
 a.api.publish(1,payload(a),{lat:55.002,lng:37},null);await drain();
 assert.equal(b.ctx.DAYS_DATA[1].stops[0].notes.find(n=>n.id==='note-b').images[0],'fb:photo-one');
 assert.equal(a.saved.length,noteSaves);assert.equal(b.saved.length,0);
});
test('same note conflict is explicit and a tombstone cannot resurrect a deleted note',async()=>{
 const s=backend(),a=client(s,'a'),b=client(s,'b');await a.api.claim(1);
 await a.api.saveNote(1,a.ctx.DAYS_DATA[1].stops[0],'note',{id:'note',text:'Исходная',images:[]});a.api.flush();b.api.flush();
 const stop=b.ctx.DAYS_DATA[1].stops[0];b.api.beginNoteEdit(1,stop,stop.notes[0]);b.editors.push({id:'stop-note-edit-s1-0',style:{display:'block'}});
 await a.api.saveNote(1,a.ctx.DAYS_DATA[1].stops[0],'note',null);a.api.flush();
 await assert.rejects(b.api.saveNote(1,stop,'note',{id:'note',text:'Черновик'}),/изменили/);
 b.api.cancelNoteEdit(1,'s1','note');b.editors.length=0;b.api.flush();
 assert.equal(stop.notes.length,0);
});
test('finished recording is persisted once ownership is released and helper receives the finish',async()=>{
 const s=backend(),a=client(s,'a'),b=client(s,'b');await a.api.claim(1);
 a.ctx.DAYS_DATA[1].walkReview.phase='finished';a.ctx.DAYS_DATA[1].walkReview.finishedAt=Date.now();
 a.api.publish(1,payload(a),null,null);await drain();
 assert.equal(s.get('walkRecorders/route').phase,'finished');
 assert.equal(b.ctx.DAYS_DATA[1].walkReview.phase,'finished');
 assert.equal(a.saved.length,1);assert.equal(a.api.suppressCloudSave(),false);
});
test('read-only users never subscribe to recorder control or collaborative private notes',()=>{
 const s=backend(),a=client(s,'a',{admin:false});const count=s.writes.length;
 assert.equal(a.api.ready,false);
 assert.equal(a.api.hasRemoteRecorder(),false);assert.equal(a.api.collaborative(a.ctx.DAYS_DATA[1]),false);
 assert.equal(s.writes.length,count);
});
test('loss of network does not pause a walk; synchronization resumes without a forced takeover',async()=>{
 let time=100000;class Clock extends Date {static now(){return time}}
 const s=backend(),a=client(s,'a',{Date:Clock});await a.api.claim(1);
 s.set('.info/connected',false);time+=120000;
 for(const timer of a.timers)if(timer.ms===5000)await timer.fn();
 assert.equal(a.events.filter(e=>e==='walk-recorder-lost').length,0);
 assert.equal(a.api.localOnly(a.ctx.DAYS_DATA[1]),true);assert.equal(a.api.suppressCloudSave(),true);
 s.set('.info/connected',true);await drain();
 assert.equal(a.api.isOwner(),true);assert.equal(a.api.localOnly(a.ctx.DAYS_DATA[1]),false);
});
test('a new offline walk stays local and claims ownership when Firebase reconnects',async()=>{
 const s=backend();s.set('.info/connected',false);const a=client(s,'a');
 assert.equal(await a.api.claim(1),true);assert.equal(a.api.localOnly(a.ctx.DAYS_DATA[1]),true);
 assert.equal(s.get('walkRecorders/route'),undefined);
 s.set('.info/connected',true);await drain();
 assert.equal(a.api.isOwner(),true);assert.ok(s.get('walkRecorders/route').live);
});
test('offline edits to an existing note are retained locally and sent after reconnecting',async()=>{
 const s=backend(),a=client(s,'a'),b=client(s,'b');await a.api.claim(1);
 await a.api.saveNote(1,a.ctx.DAYS_DATA[1].stops[0],'note',{id:'note',text:'До потери связи',images:[]});a.api.flush();b.api.flush();
 s.set('.info/connected',false);
 const stop=a.ctx.DAYS_DATA[1].stops[0];stop.notes[0].text='Записано без сети';
 await a.api.saveNote(1,stop,'note',stop.notes[0]);
 assert.ok(a.cache.get('travel_walk_note_outbox_route').includes('Записано без сети'));
 s.set('.info/connected',true);await drain();
 assert.equal(b.ctx.DAYS_DATA[1].stops[0].notes[0].text,'Записано без сети');
 assert.equal(JSON.parse(a.cache.get('travel_walk_note_outbox_route')).length,0);
});
test('notes remain writable after a walk finishes; finish is not mistaken for an offline lease',async()=>{
 const s=backend(),a=client(s,'a'),b=client(s,'b');await a.api.claim(1);
 a.ctx.DAYS_DATA[1].walkReview.phase='finished';a.api.publish(1,payload(a),null,null);await drain();
 assert.equal(a.api.localOnly(a.ctx.DAYS_DATA[1]),false);
 await a.api.saveNote(1,a.ctx.DAYS_DATA[1].stops[0],'after',{id:'after',text:'После прогулки',images:[]});a.api.flush();b.api.flush();
 assert.equal(b.ctx.DAYS_DATA[1].stops[0].notes[0].text,'После прогулки');
});
test('Firebase missing empty arrays still creates a real walk before the first checkpoint',async()=>{
 const s=backend(),a=client(s,'a'),b=client(s,'b');await a.api.claim(1);
 const walk=payload(a);delete walk.day.stops;delete walk.day.walkReview.segments;
 a.api.publish(1,walk,null,null);await drain();
 assert.equal(b.ctx.DAYS_DATA[1].stops.length,0);
 assert.equal(b.ctx.DAYS_DATA[1].walkReview.segments.length,0);
});
test('hidden reader day keeps its GPS only in the published spectator branch',async()=>{
 const s=backend(),a=client(s,'a');await a.api.claim(1);
 a.ctx.walkBroadcastPayload=()=>null;
 const spectator={publicationId:'pub',lat:55,lng:37,walk:payload(a)};
 a.api.publish(1,payload(a),{lat:55,lng:37,speed:3},spectator);await drain();
 const gps=s.get('gps');assert.equal(gps.lat,undefined);assert.equal(gps.walk,undefined);
 assert.equal(gps.spectator.publicationId,'pub');
});
test('unpublished and reader-hidden live walk never exposes a public GPS packet',async()=>{
 const s=backend(),a=client(s,'a');await a.api.claim(1);a.ctx.walkBroadcastPayload=()=>null;
 a.api.publish(1,payload(a),{lat:55,lng:37,speed:3},null);await drain();
 assert.equal(s.get('gps'),null);assert.ok(s.get('walkRecorders/route').live);
});
