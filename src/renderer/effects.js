'use strict';
// Effekt-Bausteine fuer die Zeichen-Pipeline. Alles arbeitet auf einem 2D-Canvas.
const Fx = (() => {
  const hex = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const rgba = (h, a) => { const [r, g, b] = hex(h); return `rgba(${r},${g},${b},${a})`; };

  // Position -> linke obere Ecke fuer ein Rechteck w x h in einer Flaeche W x H
  function anchor(pos, W, H, w, h, m) {
    m = m == null ? Math.round(Math.min(W, H) * 0.025) : m;
    const x = pos.endsWith('l') ? m : pos.endsWith('r') ? W - w - m : (W - w) / 2;
    const y = pos.startsWith('t') ? m : pos.startsWith('b') ? H - h - m : (H - h) / 2;
    return pos === 'c' ? { x: (W - w) / 2, y: (H - h) / 2 } : { x, y };
  }

  function cssFilter(e) {
    const parts = [];
    const c = e.color;
    if (c.brightness !== 100) parts.push(`brightness(${c.brightness}%)`);
    if (c.contrast !== 100) parts.push(`contrast(${c.contrast}%)`);
    if (c.saturate !== 100) parts.push(`saturate(${c.saturate}%)`);
    if (c.hue) parts.push(`hue-rotate(${c.hue}deg)`);
    const f = e.filter, a = f.amount;
    if (f.type === 'grayscale') parts.push(`grayscale(${a}%)`);
    if (f.type === 'sepia') parts.push(`sepia(${a}%)`);
    if (f.type === 'invert') parts.push(`invert(${a}%)`);
    if (f.type === 'blur') parts.push(`blur(${Math.round(a / 5)}px)`);
    return parts.length ? parts.join(' ') : 'none';
  }

  let tmp = null;
  function scratch(w, h) {
    if (!tmp) tmp = document.createElement('canvas');
    if (tmp.width !== w || tmp.height !== h) { tmp.width = w; tmp.height = h; }
    return tmp;
  }

  // Zeichnet ein Quellbild (Video/Img/Canvas) mit Farb-/Filter-/Spiegel-Effekten.
  // sx,sy,sw,sh = Ausschnitt der Quelle, dx,dy,dw,dh = Ziel
  function drawSource(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh, e) {
    ctx.save();
    ctx.filter = cssFilter(e);
    ctx.translate(dx + dw / 2, dy + dh / 2);
    ctx.scale(e.mirror.h ? -1 : 1, e.mirror.v ? -1 : 1);
    if (e.filter.type === 'pixelate') {
      const k = Math.max(2, Math.round(2 + e.filter.amount * 0.4));
      const sw2 = Math.max(1, Math.round(dw / k)), sh2 = Math.max(1, Math.round(dh / k));
      const t = scratch(sw2, sh2);
      const tc = t.getContext('2d');
      tc.imageSmoothingEnabled = true;
      tc.drawImage(src, sx, sy, sw, sh, 0, 0, sw2, sh2);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(t, 0, 0, sw2, sh2, -dw / 2, -dh / 2, dw, dh);
      ctx.imageSmoothingEnabled = true;
    } else {
      ctx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    }
    ctx.restore();
    if (e.color.tintEnabled && e.color.tintAlpha > 0) {
      ctx.save();
      ctx.fillStyle = rgba(e.color.tint, e.color.tintAlpha / 100);
      ctx.fillRect(dx, dy, dw, dh);
      ctx.restore();
    }
  }

  // Chroma-Key: entfernt eine Farbe, liefert Canvas mit Transparenz
  let ck = null;
  function chroma(src, w, h, c) {
    if (!ck) ck = document.createElement('canvas');
    if (ck.width !== w || ck.height !== h) { ck.width = w; ck.height = h; }
    const x = ck.getContext('2d', { willReadFrequently: true });
    x.clearRect(0, 0, w, h);
    x.drawImage(src, 0, 0, w, h);
    const img = x.getImageData(0, 0, w, h);
    const d = img.data, [kr, kg, kb] = hex(c.color);
    const tol = c.tolerance * 4.4, soft = Math.max(0.001, c.softness * 4.4);
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - kr, dg = d[i + 1] - kg, db = d[i + 2] - kb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist < tol) d[i + 3] = 0;
      else if (dist < tol + soft) d[i + 3] = Math.round(((dist - tol) / soft) * d[i + 3]);
    }
    x.putImageData(img, 0, 0);
    return ck;
  }

  function drawCamera(ctx, W, H, e, cam) {
    const c = e.camera;
    if (!cam || !cam.videoWidth) return;
    const cw = cam.videoWidth, ch = cam.videoHeight;
    const w = Math.round(W * c.size / 100), h = Math.round(w * ch / cw);
    const { x, y } = anchor(c.position, W, H, w, h);
    let img = cam;
    if (e.chroma.enabled && e.chroma.target === 'camera') img = chroma(cam, Math.min(cw, 480), Math.round(Math.min(cw, 480) * ch / cw), e.chroma);
    ctx.save();
    if (c.shape === 'round') {
      const r = Math.min(w, h) / 2;
      ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2); ctx.clip();
    }
    if (c.mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, w, h); }
    else ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    if (c.border) {
      ctx.save();
      ctx.lineWidth = Math.max(2, W / 400); ctx.strokeStyle = '#ffffff';
      if (c.shape === 'round') { ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2); ctx.stroke(); }
      else ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }
  }

  function drawWatermark(ctx, W, H, e, img) {
    const w0 = e.watermark;
    if (!img || !img.complete || !img.naturalWidth) return;
    const w = Math.round(W * w0.size / 100), h = Math.round(w * img.naturalHeight / img.naturalWidth);
    const { x, y } = anchor(w0.position, W, H, w, h);
    ctx.save(); ctx.globalAlpha = w0.opacity / 100; ctx.drawImage(img, x, y, w, h); ctx.restore();
  }

  const two = (n) => String(n).padStart(2, '0');
  function expand(text) {
    const d = new Date();
    return text.replace(/\{datum\}/g, `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()}`)
      .replace(/\{zeit\}/g, `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`);
  }

  function drawText(ctx, W, H, e) {
    const t = e.text;
    const txt = expand(t.text || '');
    if (!txt) return;
    const size = Math.round(H * t.size / 720);
    ctx.save();
    ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const lines = txt.split('\n');
    const lw = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const pad = Math.round(size * 0.35), lh = Math.round(size * 1.25);
    const w = Math.ceil(lw + pad * 2), h = lines.length * lh + pad;
    const pos = t.position;
    const { x, y } = anchor(pos, W, H, w, h);
    if (t.bgAlpha > 0) { ctx.fillStyle = rgba(t.bg, t.bgAlpha / 100); roundRect(ctx, x, y, w, h, size * 0.25); ctx.fill(); }
    ctx.fillStyle = t.color;
    lines.forEach((l, i) => ctx.fillText(l, x + pad, y + pad / 2 + lh * (i + 0.5)));
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ---- Tastenanschlaege ----
  const items = [];
  const PRETTY = { Escape: 'Esc', Backspace: '⌫', ' ': 'Leertaste', Space: 'Leertaste', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Up: '↑', Down: '↓', Left: '←', Right: '→', Delete: 'Entf', Control: 'Strg', Ctrl: 'Strg' };
  const isMod = (k) => /^(Ctrl|Control|Alt|Shift|Meta|Win|Super)/i.test(k);
  function keyEvent(ev) {
    if (ev.type !== 'down' || isMod(ev.key)) return;
    const k = PRETTY[ev.key] || (ev.key.length === 1 ? ev.key.toUpperCase() : ev.key);
    const mods = [ev.ctrl && 'Strg', ev.alt && 'Alt', ev.shift && 'Umschalt', ev.meta && 'Win'].filter(Boolean);
    items.push({ text: [...mods, k].join(' + '), t: performance.now() });
    while (items.length > 6) items.shift();
  }
  function drawKeys(ctx, W, H, e) {
    const k = e.keys, now = performance.now();
    for (let i = items.length - 1; i >= 0; i--) if (now - items[i].t > k.hold * 1000) items.splice(i, 1);
    if (!items.length) return;
    const size = Math.round(H * k.size / 720);
    ctx.save();
    ctx.font = `600 ${size}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const pad = Math.round(size * 0.45), gap = Math.round(size * 0.3), h = Math.round(size * 1.6);
    const widths = items.map((it) => ctx.measureText(it.text).width + pad * 2);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
    const { x: x0, y } = anchor(k.position, W, H, total, h, Math.round(H * 0.04));
    let x = x0;
    items.forEach((it, i) => {
      const age = (now - it.t) / (k.hold * 1000);
      ctx.globalAlpha = age > 0.75 ? Math.max(0, 1 - (age - 0.75) * 4) : 1;
      ctx.fillStyle = rgba(k.bg, 0.85); roundRect(ctx, x, y, widths[i], h, size * 0.3); ctx.fill();
      ctx.fillStyle = k.color; ctx.fillText(it.text, x + pad, y + h / 2);
      x += widths[i] + gap;
    });
    ctx.restore();
  }

  return { hex, rgba, anchor, cssFilter, drawSource, chroma, drawCamera, drawWatermark, drawText, drawKeys, keyEvent, expand };
})();
