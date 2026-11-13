'use strict';
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let S = null;               // Einstellungen
let PLATFORM = 'win32';
let KEYHOOK = false;
let saveTimer = null;
let devices = { cams: [], mics: [] };
let sources = { displays: [], windows: [] };
let lastDim = '';
let sessionOpts = null;     // Optionen der laufenden Aufnahme (z. B. Auto-Stopp)

const get = (path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), S);
function set(path, val) {
  const keys = path.split('.'); const last = keys.pop();
  keys.reduce((o, k) => o[k], S)[last] = val;
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => api.saveSettings(S), 250); }
const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
const fmtSize = (b) => b > 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const baseName = (p) => p.split(/[\\/]/).pop();
const uid = () => Math.random().toString(36).slice(2, 10);

function say(msg) { $('stage-msg').textContent = msg || ''; $('stage-msg').hidden = !msg; }
function status(msg) { $('st-state').textContent = msg; }

// ---------- Bindings ----------
function bindAll(root = document) {
  $$('[data-bind]', root).forEach((el) => {
    const path = el.dataset.bind;
    const apply = () => {
      const v = get(path);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
      const out = el.parentElement.querySelector('output'); if (out && el.type === 'range') out.textContent = v + (path.includes('hold') ? ' s' : '');
    };
    apply();
    const onChange = () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'range' || 'num' in el.dataset) v = Number(v);
      set(path, v); apply(); save(); changed(path);
    };
    el.addEventListener(el.type === 'range' || el.type === 'text' || el.type === 'color' || el.type === 'number' ? 'input' : 'change', onChange);
  });
}
function changed(path) {
  if (path === 'audio.system' && !Pipeline.isRecording()) reopen();
  else if (path === 'audio.mic' || path === 'audio.micId') Pipeline.syncMic();
  else if (path.startsWith('audio.') && path.endsWith('Gain')) Pipeline.syncGains();
  else if (path.startsWith('effects.camera.') && /enabled|deviceId/.test(path)) Pipeline.syncCamera();
  else if (path === 'output.fps') { Pipeline.ensureLoop(); updateInfo(); }
  else if (path === 'effects.keys.enabled') api.setKeyHook(get(path));
  else if (path === 'output.format' || path === 'output.scale') updateInfo();
  else if (path === 'output.cursor' && !Pipeline.isRecording()) reopen();
}

// ---------- Geraete / Quellen ----------
async function enumerate() {
  for (const c of [{ video: true }, { audio: true }]) {
    try { (await navigator.mediaDevices.getUserMedia(c)).getTracks().forEach((t) => t.stop()); } catch { /* kein Geraet / abgelehnt */ }
  }
  const list = await navigator.mediaDevices.enumerateDevices();
  devices.cams = list.filter((d) => d.kind === 'videoinput');
  devices.mics = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  const fill = (sel, items, cur, label) => {
    sel.innerHTML = '';
    if (!items.length) { const o = document.createElement('option'); o.value = ''; o.textContent = '(keines gefunden)'; sel.appendChild(o); return; }
    items.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `${label} ${i + 1}`; sel.appendChild(o); });
    sel.value = items.some((d) => d.deviceId === cur) ? cur : items[0].deviceId;
  };
  fill($('sel-cam'), devices.cams, S.ui.cameraId, 'Kamera');
  fill($('sel-device'), devices.cams, S.ui.deviceId, 'Videogerät');
  fill($('sel-mic'), devices.mics, S.audio.micId, 'Mikrofon');
  fill($('fx-cam-select'), devices.cams, S.effects.camera.deviceId, 'Kamera');
  S.ui.cameraId = $('sel-cam').value; S.ui.deviceId = $('sel-device').value;
  S.audio.micId = $('sel-mic').value; S.effects.camera.deviceId = $('fx-cam-select').value;
}

async function refreshSources() {
  sources = await api.listSources();
  Pipeline.setSources(sources);
  const dsel = $('sel-display'), rsel = $('sel-region-display'), wsel = $('sel-window');
  for (const sel of [dsel, rsel]) {
    sel.innerHTML = '';
    sources.displays.forEach((d) => { const o = document.createElement('option'); o.value = d.id; o.textContent = d.label; sel.appendChild(o); });
  }
  dsel.value = sources.displays.some((d) => d.id === S.ui.displayId) ? S.ui.displayId : (sources.displays[0] || {}).id;
  rsel.value = S.ui.region && sources.displays.some((d) => d.id === S.ui.region.displayId) ? S.ui.region.displayId : dsel.value;
  S.ui.displayId = dsel.value;
  wsel.innerHTML = '';
  const ph = document.createElement('option'); ph.value = ''; ph.textContent = sources.windows.length ? '– Fenster wählen –' : '(keine Fenster gefunden)'; wsel.appendChild(ph);
  sources.windows.forEach((w) => { const o = document.createElement('option'); o.value = w.id; o.textContent = w.label; wsel.appendChild(o); });
  wsel.value = sources.windows.some((w) => w.id === S.ui.windowId) ? S.ui.windowId : '';
  S.ui.windowId = wsel.value;
}

function fillFormats() {
  const sel = $('sel-format'); sel.innerHTML = '';
  const auto = document.createElement('option'); auto.value = 'auto'; auto.textContent = 'Automatisch'; sel.appendChild(auto);
  Pipeline.supportedFormats().forEach((f) => { const o = document.createElement('option'); o.value = f.id; o.textContent = f.label; sel.appendChild(o); });
  sel.value = [...sel.options].some((o) => o.value === S.output.format) ? S.output.format : 'auto';
}

function showSourceUi() {
  $$('.src').forEach((b) => b.classList.toggle('on', b.dataset.source === S.ui.source));
  $$('.opt').forEach((o) => o.classList.toggle('on', o.dataset.for === S.ui.source));
  const r = S.ui.region;
  $('region-info').textContent = r ? `${r.width} × ${r.height} px` : 'noch kein Bereich gewählt';
  $('net-url').value = S.ui.netUrl || '';
}

let reopening = false;
async function reopen() {
  if (Pipeline.isRecording()) return;
  if (reopening) return; reopening = true;
  try {
    say('Quelle wird gestartet …'); status('Quelle wird gestartet …');
    const r = await Pipeline.openSource();
    if (!r.ok) { say(r.error); status('Keine Quelle aktiv'); }
    else { say(''); status('Bereit'); }
    updateInfo();
  } finally { reopening = false; }
}
function updateInfo() {
  const c = Pipeline.canvas;
  const fmt = $('sel-format').selectedOptions[0];
  $('st-info').textContent = Pipeline.hasSource ? `${c.width}×${c.height} · ${S.output.fps} B/s · ${fmt ? fmt.textContent : ''}` : '';
  const hint = $('audio-hint');
  hint.textContent = S.audio.system && PLATFORM !== 'win32' ? 'Systemton wird nur unter Windows aufgenommen.' : (S.audio.system && !Pipeline.hasSystemAudio && Pipeline.hasSource && ['screen', 'window', 'region'].includes(S.ui.source) ? 'Kein Systemton verfügbar.' : '');
}

// ---------- Aufnahme-Ablauf ----------
function setUiRecording(on, paused) {
  $('btn-rec').disabled = on; $('btn-rec').classList.toggle('recording', on);
  $('btn-pause').disabled = !on; $('btn-stop').disabled = !on;
  $('btn-pause').querySelector('.lbl').textContent = paused ? 'Fortsetzen' : 'Pause';
  $('rec-badge').hidden = !on; $('rec-badge').textContent = paused ? '❚❚ PAUSE' : '● REC'; $('rec-badge').classList.toggle('paused', !!paused);
  $('timer').classList.toggle('rec', on && !paused);
  $$('.src, .source-opts select, .source-opts input, .source-opts button, #sel-format').forEach((e) => { e.disabled = on; });
  api.setRecordingState({ recording: on, paused: !!paused });
}

async function countdown(n) {
  const el = $('countdown'); el.hidden = false;
  for (let i = n; i > 0; i--) { el.textContent = i; await new Promise((r) => setTimeout(r, 1000)); if (cancelCountdown) break; }
  el.hidden = true;
}
let cancelCountdown = false, starting = false;

async function startRec(opts = {}) {
  if (Pipeline.isRecording() || starting) return;
  starting = true; cancelCountdown = false;
  try {
    if (!Pipeline.hasSource) { await reopen(); }
    if (!Pipeline.hasSource) { status('Keine Quelle aktiv – Aufnahme nicht möglich'); return; }
    if (S.general.countdown > 0 && !opts.noCountdown) { $('btn-rec').disabled = true; await countdown(S.general.countdown); $('btn-rec').disabled = false; if (cancelCountdown) return; }
    const info = await Pipeline.startRecording({ folder: opts.folder });
    sessionOpts = opts;
    setUiRecording(true, false);
    status('Aufnahme läuft → ' + baseName(info.path));
    $('st-info').textContent = `${info.width}×${info.height} · ${info.fps} B/s · ${info.format.label}`;
    if (opts.stopAfterMs) sessionOpts.stopTimer = setTimeout(() => stopRec(), opts.stopAfterMs);
    if (S.general.minimizeOnRecord) api.windowAction('minimize');
  } catch (e) { status('Fehler: ' + e.message); say(e.message); setUiRecording(false); }
  finally { starting = false; }
}

async function stopRec() {
  if (!Pipeline.isRecording()) { cancelCountdown = true; return; }
  clearTimeout(sessionOpts && sessionOpts.stopTimer);
  status('Aufnahme wird gespeichert …');
  const res = await Pipeline.stopRecording();
  setUiRecording(false);
  api.windowAction('restore');
  $('timer').textContent = '00:00:00'; $('st-size').textContent = '';
  if (res) {
    S.recent = [{ path: res.path, bytes: res.bytes, ms: res.durationMs, at: Date.now() }, ...S.recent.filter((r) => r.path !== res.path)].slice(0, 8);
    save(); renderRecent();
    status(`Gespeichert: ${res.path} (${fmtSize(res.bytes)})`);
    if (S.general.openAfter) api.openPath(res.path);
  }
  const quit = sessionOpts && sessionOpts.quitAfter; sessionOpts = null;
  if (quit) api.quit();
  return res;
}
function togglePause() {
  if (!Pipeline.isRecording()) return;
  if (Pipeline.isPaused()) { Pipeline.resume(); setUiRecording(true, false); status('Aufnahme läuft'); }
  else { Pipeline.pause(); setUiRecording(true, true); status('Pause'); }
}
async function takeShot() {
  if (!Pipeline.hasSource) { status('Keine Quelle aktiv'); return; }
  const p = await api.saveShot({ dataUrl: Pipeline.snapshot(S.output.shotFormat), format: S.output.shotFormat, folder: S.output.shotFolder });
  status('Schnappschuss gespeichert: ' + p);
}

function renderRecent() {
  const ul = $('recent'); ul.innerHTML = '';
  if (!S.recent.length) { const li = document.createElement('li'); li.className = 'muted'; li.textContent = 'Noch keine Aufnahmen.'; ul.appendChild(li); return; }
  S.recent.forEach((r) => {
    const li = document.createElement('li');
    const nm = document.createElement('span'); nm.className = 'nm'; nm.title = r.path; nm.textContent = baseName(r.path);
    const sm = document.createElement('small'); sm.textContent = `${fmtTime(r.ms)} · ${fmtSize(r.bytes)}`;
    const b1 = document.createElement('button'); b1.className = 'small'; b1.textContent = '▶'; b1.title = 'Öffnen'; b1.onclick = () => api.openPath(r.path);
    const b2 = document.createElement('button'); b2.className = 'small'; b2.textContent = '📂'; b2.title = 'Im Ordner zeigen'; b2.onclick = () => api.showItem(r.path);
    const wrap = document.createElement('span'); wrap.className = 'nm'; wrap.append(nm, document.createElement('br'), sm);
    li.append(wrap, b1, b2); ul.appendChild(li);
  });
}

// ---------- Dialoge ----------
function initDialogs() {
  $$('dialog').forEach((d) => {
    $$('[data-close]', d).forEach((b) => b.addEventListener('click', () => d.close()));
    $$('.tabs button', d).forEach((tb) => tb.addEventListener('click', () => {
      $$('.tabs button', d).forEach((x) => x.classList.toggle('on', x === tb));
      $$('.tabpane', d).forEach((p) => p.classList.toggle('on', p.id === tb.dataset.tab));
    }));
  });
  $('btn-effects').onclick = () => { updateFxUi(); $('dlg-effects').showModal(); };
  $('btn-options').onclick = () => { $('op-video-folder').value = S.output.videoFolder; $('op-shot-folder').value = S.output.shotFolder; $('dlg-options').showModal(); };
  $('btn-schedule').onclick = () => { renderSchedule(); $('dlg-schedule').showModal(); };
  $('dlg-options').addEventListener('close', () => api.saveSettings(S));
  $('dlg-effects').addEventListener('close', () => api.saveSettings(S));

  $('fx-color-reset').onclick = () => { Object.assign(S.effects.color, { brightness: 100, contrast: 100, saturate: 100, hue: 0, tintEnabled: false, tintAlpha: 20 }); bindAll($('fx-color')); save(); };
  $('fx-wm-pick').onclick = async () => { const d = await api.pickImage(); if (d) { S.effects.watermark.image = d; S.effects.watermark.enabled = true; updateFxUi(); bindAll($('fx-water')); save(); } };
  $('fx-wm-clear').onclick = () => { S.effects.watermark.image = ''; S.effects.watermark.enabled = false; updateFxUi(); bindAll($('fx-water')); save(); };
  $('fx-cam-select').onchange = (e) => { S.effects.camera.deviceId = e.target.value; save(); Pipeline.syncCamera(); };

  $('op-pick-video').onclick = async () => { const f = await api.pickFolder(S.output.videoFolder); if (f) { S.output.videoFolder = f; $('op-video-folder').value = f; $('out-folder').value = f; save(); } };
  $('op-pick-shot').onclick = async () => { const f = await api.pickFolder(S.output.shotFolder); if (f) { S.output.shotFolder = f; $('op-shot-folder').value = f; save(); } };
  $('about-text').innerHTML = '';
}
function updateFxUi() {
  $('fx-wm-name').textContent = S.effects.watermark.image ? 'Bild geladen' : 'kein Bild';
  $('fx-keys-hint').textContent = KEYHOOK ? 'Tastenanschläge werden systemweit erfasst.' : 'Hinweis: Das Modul für systemweite Tastenerfassung ist nicht verfügbar – es werden nur Tasten in diesem Fenster erfasst.';
}

// ---------- Zeitplan ----------
const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const SRC_LABEL = { current: 'Aktuelle Quelle', screen: 'Bildschirm', webcam: 'Webcam', netcam: 'Netzwerkkamera', device: 'Videogerät' };
let editing = null;
function describeWhen(e) {
  if (e.repeat === 'once') return `${e.date || '?'} ${e.time}`;
  if (e.repeat === 'daily') return `täglich ${e.time}`;
  return `${(e.days || []).map((d) => DAYS[d]).join(', ')} ${e.time}`;
}
function renderSchedule() {
  $('sch-hint').textContent = PLATFORM === 'win32'
    ? 'Einträge werden zusätzlich in der Windows-Aufgabenplanung angelegt: Das Programm startet sich zur Uhrzeit selbst (der Rechner wird dafür geweckt) und nimmt auf.'
    : 'Die Zeitplan-Aufnahme funktioniert, solange das Programm läuft. Der Selbststart über die Aufgabenplanung steht nur unter Windows zur Verfügung.';
  const tb = $('sch-table').querySelector('tbody'); tb.innerHTML = '';
  if (!S.schedules.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 6; td.className = 'muted'; td.textContent = 'Keine Einträge.'; tr.appendChild(td); tb.appendChild(tr); }
  S.schedules.forEach((e) => {
    const tr = document.createElement('tr');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = e.enabled; cb.onchange = () => { e.enabled = cb.checked; persistSchedules(); };
    const td0 = document.createElement('td'); td0.appendChild(cb);
    const cells = [e.name, describeWhen(e), e.durationMin + ' min', SRC_LABEL[e.source] || e.source].map((t) => { const td = document.createElement('td'); td.textContent = t; return td; });
    const act = document.createElement('td');
    const be = document.createElement('button'); be.className = 'small'; be.textContent = 'Bearbeiten'; be.onclick = () => openForm(e);
    const bd = document.createElement('button'); bd.className = 'small'; bd.textContent = 'Löschen'; bd.onclick = () => { S.schedules = S.schedules.filter((x) => x !== e); persistSchedules(); renderSchedule(); };
    act.append(be, ' ', bd);
    tr.append(td0, ...cells, act); tb.appendChild(tr);
  });
}
async function persistSchedules() {
  await api.saveSettings(S);
  const r = await api.syncSchedules(S.schedules);
  if (r && r.errors && r.errors.length) status('Aufgabenplanung: ' + r.errors.join('; '));
}
function openForm(e) {
  editing = e || { id: uid(), name: 'Aufnahme ' + (S.schedules.length + 1), enabled: true, repeat: 'once', date: new Date().toISOString().slice(0, 10), time: '08:00', durationMin: 60, days: [1, 2, 3, 4, 5], source: 'current', folder: '', quitAfter: false, isNew: !e };
  $('sch-form-title').textContent = e ? 'Eintrag bearbeiten' : 'Neuer Eintrag';
  $('sch-name').value = editing.name; $('sch-source').value = editing.source; $('sch-repeat').value = editing.repeat;
  $('sch-date').value = editing.date || ''; $('sch-time').value = editing.time; $('sch-dur').value = editing.durationMin;
  $('sch-folder').value = editing.folder || ''; $('sch-quit').checked = !!editing.quitAfter;
  const dv = $('sch-days'); dv.innerHTML = '';
  DAYS.forEach((n, i) => { const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.value = i; c.checked = (editing.days || []).includes(i); l.append(c, n); dv.appendChild(l); });
  syncRepeatUi(); $('sch-form').hidden = false; $('sch-foot').hidden = true;
}
function syncRepeatUi() { const r = $('sch-repeat').value; $('sch-date-l').hidden = r !== 'once'; $('sch-days').hidden = r !== 'weekly'; }
function initSchedule() {
  $('sch-add').onclick = () => openForm(null);
  $('sch-repeat').onchange = syncRepeatUi;
  $('sch-cancel').onclick = () => { $('sch-form').hidden = true; $('sch-foot').hidden = false; };
  $('sch-pick').onclick = async () => { const f = await api.pickFolder(S.output.videoFolder); if (f) $('sch-folder').value = f; };
  $('sch-folder-clear').onclick = () => { $('sch-folder').value = ''; };
  $('sch-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const e = editing;
    Object.assign(e, {
      name: $('sch-name').value.trim() || 'Aufnahme', source: $('sch-source').value, repeat: $('sch-repeat').value,
      date: $('sch-date').value, time: $('sch-time').value || '08:00', durationMin: Math.max(1, Number($('sch-dur').value) || 60),
      days: $$('input', $('sch-days')).filter((c) => c.checked).map((c) => Number(c.value)), folder: $('sch-folder').value, quitAfter: $('sch-quit').checked
    });
    if (e.repeat === 'once' && !e.date) { alert('Bitte ein Datum wählen.'); return; }
    if (e.repeat === 'weekly' && !e.days.length) { alert('Bitte mindestens einen Wochentag wählen.'); return; }
    if (e.isNew) { delete e.isNew; S.schedules.push(e); }
    $('sch-form').hidden = true; $('sch-foot').hidden = false;
    renderSchedule(); await persistSchedules();
  };
}
async function onScheduleFire(e) {
  if (Pipeline.isRecording()) { status(`Zeitplan „${e.name}“ übersprungen – es läuft schon eine Aufnahme`); return; }
  if (e.source && e.source !== 'current' && S.ui.source !== e.source) {
    S.ui.source = e.source; showSourceUi(); await reopen();
  } else if (!Pipeline.hasSource) await reopen();
  status(`Zeitplan „${e.name}“ startet …`);
  await startRec({ noCountdown: true, folder: e.folder || undefined, stopAfterMs: e.durationMin * 60000, quitAfter: e.quitAfter });
}

// ---------- Menue-Aktionen ----------
async function onMenu(a) {
  if (a === 'record-toggle') { Pipeline.isRecording() ? stopRec() : startRec(); }
  else if (a === 'pause') togglePause();
  else if (a === 'stop') stopRec();
  else if (a === 'shot') takeShot();
  else if (a === 'effects') $('btn-effects').click();
  else if (a === 'options') $('btn-options').click();
  else if (a === 'schedule') $('btn-schedule').click();
  else if (a === 'refresh') { await refreshSources(); reopen(); }
  else if (a === 'open-folder') api.openPath(S.output.videoFolder);
  else if (a === 'stop-and-quit') { await stopRec(); api.quit(); }
  else if (a === 'about') {
    const i = await api.appInfo();
    $('about-text').textContent = `Version ${i.version} · Electron ${i.electron} · Chromium ${i.chrome} · ${i.platform}. Bildschirm-, Fenster-, Bereichs- und Kameraaufnahme mit Audio, Effekten und Zeitplan.`;
    $('dlg-about').showModal();
  }
}

// ---------- Start ----------
async function boot() {
  const init = await api.loadSettings();
  S = init.settings; PLATFORM = init.platform;
  const info = await api.appInfo(); KEYHOOK = info.keyHook;
  Pipeline.init(() => S, {
    onError: (m) => status(m),
    onSize: (b) => { $('st-size').textContent = fmtSize(b); },
    onSourceLost: () => { say('Die Quelle wurde beendet.'); if (Pipeline.isRecording()) stopRec(); }
  });
  initDialogs(); initSchedule();
  fillFormats(); bindAll(); $('out-folder').value = S.output.videoFolder;
  const devicesReady = enumerate().then(() => bindAll());
  await refreshSources();
  showSourceUi(); renderRecent();
  // Bildschirmquellen brauchen die Geraeteliste nicht: sofort starten
  if (['screen', 'window', 'region'].includes(S.ui.source)) reopen();

  $$('.src').forEach((b) => b.onclick = () => { if (Pipeline.isRecording()) return; S.ui.source = b.dataset.source; showSourceUi(); save(); reopen(); });
  $('sel-display').onchange = (e) => { S.ui.displayId = e.target.value; save(); reopen(); };
  $('sel-window').onchange = (e) => { S.ui.windowId = e.target.value; save(); reopen(); };
  $('btn-refresh-win').onclick = async () => { await refreshSources(); };
  $('sel-cam').onchange = (e) => { S.ui.cameraId = e.target.value; save(); reopen(); };
  $('sel-device').onchange = (e) => { S.ui.deviceId = e.target.value; save(); reopen(); };
  $('sel-mic').onchange = (e) => { S.audio.micId = e.target.value; save(); Pipeline.syncMic(); };
  $('sel-region-display').onchange = () => { S.ui.region = null; showSourceUi(); save(); };
  $('btn-region').onclick = async () => {
    const r = await api.selectRegion($('sel-region-display').value);
    if (r) { S.ui.region = r; S.ui.displayId = r.displayId; save(); showSourceUi(); reopen(); }
  };
  $('btn-net-go').onclick = () => { S.ui.netUrl = $('net-url').value.trim(); save(); reopen(); };
  $('net-url').onkeydown = (e) => { if (e.key === 'Enter') $('btn-net-go').click(); };
  $('btn-folder').onclick = async () => { const f = await api.pickFolder(S.output.videoFolder); if (f) { S.output.videoFolder = f; $('out-folder').value = f; save(); } };
  $('btn-rec').onclick = () => startRec();
  $('btn-pause').onclick = togglePause;
  $('btn-stop').onclick = stopRec;
  $('btn-shot').onclick = takeShot;

  api.onMenu(onMenu);
  api.onScheduleFire(onScheduleFire);
  api.onKeys((ev) => { if (S.effects.keys.enabled) Fx.keyEvent(ev); });
  window.addEventListener('keydown', (e) => { if (S.effects.keys.enabled && !KEYHOOK && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) Fx.keyEvent({ type: 'down', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }); });
  if (S.effects.keys.enabled) api.setKeyHook(true);

  setInterval(() => {
    if (Pipeline.isRecording()) $('timer').textContent = fmtTime(Pipeline.elapsedMs());
    $('meter-bar').style.width = Math.round(Pipeline.level() * 100) + '%';
    const c = Pipeline.canvas, dim = c.width + 'x' + c.height;
    if (!Pipeline.isRecording() && dim !== lastDim) { lastDim = dim; updateInfo(); }
  }, 120);

  await devicesReady;
  await Pipeline.syncMic(); await Pipeline.syncCamera();
  if (!['screen', 'window', 'region'].includes(S.ui.source)) await reopen();
  api.syncSchedules(S.schedules);
  api.ready();
}
boot().catch((e) => { document.getElementById('stage-msg').textContent = 'Startfehler: ' + e.message; console.error(e); });
