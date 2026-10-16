const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'js/storage.js'), 'utf8');

test('connection fields and destructive reset are inside collapsed settings section', () => {
  const section = html.match(/<details class="cloud-connection-settings"[^>]*>([\s\S]*?)<\/details>/)[0];
  assert.doesNotMatch(section.split('>')[0], /\sopen(?:\s|=|$)/);
  for (const id of ['cs-token', 'cs-gist', 'cs-firebase-key', 'cs-status']) {
    assert.ok(section.includes('id="' + id + '"'));
  }
  assert.match(section, /onclick="clearCloudSettings\(\)"/);
  assert.match(section, /onclick="saveCloudSettings\(\)"/);
  assert.doesNotMatch(html, /onclick="showChangelog\(\)"/);
});

test('opening settings resets disclosure without changing saved credentials', () => {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, { open: true, classList: { add() {} } });
    return elements.get(id);
  };
  const saved = new Map([['travel_gist_token', 'test-token'], ['travel_gist_id', 'test-gist']]);
  const ctx = vm.createContext({ document: { getElementById }, localStorage: { getItem: key => saved.get(key) }, _checkAppVersion() {} });
  vm.runInContext(storage.slice(storage.indexOf('function openCloudSettings()'), storage.indexOf('// ── VERSION CHECK')), ctx);
  vm.runInContext('openCloudSettings()', ctx);
  assert.equal(getElementById('cloudConnectionSettings').open, false);
  assert.equal(getElementById('cs-token').value, 'test-token');
  assert.equal(getElementById('cs-gist').value, 'test-gist');
});
