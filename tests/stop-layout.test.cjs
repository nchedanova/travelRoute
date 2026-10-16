const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('edit, insertion and end-of-day addition share the wider type layout', () => {
  assert.equal((app.match(/class="stop-type-time-row"/g) || []).length, 3);
  assert.doesNotMatch(app, /grid-template-columns:1fr 1fr 1fr/);
  const row = css.match(/\.stop-type-time-row\s*\{([^}]+)\}/)[1];
  assert.match(row, /minmax\(136px,1\.7fr\) repeat\(2,minmax\(0,1fr\)\)/);
  const modalRow = html.match(/<div class="modal-row stop-icon-type-row">([\s\S]*?)id="new-stop-type-container"/);
  assert.ok(modalRow);
});

test('type menu can expand to fit its labels and arrow cannot be squeezed out', () => {
  assert.match(css.match(/\.type-dropdown-menu\s*\{([^}]+)\}/)[1], /min-width: max-content/);
  assert.match(css.match(/\.type-dropdown-label\s*\{([^}]+)\}/)[1], /white-space:nowrap/);
  assert.match(css.match(/\.type-dropdown-arrow\s*\{([^}]+)\}/)[1], /flex-shrink:0/);
});
