const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function setup(){
  const render=fs.readFileSync(path.join(__dirname,'../js/render.js'),'utf8');
  const map=fs.readFileSync(path.join(__dirname,'../js/map.js'),'utf8');
  const types={'Заправка':'⛽','Кафе':'🍜','Магазин':'🛒','Отель':'🛎️','Жильё':'🏠','Парк':'🌳','Другое':'📍'};
  const config=fs.readFileSync(path.join(__dirname,'../js/config.js'),'utf8');
  const ctx=vm.createContext({TYPE_ICONS:types,L:{divIcon:args=>args}});
  vm.runInContext(config.slice(config.indexOf('const ICON_SETS'),config.indexOf('// Минуты стоянки')),ctx);
  vm.runInContext(render.slice(render.indexOf('function dayActionIcon('),render.indexOf("document.addEventListener('DOMContentLoaded'")),ctx);
  vm.runInContext(map.slice(map.indexOf('function hexRgba('),map.indexOf('// ── PILL POPUP')),ctx);
  return {ctx,types};
}
test('type defaults use distinct graphic icons; explicitly chosen emoji remain emoji',()=>{
  const {ctx,types}=setup();const colors=new Set();
  for(const [type,emoji] of Object.entries(types)){
    const html=ctx.pointIconMarkup(emoji,type);assert.match(html,/<svg/);
    colors.add(html.match(/color:([^\"]+)/)[1]);
    assert.equal(ctx.pointIconMarkup('emoji:'+emoji,type),emoji);
    assert.equal(ctx.pointIconText('type:'+type),emoji);
    assert.match(ctx.pointIconMarkup('type:'+type),/<svg/);
  }
  assert.equal(colors.size,6); // Fuel and the default pin share a muted red.
});
test('category palettes keep matching graphics and quick emoji, with an expanded walking palette',()=>{
  const {ctx,types}=setup();
  for(const type of Object.keys(types)){
    const choices=ctx.pointIconChoices(type);
    assert.equal(choices.filter(ic=>ic.startsWith('emoji:')).length,type === 'Другое' || type === 'Парк' ? 18 : type === 'Жильё' ? 8 : 6);
    assert.equal(choices.filter(ic=>ic.startsWith('type:')).length,1);
    assert.equal(choices[0],'type:'+type);
    for(const icon of choices.filter(ic=>ic.startsWith('graphic:'))){
      assert.match(ctx.pointIconMarkup(icon),/<svg/);
      assert.doesNotMatch(ctx.pointIconText(icon),/graphic:/);
      assert.equal(vm.runInContext(`POINT_GRAPHICS[${JSON.stringify(icon.slice(8))}][0]`,ctx),type);
    }
  }
  const other=ctx.pointIconChoices('Другое');
  const park=ctx.pointIconChoices('Парк');
  for(const key of ['park','tree','leaves','promenade','museum','pool','beach','mountains','concert']){
    assert.ok((['museum','pool','beach','mountains','concert'].includes(key) ? other : park).includes('graphic:'+key));
    assert.match(ctx.makeIcon('graphic:'+key,'#f5a623').html,/stop-type-glyph/);
  }
  for(const emoji of ['📍','🌳','🌲','🍃','🌿','🍀','🌊']) assert.ok(other.includes('emoji:'+emoji));
  assert.doesNotMatch(ctx.pointIconMarkup('type:Жильё'),/<image|<script|https?:/);
  assert.doesNotMatch(ctx.pointIconMarkup('graphic:cottage'),/<image|<script|https?:/);
});
test('map markers render icon tokens as graphics without exposing storage tokens',()=>{
  const {ctx}=setup();
  const graphic=ctx.makeIcon('type:Кафе','#f5a623');
  assert.match(graphic.html,/stop-type-glyph/);assert.doesNotMatch(graphic.html,/type:Кафе/);
  assert.match(ctx.makeIcon('⛽','#f5a623',34,false,1,'Заправка').html,/stop-type-glyph/);
  assert.match(ctx.makeIcon('emoji:⛽','#f5a623').html,/⛽/);
  assert.match(ctx.makeStartIcon('type:Жильё','#f5a623').html,/stop-type-glyph/);
});

test('park category is available in production config and preserves saved graphic tokens',()=>{
  const {ctx}=setup();
  const config=fs.readFileSync(path.join(__dirname,'../js/config.js'),'utf8');
  const configCtx=vm.createContext({});
  vm.runInContext(config.slice(config.indexOf('const TYPE_ICONS'),config.indexOf('// Минуты стоянки')),configCtx);
  assert.equal(vm.runInContext("TYPE_ICONS['Парк']",configCtx),'🌳');
  const park=ctx.pointIconChoices('Парк');
  for(const key of ['park','tree','leaves','promenade','bench','benchTree','benchArms','gazebo','gazeboArch','picnic','playground','bridge','parkLantern','parkLanternDouble','parkLanternGlobe','parkPath','parkAlley','parkSignpost']) {
    assert.ok(park.includes('graphic:'+key));
    assert.match(ctx.pointIconMarkup('graphic:'+key,'Другое'),/<svg/);
    assert.equal(ctx.pointIconMarkup('graphic:'+key,'Другое'),ctx.pointIconMarkup('graphic:'+key,'Парк'));
    assert.doesNotMatch(ctx.makeIcon('graphic:'+key,'#f5a623',34,false,1,'Парк').html,/graphic:/);
  }
  assert.equal(ctx.pointIconText('type:Парк'),'🌳');
  assert.match(ctx.pointIconMarkup('type:Парк'),/<svg/);
});

test('realistic category palettes have enough offline choices and every paint reference resolves',()=>{
  const {ctx}=setup();
  for(const type of ['Заправка','Кафе','Магазин','Отель','Жильё','Парк','Другое']) {
    const choices=ctx.pointIconChoices(type).filter(ic=>ic.startsWith('graphic:'));
    assert.ok(choices.length>=7,type+' needs at least seven choices');
    for(const icon of ['type:'+type,...choices]){
      const markup=ctx.pointIconMarkup(icon);
      assert.doesNotMatch(markup,/<script|<image|https?:/);
      for(const [,ref] of markup.matchAll(/url\(#([^)]*)\)/g))assert.ok(markup.includes('id="'+ref+'"'),icon+': missing paint '+ref);
    }
  }
});

test('every schematic icon token from build 23 still resolves; rendering leaves route history intact',()=>{
  const {ctx}=setup();
  const legacyKeys=["parkLantern","parkLanternDouble","parkLanternGlobe","parkPath","parkAlley","parkSignpost","lukoil","rosneft","gazpromneft","tatneft","neftmagistral","shell","teboil","charging","service","parking","dining","bakery","takeaway","bag","groceries","pharmacy","magnit","pyaterochka","globus","dixy","metro","chizhik","perekrestok","bed","key","bellhop","apartment","cottage","camping","park","tree","leaves","promenade","bench","benchTree","benchArms","gazebo","gazeboArch","picnic","playground","bridge","museum","pool","beach","mountains","concert"];
  const route={dateISO:'27.07.2026',start:{icon:'type:Жильё',lat:55,lng:37},stops:legacyKeys.map((key,i)=>({id:'historic-'+i,type:'Другое',icon:'graphic:'+key,arrA:'09:20',depA:'09:40',notes:[{text:'existing',images:['fb:photo']}]}))};
  const before=JSON.stringify(route);
  for(const stop of route.stops){
    assert.equal(vm.runInContext('Object.hasOwn(POINT_GRAPHICS,'+JSON.stringify(stop.icon.slice(8))+')',ctx),true,stop.icon);
    assert.match(ctx.makeIcon(stop.icon,'#f5a623',34,false,1,stop.type).html,/<svg/);
  }
  assert.equal(JSON.stringify(route),before);
  assert.match(ctx.pointIconMarkup('graphic:bench','Другое'),/scale\(\.5\)/);
  assert.equal(ctx.pointIconMarkup('emoji:🌳','Парк'),'🌳');
  assert.equal(ctx.pointIconMarkup('emoji:🏠','Жильё'),'🏠');
});

test('non-park legacy graphics and category defaults remain schematic alongside explicit volumetric choices',()=>{
 const {ctx}=setup();
 for(const key of ['dining','bakery','takeaway','bed','key','bellhop','apartment','cottage','camping','museum','pool','beach','mountains','concert']){
   const legacy=ctx.pointIconMarkup('graphic:'+key),modern=ctx.pointIconMarkup('graphic:realistic_'+key);
   assert.doesNotMatch(legacy,/scale\(\.5\)/,key);
   assert.match(modern,/scale\(\.5\)/,key);
   const type=vm.runInContext('POINT_GRAPHICS['+JSON.stringify(key)+'][0]',ctx);
   assert.ok(ctx.pointIconChoices(type).includes('graphic:'+key));
   assert.ok(ctx.pointIconChoices(type).includes('graphic:realistic_'+key));
 }
 for(const type of ['Заправка','Кафе','Магазин','Отель','Жильё','Другое'])assert.doesNotMatch(ctx.stopTypeIcon(type),/scale\(\.5\)/,type);
});
