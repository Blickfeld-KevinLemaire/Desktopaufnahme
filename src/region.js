'use strict';
const sel = document.getElementById('sel');
const dim = document.getElementById('dim');
let start = null, rect = null;
function norm(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
function show(r) {
  sel.hidden = false;
  sel.style.left = r.x + 'px'; sel.style.top = r.y + 'px';
  sel.style.width = r.width + 'px'; sel.style.height = r.height + 'px';
  dim.textContent = r.width + ' × ' + r.height;
}
addEventListener('mousedown', (e) => { start = { x: e.clientX, y: e.clientY }; rect = null; });
addEventListener('mousemove', (e) => { if (!start) return; rect = norm(start, { x: e.clientX, y: e.clientY }); show(rect); });
addEventListener('mouseup', () => { start = null; if (!rect || rect.width < 8 || rect.height < 8) { rect = null; sel.hidden = true; } });
addEventListener('dblclick', () => { if (rect) finish(); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') regionApi.cancel();
  if (e.key === 'Enter' && rect) finish();
});
function finish() {
  regionApi.done({ ...rect, displayWidth: innerWidth, displayHeight: innerHeight });
}
