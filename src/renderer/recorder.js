'use strict';
// Aufnahme-Pipeline: Quelle -> Canvas (mit Effekten) -> MediaRecorder -> Datei (per IPC)
const Pipeline = (() => {
  const canvas = document.getElementById('preview');
  const ctx = canvas.getContext('2d', { alpha: false });
  const vid = document.createElement('video'); vid.muted = true; vid.playsInline = true;
  const camVid = document.createElement('video'); camVid.muted = true; camVid.playsInline = true;
  const netImg = new Image(); netImg.crossOrigin = 'anonymous';
  const wmImg = new Image();
  let wmSrc = '';

  let getS = null, hooks = {};
  let stream = null, camStream = null, micStream = null, camKey = '', micKey = '';
  let mode = null;                 // 'video' | 'img' | null
  let loop = null, loopFps = 0;
  let sources = { displays: [], windows: [] };
  let sysTracksKey = '';

  // ---- Audio ----
  let actx = null, mix = null, dest = null, analyser = null, sysGain = null, micGain = null, sysNode = null, micNode = null;
  const meterBuf = new Uint8Array(1024);
  function ensureAudio() {
    if (actx) return;
    actx = new AudioContext();
    mix = actx.createGain(); dest = actx.createMediaStreamDestination();
    analyser = actx.createAnalyser(); analyser.fftSize = 1024;
    sysGain = actx.createGain(); micGain = actx.createGain();
    sysGain.connect(mix); micGain.connect(mix); mix.connect(dest); mix.connect(analyser);
  }
  function syncGains() {
    if (!actx) return;
    const a = getS().audio;
    sysGain.gain.value = a.sysGain / 100; micGain.gain.value = a.micGain / 100;
  }
  function level() {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(meterBuf);
    let peak = 0;
    for (let i = 0; i < meterBuf.length; i++) peak = Math.max(peak, Math.abs(meterBuf[i] - 128));
    return Math.min(1, peak / 100);
  }
  function connectSystem() {
    if (sysNode) { try { sysNode.disconnect(); } catch { /* */ } sysNode = null; }
    const tracks = stream ? stream.getAudioTracks() : [];
    if (getS().audio.system && tracks.length) {
      ensureAudio();
      sysNode = actx.createMediaStreamSource(new MediaStream(tracks));
      sysNode.connect(sysGain);
    }
    syncGains();
  }
  async function syncMic() {
    const a = getS().audio;
    const key = a.mic ? 'on:' + a.micId : '';
    if (key === micKey) return;
    micKey = key;
    if (micNode) { try { micNode.disconnect(); } catch { /* */ } micNode = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (!a.mic) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: a.micId ? { exact: a.micId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      ensureAudio(); await actx.resume();
      micNode = actx.createMediaStreamSource(micStream); micNode.connect(micGain);
      syncGains();
    } catch (e) { micKey = ''; hooks.onError && hooks.onError('Mikrofon: ' + (e.message || e.name)); }
  }

  // ---- Kamera-Ueberlagerung ----
  async function syncCamera() {
    const c = getS().effects.camera;
    const key = c.enabled ? 'on:' + c.deviceId : '';
    if (key === camKey) return;
    camKey = key;
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; camVid.srcObject = null; }
    if (!c.enabled) return;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: c.deviceId ? { exact: c.deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } });
      camVid.srcObject = camStream; await camVid.play();
    } catch (e) { camKey = ''; hooks.onError && hooks.onError('Kamera-Überlagerung: ' + (e.message || e.name)); }
  }

  // ---- Quelle oeffnen ----
  function stopSource() {
    if (stream) { stream.getTracks().forEach((t) => { t.onended = null; t.stop(); }); stream = null; }
    vid.srcObject = null; netImg.removeAttribute('src');
    mode = null; sysTracksKey = '';
    if (sysNode) { try { sysNode.disconnect(); } catch { /* */ } sysNode = null; }
  }
  function displaySourceId(displayId) {
    const d = sources.displays.find((x) => x.id === displayId) || sources.displays[0];
    return d ? d.sourceId : '';
  }
  async function getDisplay(sourceId) {
    const s = getS();
    await api.selectCapture({ sourceId, audio: s.audio.system });
    const video = { frameRate: s.output.fps, cursor: s.output.cursor ? 'always' : 'never' };
    try { return await navigator.mediaDevices.getDisplayMedia({ video, audio: s.audio.system }); }
    catch { return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: s.output.fps }, audio: s.audio.system }); }
  }
  async function openSource() {
    stopSource();
    const s = getS(), u = s.ui;
    let info = '';
    try {
      if (u.source === 'screen') stream = await getDisplay(displaySourceId(u.displayId));
      else if (u.source === 'window') {
        if (!u.windowId) throw new Error('Bitte ein Fenster auswählen.');
        stream = await getDisplay(u.windowId);
      } else if (u.source === 'region') {
        if (!u.region) throw new Error('Bitte zuerst einen Bereich wählen.');
        stream = await getDisplay(displaySourceId(u.region.displayId));
      } else if (u.source === 'webcam' || u.source === 'device') {
        const id = u.source === 'webcam' ? u.cameraId : u.deviceId;
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: s.output.fps } } });
      } else if (u.source === 'netcam') {
        if (!/^https?:\/\//i.test(u.netUrl)) throw new Error('Bitte eine http(s)-Adresse der Kamera eintragen.');
        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('Keine Antwort von der Netzwerkkamera.')), 10000);
          netImg.onload = () => { clearTimeout(t); res(); };
          netImg.onerror = () => { clearTimeout(t); rej(new Error('Netzwerkkamera nicht erreichbar oder kein MJPEG/Bild-Stream.')); };
          netImg.src = 'netcam://stream/?u=' + encodeURIComponent(u.netUrl) + '&_=' + Date.now();
        });
        mode = 'img';
      }
      if (stream) {
        vid.srcObject = stream; await vid.play(); mode = 'video';
        const vt = stream.getVideoTracks()[0];
        if (vt) vt.onended = () => { stopSource(); hooks.onSourceLost && hooks.onSourceLost(); };
        connectSystem();
      }
      return { ok: true };
    } catch (e) {
      stopSource();
      return { ok: false, error: e.message || String(e) };
    }
  }

  // ---- Zeichnen ----
  function srcRect() {
    const u = getS().ui;
    if (mode === 'img') return netImg.naturalWidth ? { el: netImg, sx: 0, sy: 0, sw: netImg.naturalWidth, sh: netImg.naturalHeight, camera: true } : null;
    if (mode !== 'video' || !vid.videoWidth) return null;
    const vw = vid.videoWidth, vh = vid.videoHeight;
    if (u.source === 'region' && u.region) {
      const r = u.region, k = vw / r.displayWidth;
      const sx = Math.max(0, Math.round(r.x * k)), sy = Math.max(0, Math.round(r.y * k));
      return { el: vid, sx, sy, sw: Math.min(vw - sx, Math.round(r.width * k)), sh: Math.min(vh - sy, Math.round(r.height * k)) };
    }
    return { el: vid, sx: 0, sy: 0, sw: vw, sh: vh, camera: u.source === 'webcam' || u.source === 'device' };
  }
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  let recording = false;

  function draw() {
    const s = getS(), e = s.effects;
    const r = srcRect();
    if (!r) {
      if (!recording) { if (canvas.width !== 1280) { canvas.width = 1280; canvas.height = 720; } }
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const k = s.output.scale / 100;
    if (!recording) {
      const w = even(r.sw * k), h = even(r.sh * k);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
    const W = canvas.width, H = canvas.height;
    // Einpassen (falls sich die Quellgroesse waehrend der Aufnahme aendert: Letterbox)
    const fit = Math.min(W / r.sw, H / r.sh);
    const dw = Math.round(r.sw * fit), dh = Math.round(r.sh * fit);
    const dx = Math.round((W - dw) / 2), dy = Math.round((H - dh) / 2);
    const keySource = e.chroma.enabled && e.chroma.target === 'source' && r.camera;
    ctx.fillStyle = keySource ? e.chroma.bg : '#000';
    ctx.fillRect(0, 0, W, H);
    let el = r.el, sx = r.sx, sy = r.sy, sw = r.sw, sh = r.sh;
    if (keySource) { const cw = Math.min(sw, 640), chh = Math.round(cw * sh / sw); el = Fx.chroma(r.el, cw, chh, e.chroma); sx = 0; sy = 0; sw = cw; sh = chh; }
    Fx.drawSource(ctx, el, sx, sy, sw, sh, dx, dy, dw, dh, e);
    if (e.camera.enabled) Fx.drawCamera(ctx, W, H, e, camVid);
    if (e.watermark.enabled && e.watermark.image) {
      if (wmSrc !== e.watermark.image) { wmSrc = e.watermark.image; wmImg.src = wmSrc; }
      Fx.drawWatermark(ctx, W, H, e, wmImg);
    }
    if (e.text.enabled) Fx.drawText(ctx, W, H, e);
    if (e.keys.enabled) Fx.drawKeys(ctx, W, H, e);
  }

  function ensureLoop() {
    const fps = recording ? recFps : getS().output.fps;
    if (loop && fps === loopFps) return;
    if (loop) clearInterval(loop);
    loopFps = fps;
    loop = setInterval(draw, Math.round(1000 / fps));
  }

  // ---- Aufnahme ----
  // Bewusst ohne generisches 'video/mp4' (liefert je nach System VP9 statt H.264).
  const FORMATS = [
    { id: 'mp4', ext: 'mp4', mimes: [
      ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'MP4 (H.264 + AAC)'], ['video/mp4;codecs=avc1,mp4a.40.2', 'MP4 (H.264 + AAC)'],
      ['video/mp4;codecs=avc1.640028,opus', 'MP4 (H.264 + Opus)'], ['video/mp4;codecs=avc1,opus', 'MP4 (H.264 + Opus)'], ['video/mp4;codecs=avc1', 'MP4 (H.264)']] },
    { id: 'webm-vp9', ext: 'webm', mimes: [['video/webm;codecs=vp9,opus', 'WebM (VP9 + Opus)']] },
    { id: 'webm-vp8', ext: 'webm', mimes: [['video/webm;codecs=vp8,opus', 'WebM (VP8 + Opus)']] }
  ];
  function supportedFormats() {
    const out = [];
    for (const f of FORMATS) {
      const hit = f.mimes.find(([m]) => MediaRecorder.isTypeSupported(m));
      if (hit) out.push({ id: f.id, ext: f.ext, mime: hit[0], label: hit[1] });
    }
    return out;
  }
  function pickFormat(id) {
    const list = supportedFormats();
    return list.find((f) => f.id === id) || list[0];
  }
  const BITRATE = { low: 1.5e6, medium: 4e6, high: 8e6, ultra: 16e6 };

  let mr = null, rec = null, recFps = 30, chain = Promise.resolve(), startedAt = 0, accMs = 0, pausedAt = 0;

  async function startRecording(opts = {}) {
    if (recording) throw new Error('Es läuft bereits eine Aufnahme.');
    const s = getS();
    if (!srcRect()) throw new Error('Keine Bildquelle aktiv.');
    draw();   // Canvas-Groesse an die Quelle anpassen, bevor sie fuer die Aufnahme fixiert wird
    const fmt = pickFormat(s.output.format);
    if (!fmt) throw new Error('Dieser Rechner unterstützt keinen Aufnahmeformat-Encoder.');
    await syncMic();
    recFps = s.output.fps;
    const out = await api.recOpen({ ext: fmt.ext, folder: opts.folder || s.output.videoFolder, pattern: s.output.namePattern });
    rec = { id: out.id, path: out.path, fmt };
    const vstream = canvas.captureStream(recFps);
    const tracks = [...vstream.getVideoTracks()];
    const wantAudio = (s.audio.system && stream && stream.getAudioTracks().length) || (s.audio.mic && micStream);
    if (wantAudio) { ensureAudio(); await actx.resume(); tracks.push(...dest.stream.getAudioTracks()); }
    mr = new MediaRecorder(new MediaStream(tracks), { mimeType: fmt.mime, videoBitsPerSecond: BITRATE[s.output.quality] || 4e6, audioBitsPerSecond: 192000 });
    chain = Promise.resolve();
    mr.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      chain = chain.then(async () => {
        try { const bytes = await api.recWrite(rec.id, await ev.data.arrayBuffer()); hooks.onSize && hooks.onSize(bytes); }
        catch (err) { hooks.onError && hooks.onError('Schreiben fehlgeschlagen: ' + err.message); }
      });
    };
    recording = true; ensureLoop();
    mr.start(1000);
    startedAt = performance.now(); accMs = 0; pausedAt = 0;
    return { path: out.path, format: fmt, width: canvas.width, height: canvas.height, fps: recFps };
  }
  function pause() { if (mr && mr.state === 'recording') { mr.pause(); pausedAt = performance.now(); accMs += pausedAt - startedAt; } }
  function resume() { if (mr && mr.state === 'paused') { mr.resume(); startedAt = performance.now(); pausedAt = 0; } }
  function elapsedMs() { if (!recording) return 0; return accMs + (pausedAt ? 0 : performance.now() - startedAt); }
  const isPaused = () => !!mr && mr.state === 'paused';
  const isRecording = () => recording;

  function stopRecording() {
    return new Promise((resolve) => {
      if (!mr) return resolve(null);
      const ms = elapsedMs();
      const m = mr, r = rec;
      m.onstop = async () => {
        await chain;
        const res = await api.recClose(r.id);
        recording = false; mr = null; rec = null; ensureLoop();
        resolve({ ...res, durationMs: ms, format: r.fmt });
      };
      if (m.state !== 'inactive') m.stop(); else m.onstop();
    });
  }

  function snapshot(format) {
    const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
    draw();
    return canvas.toDataURL(type, 0.92);
  }

  return {
    init(getSettings, h) { getS = getSettings; hooks = h || {}; ensureLoop(); },
    setSources(x) { sources = x; },
    openSource, stopSource, syncCamera, syncMic, syncGains, connectSystem, ensureLoop,
    supportedFormats, startRecording, stopRecording, pause, resume, isPaused, isRecording, elapsedMs,
    snapshot, level, draw,
    get canvas() { return canvas; },
    get hasSource() { return !!srcRect(); },
    get hasSystemAudio() { return !!(stream && stream.getAudioTracks().length); }
  };
})();
