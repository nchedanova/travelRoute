// One GPS recorder per journal. Collaborators exchange live geometry and
// individual notes through Firebase, never Gist polling on each GPS update.
var walkCollaboration = (() => {
  const clientId = crypto.randomUUID();
  const leaseMs = 60000;
  let db, leaseRef, roomRef, lease = null, roomWalkId, room = {}, lastLeaseKey = '';
  let connected = false, connectedRef, offsetRef, serverOffset = 0, lastLive = null, cloudSavedAt = 0;
  let heartbeat, expiryTimer, leaseReady = false, publishQueue = Promise.resolve(), noteQueue = Promise.resolve();
  let offlineClaim = null, reclaiming = false;
  let savingCommittedNotes = false;
  const dirtyStops = new Set();
  const editVersions = new Map();
  const pendingNotes = new Map();
  const noteOutbox = new Map();
  const noteKey=(walkId,stopId,noteId)=>walkId+'/'+stopId+'/'+noteId;
  function persistOutbox() {
    try {localStorage.setItem('travel_walk_note_outbox_'+CLOUD_CONFIG.binId,JSON.stringify([...noteOutbox]));}catch{}
  }
  const now = () => Date.now() + serverOffset;
  const enabled = () => !!db && !!CLOUD_CONFIG.canWrite && !!CLOUD_CONFIG.binId && !SPECTATOR_MODE;
  const alive = value => value && value.phase !== 'finished' && value.expiresAt > now();
  const isOwner = () => enabled() && alive(lease) && lease.clientId === clientId;
  const hasRemoteRecorder = () => enabled() && alive(lease) && lease.clientId !== clientId;
  const remoteDay = day => !!day?.walkReview?.id && enabled() && lease?.walkId === day.walkReview.id && lease.clientId !== clientId && lease.phase !== 'finished';
  const collaborative = day => enabled() && !!day?.walkReview?.id && (roomWalkId === day.walkReview.id || lease?.walkId === day.walkReview.id);
  const localOnly = day => enabled() && !!day?.walkReview &&
    (offlineClaim?.walkId===day.walkReview.id || (lease?.walkId===day.walkReview.id && lease.clientId===clientId &&
      (!connected || (lease.phase!=='finished' && !alive(lease)))));
  const notify = () => document.dispatchEvent(new Event('walk-collaboration-changed'));
  const clone = value => JSON.parse(JSON.stringify(value));
  const safeKey = value => String(value).replace(/[.#$\[\]\/]/g, '_');
  const roomPath = walkId => 'walkRooms/' + safeKey(CLOUD_CONFIG.binId) + '/' + safeKey(walkId);
  function ensureNoteIds(stop) {
    (stop.notes || []).forEach((note,index) => { note.id ||= 'legacy-' + index; });
  }
  function editing(stopId) {
    return [...document.querySelectorAll('[id^="stop-note-edit-"]')].some(el =>
      el.id.startsWith('stop-note-edit-' + stopId + '-') && el.style.display !== 'none');
  }
  function refreshStop(dayId, stop) {
    const old = document.getElementById('card-' + stop.id);
    if (editing(stop.id)) { dirtyStops.add(stop.id); return; }
    if (old) old.replaceWith(makeStopCard(stop, dayId));
  }
  function overlayNotes(dayId, stop) {
    const shared = room.notes?.[safeKey(stop.id)];
    if (!shared) return false;
    ensureNoteIds(stop);
    // Draft indices must stay stable while an editor/upload is open.
    if (editing(stop.id) || pendingNotes.has(stop.id)) { dirtyStops.add(stop.id); return false; }
    const entries = new Map((stop.notes || []).map(note => [note.id,note]));
    for (const [id,value] of Object.entries(shared)) {
      if (noteOutbox.has(noteKey(roomWalkId,stop.id,id))) continue;
      if (value.deleted) entries.delete(id);
      else if (value.note) entries.set(id, {...value.note,id});
    }
    const notes = [...entries.values()];
    if (JSON.stringify(notes) === JSON.stringify(stop.notes || [])) return false;
    stop.notes = notes;
    dirtyStops.delete(stop.id);
    return true;
  }
  function applyNotes() {
    const dayId = Object.keys(DAYS_DATA).find(id => DAYS_DATA[id].walkReview?.id === roomWalkId);
    if (!dayId) return;
    let changed=false;
    for (const stop of DAYS_DATA[dayId].stops) {
      if (overlayNotes(dayId,stop)) {changed=true;refreshStop(Number(dayId),stop);}
    }
    if (changed) notesCommitted(Number(dayId));
  }
  function applyLive(live) {
    const walk = live?.walk;
    if (!walk || walk.routeId !== CLOUD_CONFIG.binId || !Number.isSafeInteger(walk.dayId) ||
        walk.dayId < 1 || walk.day?.walkReview?.id !== roomWalkId ||
        live.ownerId !== lease?.clientId || live.epoch !== lease?.epoch || live.ownerId===clientId) return;
    const existing = DAYS_DATA[walk.dayId];
    if (existing && (!sameRecordedWalk(existing,walk.day) || existing.archived)) return;
    if (existing?.walkReview?.phase==='finished' &&
        (walk.day.walkReview.phase!=='finished' || cloudSavedAt>=walk.updatedAt)) return;
    if (lastLive && live.epoch===lastLive.epoch &&
        (live.revision ? live.revision<=(lastLive.revision||0) : live.updatedAt<=lastLive.updatedAt)) return;
    // A completed, subsequently saved correction remains authoritative.
    if (existing?.walkReview?.phase === 'finished' && existing.walkReview.lastAt > walk.day.walkReview.lastAt) return;
    const stopMap = new Map(existing?.stops?.map(stop => [stop.id,stop]));
    const stops = (walk.day.stops || []).map(incoming => {
      const {notes:ignoredNotes,...routeStop}=incoming;
      const stop = stopMap.get(incoming.id) || {...routeStop,notes:[]};
      Object.assign(stop,routeStop);ensureNoteIds(stop);return stop;
    });
    DAYS_DATA[walk.dayId] = {...existing,...walk.day,stops,
      walkReview:{...walk.day.walkReview,segments:walk.day.walkReview.segments || []}};
    const day = DAYS_DATA[walk.dayId];
    for (const stop of stops) overlayNotes(walk.dayId,stop);
    const section = document.getElementById('day' + walk.dayId);
    if (!section) {
      document.querySelector('#daySections .route-empty')?.remove();
      document.getElementById('daySections').appendChild(renderDaySection(walk.dayId));
      renderStops(walk.dayId);
    } else {
      const list = document.getElementById('d' + walk.dayId + '-stops');
      if (!section.querySelector('.stop-card')) list.replaceChildren();
      for (const stop of stops) {
        if (!document.getElementById('card-' + stop.id)) list.appendChild(makeStopCard(stop,walk.dayId));
        for (const kind of ['arr','dep']) {
          const field = document.getElementById(kind + '-' + stop.id);
          if (field && document.activeElement !== field) field.value = stop[kind + 'A'] || '';
        }
      }
      for (const card of list.querySelectorAll('.stop-card')) {
        if (!stops.some(stop => card.id === 'card-' + stop.id)) card.remove();
      }
    }
    const depart=document.getElementById('d'+walk.dayId+'-depart');
    if (depart && document.activeElement!==depart) depart.value=day.departA || '';
    const planned=document.getElementById('d'+walk.dayId+'-departP-display');
    if (planned) planned.textContent=day.departP || '—';
    const startName=document.getElementById('d'+walk.dayId+'-start-name');
    if (startName) startName.innerHTML=startPointNameMarkup(day.start,true);
    redrawDay(walk.dayId);renderTabs();updateDayRoute(walk.dayId);updateProgress();
    if (!DAYS_DATA[currentDay] || DAYS_DATA[currentDay].archived) switchDay(walk.dayId);
    if (currentDay === walk.dayId && !map.hasLayer(layers[walk.dayId])) layers[walk.dayId].addTo(map);
    if (!lastLive && currentDay === walk.dayId) fitDayMap(walk.dayId);
    lastLive = live;
    if (live.point && currentDay === walk.dayId && !_walkGpsActive && !_drivingMode) {
      const p=live.point;
      _updateGpsMarker(p.lat,p.lng,p.accuracy,true,p.heading,undefined,false,p.speed,walk.day.gpsWalkStyle);
      _setGpsControls(true,true);_updateSpeedDisplay(p.speed);
    } else if (!live.point && currentDay===walk.dayId && !_walkGpsActive && !_drivingMode) {
      if (typeof _clearGpsMarker==='function') _clearGpsMarker();
      _setGpsControls(false,false);_updateSpeedDisplay(null);
    }
    notify();
  }
  function bindRoom(walkId) {
    if (roomWalkId === walkId) return;
    if (roomRef) roomRef.off('value');
    roomWalkId = walkId;room = {};lastLive = null;
    roomRef = db.ref(roomPath(walkId));
    roomRef.on('value', snap => {
      room = snap.val() || {};
      applyLive(lease?.live || room.live);applyNotes();
    }, error => console.warn('Walk collaboration:',error));
  }
  function bind(database) {
    if (!CLOUD_CONFIG.canWrite || !CLOUD_CONFIG.binId || SPECTATOR_MODE || db === database) return;
    db = database;
    try {for (const [key,value] of JSON.parse(localStorage.getItem('travel_walk_note_outbox_'+CLOUD_CONFIG.binId)||'[]')) noteOutbox.set(key,value);}catch{}
    connectedRef = db.ref('.info/connected');
    connectedRef.on('value', snap => {
      connected=!!snap.val();notify();
      if (connected) void recoverConnection();
    });
    offsetRef = db.ref('.info/serverTimeOffset');
    offsetRef.on('value', snap => { serverOffset=Number(snap.val()) || 0; });
    leaseRef = db.ref('walkRecorders/' + safeKey(CLOUD_CONFIG.binId));
    leaseRef.on('value', snap => {
      const previous=lease,first=!leaseReady;lease=snap.val();leaseReady=true;
      if (lease?.clientId!==clientId && lease?.phase!=='finished' &&
          (previous?.clientId===clientId || (offlineClaim && offlineClaim.walkId===lease?.walkId))) {
        const id=offlineClaim?.dayId ?? previous?.dayId;
        try { if (DAYS_DATA[id]) localStorage.setItem('travel_walk_handoff_backup_'+DAYS_DATA[id].walkReview.id,JSON.stringify(DAYS_DATA[id])); } catch {}
        offlineClaim=null;
        document.dispatchEvent(new Event('walk-recorder-lost'));
      }
      if (lease?.walkId) bindRoom(lease.walkId);
      if (lease?.live) applyLive(lease.live);
      const key = lease ? [lease.clientId,lease.epoch,lease.walkId,lease.phase].join(':') : '';
      if (key !== lastLeaseKey) {
        lastLeaseKey=key;
        notify();
        if (lease?.phase==='finished' && lease.clientId===clientId && typeof saveData==='function') saveData();
      }
      if (first && !lease && !offlineClaim && typeof publishRecoveredWalk==='function') publishRecoveredWalk();
    },error=>console.warn('Walk recorder:',error));
    heartbeat = setInterval(async () => {
      if (!isOwner() || !connected || lease.expiresAt-now()>leaseMs-15000) return;
      await leaseRef.transaction(value => {
        if (value?.clientId !== clientId || value.epoch !== lease?.epoch) return;
        return {...value,expiresAt:now()+leaseMs};
      },undefined,false).catch(error=>console.warn('Walk recorder heartbeat:',error));
    },15000);
    expiryTimer = setInterval(() => {
      if (lease?.clientId===clientId && lease.phase!=='finished' && !alive(lease)) void recoverConnection();
    },5000);
    void recoverConnection();
  }
  async function recoverConnection() {
    if (!connected || !leaseRef || reclaiming) return;
    const pending=offlineClaim || (lease?.clientId===clientId &&
      ((lease.phase!=='finished' && !alive(lease)) || [...noteOutbox.values()].some(op=>op.walkId===lease.walkId))
      ? {dayId:lease.dayId,walkId:lease.walkId}:null);
    if (!pending || DAYS_DATA[pending.dayId]?.walkReview?.id!==pending.walkId) return;
    reclaiming=true;
    try {
      if (!await claim(pending.dayId,false,true)) {
        try { localStorage.setItem('travel_walk_handoff_backup_'+pending.walkId,JSON.stringify(DAYS_DATA[pending.dayId])); } catch {}
        offlineClaim=null;
        showToast('Другое устройство уже записывает прогулку. Локальная копия сохранена.');
        document.dispatchEvent(new Event('walk-recorder-lost'));return;
      }
      offlineClaim=null;
      const day=DAYS_DATA[pending.dayId];
      for (const [key,operation] of [...noteOutbox]) {
        if (operation.walkId!==pending.walkId) continue;
        const stop=day.stops.find(stop=>stop.id===operation.stopId);
        if (!stop) continue;
        await saveNote(pending.dayId,stop,operation.noteId,operation.note,operation.expected);
        noteOutbox.delete(key);persistOutbox();
      }
      for (const stop of day.stops) {
        ensureNoteIds(stop);
        for (const note of stop.notes || []) if ((note.text || note.images?.length) && !room.notes?.[safeKey(stop.id)]?.[safeKey(note.id)]) {
          await saveNote(pending.dayId,stop,note.id,note);
        }
      }
      const walk=walkBroadcastPayload(pending.dayId,true);
      if (walk) publish(pending.dayId,walk,null,spectatorWalkPayload(pending.dayId));
      notify();
    } catch(error) {console.warn('Walk reconnection:',error);showToast('Не все заметки отправлены. Локальные изменения сохранены.');}
    finally {reclaiming=false;}
  }
  async function flushOutbox(dayId) {
    const day=DAYS_DATA[dayId];
    for (const operation of [...noteOutbox.values()]) {
      if (operation.walkId!==day.walkReview.id) continue;
      const stop=day.stops.find(stop=>stop.id===operation.stopId);
      if (stop) await saveNote(dayId,stop,operation.noteId,operation.note,operation.expected);
    }
  }
  async function claim(dayId, force = false, recovering = false) {
    if (!CLOUD_CONFIG.binId || !CLOUD_CONFIG.canWrite || SPECTATOR_MODE) return !CLOUD_CONFIG.binId;
    const day=DAYS_DATA[dayId];day.walkReview.id ||= crypto.randomUUID();
    if (!enabled() || !connected) {
      if (hasRemoteRecorder() || force) {showToast('Для передачи записи нужно подключение к Firebase.');return false;}
      offlineClaim={dayId,walkId:day.walkReview.id};
      showToast('Нет связи с Firebase. Прогулка записывается на этом устройстве.');notify();return true;
    }
    const user=typeof firebase!=='undefined'?firebase.auth?.().currentUser:null;
    const result=await leaseRef.transaction(value => {
      if (alive(value) && value.clientId !== clientId && !force) return;
      return {clientId,walkId:day.walkReview.id,dayId,epoch:(value?.epoch||0)+1,
        expiresAt:now()+leaseMs,phase:'recording',name:user?.displayName || 'Другое устройство'};
    },undefined,false).catch(()=>null);
    if (!result?.committed) { if (!recovering) showToast('Прогулку уже записывают на другом устройстве.');return false; }
    lease=result.snapshot.val();bindRoom(lease.walkId);notify();
    try {await flushOutbox(dayId);}catch(error){showToast('Часть заметок ожидает отправки. Локальные изменения сохранены.');}
    return true;
  }
  function publish(dayId, walk, point, spectator) {
    if (!enabled()) return false;
    if (!isOwner() || lease.walkId !== DAYS_DATA[dayId]?.walkReview?.id) return true;
    const owner={epoch:lease.epoch};
    const packet={ownerId:clientId,epoch:owner.epoch,updatedAt:now(),walk:clone(walk),...(point?{point:clone(point)}:{})};
    publishQueue=publishQueue.catch(()=>{}).then(async()=>{
      if (!isOwner() || lease.epoch!==owner.epoch) return;
      // Ownership and geometry commit atomically. A delayed packet from the
      // previous recorder cannot replace the new recorder's live track.
      const result=await leaseRef.transaction(value=>{
        if (value?.clientId!==clientId || value.epoch!==owner.epoch || value.phase==='finished') return;
        const finished=walk.day.walkReview.phase==='finished';
        return {...value,live:{...packet,revision:(value.live?.revision||0)+1},phase:finished?'finished':'recording',expiresAt:finished?0:now()+leaseMs};
      },undefined,false);
      if (!result.committed || lease?.clientId!==clientId || lease.epoch!==owner.epoch) return;
      const readerWalk=walkBroadcastPayload(dayId);
      await db.ref('gps').set(readerWalk ? {...(point||{}),walk:readerWalk,spectator:spectator||null}
        : spectator ? {spectator} : null);
    }).catch(error=>console.warn('Shared walk:',error));
    return true;
  }
  async function saveNote(dayId, stop, noteId, note, expectedVersion) {
    const day=DAYS_DATA[dayId];
    if (localOnly(day)) {
      const key=noteKey(day.walkReview.id,stop.id,noteId);
      noteOutbox.set(key,{walkId:day.walkReview.id,stopId:stop.id,noteId,note:note?clone(note):null,
        expected:noteOutbox.get(key)?.expected ?? editVersions.get(key) ?? room.notes?.[safeKey(stop.id)]?.[safeKey(noteId)]?.revision ?? 0});
      persistOutbox();editVersions.delete(key);return true;
    }
    if (!collaborative(day)) return false;
    if (!connected) throw Error('Нет соединения с Firebase. Заметка остаётся в редакторе.');
    ensureNoteIds(stop);
    const ref=db.ref(roomPath(day.walkReview.id)+'/notes/'+safeKey(stop.id)+'/'+safeKey(noteId));
    const key=noteKey(day.walkReview.id,stop.id,noteId);
    const expected=expectedVersion ?? editVersions.get(key) ?? room.notes?.[safeKey(stop.id)]?.[safeKey(noteId)]?.revision ?? 0;
    const body=note?clone({...note,id:noteId}):null;
    pendingNotes.set(stop.id,(pendingNotes.get(stop.id)||0)+1);
    noteQueue=noteQueue.catch(()=>{}).then(async()=>{
      const result=await ref.transaction(value=>{
        if ((value?.revision||0)!==expected) return;
        return {revision:expected+1,updatedAt:now(),author:clientId,...(body?{note:body}:{deleted:true})};
      },undefined,false);
      if (!result.committed) throw Error('Эту заметку изменили на другом устройстве. Ваш текст остаётся в редакторе.');
    });
    try { await noteQueue; }
    finally {
      const count=pendingNotes.get(stop.id)-1;
      if (count) pendingNotes.set(stop.id,count);else pendingNotes.delete(stop.id);
    }
    editVersions.delete(key);
    noteOutbox.delete(key);persistOutbox();
    return true;
  }
  function beginNoteEdit(dayId,stop,note) {
    if (!collaborative(DAYS_DATA[dayId])) return;
    ensureNoteIds(stop);
    const key=DAYS_DATA[dayId].walkReview.id+'/'+stop.id+'/'+note.id;
    if (!editVersions.has(key)) editVersions.set(key,room.notes?.[safeKey(stop.id)]?.[safeKey(note.id)]?.revision || 0);
  }
  function cancelNoteEdit(dayId,stopId,noteId) {
    editVersions.delete(DAYS_DATA[dayId]?.walkReview?.id+'/'+stopId+'/'+noteId);
  }
  function blockRouteEdit(dayId) {
    if (!remoteDay(DAYS_DATA[dayId])) return false;
    showToast('Маршрут изменяет записывающее устройство. Здесь доступны фото и заметки.');return true;
  }
  function notesCommitted(dayId) {
    if (!enabled() || !connected || lease?.clientId!==clientId ||
        DAYS_DATA[dayId]?.walkReview?.id!==roomWalkId || typeof saveData!=='function') return;
    // An explicit note/photo save retains the old Gist/publication update path.
    // Existing debounce and write cooldown still apply; GPS packets never use it.
    savingCommittedNotes=true;
    try {saveData();}finally{savingCommittedNotes=false;}
  }
  function flush() { applyNotes(); }
  function restore(savedAt = 0) {
    cloudSavedAt=Math.max(cloudSavedAt,savedAt);
    if (!roomWalkId) return;
    // A Gist poll can predate the active session. Reapply its live geometry.
    const previous=lastLive;lastLive=null;applyLive(lease?.live || room.live);lastLive ||= previous;applyNotes();
  }
  document.addEventListener('walk-notes-editor-closed',flush);
  return {bind,claim,publish,saveNote,ensureNoteIds,beginNoteEdit,cancelNoteEdit,blockRouteEdit,isOwner,hasRemoteRecorder,remoteDay,collaborative,localOnly,notesCommitted,
    flush,restore,get lease(){return lease},get clientId(){return clientId},
    get ready(){return leaseReady},
    blockCloudPoll:()=>enabled() && (!!offlineClaim || alive(lease) || (lease?.clientId===clientId && lease.phase!=='finished') || Object.values(DAYS_DATA).some(day=>
      day.walkReview?.id===roomWalkId && day.stops.some(stop=>editing(stop.id)))),
    suppressCloudSave:()=>!savingCommittedNotes && enabled() && (!!offlineClaim || alive(lease) || (lease?.clientId===clientId && lease.phase!=='finished'))};
})();
