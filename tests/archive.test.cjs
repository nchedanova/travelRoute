const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');

function load() {
  const classes = new Set();
  const dropdown = {
    style: { setProperty(key, value) { this[key] = value; } },
    classList: { contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key) },
  };
  const ctx = vm.createContext({
    window: { innerWidth: 360 },
    document: {
      getElementById: id => id === 'archiveDropdown' ? dropdown : { getBoundingClientRect: () => ({ bottom: 44, right: 350 }) },
      addEventListener() {}, removeEventListener() {},
    },
    closeDayMenus() {}, renderArchiveBtn() {}, setTimeout: callback => callback(),
  });
  vm.runInContext(app.slice(app.indexOf('function toggleArchive()'), app.indexOf('// ── REVERSE DAY ROUTE')), ctx);
  return { dropdown, run: code => vm.runInContext(code, ctx) };
}

test('archive scroll area is bounded by viewport and its actual top position', () => {
  const { dropdown, run } = load();
  run('toggleArchive()');
  assert.equal(dropdown.style.top, '48px');
  assert.equal(dropdown.style['--archive-top'], '48px');
  const rule = css.match(/\.archive-dropdown\s*\{([^}]+)\}/)[1];
  assert.match(rule, /max-height: min\(560px, calc\(100dvh - var\(--archive-top, 48px\) - 8px\)\)/);
  assert.match(rule, /overflow-y: auto/);
  assert.match(rule, /overscroll-behavior-y: contain/);
  assert.match(rule, /box-sizing: border-box/);
});

test('archive stays open for interactions inside and closes outside or on toggle', () => {
  const { dropdown, run } = load();
  run('toggleArchive()');
  run('_archiveOutsideClick({ target: { closest: selector => selector.includes("#archiveDropdown") } })');
  assert.equal(dropdown.classList.contains('show'), true);
  run('_archiveOutsideClick({ target: { closest: () => null } })');
  assert.equal(dropdown.classList.contains('show'), false);
  run('toggleArchive(); toggleArchive()');
  assert.equal(dropdown.classList.contains('show'), false);
});
