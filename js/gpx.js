// ── GPX EXPORT MODULE ──────────────────────────────────────────────────────────
// Генерация GPX-файла для Organic Maps, OsmAnd и других навигаторов.
// Экспортирует: waypoints (остановки дня) + track (записанный GPS-след из IndexedDB)

// ── Сборка GPX-строки ──────────────────────────────────────────────────────────
async function _buildGpx(dayNum) {
  const day = DAYS_DATA[dayNum];
  if (!day) return null;

  const dayLabel  = `День ${dayNum}` + (day.date ? ` · ${day.date}` : '');
  const startName = day.start?.name || 'Старт';
  const endName   = day.stops.length ? day.stops[day.stops.length - 1].name : '';

  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Дорожный журнал"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
<metadata>
  <n>${_gpxEsc(dayLabel)}: ${_gpxEsc(startName)} → ${_gpxEsc(endName)}</n>
  <desc>Маршрут из Дорожного журнала</desc>
  <time>${new Date().toISOString()}</time>
</metadata>
`;

  if (day.start?.lat && day.start?.lng) {
    gpx += _gpxWaypoint(day.start.lat, day.start.lng, day.start.icon + ' ' + day.start.name,
      `Старт${day.departP ? ', отпр. план ' + day.departP : ''}`);
  }
  day.stops.forEach(s => {
    if (!s.lat || !s.lng) return;
    const desc = [s.type || '', s.arrP ? 'приб. ' + s.arrP : '', s.depP ? 'отпр. ' + s.depP : ''].filter(Boolean).join(', ');
    gpx += _gpxWaypoint(s.lat, s.lng, `${s.icon || '📍'} ${s.name}`, desc);
  });

  let track = [];
  try {
    if (typeof getGpsTrack === 'function') track = await getGpsTrack();
  } catch(e) { console.warn('GPX: no track data', e); }

  if (track.length > 0) {
    gpx += `<trk>\n  <n>GPS-трек · ${_gpxEsc(dayLabel)}</n>\n  <trkseg>\n`;
    track.forEach(p => {
      gpx += `    <trkpt lat="${p.lat}" lon="${p.lng}">`;
      if (p.ts) gpx += `<time>${new Date(p.ts).toISOString()}</time>`;
      if (p.speed != null) gpx += `<speed>${(p.speed / 3.6).toFixed(1)}</speed>`;
      gpx += `</trkpt>\n`;
    });
    gpx += `  </trkseg>\n</trk>\n`;
  }

  gpx += `</gpx>`;
  return { gpx, dayLabel, track, stopCount: day.stops.length };
}

// ── Основная функция ───────────────────────────────────────────────────────────
// На мобиле: Web Share API → системный диалог → пользователь выбирает Organic Maps
//            → приложение открывается со всеми точками маршрута
// На десктопе: скачивание файла + подробная инструкция что делать дальше
async function exportGpxAndOpen(dayNum) {
  const day = DAYS_DATA[dayNum];
  if (!day) { showToast('⚠ Нет данных для дня ' + dayNum); return; }

  const btn = document.getElementById('organic-maps-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Генерация…'; }

  try {
    const result = await _buildGpx(dayNum);
    if (!result) { showToast('⚠ Ошибка генерации GPX'); return; }

    const { gpx, dayLabel, track, stopCount } = result;
    const slug     = `день-${dayNum}` + (day.date ? `-${day.date.replace(/\s/g, '-')}` : '');
    const fileName = `${slug}.gpx`;
    const blob     = new Blob([gpx], { type: 'application/gpx+xml' });
    const file     = new File([blob], fileName, { type: 'application/gpx+xml' });
    const stats    = `${stopCount} точек${track.length ? ' + GPS-трек' : ''}`;

    // ── Мобильный путь: Web Share API ──────────────────────────────────────
    // Показывает системное меню «Открыть в...» → выбрать Organic Maps →
    // приложение откроется и загрузит все точки маршрута из GPX
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: dayLabel, text: `Маршрут: ${dayLabel}` });
        showToast(`✅ GPX готов (${stats})`);
        return;
      } catch(e) {
        if (e.name === 'AbortError') return; // пользователь закрыл диалог — ок
        console.warn('Share API failed, falling back to download', e);
      }
    }

    // ── Десктопный путь: скачивание + инструкция ───────────────────────────
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const sub = document.getElementById('organic-maps-sub');
    if (sub) sub.innerHTML = `✅ Файл <b>${fileName}</b> скачан → найдите в Загрузках → откройте в Organic Maps`;

    showToast(`📥 GPX скачан (${stats}) — откройте файл в Загрузках`);

  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📲 Открыть в картах'; }
  }
}

// Обратная совместимость — старое имя функции
async function exportGpx(dayNum) { return exportGpxAndOpen(dayNum); }

function _gpxWaypoint(lat, lng, name, desc) {
  return `<wpt lat="${lat}" lon="${lng}">
  <n>${_gpxEsc(name)}</n>
  ${desc ? `<desc>${_gpxEsc(desc)}</desc>` : ''}
</wpt>
`;
}

function _gpxEsc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
