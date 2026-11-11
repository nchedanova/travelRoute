const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('new font default migrates existing users once and then preserves their explicit choice',()=>{
 const html=fs.readFileSync('index.html','utf8');const init=html.slice(html.indexOf('(function(){'),html.indexOf('})();')+5);
 const values=new Map([['travel_font','default']]);const attributes={};const ctx=vm.createContext({localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},document:{documentElement:{setAttribute:(k,v)=>attributes[k]=v}}});
 vm.runInContext(init,ctx);assert.equal(attributes['data-font'],'onest');assert.equal(values.get('travel_font'),'onest');
 values.set('travel_font','default');vm.runInContext(init,ctx);assert.equal(attributes['data-font'],'default');
 assert.match(html,/Терминал/);assert.match(html,/Современный/);
});
