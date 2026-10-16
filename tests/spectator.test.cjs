const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

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
  const { ctx, run } = context('?chat=0', {
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
  assert.equal(notifications.at(-1), '✓ Ссылка без чата скопирована');
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

test('spectator Firebase initialization preserves GPS without reading chat profiles or presence', () => {
  const { ctx, run } = context('?gist=public-route&chat=0');
  const paths = [];
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
  assert.deepEqual(paths, ['gps']);
});
