'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (cb) => { const f = (_e, ...a) => cb(...a); ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  loadSettings: inv('settings:load'),
  saveSettings: inv('settings:save'),
  listSources: inv('sources:list'),
  selectCapture: inv('capture:select'),
  pickFolder: inv('dialog:folder'),
  pickImage: inv('dialog:image'),
  selectRegion: inv('region:select'),
  recOpen: inv('rec:open'),
  recWrite: inv('rec:write'),
  recClose: inv('rec:close'),
  saveShot: inv('shot:save'),
  showItem: inv('shell:show'),
  openPath: inv('shell:open'),
  syncSchedules: inv('schedule:sync'),
  setRecordingState: inv('app:recstate'),
  setKeyHook: inv('keys:enable'),
  windowAction: inv('window:action'),
  appInfo: inv('app:info'),
  quit: inv('app:quit'),
  ready: () => ipcRenderer.send('renderer:ready'),
  onMenu: on('menu'),
  onScheduleFire: on('schedule:fire'),
  onKeys: on('keys:event')
});
