const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('publication manager lists all days by distance from today', () => {
  const nodes = {publicationList: {}, publicationCount: {}};
  const ctx = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [2026, 10, 7])); } },
    document: {addEventListener(){}, getElementById: id => nodes[id]},
    isAdmin: () => true, dayKeys: () => [1, 2, 3, 4],
    parseDateDMY: value => new Date(value.split('.').reverse().join('-') + 'T00:00:00'),
    _escHtml: value => value, _dayLabel: () => 'Undated',
    DAYS_DATA: {
      1: {dateISO: '31.05.2026', date: 'Old'},
      2: {dateISO: '06.11.2026', date: 'Yesterday'},
      3: {dateISO: '07.11.2026', date: 'Today', archived: true},
      4: {}
    }
  });
  vm.runInContext(source('js/publishing.js'), ctx);
  ctx.spectatorPublications = {p: {day: {dateISO: '2026-11-08', date: 'Tomorrow'}}};
  ctx.renderPublicationManager();
  assert.deepEqual([...nodes.publicationList.innerHTML.matchAll(/publication-title">(.*?)<\/div>/g)].map(match => match[1]), [
    '07.11.2026 · Today', '2026-11-08 · Tomorrow', '06.11.2026 · Yesterday', '31.05.2026 · Old', 'Undated'
  ]);
});

test('public Gist polls keep checking raw without repeatedly falling back to REST', async () => {
  const requests = [];
  const ctx = vm.createContext({
    GIST_URL: 'https://api.github.com/gists', CLOUD_CONFIG: {binId: 'route'},
    clearInterval(){}, setInterval(){},
    localStorage: {getItem: () => null},
    window: {addEventListener(){}}, document: {addEventListener(){}},
    fetch: async url => {
      requests.push(url);
      return {ok:false,status:404};
    }
  });
  vm.runInContext(source('js/storage.js'), ctx);
  await assert.rejects(ctx.fetchCloudData(), /HTTP 404/);
  await assert.rejects(ctx.fetchCloudData(), /lookup cooldown/);
  assert.equal(requests.filter(url => url.startsWith('https://api.github.com')).length, 1);
  assert.equal(requests.filter(url => url.startsWith('https://gist.githubusercontent.com')).length, 2);
});

function context(search = '', initial = {}) {
  const values = new Map(Object.entries(initial));
  const classes = new Set();
  const ctx = vm.createContext({
    URL, URLSearchParams, console,
    navigator: { onLine: true },
    window: {
      location: { search, pathname: '/', href: 'https://example.test/' + search },
      history: { replaceState() {} },
      addEventListener() {},
    },
    document: {
      title: 'Дорожный журнал',
      body: { classList: { add: value => classes.add(value) } },
      addEventListener() {},
      getElementById() { throw new Error('Unexpected chat UI access'); },
    },
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
  });
  vm.runInContext(source('js/config.js'), ctx);
  return { ctx, values, classes, run: code => vm.runInContext(code, ctx) };
}

test('ordinary reader keeps chat and read-only access', () => {
  const { run, classes } = context('?gist=public-route');
  assert.equal(run('isChatEnabled()'), true);
  assert.equal(run('isViewer()'), true);
  assert.equal(classes.has('spectator-mode'), false);
});

test('spectator PWA launch remembers its route role; explicit reader link restores live access', () => {
  const initial={travel_gist_id:'route',travel_spectator_route_route:'1'};
  assert.equal(context('',initial).run('SPECTATOR_MODE'),true);
  const reader=context('?gist=route',initial);
  assert.equal(reader.run('SPECTATOR_MODE'),false);
  assert.equal(reader.values.has('travel_spectator_route_route'),false);
  const owner=context('',{...initial,travel_gist_token:'owner-token'});
  assert.equal(owner.run('SPECTATOR_MODE'),false);
  assert.equal(owner.run('isAdmin()'),true);
});

test('spectator URL survives cleaning and overrides an existing admin token without deleting it', () => {
  const initial = { travel_gist_token: 'existing-token' };
  const { run, values, classes } = context('?gist=public-route&fbkey=public-key&chat=0', initial);
  assert.equal(run('isChatEnabled()'), false);
  assert.equal(run('CLOUD_CONFIG.canRead'), true);
  assert.equal(run('CLOUD_CONFIG.canWrite'), false);
  assert.equal(run('isAdmin()'), false);
  assert.equal(classes.has('spectator-mode'), true);
  assert.equal(classes.has('viewer-mode'), true);
  assert.equal(values.get('travel_gist_token'), 'existing-token');
  const normal = context('', Object.fromEntries(values));
  assert.equal(normal.run('isChatEnabled()'), true);
  assert.equal(normal.run('isAdmin()'), true);
});

test('spectator also disables demo chat and nickname/notification/presence initialization', async () => {
  const { ctx, run } = context('?chat=0');
  vm.runInContext(source('js/chat.js'), ctx);
  vm.runInContext(source('js/offline.js'), ctx);
  assert.equal(run('isAdmin()'), false);
  run('initChat(); _ensureNickname(); _showNicknameModal(); onChatTabOpen(); _writePresence(); _requestNotificationPermission(); _showNotification("name", "text");');
  await run('requestChatNotifyPermission()');
  await run('flushChatQueue()');
  assert.equal(run('_chatInited'), false);
  assert.equal(run('_chatRef'), null);
  assert.equal(run('isSoundEnabled()'), false);
});

test('share links distinguish ordinary reader and spectator and never include the admin token', async () => {
  const { ctx, run } = context('?chat=1', {
    travel_gist_id: 'public-route', travel_gist_token: 'secret', travel_firebase_key: 'public-key',
  });
  const status = { style: {} };
  let copied;
  const notifications = [];
  ctx.showToast = message => notifications.push(message);
  ctx.navigator = { clipboard: { writeText(value) { copied = value; return Promise.resolve(); } } };
  ctx.document.getElementById = () => status;
  // Test the actual share function without starting unrelated cloud timers.
  const text = source('js/storage.js');
  vm.runInContext(text.slice(text.indexOf('function copyShareLink('), text.indexOf('// ── CLOUD SETTINGS UI')), ctx);
  await run('copyShareLink(true)');
  assert.equal(notifications.at(-1), '✓ Ссылка для зрителя скопирована');
  let url = new URL(copied);
  assert.equal(url.searchParams.get('chat'), '0');
  assert.equal(url.searchParams.get('gist'), 'public-route');
  assert.equal(copied.includes('secret'), false);
  await run('copyShareLink()');
  assert.equal(notifications.at(-1), '✓ Ссылка читателя скопирована');
  url = new URL(copied);
  assert.equal(url.searchParams.has('chat'), false);
  assert.equal(url.searchParams.get('fbkey'), 'public-key');
  ctx.navigator.clipboard.writeText = () => Promise.reject(new Error('Clipboard denied'));
  await run('copyShareLink()');
  assert.match(notifications.at(-1), /Не удалось скопировать/);
  ctx.navigator.clipboard = undefined;
  await run('copyShareLink()');
  assert.match(notifications.at(-1), /Не удалось скопировать/);
});

test('neither reader nor spectator can generate share links',()=>{
  for(const query of ['?chat=0','?gist=route']) {
    const {ctx,run}=context(query,{travel_gist_id:'route'});
    ctx.navigator.clipboard={writeText(){assert.fail('Read-only roles must not copy share links');}};
    const text=source('js/storage.js');
    vm.runInContext(text.slice(text.indexOf('function copyShareLink('),text.indexOf('// ── CLOUD SETTINGS UI')),ctx);
    run('copyShareLink();copyShareLink(true)');
  }
});

test('spectator subscribes only to published GPS, never private GPS, chat or presence', () => {
  const { ctx, run } = context('?gist=public-route&chat=0');
  const paths = [];
  let photoResolutions = 0;
  ctx._resolveAllNoteImgs = () => { photoResolutions++; };
  ctx.setInterval=()=>0;
  const db = { ref(value) { paths.push(value); return { on() {} }; } };
  ctx.firebase = {
    apps: [{}], database: () => db,
    auth: () => ({
      getRedirectResult() { throw new Error('Unexpected chat auth redirect'); },
      onAuthStateChanged(cb) { cb({ uid: 'existing-user' }); },
    }),
  };
  ctx.initChat = () => { assert.equal(run('isChatEnabled()'), false); };
  ctx.initNotes = () => {};
  ctx.map = { on() {} };
  vm.runInContext(source('js/gps.js'), ctx);
  run('_showEl = function() {}; initGps();');
  assert.deepEqual(paths, ['gps/spectator']);
  assert.equal(photoResolutions, 1);
});
