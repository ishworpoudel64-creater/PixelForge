'use strict';
/* PixelForge Pro — everything runs in your browser.
   Sections: 1 State/helpers · 2 Loading · 3 Render pipeline · 4 Encoders (BMP/DPI/PDF/ZIP)
             5 Compression & target size · 6 Preview UI · 7 Crop · 8 Files/export · 9 Camera · 10 Init */

/* ---------- 1. State & helpers ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/bmp': 'bmp', 'application/pdf': 'pdf' };
const INPUTS = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif', 'image/svg+xml'];
const MAX_PX = 120e6;
const HAS_FILTER = 'filter' in CanvasRenderingContext2D.prototype;
const S = {}; // all settings live here, filled from the data-k controls in the HTML
const st = { files: [], cur: null, hist: [], busy: false, tool: 'compress', token: 0, pvUrl: null, pvRes: null, cropBox: null, id: 0, imgCache: null };

const fmtBytes = (b) => b < 1024 ? Math.round(b) + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(2) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), 4500);
}
function friendly(e) {
  const m = e && e.message;
  if (m === 'big') return 'This image is too large for your device to process.';
  if (m === 'enc') return 'Your browser cannot save this format. Try JPG or PNG.';
  if (m === 'load') return 'This image could not be processed. Please try another file.';
  return 'Something went wrong while processing. The image may be too large for your device\'s memory.';
}
function saveBlob(blob, name) {
  try {
    const u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 15000);
  } catch { toast('The download could not be started. Please try again.', true); }
}

/* ---------- 2. Loading ---------- */
function loadImg(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('load')); i.src = url; });
}
async function getImg(item) { // keeps just one decoded image in memory
  if (st.imgCache && st.imgCache.id === item.id) return st.imgCache.img;
  st.imgCache = null;
  const img = await loadImg(item.url);
  st.imgCache = { id: item.id, img };
  return img;
}
async function addFiles(list) {
  for (const f of list) {
    if (!f.size) { toast(`${f.name} is empty.`, true); continue; }
    if (!INPUTS.includes(f.type)) { toast(`${f.name}: This format is not supported by your current browser.`, true); continue; }
    const url = URL.createObjectURL(f);
    try {
      const img = await loadImg(url);
      const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
      if (w * h > MAX_PX) { URL.revokeObjectURL(url); toast(`${f.name} is too large to process in a browser (${w}×${h}).`, true); continue; }
      st.files.push({ id: ++st.id, file: f, url, w, h, crop: null, rot: 0, fx: false, fy: false, status: 'Waiting', out: null, an: null });
    } catch { URL.revokeObjectURL(url); toast('This image could not be processed. Please try another file.', true); }
  }
  if (!st.cur && st.files.length) st.cur = st.files[0];
  refresh();
}
async function analyze(item) { // complexity + transparency from a tiny sample
  if (item.an) return item.an;
  const img = await getImg(item), c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 64, 64);
  const d = x.getImageData(0, 0, 64, 64).data; let diff = 0, alpha = false;
  for (let i = 0; i < d.length - 4; i += 4) { diff += Math.abs(d[i] - d[i + 4]); if (d[i + 3] < 250) alpha = true; }
  return (item.an = { complexity: diff / (d.length / 4) , alpha });
}

/* ---------- 3. Render pipeline (crop → rotate/flip → resize → adjust → scan filter) ---------- */
function baseDims(item) {
  const c = item.crop || { w: item.w, h: item.h }, swap = item.rot % 180 !== 0;
  return swap ? { w: c.h, h: c.w } : { w: c.w, h: c.h };
}
function targetDims(item, s) {
  const b = baseDims(item), pw = +s.w || 0, ph = +s.h || 0;
  let W, H;
  if (pw && ph && !s.lock) { W = pw; H = ph; }
  else if (pw) { W = pw; H = b.h * pw / b.w; }
  else if (ph) { H = ph; W = b.w * ph / b.h; }
  else { W = b.w * s.pct / 100; H = b.h * s.pct / 100; }
  if (s.noUp && W > b.w) { W = b.w; H = b.h; }
  return { W, H };
}
async function render(item, s, f = 1) {
  const img = await getImg(item), c = item.crop || { x: 0, y: 0, w: item.w, h: item.h };
  let { W, H } = targetDims(item, s);
  W = Math.max(1, Math.round(W * f)); H = Math.max(1, Math.round(H * f));
  if (W * H > MAX_PX) throw new Error('big');
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d', { willReadFrequently: true });
  const type = outType(item, s);
  if (type === 'image/jpeg' || type === 'image/bmp' || type === 'application/pdf') { x.fillStyle = s.bg; x.fillRect(0, 0, W, H); }
  x.save();
  if (HAS_FILTER) x.filter = `brightness(${s.br}%) contrast(${s.co}%) saturate(${s.sa}%) blur(${s.bl}px) grayscale(${s.gr}%) opacity(${s.op}%)`;
  x.translate(W / 2, H / 2); x.rotate(item.rot * Math.PI / 180); x.scale(item.fx ? -1 : 1, item.fy ? -1 : 1);
  const swap = item.rot % 180 !== 0, dw = swap ? H : W, dh = swap ? W : H;
  x.drawImage(img, c.x, c.y, c.w, c.h, -dw / 2, -dh / 2, dw, dh);
  x.restore();
  scanFx(cv, s.scan);
  return cv;
}
function scanFx(cv, mode) {
  if (mode === 'original' || mode === 'photo') return;
  const x = cv.getContext('2d', { willReadFrequently: true }), im = x.getImageData(0, 0, cv.width, cv.height), d = im.data, h = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) h[(d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114) | 0]++;
  const n = d.length / 4; let a = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { a += h[i]; if (a >= n * .01) { lo = i; break; } }
  a = 0; for (let i = 255; i >= 0; i--) { a += h[i]; if (a >= n * .01) { hi = i; break; } }
  const k = 255 / Math.max(1, hi - lo), lv = (v) => clamp((v - lo) * k, 0, 255);
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
    if (mode === 'auto') { d[i] = lv(d[i]); d[i + 1] = lv(d[i + 1]); d[i + 2] = lv(d[i + 2]); }
    else { const v = mode === 'gray' ? g : mode === 'document' ? Math.min(255, lv(g) * 1.12) : (lv(g) > 128 ? 255 : 0); d[i] = d[i + 1] = d[i + 2] = v; }
  }
  x.putImageData(im, 0, 0);
}
function outType(item, s) {
  if (s.format === 'original') return ['image/gif', 'image/svg+xml'].includes(item.file.type) ? 'image/png' : item.file.type;
  return s.format;
}

/* ---------- 4. Encoders: BMP, DPI metadata, CRC32, PDF, ZIP (no libraries needed) ---------- */
function crc32(u) {
  if (!crc32.t) { crc32.t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc32.t[n] = c; } }
  let c = -1; for (let i = 0; i < u.length; i++) c = (c >>> 8) ^ crc32.t[(c ^ u[i]) & 255]; return (c ^ -1) >>> 0;
}
function encodeBmp(cv) {
  const w = cv.width, h = cv.height, d = cv.getContext('2d').getImageData(0, 0, w, h).data;
  const row = w * 3 + ((4 - (w * 3) % 4) % 4), size = 54 + row * h, buf = new ArrayBuffer(size), v = new DataView(buf), u = new Uint8Array(buf);
  v.setUint16(0, 0x4d42, true); v.setUint32(2, size, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true);
  v.setInt32(18, w, true); v.setInt32(22, h, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, row * h, true);
  for (let y = 0; y < h; y++) { let o = 54 + (h - 1 - y) * row; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; u[o++] = d[i + 2]; u[o++] = d[i + 1]; u[o++] = d[i]; } }
  return new Blob([buf], { type: 'image/bmp' });
}
async function setDpi(blob, type, dpi) { // writes print-resolution metadata only; pixels are unchanged
  dpi = Math.round(+dpi || 0); if (!dpi) return blob;
  const u = new Uint8Array(await blob.arrayBuffer()), ppm = Math.round(dpi / 0.0254);
  if (type === 'image/jpeg' && u[2] === 0xFF && u[3] === 0xE0) { u[13] = 1; u[14] = dpi >> 8; u[15] = dpi & 255; u[16] = dpi >> 8; u[17] = dpi & 255; }
  else if (type === 'image/bmp') { const v = new DataView(u.buffer); v.setInt32(38, ppm, true); v.setInt32(42, ppm, true); }
  else if (type === 'image/png') {
    const c = new Uint8Array(21), v = new DataView(c.buffer);
    v.setUint32(0, 9); c.set([112, 72, 89, 115], 4); v.setUint32(8, ppm); v.setUint32(12, ppm); c[16] = 1; v.setUint32(17, crc32(c.subarray(4, 17)));
    return new Blob([u.subarray(0, 33), c, u.subarray(33)], { type });
  }
  return new Blob([u], { type });
}
async function encode(cv, type, q) {
  const blob = type === 'image/bmp' ? encodeBmp(cv) : await new Promise((r) => cv.toBlob(r, type, q));
  if (!blob || blob.type !== type) throw new Error('enc'); // e.g. WebP encoding unsupported in Safari
  return setDpi(blob, type, S.dpi);
}
function buildPdf(pages) { // JPEG pages embedded with DCTDecode
  const enc = new TextEncoder(), parts = [], offs = []; let len = 0;
  const push = (d) => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); len += b.length; };
  const obj = (n, fn) => { offs[n] = len; push(`${n} 0 obj\n`); fn(); push('\nendobj\n'); };
  const n = pages.length, total = 3 + n * 3;
  push('%PDF-1.4\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`));
  pages.forEach((p, i) => {
    const a = 3 + i * 3, c = `q ${p.dw.toFixed(2)} 0 0 ${p.dh.toFixed(2)} ${p.x.toFixed(2)} ${p.y.toFixed(2)} cm /Im${i} Do Q`;
    obj(a, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.pw.toFixed(2)} ${p.ph.toFixed(2)}] /Resources << /XObject << /Im${i} ${a + 2} 0 R >> >> /Contents ${a + 1} 0 R >>`));
    obj(a + 1, () => push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`));
    obj(a + 2, () => { push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`); push(p.jpeg); push('\nendstream'); });
  });
  const xref = len;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts, { type: 'application/pdf' });
}
function buildZip(entries) { // "store" method ZIP
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  for (const { name, data } of entries) {
    const nb = enc.encode(name), crc = crc32(data), l = new DataView(new ArrayBuffer(30));
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, nb.length, true);
    parts.push(l.buffer, nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    cen.push(c.buffer, nb); off += 30 + nb.length + data.length;
  }
  const size = cen.reduce((n, p) => n + (p.byteLength ?? p.length), 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, e.buffer], { type: 'application/zip' });
}

/* ---------- 5. Compression & target size ---------- */
const targetBytes = () => Math.max(1, S.tgtVal * S.tgtUnit);
const isLossless = (t) => t === 'image/png' || t === 'image/bmp';

// Binary search on quality; if even the lowest quality is too large, shrink dimensions (×0.85) and repeat.
async function fitTarget(item, s, type, target) {
  let best = null;
  for (let step = 0, f = 1; step < 9; step++, f *= 0.85) {
    const cv = await render(item, s, f);
    if (isLossless(type)) {
      const blob = await encode(cv, type);
      if (!best || blob.size < best.blob.size) best = { blob, w: cv.width, h: cv.height, q: null };
      if (blob.size <= target) return { ...best, reached: true };
    } else {
      let lo = 0.05, hi = 0.98, found = null;
      for (let i = 0; i < 7; i++) {
        const q = (lo + hi) / 2, blob = await encode(cv, type, q);
        if (blob.size <= target) { found = { blob, w: cv.width, h: cv.height, q }; lo = q; } else hi = q;
        await nextFrame();
      }
      if (found) return { ...found, reached: true };
      const small = await encode(cv, type, 0.05);
      if (!best || small.size < best.blob.size) best = { blob: small, w: cv.width, h: cv.height, q: 0.05 };
    }
    if (cv.width < 40 || cv.height < 40) break;
    await nextFrame();
  }
  return { ...best, reached: false };
}
async function processItem(item, s) {
  const type = outType(item, s), enc = type === 'application/pdf' ? 'image/jpeg' : type;
  let res;
  if (s.mode === 'target') res = await fitTarget(item, s, enc, targetBytes());
  else { const cv = await render(item, s), blob = await encode(cv, enc, s.quality / 100); res = { blob, w: cv.width, h: cv.height, q: isLossless(enc) ? null : s.quality / 100, reached: null }; }
  res.type = type; res.enc = enc;
  return res;
}
async function recommend(item) {
  const an = await analyze(item), mp = item.w * item.h / 1e6, mb = item.file.size / 1048576, R = [];
  let q = { web: 82, email: 68, social: 76, print: 92 }[S.purpose] || 82;
  R.push({ web: 'Purpose: website — balance sharpness and load time', email: 'Purpose: email — smaller files send faster', social: 'Purpose: social media — platforms recompress anyway', print: 'Purpose: print — keep detail high' }[S.purpose]);
  if (mp > 12) { q -= 4; R.push(`Original is high resolution (${mp.toFixed(1)} MP)`); }
  if (mb > 3) { q -= 3; R.push('File is larger than necessary for most uses'); }
  if (an.complexity > 22) { q += 3; R.push('Image is detailed, so compression artifacts show more'); } else R.push('Image is smooth, so it compresses efficiently');
  if (an.alpha) R.push('Has transparency — use PNG or WebP to keep it');
  else if (item.file.type === 'image/png') R.push('PNG is lossless; WebP or JPG can be much smaller');
  if (item.file.type === 'image/jpeg' && mb < 0.3) { q += 4; R.push('File is already small; higher quality avoids extra loss'); }
  return { q: clamp(Math.round(q), 40, 98), R };
}

/* ---------- 6. Preview UI ---------- */
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const schedule = debounce(() => preview(), 300);

async function preview() {
  const item = st.cur; if (!item) return;
  if (st.tool === 'crop') return;
  const my = ++st.token; $('#spin').hidden = false;
  try {
    const res = await processItem(item, S);
    if (my !== st.token) return;
    if (st.pvUrl) URL.revokeObjectURL(st.pvUrl);
    st.pvUrl = URL.createObjectURL(res.blob); st.pvRes = res;
    stageImage(st.pvUrl, res.w, res.h); $('#ovWrap').hidden = $('#cmpRange').hidden = !$('#cmpOn').checked;
    $('#pvBefore').src = item.url;
    renderInfo(item, res);
  } catch (e) { if (my === st.token) { toast(friendly(e), true); $('#est').textContent = friendly(e); } }
  finally { if (my === st.token) $('#spin').hidden = true; }
}
function stageImage(url, w, h) {
  const wrap = $('#wrap'), z = $('#zoomSel').value, stage = $('#stage');
  $('#pvAfter').src = url;
  let width = z === 'fit' ? Math.min(w, stage.clientWidth - 20, (Math.min(innerHeight * .62, 640)) * w / h) : w * +z;
  wrap.style.width = Math.max(40, width) + 'px'; wrap.style.aspectRatio = w + ' / ' + h;
}
function renderInfo(item, res) {
  const o = item.file.size, n = res.blob.size, saved = o - n, pct = (saved / o) * 100;
  let msg = `Original: ${fmtBytes(o)} · Estimated: ${fmtBytes(n)}${res.q ? ' · Quality: ' + Math.round(res.q * 100) + '%' : ''}`;
  if (S.mode === 'target') msg += `\nTarget: ${fmtBytes(targetBytes())} · Result: ${fmtBytes(n)} · ${res.reached ? 'Target size reached' : 'Closest practical result'}`;
  if (res.type === 'application/pdf') msg += '\n(Estimate is for the page image; PDF adds a small overhead.)';
  $('#est').textContent = msg; $('#est').style.whiteSpace = 'pre-line';
  const d = targetDims(item, S), bd = baseDims(item);
  $('#dims').textContent = `Original ${item.w}×${item.h} → Final ${res.w}×${res.h}`;
  $('#az').innerHTML = `<div><h3>Original File</h3>Name: <span id="azn"></span><br>Format: ${item.file.type.replace('image/', '').toUpperCase()}<br>Size: ${fmtBytes(o)}<br>Dimensions: ${item.w} × ${item.h}<br>Pixels: ${(item.w * item.h / 1e6).toFixed(1)} MP<br>Color: RGB</div>
   <div><h3>Optimized File</h3>Size: ${fmtBytes(n)}<br>${saved >= 0 ? 'Reduction' : 'Increase'}: ${Math.abs(pct).toFixed(1)}%<br>Dimensions: ${res.w} × ${res.h}<br>Format: ${EXT[res.type].toUpperCase()}</div>`;
  $('#azn').textContent = item.file.name;
}
function refresh() {
  const has = st.files.length > 0;
  $('#viewer').hidden = !has; $('#drop').classList.toggle('small', has);
  renderFiles(); renderMeta(); renderRec(); renderHistory();
  $('#convFrom').textContent = st.cur ? 'Original: ' + st.cur.file.name : 'Original: —';
  if (st.cur) { showTool(st.tool); schedule(); } else { $('#est').textContent = 'Add an image to see the estimated size.'; $('#az').textContent = 'Original and optimized file details appear here.'; }
}
function renderFiles() {
  const box = $('#files'); box.innerHTML = '';
  if (st.files.length > 1) { const c = document.createElement('small'); c.textContent = `${st.files.length} files selected`; box.append(c); }
  st.files.forEach((it, i) => {
    const el = document.createElement('div'); el.className = 'file' + (it === st.cur ? ' sel' : '');
    el.innerHTML = '<img alt=""><div><div class="n"></div><div class="m"></div></div><div class="a"></div>';
    el.querySelector('img').src = it.url; el.querySelector('.n').textContent = it.file.name;
    el.querySelector('.m').innerHTML = `${fmtBytes(it.file.size)}${it.out ? ' → ' + fmtBytes(it.out) : ''} · <span class="st-${it.status}">${it.status}</span>`;
    const a = el.querySelector('.a');
    [['↑', 'Move up', () => moveFile(i, -1)], ['↓', 'Move down', () => moveFile(i, 1)], ['✕', 'Remove', () => removeFile(it)]].forEach(([t, l, fn]) => {
      const b = document.createElement('button'); b.textContent = t; b.setAttribute('aria-label', l + ' ' + it.file.name); b.onclick = (e) => { e.stopPropagation(); fn(); }; a.append(b);
    });
    el.onclick = () => { st.cur = it; refresh(); };
    box.append(el);
  });
}
function moveFile(i, d) { const j = i + d; if (j < 0 || j >= st.files.length) return; [st.files[i], st.files[j]] = [st.files[j], st.files[i]]; renderFiles(); }
function removeFile(it) {
  URL.revokeObjectURL(it.url); st.files = st.files.filter((f) => f !== it);
  if (st.imgCache && st.imgCache.id === it.id) st.imgCache = null;
  if (st.cur === it) st.cur = st.files[0] || null;
  if (!st.cur) { $('#pvAfter').removeAttribute('src'); $('#pvBefore').removeAttribute('src'); if (st.pvUrl) { URL.revokeObjectURL(st.pvUrl); st.pvUrl = null; } }
  refresh();
}
function clearWorkspace() {
  if (!st.files.length || !confirm('Clear the workspace? All loaded images will be removed from memory.')) return;
  st.files.forEach((f) => URL.revokeObjectURL(f.url)); st.files = []; st.cur = null; st.imgCache = null; st.token++;
  if (st.pvUrl) { URL.revokeObjectURL(st.pvUrl); st.pvUrl = null; }
  $('#result').textContent = ''; refresh(); toast('Workspace cleared.');
}
function renderMeta() {
  const it = st.cur, t = $('#meta'); t.innerHTML = '';
  if (!it) { t.innerHTML = '<tr><td>No image selected</td></tr>'; return; }
  [['Filename', it.file.name], ['MIME type', it.file.type], ['Width', it.w + ' px'], ['Height', it.h + ' px'], ['File size', fmtBytes(it.file.size)], ['Last modified', new Date(it.file.lastModified).toLocaleString()]].forEach(([k, v]) => {
    const r = t.insertRow(); r.insertCell().textContent = k; r.insertCell().textContent = v;
  });
}
async function renderRec() {
  const box = $('#rec'); if (!st.cur) { box.textContent = 'Add an image to get a recommendation.'; return; }
  const r = await recommend(st.cur); st.rec = r;
  box.innerHTML = 'Recommended Quality <b></b><ul></ul>'; box.querySelector('b').textContent = r.q + '%';
  r.R.forEach((t) => { const li = document.createElement('li'); li.textContent = t; box.querySelector('ul').append(li); });
}
function renderHistory() {
  const ul = $('#histList'); ul.innerHTML = '';
  if (!st.hist.length) { ul.innerHTML = '<li>Nothing yet</li>'; return; }
  st.hist.forEach((h) => { const li = document.createElement('li'); li.textContent = `${h.name} — ${fmtBytes(h.size)} — ${h.saved}% saved`; ul.append(li); });
}
function showTool(t) {
  const leaving = st.tool === 'crop' && t !== 'crop';
  st.tool = t;
  $$('.tool,[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  $$('.pnl').forEach((p) => p.hidden = p.id !== 'p-' + t);
  $('#cropbox').hidden = t !== 'crop' || !st.cur;
  if (t === 'crop' && st.cur) enterCrop(); else if (leaving) schedule();
}
function setK(k, v) { S[k] = v; const el = document.querySelector(`[data-k="${k}"]`); if (el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; syncOut(el); } }
function syncOut(el) { const o = el.nextElementSibling; if (o && o.tagName === 'OUTPUT') o.textContent = el.value + (el.dataset.u || ''); }
function readVal(el) { return el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? (el.value === '' ? '' : +el.value) : el.value; }
const PRESET_Q = { maxq: 95, bal: 82, maxc: 45 };

function onSetting(k) {
  if (k === 'mode' && PRESET_Q[S.mode]) setK('quality', PRESET_Q[S.mode]);
  if (k === 'quality' && S.mode !== 'target') setK('mode', 'custom');
  if (k === 'tgtVal' || k === 'tgtUnit') setK('mode', 'target');
  if (k === 'w' || k === 'h') {
    S.pct = 100; const b = st.cur ? baseDims(st.cur) : null;
    if (b && S.lock) { if (k === 'w' && S.w) setK('h', Math.round(b.h * S.w / b.w)); if (k === 'h' && S.h) setK('w', Math.round(b.w * S.h / b.h)); }
  }
  if (k === 'purpose') renderRec();
  schedule();
}

/* ---------- 7. Crop editor ---------- */
const cropRatio = () => { const v = $('#ratio').value; return v === 'custom' ? +$('#ratioCustom').value || 0 : +v; };
function enterCrop() {
  const it = st.cur; stageImage(it.url, it.w, it.h); $('#ovWrap').hidden = $('#cmpRange').hidden = true;
  const c = it.crop; st.cropBox = c ? { x: c.x / it.w, y: c.y / it.h, w: c.w / it.w, h: c.h / it.h } : { x: .05, y: .05, w: .9, h: .9 };
  if (!c) setRatioBox();
  $('#cropbox').hidden = false; drawCrop();
}
function setRatioBox() {
  const it = st.cur, ra = cropRatio();
  if (!ra) { st.cropBox = { x: .05, y: .05, w: .9, h: .9 }; return; }
  let wp = it.w, hp = wp / ra; if (hp > it.h) { hp = it.h; wp = hp * ra; }
  const w = wp / it.w * .9, h = hp / it.h * .9; st.cropBox = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}
function drawCrop() {
  const b = st.cropBox, e = $('#cropbox').style;
  e.left = b.x * 100 + '%'; e.top = b.y * 100 + '%'; e.width = b.w * 100 + '%'; e.height = b.h * 100 + '%';
}
function initCrop() {
  const box = $('#cropbox'); let drag = null;
  box.onpointerdown = (e) => { e.preventDefault(); box.setPointerCapture(e.pointerId); drag = { m: e.target.id === 'cropH' ? 'r' : 'm', sx: e.clientX, sy: e.clientY, b: { ...st.cropBox }, r: $('#wrap').getBoundingClientRect() }; };
  box.onpointermove = (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / drag.r.width, dy = (e.clientY - drag.sy) / drag.r.height, b = { ...drag.b }, it = st.cur;
    if (drag.m === 'm') { b.x = clamp(b.x + dx, 0, 1 - b.w); b.y = clamp(b.y + dy, 0, 1 - b.h); }
    else {
      let nw = clamp(b.w + dx, .04, 1 - b.x), nh = clamp(b.h + dy, .04, 1 - b.y); const ra = cropRatio();
      if (ra) { nh = nw * it.w / (ra * it.h); if (b.y + nh > 1) { nh = 1 - b.y; nw = nh * ra * it.h / it.w; } }
      b.w = nw; b.h = nh;
    }
    st.cropBox = b; drawCrop();
  };
  box.onpointerup = box.onpointercancel = () => { drag = null; };
  $('#applyCrop').onclick = () => {
    const it = st.cur; if (!it) return; const b = st.cropBox;
    it.crop = { x: Math.round(b.x * it.w), y: Math.round(b.y * it.h), w: Math.max(1, Math.round(b.w * it.w)), h: Math.max(1, Math.round(b.h * it.h)) };
    toast('Crop applied.'); showTool('compress');
  };
  $('#resetCrop').onclick = () => { if (!st.cur) return; st.cur.crop = null; setRatioBox(); drawCrop(); toast('Crop reset.'); };
  $('#ratio').onchange = () => { $('#ratioWrap').hidden = $('#ratio').value !== 'custom'; if (st.cur) { setRatioBox(); drawCrop(); } };
  $('#ratioCustom').oninput = () => { if (st.cur) { setRatioBox(); drawCrop(); } };
  $('#rotChips').onclick = (e) => {
    const b = e.target.closest('button'), it = st.cur; if (!b || !it) return;
    if (b.dataset.rot) it.rot = (it.rot + +b.dataset.rot) % 360;
    if (b.dataset.flip === 'x') it.fx = !it.fx; if (b.dataset.flip === 'y') it.fy = !it.fy;
    schedule();
  };
}

/* ---------- 8. Export ---------- */
function makeName(item, i, type) {
  const base = item.file.name.replace(/\.[^.]+$/, ''), c = (S.nameCustom || '').trim(), m = S.nameMode;
  const n = m === 'custom' ? (c || base) : m === 'seq' ? `${c || 'image'}-${String(i + 1).padStart(2, '0')}` : m === 'opt' ? base + '-optimized' : m === 'orig' ? base : base + '-compressed';
  return n.replace(/[\\/:*?"<>|]/g, '_') + '.' + EXT[type];
}
async function pdfPages(items, onStep) {
  const pages = [], s = { ...S, format: 'image/jpeg' }, m = S.margin * 2.835;
  for (let i = 0; i < items.length; i++) {
    onStep(i); const res = await processItem(items[i], s);
    let pw, ph; if (S.page === 'orig') { pw = res.w * .75 + 2 * m; ph = res.h * .75 + 2 * m; } else { [pw, ph] = S.page === 'a4' ? [595.28, 841.89] : [612, 792]; if (S.orient === 'land') [pw, ph] = [ph, pw]; }
    let sc = Math.min((pw - 2 * m) / res.w, (ph - 2 * m) / res.h); if (!S.fit) sc = Math.min(sc, .75);
    const dw = res.w * sc, dh = res.h * sc;
    pages.push({ jpeg: new Uint8Array(await res.blob.arrayBuffer()), w: res.w, h: res.h, pw, ph, dw, dh, x: (pw - dw) / 2, y: (ph - dh) / 2 });
    items[i].status = 'Complete'; renderFiles(); await nextFrame();
  }
  return pages;
}
async function runExport(items, asZip) {
  if (!items.length) { toast('Add an image first.', true); return; }
  if (st.busy) return; st.busy = true;
  const bar = $('#progBar'), prog = $('#prog'), txt = $('#progTxt'); bar.hidden = false; $('#result').textContent = '';
  const step = (i) => { prog.style.width = (i / items.length) * 100 + '%'; txt.textContent = `Processing ${i + 1} / ${items.length}`; };
  let totalO = 0, totalN = 0;
  try {
    if (S.format === 'application/pdf') {
      items.forEach((it) => { it.status = 'Processing'; }); renderFiles();
      const blob = buildPdf(await pdfPages(items, step));
      saveBlob(blob, (S.nameMode === 'custom' && S.nameCustom ? S.nameCustom.trim() : 'document-01').replace(/[\\/:*?"<>|]/g, '_') + '.pdf');
      totalO = items.reduce((n, i) => n + i.file.size, 0); totalN = blob.size;
      addHist(`${items.length} page PDF`, blob.size, totalO);
    } else {
      const outs = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i]; step(i); it.status = 'Processing'; renderFiles(); await nextFrame();
        try {
          const res = await processItem(it, S);
          it.out = res.blob.size; it.status = 'Complete'; outs.push({ name: makeName(it, i, res.type), blob: res.blob });
          totalO += it.file.size; totalN += res.blob.size; addHist(outs[outs.length - 1].name, res.blob.size, it.file.size);
        } catch (e) { it.status = 'Error'; toast(`${it.file.name}: ${friendly(e)}`, true); }
        renderFiles();
      }
      if (outs.length === 1 && !asZip) saveBlob(outs[0].blob, outs[0].name);
      else if (outs.length) {
        const used = new Set(), entries = [];
        for (const o of outs) { let n = o.name, k = 1; while (used.has(n)) n = o.name.replace(/(\.\w+)$/, `-${k++}$1`); used.add(n); entries.push({ name: n, data: new Uint8Array(await o.blob.arrayBuffer()) }); }
        saveBlob(buildZip(entries), 'pixelforge-export.zip');
      }
    }
    prog.style.width = '100%'; txt.textContent = 'All files processed';
    if (totalO) $('#result').textContent = `Export Complete ✓  Saved: ${fmtBytes(Math.max(0, totalO - totalN))} · Reduction: ${Math.max(0, (1 - totalN / totalO) * 100).toFixed(1)}%`;
  } catch (e) { toast(friendly(e), true); items.forEach((i) => { if (i.status === 'Processing') i.status = 'Error'; }); renderFiles(); }
  finally { st.busy = false; }
}
function addHist(name, size, orig) { st.hist.unshift({ name, size, saved: Math.max(0, Math.round((1 - size / orig) * 100)) }); st.hist = st.hist.slice(0, 25); renderHistory(); }

/* ---------- 9. Camera ---------- */
let camStream = null;
async function openCamera() {
  showTool('scan');
  if (matchMedia('(pointer:coarse)').matches || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { $('#camInput').click(); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    $('#camVideo').srcObject = camStream; $('#camDlg').showModal();
  } catch { toast('Camera access was denied or is unavailable. You can upload a photo instead.', true); $('#fileInput').click(); }
}
function closeCamera() { if (camStream) camStream.getTracks().forEach((t) => t.stop()); camStream = null; $('#camVideo').srcObject = null; if ($('#camDlg').open) $('#camDlg').close(); }
function captureFrame() {
  const v = $('#camVideo'); if (!v.videoWidth) { toast('Camera is not ready yet.', true); return; }
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
  c.toBlob((b) => { closeCamera(); if (!b) return toast('Capture failed. Please try again.', true); setK('scan', 'auto'); addFiles([new File([b], `scan-${Date.now()}.jpg`, { type: 'image/jpeg' })]); }, 'image/jpeg', .92);
}

/* ---------- 10. Init ---------- */
function init() {
  // Settings come from the HTML controls (data-k)
  Object.assign(S, { pct: 100, bg: '#ffffff' });
  $$('[data-k]').forEach((el) => {
    S[el.dataset.k] = readVal(el); syncOut(el);
    el.addEventListener('input', () => { S[el.dataset.k] = readVal(el); syncOut(el); onSetting(el.dataset.k); });
  });
  if (!HAS_FILTER) $('#filtNote').textContent = 'Your browser does not support canvas filters, so Brightness/Contrast/Saturation/Blur/Grayscale/Opacity have no effect. Scan filters still work.';

  const fi = $('#fileInput'), drop = $('#drop');
  fi.onchange = () => { addFiles([...fi.files]); fi.value = ''; };
  $('#camInput').onchange = (e) => { setK('scan', 'auto'); addFiles([...e.target.files]); e.target.value = ''; };
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } };
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));

  $$('[data-tool]').forEach((b) => b.onclick = () => showTool(b.dataset.tool));
  $('#tgtChips').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const kb = +b.dataset.tgt; kb >= 1024 ? (setK('tgtVal', kb / 1024), setK('tgtUnit', 1048576)) : (setK('tgtVal', kb), setK('tgtUnit', 1024)); setK('mode', 'target'); schedule(); };
  $('#pctChips').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pct) { setK('w', ''); setK('h', ''); S.pct = +b.dataset.pct; }
    else { S.pct = 100; setK('w', +b.dataset.px); setK('h', ''); if (st.cur && S.lock) setK('h', Math.round(baseDims(st.cur).h * S.w / baseDims(st.cur).w)); }
    schedule();
  };
  $('#useRec').onclick = () => { if (!st.rec) return toast('Add an image first.', true); setK('mode', 'custom'); setK('quality', st.rec.q); schedule(); toast('Recommended quality applied.'); };
  $('#customize').onclick = () => { setK('mode', 'custom'); $('#quality').focus(); };
  const ENH = { natural: { br: 100, co: 100, sa: 100, bl: 0, gr: 0, op: 100, scan: 'original' }, bright: { br: 115, co: 105, sa: 105 }, contrast: { br: 100, co: 135, sa: 105 }, document: { scan: 'document' }, scan: { scan: 'auto', co: 115 }, bw: { scan: 'bw' } };
  $('#enh').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.enh !== 'natural') Object.entries(ENH.natural).forEach(([k, v]) => setK(k, v)); Object.entries(ENH[b.dataset.enh]).forEach(([k, v]) => setK(k, v)); schedule(); };
  $('#resetAdj').onclick = () => { Object.entries(ENH.natural).forEach(([k, v]) => setK(k, v)); schedule(); };
  $('#scanFmt').onclick = (e) => { const b = e.target.closest('button'); if (b) { setK('format', b.dataset.fmt); toast('Output format set. Use Export & Download.'); schedule(); } };
  $('#scanBtn').onclick = openCamera; $('#heroScan').onclick = () => { location.hash = '#app'; openCamera(); };
  $('#heroStart').onclick = () => { location.hash = '#app'; fi.click(); };
  $('#camShot').onclick = captureFrame; $('#camClose').onclick = closeCamera; $('#camDlg').addEventListener('close', closeCamera);
  $('#makePdf').onclick = () => { setK('format', 'application/pdf'); runExport(st.files, false); };
  $('#exportBtn').onclick = () => runExport(st.cur ? [st.cur] : [], false);
  $('#exportAll').onclick = () => runExport(st.files, true);
  $('#clearWs').onclick = clearWorkspace;
  $('#clearHist').onclick = () => { st.hist = []; renderHistory(); };

  // Zoom & compare
  const zs = $('#zoomSel'), zoomTo = (v) => { zs.value = v; if (st.tool === 'crop' && st.cur) enterCrop(); else if (st.pvRes) stageImage(st.pvUrl, st.pvRes.w, st.pvRes.h); };
  const levels = ['0.25', '0.5', '1', '2', '4'];
  zs.onchange = () => zoomTo(zs.value);
  $('#zfit').onclick = () => zoomTo('fit');
  $('#zin').onclick = () => { const i = levels.indexOf(zs.value); zoomTo(levels[Math.min(levels.length - 1, i < 0 ? 2 : i + 1)]); };
  $('#zout').onclick = () => { const i = levels.indexOf(zs.value); zoomTo(levels[Math.max(0, i < 0 ? 2 : i - 1)]); };
  $('#cmpRange').oninput = (e) => { $('#ovWrap').style.clipPath = `inset(0 ${100 - e.target.value}% 0 0)`; };
  $('#cmpOn').onchange = () => { $('#ovWrap').hidden = $('#cmpRange').hidden = !$('#cmpOn').checked || st.tool === 'crop'; };

  $('#themeBtn').onclick = () => { const r = document.documentElement; r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('pf-theme', r.dataset.theme); } catch {} };
  try { const t = localStorage.getItem('pf-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  addEventListener('resize', debounce(() => { if (st.tool !== 'crop' && st.pvRes) stageImage(st.pvUrl, st.pvRes.w, st.pvRes.h); }, 200));
  addEventListener('pagehide', () => { st.files.forEach((f) => URL.revokeObjectURL(f.url)); if (st.pvUrl) URL.revokeObjectURL(st.pvUrl); });
  initCrop();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('service-worker.js').catch(() => {});
  showTool('compress'); refresh();
}
init();