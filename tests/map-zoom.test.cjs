const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('OSRM route and duration requests share spacing and a Retry-After pause', async () => {
  const starts = [];
  let now = 100000;
  const ctx = vm.createContext({
    Date: {now: () => now, parse: Date.parse},
    setTimeout: (callback, delay) => { now += delay; callback(); },
    window: {addEventListener() {}},
    localStorage: {getItem: () => null},
    fetch: async url => {
      starts.push({url, now});
      return {status: url === 'steps' ? 429 : 200, headers: {get: () => '90'}};
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/map.js'), 'utf8'), ctx);
  await Promise.all(['line', 'duration', 'steps', 'next-line'].map(url => ctx.fetchOsrm(url)));
  assert.deepEqual(starts.map(entry => entry.url), ['line', 'duration', 'steps']);
  assert.ok(starts[1].now - starts[0].now >= 1000);
  assert.ok(starts[2].now - starts[1].now >= 1000);
  now += 89999;
  assert.equal(await ctx.fetchOsrm('too-soon'), null);
  now++;
  await ctx.fetchOsrm('after-pause');
  assert.equal(starts.at(-1).url, 'after-pause');
});

test('auto overview includes road detours without overriding a manually moved map', () => {
  const fits = [];
  const start = {lat: 55.79, lng: 37.94};
  const stop = {lat: 55.78, lng: 37.94};
  const detour = [55.78, 37.98];
  const originalCenter = {equals: other => other === originalCenter};
  let center = originalCenter;
  const ctx = vm.createContext({
    DAYS_DATA: {1: {start, stops: [stop]}, 2: {start, stops: [], walkMode: true,
      walkReview: {segments: [[[start.lat, start.lng], detour]]}}},
    currentDay: 1,
    window: {addEventListener() {}},
    localStorage: {getItem: () => null},
    L: {latLngBounds: points => points},
    testMap: {
      fitBounds: (points, options) => fits.push({points, options}),
      getCenter: () => center,
      getZoom: () => 14,
      getBounds: () => ({contains: point => point[1] < 37.96}),
    },
    road: [[start.lat, start.lng], detour, [stop.lat, stop.lng]],
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/map.js'), 'utf8'), ctx);
  vm.runInContext('map = testMap; fitDayMap(1)', ctx);
  assert.equal(fits[0].options.maxZoom, 14);
  assert.equal(fits[0].points.some(point => point[1] === detour[1]), false);

  vm.runInContext("_routeCache['driving|55.79,37.94|55.78,37.94'] = road; extendAutoRouteView(1, road)", ctx);
  assert.equal(fits[1].points.some(point => point[1] === detour[1]), true);
  center = {equals: () => false};
  vm.runInContext('extendAutoRouteView(1, road)', ctx);
  assert.equal(fits.length, 2);

  vm.runInContext('fitDayMap(2)', ctx);
  assert.equal(fits[2].options.maxZoom, 17);
  assert.equal(fits[2].points.some(point => point[1] === detour[1]), true);
});

test('walking start keeps its explicitly selected point icon instead of replacing it with the GPS avatar',()=>{
 const ctx=vm.createContext({window:{addEventListener(){}},localStorage:{getItem:()=>null},walkIconStyle:()=> 'dog-winter'});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/map.js'),'utf8'),ctx);
 for(const icon of ['🏢','graphic:hotelBuilding','type:Жильё','emoji:🏠'])assert.equal(ctx.mapStartIconValue({walkMode:true,start:{icon},walkReview:{}}),icon);
 assert.equal(ctx.mapStartIconValue({walkMode:true,start:{icon:'🚶'}}),'walker:dog-winter');
 assert.equal(ctx.mapStartIconValue({walkMode:false,start:{icon:'🏠'}}),'🏠');
});

test('appearance changes repaint readers but do not change route geometry or trigger rerouting',()=>{
 const ctx=vm.createContext({routeAppearance:{vehicleStyle:'compact'},dayKeys:()=>[1],DAYS_DATA:{1:{start:{lat:55,lng:37},stops:[]}}});
 const storage=fs.readFileSync(path.join(__dirname,'../js/storage.js'),'utf8');vm.runInContext(storage.slice(storage.indexOf('function _buildGeoHash()'),storage.indexOf('// Выбрать currentDay')),ctx);
 const geo=ctx._buildGeoHash(),view=ctx._buildViewerHash();ctx.routeAppearance.vehicleStyle='ix35';assert.equal(ctx._buildGeoHash(),geo);assert.notEqual(ctx._buildViewerHash(),view);
});
