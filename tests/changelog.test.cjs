const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

function load(role) {
  const body = { innerHTML: '' };
  let shown = false;
  const ctx = vm.createContext({ console,
    ...(role ? {isAdmin:()=>role === 'admin' || role === 'demo',isChatEnabled:()=>role !== 'spectator',isDemoMode:()=>role === 'demo'} : {}),
    document: { getElementById(id) {
    return id === 'changelogBody' ? body : { classList: { add() { shown = true; } } };
  } } });
  vm.runInContext(app.slice(app.indexOf('var APP_VERSION ='), app.indexOf('function closeChangelog()')), ctx);
  return { run: code => vm.runInContext(code, ctx), body, shown: () => shown };
}

test('compact history includes every older version once, combining builds', () => {
  const { run } = load();
  const expected = run('JSON.stringify([...new Set(APP_CHANGELOG.slice(1).map(e => e.ver.split(" ")[0]))])');
  assert.equal(run('JSON.stringify(getCompactReleaseHistory().slice(0, -1).map(e => e.ver))'), expected);
  assert.equal(run('getCompactReleaseHistory().filter(e => e.ver === "2.8.0").length'), 1);
  assert.equal(run('getCompactReleaseHistory().at(-1).ver'), '1.x');
});

test('latest changes are visible and full compact history is expandable', () => {
  const { run, body, shown } = load();
  run('showChangelog()');
  assert.equal(shown(), true);
  assert.match(body.innerHTML, /v3\.0\.0 build 10/);
  assert.match(body.innerHTML, /ближайший манёвр появляется за 500 м/);
  assert.match(body.innerHTML, /Unbounded \+ Onest/);
  assert.match(body.innerHTML, /Поиск значков закреплён снизу/);
  assert.match(body.innerHTML, /<details class="changelog-history">/);
  assert.match(body.innerHTML, /Личные чаты/);
  assert.match(body.innerHTML, /общий чат, ответы, реакции/);
  assert.match(body.innerHTML, /точные версии и даты не восстановлены/);
});

test('app and service worker use the same release and build', () => {
  const { run } = load();
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.equal(sw.match(/APP_VERSION\s*=\s*'([^']+)'/)[1], run('APP_VERSION'));
  assert.equal(Number(sw.match(/APP_BUILD\s*=\s*(\d+)/)[1]), run('APP_BUILD'));
  const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
  const assetKeys = [...html.matchAll(/(?:js\/[\w-]+\.js|css\/style\.css)\?v=([^"']+)/g)].map(m=>m[1]);
  assert.ok(assetKeys.length >= 15);
  assert.ok(assetKeys.every(key=>key === run('APP_VERSION + "-" + APP_BUILD')));
});

test('release notes are available to admin, demo and spectator but never the reader',()=>{
  for(const [role, headline] of [
    ['admin', /ближайший манёвр появляется за 500 м/],
    ['demo', /Откройте автомаршрут/],
    ['spectator', /По ссылке зрителя/]
  ]){
    const page = load(role);
    page.run('showChangelog()');
    assert.equal(page.shown(),true);
    assert.match(page.body.innerHTML,/v3\.0\.0 build 10/);
    assert.match(page.body.innerHTML.split('<details')[0], headline);
  }
  const reader=load('reader');
  reader.run('showChangelog()');
  assert.equal(reader.shown(),false);
  assert.equal(reader.body.innerHTML,'');
});

test('spectator sees each release once, independently of demo/admin history', () => {
  const values = new Map([['changelog_seen', '2.9.0'], ['changelog_spectator_seen', '1']]);
  const ctx = vm.createContext({
    console, setTimeout() {},
    isChatEnabled: () => false, isAdmin: () => false,
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    document: { getElementById: () => ({ classList: { remove() {} } }) },
  });
  vm.runInContext(app.slice(app.indexOf('var APP_VERSION ='), app.indexOf('// Start weather listener for initial day')), ctx);
  assert.equal(vm.runInContext('shouldShowChangelogOnLoad()', ctx), true);
  vm.runInContext('closeChangelog()', ctx);
  assert.equal(vm.runInContext('shouldShowChangelogOnLoad()', ctx), false);
  vm.runInContext('APP_BUILD++', ctx);
  assert.equal(vm.runInContext('shouldShowChangelogOnLoad()', ctx), false);
  vm.runInContext('APP_CHANGELOG.unshift({ver: "3.0.0 build " + APP_BUILD})', ctx);
  assert.equal(vm.runInContext('shouldShowChangelogOnLoad()', ctx), true);
  ctx.isChatEnabled = () => true;
  assert.equal(vm.runInContext('shouldShowChangelogOnLoad()', ctx), false);
  ctx.isAdmin = () => true;
  assert.equal(vm.runInContext('shouldShowChangelogOnLoad()', ctx), true);
  vm.runInContext('closeChangelog()', ctx);
  assert.equal(vm.runInContext('shouldShowChangelogOnLoad()', ctx), false);
});
