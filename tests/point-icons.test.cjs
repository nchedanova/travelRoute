const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function setup(){
  const render=fs.readFileSync(path.join(__dirname,'../js/render.js'),'utf8');
  const map=fs.readFileSync(path.join(__dirname,'../js/map.js'),'utf8');
  const types={'Заправка':'⛽','Кафе':'🍜','Магазин':'🛒','Отель':'🛎️','Жильё':'🏠','Другое':'📍'};
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
  assert.equal(colors.size,6);
});
test('category palettes keep matching graphics and quick emoji, with an expanded walking palette',()=>{
  const {ctx,types}=setup();
  for(const type of Object.keys(types)){
    const choices=ctx.pointIconChoices(type);
    assert.equal(choices.filter(ic=>ic.startsWith('emoji:')).length,type === 'Другое' ? 17 : 6);
    assert.equal(choices.filter(ic=>ic.startsWith('type:')).length,1);
    assert.equal(choices[0],'type:'+type);
    for(const icon of choices.filter(ic=>ic.startsWith('graphic:'))){
      assert.match(ctx.pointIconMarkup(icon),/<svg/);
      assert.doesNotMatch(ctx.pointIconText(icon),/graphic:/);
      assert.equal(vm.runInContext(`POINT_GRAPHICS[${JSON.stringify(icon.slice(8))}][0]`,ctx),type);
    }
  }
  const other=ctx.pointIconChoices('Другое');
  for(const key of ['park','tree','leaves','promenade','museum','pool','beach','mountains','concert']){
    assert.ok(other.includes('graphic:'+key));
    assert.match(ctx.makeIcon('graphic:'+key,'#f5a623').html,/stop-type-glyph/);
  }
  for(const emoji of ['🌳','🌲','🍃','🌿','🍀','🌊']) assert.ok(other.includes('emoji:'+emoji));
  assert.doesNotMatch(ctx.pointIconMarkup('type:Жильё'),/stroke="#/);
  assert.doesNotMatch(ctx.pointIconMarkup('graphic:cottage'),/stroke="#/);
});
test('map markers render icon tokens as graphics without exposing storage tokens',()=>{
  const {ctx}=setup();
  const graphic=ctx.makeIcon('type:Кафе','#f5a623');
  assert.match(graphic.html,/stop-type-glyph/);assert.doesNotMatch(graphic.html,/type:Кафе/);
  assert.match(ctx.makeIcon('⛽','#f5a623',34,false,1,'Заправка').html,/stop-type-glyph/);
  assert.match(ctx.makeIcon('emoji:⛽','#f5a623').html,/⛽/);
  assert.match(ctx.makeStartIcon('type:Жильё','#f5a623').html,/stop-type-glyph/);
});
