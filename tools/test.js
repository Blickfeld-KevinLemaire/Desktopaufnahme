'use strict';
// End-to-End-Test: startet die echte Electron-App (unter Linux mit xvfb-run) und prueft die Kernfunktionen.
//   xvfb-run -a -s "-screen 0 1600x1000x24" node tools/test.js [Screenshot-Ordner]
const { _electron: electron } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { execFileSync } = require('child_process');

const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'da-shots-'));
fs.mkdirSync(shots, { recursive: true });
let failed = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FAIL ') + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'da-test-'));
  const out = path.join(work, 'videos'), pics = path.join(work, 'pics');
  // kleiner MJPEG-artiger Teststream (multipart/x-mixed-replace mit PNG-Bildern)
  const frame = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.png'));
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' });
    const t = setInterval(() => { res.write(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`); res.write(frame); res.write('\r\n'); }, 100);
    req.on('close', () => clearInterval(t));
  }).listen(0);
  const netPort = srv.address().port;

  const app = await electron.launch({
    executablePath: require('electron'), args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', path.join(__dirname, '..')],
    env: { ...process.env, DA_USER_DATA: path.join(work, 'userdata') }
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { console.log('  pageerror:', e.message); failed++; });

  console.log('Start');
  await page.waitForFunction(() => typeof Pipeline !== 'undefined' && Pipeline.hasSource, null, { timeout: 40000 });
  ok(await page.evaluate(() => Pipeline.hasSource), 'Bildschirmquelle läuft');
  ok((await page.$$eval('#sel-format option', (o) => o.length)) >= 2, 'Formate erkannt');
  await page.evaluate(({ out, pics }) => { S.output.videoFolder = out; S.output.shotFolder = pics; S.general.countdown = 0; S.general.minimizeOnRecord = false; S.output.fps = 15; }, { out, pics });

  console.log('Effekte');
  await page.evaluate(() => {
    S.effects.text.enabled = true; S.effects.text.text = 'Test {datum} {zeit}';
    S.effects.watermark.enabled = false; S.effects.filter.type = 'sepia'; S.effects.mirror.h = true;
    S.effects.keys.enabled = true; S.effects.color.tintEnabled = true;
  });
  await page.evaluate(() => { Fx.keyEvent({ type: 'down', key: 'c', ctrl: true }); Fx.keyEvent({ type: 'down', key: 'Enter' }); });
  await sleep(600);
  await page.screenshot({ path: path.join(shots, '01-hauptfenster.png') });
  const px = await page.evaluate(() => { const c = Pipeline.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4000) s += d[i] + d[i + 1] + d[i + 2]; return s; });
  ok(px > 0, 'Vorschau enthält Bild');

  console.log('Aufnahme');
  await page.click('#btn-rec');
  await page.waitForFunction(() => Pipeline.isRecording(), null, { timeout: 15000 });
  await sleep(2500);
  await page.click('#btn-pause'); await sleep(800);
  ok(await page.evaluate(() => Pipeline.isPaused()), 'Pause aktiv');
  await page.screenshot({ path: path.join(shots, '02-pause.png') });
  await page.click('#btn-pause'); await sleep(1500);
  await page.click('#btn-stop');
  await page.waitForFunction(() => !Pipeline.isRecording(), null, { timeout: 15000 });
  await sleep(500);
  const files = fs.existsSync(out) ? fs.readdirSync(out) : [];
  ok(files.length === 1, 'Videodatei angelegt: ' + files.join(','));
  if (files[0]) {
    const f = path.join(out, files[0]), size = fs.statSync(f).size;
    ok(size > 5000, `Datei hat Inhalt (${size} Bytes)`);
    try {
      const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]).toString());
      const v = j.streams.find((s) => s.codec_type === 'video');
      ok(v && v.codec_name === (f.endsWith('.mp4') ? 'h264' : v.codec_name), `ffprobe: Videospur ${v && v.codec_name} ${v && v.width}x${v && v.height}`);
      ok(v && v.width >= 1280 && v.height >= 720, 'Auflösung plausibel (' + (v && v.width) + 'x' + (v && v.height) + ')');
    } catch (e) { console.log('  (ffprobe nicht verfügbar/fehlgeschlagen: ' + String(e.message).split('\n')[0] + ')'); }
  }
  ok((await page.evaluate(() => S.recent.length)) === 1, 'Eintrag unter „Letzte Aufnahmen“');

  console.log('Schnappschuss');
  await page.click('#btn-shot'); await sleep(800);
  ok(fs.existsSync(pics) && fs.readdirSync(pics).some((f) => f.endsWith('.png')), 'PNG gespeichert');

  console.log('Zeitplan');
  await page.evaluate(() => onScheduleFire({ id: 'x1', name: 'Test', durationMin: 0.05, source: 'current', folder: '', quitAfter: false }));
  await page.waitForFunction(() => Pipeline.isRecording(), null, { timeout: 15000 });
  await page.waitForFunction(() => !Pipeline.isRecording(), null, { timeout: 15000 });
  await sleep(500);
  ok(fs.readdirSync(out).length === 2, 'Zeitplan-Aufnahme startete und stoppte selbst');

  console.log('Netzwerkkamera');
  await page.click('[data-source=netcam]');
  await page.fill('#net-url', `http://127.0.0.1:${netPort}/video.mjpg`);
  await page.click('#btn-net-go');
  await page.waitForFunction(() => Pipeline.hasSource, null, { timeout: 15000 }).catch(() => {});
  ok(await page.evaluate(() => Pipeline.hasSource), 'Netzwerkkamera-Stream wird angezeigt');
  await sleep(500);
  await page.screenshot({ path: path.join(shots, '03-netzwerkkamera.png') });

  console.log('Bereichsauswahl');
  await page.click('[data-source=region]');
  const winP = app.waitForEvent('window', { timeout: 10000 });
  await page.click('#btn-region');
  const rw = await winP;
  await rw.waitForLoadState();
  await sleep(1200);
  await rw.mouse.move(300, 200); await rw.mouse.down(); await rw.mouse.move(700, 480, { steps: 5 }); await rw.mouse.up();
  await rw.keyboard.press('Enter').catch(() => {});
  await page.waitForFunction(() => S.ui.region && S.ui.region.width > 100, null, { timeout: 10000 }).catch(() => {});
  const reg = await page.evaluate(() => S.ui.region);
  ok(reg && Math.abs(reg.width - 400) < 6 && Math.abs(reg.height - 280) < 6, 'Bereich gewählt: ' + JSON.stringify(reg && [reg.x, reg.y, reg.width, reg.height]));
  await page.waitForFunction(() => Pipeline.hasSource, null, { timeout: 15000 }).catch(() => {});
  await sleep(500);
  const dim = await page.evaluate(() => [Pipeline.canvas.width, Pipeline.canvas.height]);
  ok(Math.abs(dim[0] - 400) < 6 && Math.abs(dim[1] - 280) < 6, 'Ausgabe hat Bereichsgröße ' + dim.join('x'));

  console.log('Webcam, Überlagerung, Hintergrund, Mikrofon');
  ok((await page.$$eval('#sel-cam option', (o) => o.filter((x) => x.value).length)) >= 1, 'Webcam (Testgerät) gefunden');
  await page.click('[data-source=webcam]');
  await page.waitForFunction(() => Pipeline.hasSource && S.ui.source === 'webcam', null, { timeout: 15000 });
  await sleep(800);
  await page.evaluate(() => { Object.assign(S.effects.camera, { enabled: true }); S.audio.mic = true; S.audio.system = false; S.effects.chroma.enabled = true; S.effects.chroma.target = 'camera'; changed('effects.camera.enabled'); changed('audio.mic'); });
  await sleep(1500);
  ok(await page.evaluate(() => !!document.querySelector('#sel-mic').value), 'Mikrofon (Testgerät) gefunden');
  await page.screenshot({ path: path.join(shots, '03b-webcam-ueberlagerung.png') });
  const before = fs.readdirSync(out).length;
  await page.click('#btn-rec'); await page.waitForFunction(() => Pipeline.isRecording(), null, { timeout: 15000 });
  await sleep(2500); await page.click('#btn-stop');
  await page.waitForFunction(() => !Pipeline.isRecording(), null, { timeout: 15000 }); await sleep(500);
  const newest = fs.readdirSync(out).sort().pop();
  ok(fs.readdirSync(out).length === before + 1, 'Webcam-Aufnahme gespeichert: ' + newest);
  try {
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path.join(out, newest)]).toString());
    ok(j.streams.some((x) => x.codec_type === 'audio'), 'Tonspur (Mikrofon) in der Datei: ' + j.streams.map((x) => x.codec_name).join('+'));
  } catch (e) { ok(false, 'ffprobe: ' + e.message.split('\n')[0]); }
  await page.evaluate(() => { S.effects.camera.enabled = false; S.audio.mic = false; S.effects.chroma.enabled = false; changed('effects.camera.enabled'); changed('audio.mic'); });

  console.log('Dialoge');
  await page.click('[data-source=screen]'); await sleep(1500);
  await page.click('#btn-effects'); await sleep(300);
  await page.screenshot({ path: path.join(shots, '04-effekte.png') });
  await page.click('#dlg-effects [data-tab=fx-camera]'); await sleep(100);
  await page.screenshot({ path: path.join(shots, '04b-effekte-kamera.png') });
  await page.click('#dlg-effects [data-close]');
  await page.click('#btn-options'); await sleep(200);
  await page.screenshot({ path: path.join(shots, '05-optionen.png') });
  await page.click('#dlg-options [data-close]');
  await page.click('#btn-schedule'); await page.click('#sch-add'); await sleep(200);
  await page.fill('#sch-name', 'Morgen-Aufnahme'); await page.selectOption('#sch-repeat', 'daily'); await page.fill('#sch-time', '07:30');
  await page.screenshot({ path: path.join(shots, '06-zeitplan-formular.png') });
  await page.click('#sch-form button[type=submit]'); await sleep(500);
  ok((await page.evaluate(() => S.schedules.length)) === 1, 'Zeitplan-Eintrag gespeichert');
  await page.screenshot({ path: path.join(shots, '07-zeitplan.png') });
  await page.click('#dlg-schedule [data-close]');

  await app.close(); srv.close();
  console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
  console.log('Screenshots:', shots);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
