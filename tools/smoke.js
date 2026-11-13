'use strict';
// Startet die App (unter Xvfb) und macht einen Screenshot der Oberflaeche.
const { _electron: electron } = require('/opt/node-tools/node_modules/playwright');
const path = require('path'), fs = require('fs'), os = require('os');
(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'da-'));
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', path.join(__dirname, '..')], env: { ...process.env, DA_USER_DATA: userData } });
  const page = await app.firstWindow();
  page.on('console', (m) => console.log('[renderer]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.waitForTimeout(5000);
  console.log('status:', await page.textContent('#st-state'), '|', await page.textContent('#stage-msg'));
  console.log('info:', await page.textContent('#st-info'));
  console.log('formats:', await page.$$eval('#sel-format option', (o) => o.map((x) => x.textContent)));
  await page.screenshot({ path: process.argv[2] || 'smoke.png' });
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
