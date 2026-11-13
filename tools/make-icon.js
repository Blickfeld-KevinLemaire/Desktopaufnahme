'use strict';
// Erzeugt assets/icon.png (rote Aufnahmetaste auf dunklem Grund) ohne Zusatzpakete.
const zlib = require('zlib'), fs = require('fs'), path = require('path');
const N = 256, px = Buffer.alloc(N * N * 4);
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const i = (y * N + x) * 4, cx = x - 127.5, cy = y - 127.5;
  const rr = Math.max(Math.abs(cx), Math.abs(cy)) - 100, corner = Math.hypot(Math.max(Math.abs(cx) - 76, 0), Math.max(Math.abs(cy) - 76, 0)) - 48;
  let a = corner < 0 ? 255 : 0, r = 28, g = 33, b = 40;
  const d = Math.hypot(cx, cy);
  if (a && d < 62) { const t = Math.max(0, 1 - Math.hypot(cx + 20, cy + 22) / 90); r = 200 + 55 * t; g = 30 + 90 * t; b = 24 + 80 * t; }
  else if (a && d < 80) { r = 235; g = 238; b = 242; }
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; void rr;
}
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
