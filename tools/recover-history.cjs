// Offline recovery only. Both inputs are saved GitHub Gist API responses.
// Match dates and coordinates, never positional day/stop IDs.
const fs = require('node:fs');
const path = require('node:path');
function payload(file) {
  const response = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return JSON.parse(response.files['data.json'].content);
}
function samePoint(a,b) {
  return a && b && Math.abs(Number(a.lat)-Number(b.lat))<0.000001 && Math.abs(Number(a.lng)-Number(b.lng))<0.000001;
}
function recover(current, historical) {
  const copy = structuredClone(current);
  const dates = new Set(['27.07.2026','28.07.2026','29.07.2026','30.07.2026','31.07.2026','01.08.2026']);
  const report = [];
  for (const [key, day] of Object.entries(copy.daysData)) {
    if (!dates.has(day.dateISO)) continue;
    const candidates = Object.values(historical.daysData).filter(old => old.dateISO===day.dateISO && samePoint(old.start,day.start));
    if (candidates.length!==1) throw new Error('Ambiguous source day: '+day.dateISO);
    const old = candidates[0];
    const matches = day.stops.map(stop => old.stops.filter(s => samePoint(s,stop)));
    if (matches.some(m => m.length!==1)) throw new Error('Ambiguous source stop: '+day.dateISO);
    day.departA = old.departA || '';
    day.stops.forEach((stop,i) => { stop.arrA=matches[i][0].arrA || ''; stop.depA=matches[i][0].depA || ''; });
    copy['dep'+key]=day.departA;
    report.push({date:day.dateISO,departA:day.departA,stops:matches.length});
  }
  copy.actuals={};
  for(const day of Object.values(copy.daysData)) for(const stop of day.stops) copy.actuals[stop.id]={arrA:stop.arrA||'',depA:stop.depA||''};
  return {payload:copy,report};
}
module.exports={recover};
if(require.main===module) {
  const [currentFile,oldFile,outDir]=process.argv.slice(2);
  const current=payload(currentFile);
  const result=recover(current,payload(oldFile));
  fs.mkdirSync(outDir,{recursive:true});
  fs.writeFileSync(path.join(outDir,'original-route.json'),JSON.stringify(current,null,2));
  fs.writeFileSync(path.join(outDir,'recovered-route.json'),JSON.stringify(result.payload,null,2));
  fs.writeFileSync(path.join(outDir,'recovery-report.json'),JSON.stringify(result.report,null,2));
  console.log(JSON.stringify(result.report,null,2));
}
