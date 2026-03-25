// ── ИМПОРТ МАРШРУТА ИЗ КАРТ ───────────────────────────────────────────────────
var _importDay  = null;
var _importMode = null;
var _importPts  = null;

// ── ПАРСЕР ССЫЛОК ─────────────────────────────────────────────────────────────
function parseMapLink(url) {
  url = url.trim();
  var ytMatch = url.match(/[?&]rtext=([^&]+)/);
  if (ytMatch) {
    var points = decodeURIComponent(ytMatch[1]).split('~').map(function(p) {
      var c = p.trim().split(',');
      var lat = parseFloat(c[0]), lng = parseFloat(c[1]);
      return (isNaN(lat)||isNaN(lng)) ? null : {lat:lat,lng:lng};
    }).filter(Boolean);
    if (points.length) return {service:'Яндекс Карты',points:points};
  }
  var gm = url.match(/maps\.google\.[^/]+\/maps\/dir\/([^?#]+)/);
  if (!gm) gm = url.match(/google\.[^/]+\/maps\/dir\/([^?@#]+)/);
  if (gm) {
    var pts=[]; gm[1].split('/').filter(function(s){return s&&s!=='data';}).forEach(function(seg){
      var m=seg.match(/^(-?\d+\.?\d*),(-?\d+\.?\d*)$/);
      if(m) pts.push({lat:parseFloat(m[1]),lng:parseFloat(m[2])});
    });
    if (pts.length) return {service:'Google Maps',points:pts};
  }
  var dg = url.match(/2gis\.[^/]+[^?]*\?([^#]*)/);
  if (dg) {
    var rp = dg[1].match(/routePoints=([^&]+)/);
    if (rp) {
      var pts3=decodeURIComponent(rp[1]).split('~').map(function(p){
        var c=p.trim().split(','); var lng=parseFloat(c[0]),lat=parseFloat(c[1]);
        return (isNaN(lat)||isNaN(lng))?null:{lat:lat,lng:lng};
      }).filter(Boolean);
      if (pts3.length) return {service:'2GIS',points:pts3};
    }
  }
  var osmPin = url.match(/[?&]pin=([^&]+)/);
  if (osmPin) {
    var coords=decodeURIComponent(osmPin[1]).split(/[,;]/);
    var la=parseFloat(coords[0]),lo=parseFloat(coords[1]);
    if (!isNaN(la)&&!isNaN(lo)) return {service:'OsmAnd',points:[{lat:la,lng:lo}]};
  }
  var raw=url.replace(/%2C/gi,',').replace(/%7E/gi,'~'), uni=[], re=/(-?\d{1,3}\.\d{3,})[,\s]+(-?\d{1,3}\.\d{3,})/g, m;
  while((m=re.exec(raw))!==null){var a=parseFloat(m[1]),b=parseFloat(m[2]);if(a>=-90&&a<=90&&b>=-180&&b<=180)uni.push({lat:a,lng:b});}
  if (uni.length>=2) return {service:'Универсальный',points:uni};
  return null;
}

// ── REVERSE GEOCODING — умный приоритет + пост-обработка ─────────────────────
// Категории Nominatim, которым мы доверяем как «полезным» объектам
var _USEFUL_CLASSES = {
  amenity: ['fuel','restaurant','cafe','fast_food','hotel','motel','hostel',
            'bar','pub','food_court','ice_cream','parking','toilets',
            'car_wash','charging_station'],
  tourism: true,   // любой tourism объект полезен
  shop:    true,   // любой магазин полезен
  highway: ['services','rest_area']
};

function _isUsefulObject(cls, type) {
  var allowed = _USEFUL_CLASSES[cls];
  if (!allowed) return false;
  if (allowed === true) return true;
  return allowed.indexOf(type) !== -1;
}

async function _reverseGeocode(lat, lng) {
  try {
    var r = await fetch('https://nominatim.openstreetmap.org/reverse?lat='+lat+'&lon='+lng+'&format=json&accept-language=ru&addressdetails=1&zoom=17',{headers:{'Accept-Language':'ru'}});
    var data = await r.json();
    if (!data||!data.address) return null;
    var a        = data.address;
    var road     = a.road||a.highway||a.motorway||'';
    var locality = a.city||a.town||a.village||a.suburb||a.municipality||a.county||'';
    var name;

    // Используем data.name только если объект — полезная категория (не банк, не офис и т.д.)
    if (data.name && data.name !== locality && _isUsefulObject(data.class, data.type)) {
      name = data.name + (locality ? ' · '+locality : '');
    } else if (road) {
      name = road + (locality ? ' · '+locality : '');
    } else if (locality) {
      name = locality;
    } else {
      name = data.display_name.split(',')[0].trim();
    }
    return _cleanGeoName(name) || null;
  } catch(e){}
  return null;
}

function _cleanGeoName(name) {
  if (!name) return name;
  name = name.replace(/^(Россия|Russia|Украина|Ukraine|Беларусь|Belarus|Казахстан|Kazakhstan|Грузия|Georgia|Турция|Turkey)[,\s]+/i,'');
  name = name.replace(/^[\w\s]+(область|республика|край|округ|oblast|region)[,\s]+/i,'');
  name = name.replace(/^\d{5,6}[,\s]+/,'');
  name = name.replace(/,\s*,/g,',').trim().replace(/^[,\s]+|[,\s]+$/g,'');
  if (name.length>1) name = name[0].toUpperCase()+name.slice(1);
  return name;
}

function _guessType(name) {
  if (!name) return 'Другое';
  var n = name.toLowerCase();
  if (/заправ|азс|газпром|лукойл|роснефть|нефть|fuel|petrol|shell|bp\b/.test(n)) return 'Заправка';
  if (/кафе|кафетерий|ресторан|столов|помпон|макдон|бургер|кофе|cafe|rest/.test(n))  return 'Кафе';
  if (/отель|гостин|хостел|hotel|inn|амакс|mercure|hilton|marriott/.test(n))          return 'Отель';
  if (/квартир|апарт|дом\b|жильё|villa|apartment/.test(n))                            return 'Жильё';
  return 'Другое';
}

// ── MODAL ─────────────────────────────────────────────────────────────────────
function openImportModal(day) {
  _importDay=day||null; _importMode=null; _importPts=null;
  var modal=document.getElementById('importModal'); if(!modal) return;
  _showImportStep('form');
  document.getElementById('importUrlInput').value='';
  document.getElementById('importPreview').style.display='none';
  document.getElementById('importActionsMain').style.display='none';
  document.getElementById('importActionsCancel').style.display='flex';
  document.getElementById('importError').style.display='none';
  modal.classList.add('show');
  setTimeout(function(){document.getElementById('importUrlInput').focus();},100);
}

function closeImportModal() {
  document.getElementById('importModal').classList.remove('show');
  _importDay=_importMode=_importPts=null;
}

function _showImportStep(step) {
  document.getElementById('importFormArea').style.display  = step==='form'     ? 'block':'none';
  document.getElementById('importProgress').style.display  = step==='progress' ? 'block':'none';
  document.getElementById('importEditStep').style.display  = step==='edit'     ? 'block':'none';
}

// ── LIVE PARSE ────────────────────────────────────────────────────────────────
function onImportInput() {
  var val=document.getElementById('importUrlInput').value.trim();
  var preview=document.getElementById('importPreview');
  var actions=document.getElementById('importActionsMain');
  var errEl=document.getElementById('importError');
  errEl.style.display='none';
  if (!val) {
    preview.style.display='none'; actions.style.display='none';
    document.getElementById('importActionsCancel').style.display='flex'; return;
  }
  var result=parseMapLink(val);
  if (!result||!result.points.length) {
    preview.style.display='none'; actions.style.display='none';
    if (val.length>20){errEl.textContent='Не удалось распознать ссылку. Поддерживаются Яндекс, Google Maps, 2GIS, OsmAnd.';errEl.style.display='block';}
    return;
  }
  var pts=result.points, showMax=3, html='';
  pts.forEach(function(p,i){
    if(i===0) html+='<div class="imp-pt"><span class="imp-pt-n imp-pt-start">🚩</span><span class="imp-pt-start-text">Старт</span><span class="imp-pt-coord">'+p.lat.toFixed(5)+', '+p.lng.toFixed(5)+'</span></div>';
    else if(i<=showMax) html+='<div class="imp-pt"><span class="imp-pt-n">'+i+'</span><span class="imp-pt-coord">'+p.lat.toFixed(5)+', '+p.lng.toFixed(5)+'</span></div>';
  });
  if(pts.length>showMax+1) html+='<div class="imp-pt imp-pt-more">··· ещё '+(pts.length-showMax-1)+' точек</div>';
  document.getElementById('importServiceName').textContent=result.service;
  document.getElementById('importPointCount').textContent=pts.length+' ('+(pts.length>1?'1 старт + '+(pts.length-1)+' остановок':'1 точка')+')';
  document.getElementById('importPreviewList').innerHTML=html;
  preview.style.display='block'; actions.style.display='flex';
  document.getElementById('importActionsCancel').style.display='none';
}

// ── GEOCODING + SHOW EDIT ─────────────────────────────────────────────────────
async function doImport(mode) {
  var val=document.getElementById('importUrlInput').value.trim();
  var result=parseMapLink(val); if(!result||!result.points.length) return;
  _importMode=mode; _importPts=result.points;
  var pts=_importPts;
  _showImportStep('progress');
  document.getElementById('importActionsMain').style.display='none';
  document.getElementById('importActionsCancel').style.display='none';
  var progressList=document.getElementById('importProgressList');
  var progressFill=document.getElementById('importProgressFill');
  var progressCount=document.getElementById('importProgressCount');
  function buildRows(names){
    var h='';
    pts.forEach(function(p,i){
      var label=names[i]||(p.lat.toFixed(4)+', '+p.lng.toFixed(4));
      var cls=names[i]?'imp-prog-done':(i===names.length?'imp-prog-active':'imp-prog-wait');
      h+='<div class="imp-prog-item '+cls+'">'+(i===names.length?'<span class="imp-spinner"></span>':(names[i]?'✓ ':'— '))+label+'</div>';
    });
    return h;
  }
  var resolvedNames=[];
  progressList.innerHTML=buildRows(resolvedNames);
  for (var i=0;i<pts.length;i++){
    var name=await _reverseGeocode(pts[i].lat,pts[i].lng);
    resolvedNames.push(name||(pts[i].lat.toFixed(4)+', '+pts[i].lng.toFixed(4)));
    progressList.innerHTML=buildRows(resolvedNames);
    progressFill.style.width=Math.round(resolvedNames.length/pts.length*100)+'%';
    progressCount.textContent=resolvedNames.length+' / '+pts.length;
    if(i<pts.length-1) await new Promise(function(res){setTimeout(res,1100);});
  }
  _showEditStep(pts, resolvedNames);
}

// ── EDIT STEP ─────────────────────────────────────────────────────────────────
function _escAttr(s){return (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}

function _showEditStep(pts, names) {
  var html='';
  pts.forEach(function(p,i){
    var name=names[i], isStart=i===0;
    var borderStyle=isStart?'border-color:var(--amber-dim,#3a3a2a)':'';
    html+='<div class="imp-edit-row" style="'+borderStyle+'">';
    html+='<div style="display:flex;align-items:center;gap:6px">';
    if (isStart) {
      html+='<span style="font-size:13px;flex-shrink:0">🚩</span>';
      html+='<input class="imp-edit-name" data-idx="'+i+'" value="'+_escAttr(name)+'" placeholder="Название старта">';
    } else {
      var guessed=_guessType(name);
      var typeKeys=Object.keys(TYPE_ICONS);
      var guessedIdx=typeKeys.indexOf(guessed); if(guessedIdx<0) guessedIdx=typeKeys.length-1;
      var guessedIcon=TYPE_ICONS[guessed]||'📍';
      html+='<button type="button" class="imp-type-btn" data-idx="'+i+'" data-type="'+guessed+'" data-tidx="'+guessedIdx+'" onclick="cycleImportType(this)" title="Тип — нажми для смены">'+guessedIcon+'</button>';
      html+='<input class="imp-edit-name" data-idx="'+i+'" value="'+_escAttr(name)+'" placeholder="Название точки">';
    }
    html+='<span class="imp-edit-coord">'+p.lat.toFixed(4)+', '+p.lng.toFixed(4)+'</span>';
    html+='</div></div>';
  });
  document.getElementById('importEditList').innerHTML=html;
  _showImportStep('edit');
}

// ── TYPE CYCLE BUTTON ────────────────────────────────────────────────────────
function cycleImportType(btn) {
  var typeKeys = Object.keys(TYPE_ICONS);
  var tidx = (parseInt(btn.dataset.tidx, 10) + 1) % typeKeys.length;
  var newType = typeKeys[tidx];
  btn.dataset.tidx = tidx;
  btn.dataset.type = newType;
  btn.textContent  = TYPE_ICONS[newType] || '📍';
}

// ── COMMIT ────────────────────────────────────────────────────────────────────
function commitImport() {
  var pts=_importPts, mode=_importMode; if(!pts||!mode) return;
  var names=[], types=[];
  pts.forEach(function(p,i){
    var ne=document.querySelector('.imp-edit-name[data-idx="'+i+'"]');
    var te=document.querySelector('.imp-type-btn[data-idx="'+i+'"]');
    names.push((ne?ne.value.trim():'')||(p.lat.toFixed(4)+','+p.lng.toFixed(4)));
    types.push(te?(te.dataset.type||'Другое'):'Другое');
  });
  var startPt=pts[0], startName=names[0];
  var stopPts=pts.slice(1), stopNames=names.slice(1), stopTypes=types.slice(1);

  if (mode==='new') {
    var keys=dayKeys(), newD=Math.max.apply(null,keys)+1, colIdx=keys.length%DAY_COLORS.length;
    var newDateISO='', lastDay=DAYS_DATA[keys[keys.length-1]];
    if(lastDay&&lastDay.dateISO&&typeof parseDateDMY==='function'){
      var dt=parseDateDMY(lastDay.dateISO); if(dt){dt.setDate(dt.getDate()+1);newDateISO=fmtDateDMY(dt);}
    }
    var stops=stopPts.map(function(p,i){
      var t=stopTypes[i];
      return {id:'d'+newD+'s'+(i+1),num:i+1,icon:TYPE_ICONS[t]||'📍',type:t,name:stopNames[i],lat:p.lat,lng:p.lng,arrP:'',depP:'',arrA:'',depA:''};
    });
    DAYS_DATA[newD]={color:DAY_COLORS[colIdx],dateISO:newDateISO,
      date:startName+(stops.length?' → '+stops[stops.length-1].name:''),
      departP:'',departA:'',
      start:{lat:startPt.lat,lng:startPt.lng,name:startName,icon:'🚗'},stops:stops};
    layers[newD]=L.layerGroup(); segmentLayers[newD]=[];
    renderTabs();
    document.getElementById('daySections').appendChild(renderDaySection(newD));
    renderStops(newD); updateDayRoute(newD); redrawDay(newD); switchDay(newD);

  } else {
    var day=_importDay; if(!day||!DAYS_DATA[day]) day=currentDay;
    snapshotForUndo('Импорт точек в день '+day);
    if(!DAYS_DATA[day].start.lat)
      DAYS_DATA[day].start={lat:startPt.lat,lng:startPt.lng,name:startName,icon:'🚗'};
    var ec=DAYS_DATA[day].stops.length;
    stopPts.forEach(function(p,i){
      var t=stopTypes[i];
      DAYS_DATA[day].stops.push({id:'d'+day+'s'+Date.now()+i,num:ec+i+1,icon:TYPE_ICONS[t]||'📍',type:t,name:stopNames[i],lat:p.lat,lng:p.lng,arrP:'',depP:'',arrA:'',depA:''});
    });
    renderStops(day); updateDayRoute(day); redrawDay(day); switchDay(day);
  }

  saveData();
  closeImportModal();
  showToast('✅ Импортировано '+pts.length+' точек');
}
