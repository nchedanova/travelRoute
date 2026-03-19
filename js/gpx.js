// ── GPX EXPORT MODULE ──────────────────────────────────────────────────────────
// Генерация GPX-файла для Organic Maps, OsmAnd и других навигаторов.
// Экспортирует: waypoints (остановки дня) + track (записанный GPS-след из IndexedDB)

async function exportGpx(dayNum) {
  const day = DAYS_DATA[dayNum];
  if (!day) { showToast('⚠ Нет данных для дня ' + dayNum); return; }

  const dayLabel = `День ${dayNum}` + (day.date ? ` · ${day.date}` : '');
  const startName = day.start?.name || 'Старт';
  const endName = day.stops.length ? day.stops[day.stops.length - 1].name : '';

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Дорожный журнал"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
<metadata>
  <name>${_gpxEsc(dayLabel)}: ${_gpxEsc(startName)} → ${_gpxEsc(endName)}</name>
  <desc>Маршрут из Дорожного журнала</desc>
  <time>${new Date().toISOString()}</time>
</metadata>
`;

  // ── Waypoints ──────────────────────────────────────────────────────────────
  // Точка старта
  if (day.start?.lat && day.start?.lng) {
    gpx += _gpxWaypoint(day.start.lat, day.start.lng, day.start.icon + ' ' + day.start.name,
      `Старт${day.departP ? ', отпр. план ' + day.departP : ''}`);
  }
  // Остановки
  day.stops.forEach((s, i) => {
    if (!s.lat || !s.lng) return;
    const desc = [s.type || '', s.arrP ? 'приб. ' + s.arrP : '', s.depP ? 'отпр. ' + s.depP : ''].filter(Boolean).join(', ');
    gpx += _gpxWaypoint(s.lat, s.lng, `${s.icon || '📍'} ${s.name}`, desc);
  });

  // ── Track (GPS-след из IndexedDB) ─────────────────────────────────────────
  let track = [];
  try {
    if (typeof getGpsTrack === 'function') track = await getGpsTrack();
  } catch(e) { console.warn('GPX: no track data', e); }

  if (track.length > 0) {
    gpx += `<trk>
  <name>GPS-трек · ${_gpxEsc(dayLabel)}</name>
  <trkseg>
`;
    track.forEach(p => {
      gpx += `    <trkpt lat="${p.lat}" lon="${p.lng}">`;
      if (p.ts) gpx += `<time>${new Date(p.ts).toISOString()}</time>`;
      if (p.speed != null) gpx += `<speed>${(p.speed / 3.6).toFixed(1)}</speed>`; // km/h → m/s
      gpx += `</trkpt>\n`;
    });
    gpx += `  </trkseg>
</trk>
`;
  }

  gpx += `</gpx>`;

  // ── Download ──────────────────────────────────────────────────────────────
  const slug = `день-${dayNum}` + (day.date ? `-${day.date.replace(/\s/g, '-')}` : '');
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${slug}.gpx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`📥 GPX скачан (${day.stops.length} точек${track.length ? ' + трек' : ''})`);
}

function _gpxWaypoint(lat, lng, name, desc) {
  return `<wpt lat="${lat}" lon="${lng}">
  <name>${_gpxEsc(name)}</name>
  ${desc ? `<desc>${_gpxEsc(desc)}</desc>` : ''}
</wpt>
`;
}

function _gpxEsc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
