const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/render.js'), 'utf8');

test('auto-plan uses midnight departure, with arrival as the fallback only when departure is empty', () => {
  const autoFill = source.slice(source.indexOf('function _parseTime('), source.indexOf('function cascadeAutoFillFrom('));
  for (const [arrP, depP, existingPlan, expected] of [
    ['23:55', '00:00', '', '00:20'],
    ['23:55', '', '', '00:15'],
    ['10:00', '10:05', '', '10:25'],
    ['23:55', '00:00', '00:37', '00:37'],
  ]) {
    const next = {id: 'next', arrP: existingPlan, arrA: '00:22'};
    const day = {stops: [{arrP, depP}, next]};
    const runtime = vm.createContext({
      DAYS_DATA: {1: day},
      isAdmin: () => true,
      getSegmentDuration: () => 20 * 60,
      document: {getElementById: () => null},
      updateProgress() {},
      saveData() {},
    });
    vm.runInContext(autoFill, runtime);
    runtime.autoFillTimes(1);
    assert.equal(next.arrP, expected, `arrival ${arrP}, departure ${depP}`);
    assert.equal(next.arrA, '00:22');
  }
});
