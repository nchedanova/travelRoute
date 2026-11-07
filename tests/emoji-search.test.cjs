const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/config.js'),'utf8');
const ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('const EMOJI_DICT')),ctx);
const search=query=>Array.from(ctx.searchEmoji(query));

test('Russian forms, diminutives and synonyms find the same relevant emoji offline',()=>{
  for(const q of ['лист','листики','листочки','листья']) assert.ok(search(q).includes('🍃'),q);
  for(const q of ['дерево','деревья','деревце','деревцем']) assert.ok(search(q).includes('🌳'),q);
  assert.ok(search('набережной').includes('🏞️'));
  assert.ok(search('поплавать').includes('🏊'));
  assert.ok(search('перекусить').includes('🍔'));
  assert.ok(search('МУЗЕИ').includes('🏛️'));
  assert.ok(search('зелёная').includes('🌿'));
  for(const q of ['пин','метка','геометка']) assert.equal(search(q)[0],'📍');
});
test('exact tags rank first; phrases require every word; duplicate emoji are merged',()=>{
  assert.equal(search('парк')[0],'🌳');
  assert.ok(search('парк листики').includes('🍃'));
  assert.equal(search('кофейня')[0],'☕');
  assert.equal(search('палатка').filter(e=>e==='⛺').length,1);
  assert.deepEqual(search('парк бензин'),[]);
  assert.deepEqual(search('несуществующийзапрос'),[]);
  assert.deepEqual(search('  '),[]);
  assert.deepEqual(search('а'),[]);
  assert.ok(search('парк').length<=24);
});
