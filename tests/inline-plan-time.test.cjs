const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/app.js'), 'utf8');

function setup() {
  const nodes = new Map();
  const document = { activeElement:null, getElementById:id=>nodes.get(id)||null };
  function node(id) {
    const classes = new Set(), listeners = {};
    const el = {id, style:{}, dataset:{}, value:'', children:[], draggable:true,
      classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)},
      setAttribute(k,v){this[k]=v;}, removeAttribute(k){delete this[k];},
      appendChild(child){this.children.push(child);child.parent=this;if(child.id)nodes.set(child.id,child);},
      addEventListener(k,v){listeners[k]=v;},
      focus(){document.activeElement=this;}, select(){},
      closest(){return null;},
      fire(k, key){listeners[k]?.({key,preventDefault(){}});},
      remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);if(this.id)nodes.delete(this.id);}
    };
    Object.defineProperty(el,'textContent',{get(){return this.text||'';},set(v){this.text=v;for(const c of this.children)if(c.id)nodes.delete(c.id);this.children=[];}});
    if(id)nodes.set(id,el);
    return el;
  }
  document.createElement = () => node();
  ['card-s1','stop-main-s1','planned-arr-s1','planned-dep-s1','dep-block-s1','dots-s1','arr-s1','dep-s1'].forEach(node);
  nodes.get('arr-s1').value='09:17'; nodes.get('dep-s1').value='09:49';
  const stop={id:'s1',arrP:'09:10',depP:'09:35',arrA:'09:17',depA:'09:49'};
  let saves=0;
  const ctx=vm.createContext({document,DAYS_DATA:{1:{stops:[stop]}},isAdmin:()=>true,
    dayActionIcon:()=>'<svg></svg>',applyMask(){},showToast(){},snapshotForUndo(){},
    updateProgress(){},saveData(){saves++;},autoFillTimes(){},fetchStopWeather(){},cascadeAutoFillFrom(){}});
  vm.runInContext(source.slice(source.indexOf('const _inlinePlanEdits'),source.indexOf('// ── TIME ARITHMETIC')),ctx);
  ctx.cancelStopEdit=id=>ctx.restoreInlinePlanTime(id);
  return {ctx,nodes,stop,get saves(){return saves;}};
}

test('plan fields save only explicitly; blur and cancellation preserve plans and facts',()=>{
  const s=setup();s.ctx.editStopTime('s1',1);
  const field=s.nodes.get('et-arrP-s1');field.value='10:20';field.fire('blur');
  assert.equal(s.stop.arrP,'09:10');assert.equal(s.saves,0);
  field.fire('keydown','Escape');
  assert.equal(s.stop.arrP,'09:10');assert.equal(s.nodes.get('arr-s1').value,'09:17');
  assert.equal(s.nodes.has('et-arrP-s1'),false);
  s.ctx.editStopTime('s1',1);s.nodes.get('et-arrP-s1').value='10:20';
  s.nodes.get('et-depP-s1').value='1050';s.ctx.finishInlinePlanTime('s1',true);
  assert.equal(s.stop.arrP,'10:20');assert.equal(s.stop.depP,'10:50');assert.equal(s.saves,1);
  assert.equal(s.stop.arrA,'09:17');assert.equal(s.stop.depA,'09:49');
  assert.equal(s.nodes.get('dep-s1').value,'09:49');
});

test('invalid drafts cannot save; an unchanged plan does not trigger recalculation',()=>{
  const s=setup();s.ctx.editStopTime('s1',1);s.nodes.get('et-arrP-s1').value='29:99';
  s.ctx.finishInlinePlanTime('s1',true);
  assert.equal(s.saves,0);assert.equal(s.nodes.get('et-arrP-s1')['aria-invalid'],'true');
  s.nodes.get('et-arrP-s1').value='910';s.nodes.get('et-arrP-s1').fire('keydown','Enter');
  assert.equal(s.saves,0);assert.equal(s.nodes.has('et-arrP-s1'),false);
});

test('read-only roles cannot enter plan editing',()=>{
  const s=setup();s.ctx.isAdmin=()=>false;s.ctx.editStopTime('s1',1);
  assert.equal(s.nodes.has('et-arrP-s1'),false);assert.equal(s.saves,0);
});

test('refreshing the day discards an unsaved plan editor and permits reopening',()=>{
  const s=setup();s.ctx.editStopTime('s1',1);s.nodes.get('et-arrP-s1').value='11:20';
  s.ctx.discardInlinePlanTimeForDay(1);
  assert.equal(s.stop.arrP,'09:10');assert.equal(s.saves,0);
  s.ctx.editStopTime('s1',1);assert.equal(s.nodes.get('et-arrP-s1').value,'09:10');
});
