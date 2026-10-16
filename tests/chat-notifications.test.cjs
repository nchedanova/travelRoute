const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const chat = fs.readFileSync(path.join(__dirname, '..', 'js/chat.js'), 'utf8');

test('connecting and reconnecting chat never request notification permission; live events still work', () => {
  const listeners = {};
  const calls = [];
  const ref = {
    limitToLast(count) { assert.equal(count, 200); return this; },
    on(event, callback) { listeners[event] = callback; },
  };
  const ctx = vm.createContext({
    _chatRef: ref, _chatVisible: false, _chatUnread: 0, _lastMsgTs: 0,
    localStorage: { getItem: () => '0' },
    _requestNotificationPermission() { assert.fail('Permission requested without a click'); },
    _appendMessage: (...args) => calls.push(['add', ...args]),
    _appendMessageAt: (...args) => calls.push(['change', ...args]),
    _updateUnreadBadge: () => calls.push(['badge']),
    _playDing: () => calls.push(['sound']),
    _showNotification: (...args) => calls.push(['notification', ...args]),
    document: { getElementById: () => ({ nextSibling: null, remove: () => calls.push(['remove']) }) },
  });
  vm.runInContext(chat.slice(chat.indexOf('function _listenMessages()'), chat.indexOf('// ── SEND')), ctx);
  vm.runInContext('_listenMessages(); _listenMessages()', ctx);
  assert.deepEqual(Object.keys(listeners).sort(), ['child_added', 'child_changed', 'child_removed']);
  const msg = { name: 'Test', text: 'Message', ts: Date.now() };
  const snap = { key: 'message-id', val: () => msg };
  listeners.child_added(snap);
  assert.equal(ctx._chatUnread, 1);
  assert.equal(ctx._lastMsgTs, msg.ts);
  assert.ok(calls.some(call => call[0] === 'notification'));
  listeners.child_changed(snap);
  listeners.child_removed(snap);
  assert.ok(calls.some(call => call[0] === 'change'));
  assert.equal(calls.filter(call => call[0] === 'remove').length, 2);
});

test('explicit notification control still requests permission on click', async () => {
  let requested = 0;
  const values = new Map([['travel_chat_notify', 'off']]);
  const Notification = { permission: 'default', requestPermission() { requested++; return Promise.resolve('granted'); } };
  const ctx = vm.createContext({
    window: { Notification }, Notification, isChatEnabled: () => true,
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    document: { title: 'Test', getElementById: () => null },
    showToast() {},
  });
  vm.runInContext(chat.slice(chat.indexOf('function getNotifyMode()'), chat.indexOf('function _showNotification(')), ctx);
  assert.equal(requested, 0);
  vm.runInContext('toggleChatSound()', ctx);
  await Promise.resolve();
  assert.equal(requested, 1);
  assert.equal(values.get('travel_chat_notify'), 'pin');
});
