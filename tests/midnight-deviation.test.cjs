const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/render.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function routeTimeDayOffset('), source.indexOf('function recordedWalkDurationMinutes(')), context);
vm.runInContext(source.slice(source.indexOf('function _parseTime('), source.indexOf('function _fmtTime(')), context);

test('stop deviation accounts for midnight on either side of the comparison', () => {
  assert.equal(context.timeDelta('23:49', '00:15', '18:15', '18:17'), 26);
  assert.equal(context.timeDelta('00:10', '23:55', '18:15', '18:17'), -15);
  assert.equal(context.timeDelta('23:50', '00:00', '08:00', '08:00'), 10);
  assert.equal(context.timeDelta('00:10', '01:00', '08:00', '08:00'), 50);
});

test('daytime deviation and routes without start times retain their previous calculation', () => {
  assert.equal(context.timeDelta('21:15', '21:16', '18:15', '18:17'), 1);
  assert.equal(context.timeDelta('00:00', '00:00', '00:00', '00:00'), 0);
  assert.equal(context.timeDelta('21:15', '21:16', '', '18:17'), 1);
  assert.equal(context.timeDelta('21:15', '', '18:15', '18:17'), null);
});
