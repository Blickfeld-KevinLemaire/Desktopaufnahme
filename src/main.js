'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const {
  app, BrowserWindow, ipcMain, dialog, desktopCapturer, screen, session, Tray, Menu,
  nativeImage, shell, protocol, net, globalShortcut
} = require('electron');
const DEFAULTS = require('./defaults');

if (process.env.DA_USER_DATA) app.setPath('userData', process.env.DA_USER_DATA);

protocol.registerSchemesAsPrivileged([{
  scheme: 'netcam',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'einstellungen.json');

let win = null, tray = null, regionWin = null, regionResolve = null;
let settings = null;
let pendingCapture = { sourceId: '', audio: false };
let recording = false, paused = false, quitting = false;
let rendererReady = false;
const pendingFires = [];
const fired = new Set();
const recs = new Map();
let recSeq = 0;
let uio = null;

// ---------- Einstellungen ----------
function merge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = {};
  for (const k of Object.keys(base)) out[k] = merge(base[k], extra && typeof extra === 'object' ? extra[k] : undefined);
  if (extra && typeof extra === 'object') for (const k of Object.keys(extra)) if (!(k in out)) out[k] = extra[k];
  return out;
}
function defaultsWithPaths() {
  const d = JSON.parse(JSON.stringify(DEFAULTS));
  d.output.videoFolder = path.join(app.getPath('videos'), 'Desktopaufnahme');
  d.output.shotFolder = path.join(app.getPath('pictures'), 'Desktopaufnahme');
  return d;
}
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')); } catch { /* erster Start */ }
  settings = merge(defaultsWithPaths(), saved);
  return settings;
}
function saveSettings(s) {
  settings = s;
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2));
  registerHotkeys();
  try { app.setLoginItemSettings({ openAtLogin: !!s.general.autostart, args: ['--hidden'] }); } catch { /* ignorieren */ }
}

// ---------- Fenster, Menue, Tray ----------
function send(ch, ...a) { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); }

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 980, minHeight: 640,
    title: 'Desktopaufnahme', icon: ICON, backgroundColor: '#f0f0f0',
    show: !process.argv.includes('--hidden'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (quitting) return;
    if (recording) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['Aufnahme beenden und schließen', 'Weiter aufnehmen'], defaultId: 1, cancelId: 1,
        title: 'Aufnahme läuft', message: 'Es läuft noch eine Aufnahme.', detail: 'Soll sie beendet und gespeichert werden?'
      });
      if (r === 1) { e.preventDefault(); return; }
      e.preventDefault();
      send('menu', 'stop-and-quit');
      return;
    }
    if (settings && settings.general.trayOnClose && tray) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
  buildMenu();
}

function buildMenu() {
  const m = (label, action, accelerator) => ({ label, accelerator, click: () => send('menu', action) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '&Datei', submenu: [
      m('Aufnahme starten / stoppen', 'record-toggle'),
      m('Schnappschuss', 'shot'),
      { type: 'separator' },
      m('Aufnahmeordner öffnen', 'open-folder'),
      { type: 'separator' },
      { label: 'Beenden', click: () => { quitting = true; app.quit(); } }
    ] },
    { label: '&Aufnahme', submenu: [
      m('Start / Stopp', 'record-toggle'), m('Pause / Fortsetzen', 'pause'), m('Stopp', 'stop'),
      { type: 'separator' }, m('Quellen aktualisieren', 'refresh')
    ] },
    { label: '&Werkzeuge', submenu: [m('Effekte …', 'effects'), m('Zeitplan …', 'schedule')] },
    { label: '&Optionen', submenu: [m('Einstellungen …', 'options')] },
    { label: '&Hilfe', submenu: [m('Über Desktopaufnahme', 'about')] }
  ]));
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('Desktopaufnahme');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Öffnen', click: () => { win && (win.show(), win.restore(), win.focus()); } },
      { label: 'Aufnahme starten / stoppen', click: () => send('menu', 'record-toggle') },
      { type: 'separator' },
      { label: 'Beenden', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => { win && (win.show(), win.restore(), win.focus()); });
  } catch { tray = null; }
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  if (!settings) return;
  const map = { record: 'record-toggle', pause: 'pause', shot: 'shot' };
  for (const k of Object.keys(map)) {
    const acc = settings.hotkeys && settings.hotkeys[k];
    if (!acc) continue;
    try { globalShortcut.register(acc, () => send('menu', map[k])); } catch { /* ungueltiges Kuerzel */ }
  }
}

// ---------- Netzwerkkamera-Proxy (MJPEG/HTTP) ----------
function registerNetcam() {
  protocol.handle('netcam', async (req) => {
    try {
      const target = new URL(req.url).searchParams.get('u');
      const u = new URL(target);
      if (!/^https?:$/.test(u.protocol)) return new Response('Nur http/https', { status: 400 });
      const headers = {};
      if (u.username) {
        headers.Authorization = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64');
        u.username = ''; u.password = '';
      }
      const r = await net.fetch(u.toString(), { headers });
      return new Response(r.body, {
        status: r.status,
        headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'access-control-allow-origin': '*' }
      });
    } catch (e) {
      return new Response(String(e && e.message), { status: 502 });
    }
  });
}

// ---------- IPC ----------
function uniquePath(folder, base, ext) {
  fs.mkdirSync(folder, { recursive: true });
  let p = path.join(folder, base + '.' + ext), n = 1;
  while (fs.existsSync(p)) p = path.join(folder, `${base}_${++n}.${ext}`);
  return p;
}
const pad = (n) => String(n).padStart(2, '0');
function fileBase(pattern) {
  const d = new Date();
  const datum = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const zeit = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return (pattern || 'Aufnahme_{datum}_{zeit}').replace(/\{datum\}/g, datum).replace(/\{zeit\}/g, zeit)
    .replace(/[<>:"/\\|?*]/g, '_');
}

function setupIpc() {
  ipcMain.handle('settings:load', () => ({ settings: loadSettings(), platform: process.platform }));
  ipcMain.handle('settings:save', (_e, s) => { saveSettings(s); return true; });

  ipcMain.handle('app:info', () => ({
    name: app.getName(), version: app.getVersion(), electron: process.versions.electron,
    chrome: process.versions.chrome, platform: process.platform, keyHook: !!uio
  }));
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('app:recstate', (_e, st) => {
    recording = !!st.recording; paused = !!st.paused;
    if (win) win.setTitle(recording ? (paused ? 'Desktopaufnahme – Pause' : 'Desktopaufnahme – ● Aufnahme') : 'Desktopaufnahme');
    if (tray) tray.setToolTip(recording ? 'Desktopaufnahme – Aufnahme läuft' : 'Desktopaufnahme');
    return true;
  });
  ipcMain.handle('window:action', (_e, a) => {
    if (!win) return;
    if (a === 'minimize') win.minimize();
    if (a === 'restore') { win.show(); win.restore(); win.focus(); }
  });

  ipcMain.handle('sources:list', async () => {
    const thumb = { width: 240, height: 150 };
    const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: thumb, fetchWindowIcons: false });
    const screens = srcs.filter((s) => s.id.startsWith('screen:'));
    const primary = screen.getPrimaryDisplay().id;
    const displays = screen.getAllDisplays().map((d, i) => {
      const src = screens.find((s) => s.display_id === String(d.id)) || screens[i];
      return {
        id: String(d.id), sourceId: src ? src.id : '',
        label: `Bildschirm ${i + 1} (${d.size.width}×${d.size.height})${d.id === primary ? ' – Hauptbildschirm' : ''}`,
        bounds: d.bounds, scaleFactor: d.scaleFactor, thumb: src ? src.thumbnail.toDataURL() : ''
      };
    });
    const windows = srcs.filter((s) => s.id.startsWith('window:') && s.name && s.name !== 'Desktopaufnahme')
      .map((s) => ({ id: s.id, label: s.name, thumb: s.thumbnail.toDataURL() }));
    return { displays, windows };
  });

  ipcMain.handle('capture:select', (_e, c) => { pendingCapture = { sourceId: c.sourceId || '', audio: !!c.audio }; return true; });

  ipcMain.handle('dialog:folder', async (_e, cur) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: cur || undefined });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:image', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
    if (r.canceled) return null;
    const f = r.filePaths[0];
    const ext = path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext};base64,` + fs.readFileSync(f).toString('base64');
  });

  ipcMain.handle('region:select', (_e, displayId) => selectRegion(displayId));
  ipcMain.on('region:done', (_e, rect) => {
    if (regionWin && !regionWin.isDestroyed()) regionWin.close();
    const r = regionResolve; regionResolve = null;
    if (r) r(rect);
  });

  ipcMain.handle('rec:open', (_e, o) => {
    const folder = (o.folder || settings.output.videoFolder);
    const p = uniquePath(folder, fileBase(o.pattern || settings.output.namePattern), o.ext);
    const id = ++recSeq;
    recs.set(id, { stream: fs.createWriteStream(p), path: p, bytes: 0 });
    return { id, path: p };
  });
  ipcMain.handle('rec:write', (_e, id, data) => new Promise((resolve, reject) => {
    const r = recs.get(id);
    if (!r) return reject(new Error('Unbekannte Aufnahme'));
    const buf = Buffer.from(data);
    r.stream.write(buf, (err) => { if (err) reject(err); else { r.bytes += buf.length; resolve(r.bytes); } });
  }));
  ipcMain.handle('rec:close', (_e, id) => new Promise((resolve) => {
    const r = recs.get(id);
    if (!r) return resolve(null);
    recs.delete(id);
    r.stream.end(() => resolve({ path: r.path, bytes: r.bytes }));
  }));
  ipcMain.handle('shot:save', (_e, o) => {
    const ext = o.format === 'jpg' ? 'jpg' : 'png';
    const p = uniquePath(o.folder || settings.output.shotFolder, 'Schnappschuss_' + fileBase('{datum}_{zeit}'), ext);
    fs.writeFileSync(p, Buffer.from(o.dataUrl.split(',')[1], 'base64'));
    return p;
  });
  ipcMain.handle('shell:show', (_e, p) => { shell.showItemInFolder(p); return true; });
  ipcMain.handle('shell:open', async (_e, p) => (await shell.openPath(p)) || true);

  ipcMain.handle('schedule:sync', async (_e, list) => { settings.schedules = list; return syncWindowsTasks(list); });
  ipcMain.handle('keys:enable', (_e, on) => setKeyHook(!!on));
  ipcMain.on('renderer:ready', () => {
    rendererReady = true;
    while (pendingFires.length) send('schedule:fire', pendingFires.shift());
  });
}

// ---------- Bereichsauswahl ----------
function selectRegion(displayId) {
  return new Promise((resolve) => {
    const disp = screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
    const wasVisible = win && win.isVisible() && !win.isMinimized();
    if (wasVisible) win.minimize();
    regionResolve = (rect) => {
      if (wasVisible && win) { win.restore(); win.focus(); }
      resolve(rect ? { displayId: String(disp.id), ...rect } : null);
    };
    setTimeout(() => {
      regionWin = new BrowserWindow({
        x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height,
        frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false,
        movable: false, fullscreenable: false, hasShadow: false, show: false,
        webPreferences: { preload: path.join(__dirname, 'region-preload.js'), contextIsolation: true, sandbox: true }
      });
      regionWin.setAlwaysOnTop(true, 'screen-saver');
      regionWin.once('ready-to-show', () => { regionWin.show(); regionWin.focus(); });
      regionWin.on('closed', () => { regionWin = null; if (regionResolve) { const r = regionResolve; regionResolve = null; r(null); } });
      regionWin.loadFile(path.join(__dirname, 'region.html'));
    }, wasVisible ? 400 : 0);
  });
}

// ---------- Globale Tastenanschlaege (optional, uiohook-napi) ----------
function setKeyHook(on) {
  try {
    if (!uio) {
      const mod = require('uiohook-napi');
      const names = {};
      for (const [k, v] of Object.entries(mod.UiohookKey)) names[v] = k;
      uio = { hook: mod.uIOhook, names, started: false };
      uio.hook.on('keydown', (e) => send('keys:event', { type: 'down', key: uio.names[e.keycode] || String(e.keycode), ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }));
      uio.hook.on('keyup', (e) => send('keys:event', { type: 'up', key: uio.names[e.keycode] || String(e.keycode) }));
    }
    if (on && !uio.started) { uio.hook.start(); uio.started = true; }
    if (!on && uio.started) { uio.hook.stop(); uio.started = false; }
    return true;
  } catch { uio = null; return false; }
}

// ---------- Zeitplan ----------
function fireSchedule(entry, key) {
  if (key) { if (fired.has(key)) return; fired.add(key); if (fired.size > 200) fired.clear(); }
  if (rendererReady) send('schedule:fire', entry); else pendingFires.push(entry);
  if (win && !win.isDestroyed() && !win.isVisible()) win.show();
}
function schedulerTick() {
  if (!settings) return;
  const now = new Date();
  const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  for (const e of settings.schedules || []) {
    if (!e.enabled || e.time !== hm) continue;
    const ok = e.repeat === 'daily' || (e.repeat === 'weekly' && (e.days || []).includes(now.getDay())) || (e.repeat === 'once' && e.date === day);
    if (ok) fireSchedule(e, `${e.id}@${day}T${hm}`);
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function taskXml(e) {
  const today = new Date();
  const base = e.repeat === 'once' && e.date ? e.date : `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const start = `${base}T${e.time}:00`;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let trig;
  if (e.repeat === 'once') trig = `<TimeTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled></TimeTrigger>`;
  else if (e.repeat === 'weekly') {
    const ds = (e.days && e.days.length ? e.days : [1]).map((d) => `<${dayNames[d]}/>`).join('');
    trig = `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek>${ds}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>`;
  } else trig = `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>${trig}</Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>false</StartWhenAvailable><WakeToRun>true</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>${esc(process.execPath)}</Command><Arguments>--zeitplan=${esc(e.id)}</Arguments></Exec></Actions>
</Task>`;
}
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { windowsHide: true }, (err, out, errOut) => res({ err, out, errOut })));

// Legt je Zeitplan-Eintrag einen Windows-Aufgabenplanungs-Task an, damit sich das Programm
// zur gewuenschten Uhrzeit selbst startet (auch wenn es nicht laeuft; weckt den Rechner).
async function syncWindowsTasks(list) {
  if (process.platform !== 'win32') return { ok: true, skipped: true, note: 'Selbststart nur unter Windows' };
  const q = await run('schtasks', ['/Query', '/FO', 'CSV', '/NH']);
  const old = (q.out || '').split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, '')).filter((n) => /^\\?Desktopaufnahme_/.test(n));
  for (const n of old) await run('schtasks', ['/Delete', '/TN', n.replace(/^\\/, ''), '/F']);
  const errors = [];
  for (const e of list.filter((x) => x.enabled)) {
    const f = path.join(os.tmpdir(), `da_task_${e.id}.xml`);
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(e), 'utf16le')]));
    const r = await run('schtasks', ['/Create', '/TN', `Desktopaufnahme_${e.id}`, '/XML', f, '/F']);
    try { fs.unlinkSync(f); } catch { /* ignorieren */ }
    if (r.err) errors.push(`${e.name}: ${(r.errOut || r.err.message).trim()}`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------- Start ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (win) { win.show(); if (win.isMinimized()) win.restore(); }
    handleArgs(argv);
  });
  app.whenReady().then(() => {
    loadSettings();
    registerNetcam();
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'display-capture', 'mediaKeySystem'].includes(perm)));
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const srcs = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const s = srcs.find((x) => x.id === pendingCapture.sourceId) || srcs.find((x) => x.id.startsWith('screen:'));
        const resp = { video: s };
        if (pendingCapture.audio && process.platform === 'win32') resp.audio = 'loopback';
        callback(resp);
      } catch { callback({}); }
    }, { useSystemPicker: false });
    setupIpc();
    createWindow();
    createTray();
    registerHotkeys();
    setInterval(schedulerTick, 10000);
    handleArgs(process.argv);
  });
  app.on('window-all-closed', () => { if (quitting || !tray || !settings.general.trayOnClose) app.quit(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); if (uio && uio.started) try { uio.hook.stop(); } catch { /* ignorieren */ } });
}
function handleArgs(argv) {
  const a = argv.find((x) => x.startsWith('--zeitplan='));
  if (!a) return;
  const id = a.split('=')[1];
  const e = (settings.schedules || []).find((s) => s.id === id);
  if (e) {
    const n = new Date();
    fireSchedule(e, `${e.id}@${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`);
  }
}
