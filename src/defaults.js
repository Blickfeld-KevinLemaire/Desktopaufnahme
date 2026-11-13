'use strict';
// Standard-Einstellungen. Werden beim Laden mit den gespeicherten Werten zusammengefuehrt.
module.exports = {
  ui: { source: 'screen', displayId: '', windowId: '', cameraId: '', deviceId: '', netUrl: '', region: null },
  audio: { system: true, mic: false, micId: '', sysGain: 100, micGain: 100 },
  output: {
    format: 'auto', quality: 'medium', fps: 30, scale: 100, cursor: true,
    videoFolder: '', shotFolder: '', shotFormat: 'png',
    namePattern: 'Aufnahme_{datum}_{zeit}'
  },
  general: { minimizeOnRecord: true, countdown: 3, autostart: false, trayOnClose: false, openAfter: false },
  hotkeys: {
    record: 'CommandOrControl+Shift+R',
    pause: 'CommandOrControl+Shift+P',
    shot: 'CommandOrControl+Shift+S'
  },
  effects: {
    camera: { enabled: false, deviceId: '', position: 'br', size: 25, shape: 'rect', mirror: true, border: true },
    text: { enabled: false, text: '{datum} {zeit}', position: 'bl', size: 28, color: '#ffffff', bg: '#000000', bgAlpha: 50 },
    color: { brightness: 100, contrast: 100, saturate: 100, hue: 0, tintEnabled: false, tint: '#ff8800', tintAlpha: 20 },
    filter: { type: 'none', amount: 100 },
    mirror: { h: false, v: false },
    watermark: { enabled: false, image: '', position: 'tr', size: 15, opacity: 80 },
    keys: { enabled: false, position: 'bc', size: 30, color: '#ffffff', bg: '#202020', hold: 2 },
    chroma: { enabled: false, target: 'camera', color: '#00ff00', tolerance: 40, softness: 15, bg: '#000000' }
  },
  schedules: [],
  recent: []
};
