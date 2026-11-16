// engine.js — flat2d core: math, easing, colour, canvas primitives, keyframes, camera, the SceneSpec interpreter
// and the QA hook. Classic script (file:// pages cannot load modules); everything hangs off window.FLAT2D.
// rig.js, shapes.js and ui.js add F.rig / F.shapes / F.ui; a look may add extras (looks/<kit>.js -> look.js);
// a package may add F.custom[fn] (custom.js). Drawing basics only: no scenes, no named characters.
'use strict';
(function () {
const F = window.FLAT2D = window.FLAT2D || {};
F.custom = F.custom || {};
F.extras = F.extras || {};

// ---------- math / easing ----------
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const inv = (a, b, x) => (b === a ? (x >= b ? 1 : 0) : clamp((x - a) / (b - a)));
const E = {
  lin: t => t,
  inQ: t => t * t,
  outQ: t => 1 - (1 - t) * (1 - t),
  ioQ: t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  inC: t => t * t * t,
  outC: t => 1 - Math.pow(1 - t, 3),
  ioC: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  ioS: t => -(Math.cos(Math.PI * t) - 1) / 2,
  outE: t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t),
  ioE: t => t <= 0 ? 0 : t >= 1 ? 1 : t < .5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  outB: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  inE: t => t <= 0 ? 0 : Math.pow(2, 10 * t - 10),
  inB: t => { const c1 = 1.70158; return (c1 + 1) * t * t * t - c1 * t * t; },
  ioB: t => { const c2 = 1.70158 * 1.525; return t < .5 ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2 : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2; },
  outEl: t => t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1,
  outBo: t => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375; return n * (t -= 2.625 / d) * t + 0.984375; },
  step: t => t < 1 ? 0 : 1,
};
Object.assign(E, { linear: E.lin, in: E.inC, out: E.outC, io: E.ioC });
function ease(name, where) {
  if (name == null) return E.ioC;
  const f = E[name];
  if (!f) throw new Error(`${where}: unknown ease "${name}" (use ${Object.keys(E).join('|')})`);
  return f;
}
const k = (x, a, b, e = E.ioC) => e(inv(a, b, x));
const pop = (x, a, d = 0.38) => x <= a ? 0 : E.outB(inv(a, a + d, x));
function rng(seed) { // mulberry32
  let a = (typeof seed === 'string' ? hashStr(seed) : seed) >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function noise1(x, seed = 0) {
  const h = n => { const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return s - Math.floor(s); };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u) * 2 - 1;
}
const D2R = Math.PI / 180;

// ---------- colour ----------
function hex2rgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function rgba(h, a) { if (h[0] !== '#') return h; const [r, g, b] = hex2rgb(h); return `rgba(${r},${g},${b},${a})`; }
function mix(h1, h2, t) { const a = hex2rgb(h1), b = hex2rgb(h2); return '#' + a.map((v, i) => Math.round(lerp(v, b[i], t)).toString(16).padStart(2, '0')).join(''); }
const shade = (h, t) => h[0] !== '#' ? h : t >= 0 ? mix(h, '#ffffff', t) : mix(h, '#000000', -t);
// "@token" -> look palette; hex / rgb() / named pass through. Unknown tokens throw (caller adds the item name).
function col(c, fallback) {
  if (c == null || c === '') return fallback;
  if (typeof c !== 'string') throw new Error(`colour must be a string, got ${JSON.stringify(c)}`);
  if (c[0] === '@') {
    const v = F.look.palette[c.slice(1)];
    if (!v) throw new Error(`unknown colour token "${c}" (look palette has ${Object.keys(F.look.palette).join(', ')})`);
    return v;
  }
  return c;
}

// ---------- primitives ----------
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function circ(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2); }
function ell(ctx, x, y, rx, ry, rot = 0) { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), rot, 0, Math.PI * 2); }
function fillC(ctx, x, y, r, c) { circ(ctx, x, y, r); ctx.fillStyle = c; ctx.fill(); }
function fillE(ctx, x, y, rx, ry, c, rot = 0) { ell(ctx, x, y, rx, ry, rot); ctx.fillStyle = c; ctx.fill(); }
function fillRR(ctx, x, y, w, h, r, c) { rr(ctx, x, y, w, h, r); ctx.fillStyle = c; ctx.fill(); }
function poly(ctx, pts, close = true) { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); if (close) ctx.closePath(); }
function line(ctx, x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
function stroke(ctx, c, w, cap = 'round') { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = cap; ctx.lineJoin = 'round'; ctx.stroke(); }
function smoothPath(ctx, pts, closed = true, tension = 0.5) {
  const n = pts.length; ctx.beginPath();
  const P = i => closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)];
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) * tension / 3, p1[1] + (p2[1] - p0[1]) * tension / 3, p2[0] - (p3[0] - p1[0]) * tension / 3, p2[1] - (p3[1] - p1[1]) * tension / 3, p2[0], p2[1]);
  }
  if (closed) ctx.closePath();
}
function polyLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
function partial(pts, p) {
  if (p >= 1) return pts.slice(); if (p <= 0) return [pts[0]];
  const L = polyLen(pts) * p; let acc = 0; const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + d >= L) { const f = d ? (L - acc) / d : 0; out.push([lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f)]); return out; }
    acc += d; out.push(pts[i]);
  }
  return out;
}
function drawOn(ctx, pts, p, c, w, close = false) {
  if (p <= 0 || pts.length < 2) return;
  poly(ctx, partial(close ? pts.concat([pts[0]]) : pts, p), false); stroke(ctx, c, w);
}
function bez(p0, p1, p2, n = 32) { const o = []; for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; o.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]); } return o; }
function glowDot(ctx, x, y, r, c, a = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(c, 0.55 * a)); g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
function sparkle(ctx, x, y, s, a = 1, c = '#fff') {
  if (a <= 0 || s <= 0) return; ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = c; ctx.beginPath();
  ctx.moveTo(x, y - s); ctx.quadraticCurveTo(x, y, x + s, y); ctx.quadraticCurveTo(x, y, x, y + s); ctx.quadraticCurveTo(x, y, x - s, y); ctx.quadraticCurveTo(x, y, x, y - s); ctx.fill(); ctx.restore();
}
// full-size offscreen canvases, reused
const _pool = {};
function layerCanvas(name, w, h) {
  let c = _pool[name];
  if (!c || c.width !== w || c.height !== h) { c = document.createElement('canvas'); c.width = w; c.height = h; _pool[name] = c; }
  const x = c.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none'; x.clearRect(0, 0, w, h);
  return [c, x];
}

// ---------- keyframes ----------
// keys: [[t, v, ease?], ...] (ease of the arriving key). Before the first key: first value; after the last: last.
function track(keys, t, where) {
  if (!Array.isArray(keys) || !keys.length) throw new Error(`${where}: keyframes must be a non-empty array of [t, value, ease]`);
  if (typeof keys[0] === 'number') return keys[0] === keys[0] && keys.length === 1 ? keys[0] : keys[0]; // bare number list: constant
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t < b[0]) return lerp(a[1], b[1], ease(b[2], where)(inv(a[0], b[0], t)));
  }
  return keys[keys.length - 1][1];
}
// object keyframes (camera): each key may set only some fields; missing fields carry over from the previous key.
function trackObj(keys, t, base, where) {
  if (!keys || !keys.length) return { ...base };
  const full = []; let cur = { ...base };
  for (const kf of keys) { cur = { ...cur, ...kf[1] }; full.push([kf[0], cur, kf[2]]); }
  if (t <= full[0][0]) return { ...full[0][1] };
  for (let i = 1; i < full.length; i++) {
    const a = full[i - 1], b = full[i];
    if (t < b[0]) { const p = ease(b[2], where)(inv(a[0], b[0], t)); const o = {}; for (const f in b[1]) o[f] = lerp(a[1][f], b[1][f], p); return o; }
  }
  return { ...full[full.length - 1][1] };
}

// ---------- camera ----------
// cam = {x, y, zoom, rot(deg)}: world point (x, y) at screen centre. depth 0 = screen-locked, 1 = moves with actors.
function applyCam(ctx, cam, depth = 1) {
  const W = F.W, H = F.H;
  const z = 1 + (cam.zoom - 1) * depth;
  const x = W / 2 + (cam.x - W / 2) * depth, y = H / 2 + (cam.y - H / 2) * depth;
  ctx.translate(W / 2, H / 2); if (cam.rot) ctx.rotate(cam.rot * D2R * depth); ctx.scale(z, z); ctx.translate(-x, -y);
}
function camAt(spec, t, where) {
  const W = F.W, H = F.H;
  const cam = trackObj(spec.camera, t, { x: W / 2, y: H / 2, zoom: 1, rot: 0 }, `${where} camera`);
  // gentle hand-held drift from the look
  const dr = F.look.motion.drift ?? 0;
  if (dr) { cam.x += noise1(t * 0.35, 1) * dr; cam.y += noise1(t * 0.3, 9) * dr; }
  // a look whose camera never stops: a slow push-in on top of the spec's camera (look.motion.push = zoom per 10 s)
  const push = F.look.motion.push ?? 0;
  if (push) cam.zoom *= 1 + push * t / 10;
  for (const s of spec.shake || []) { // [t, dur, amplitude px]
    const [t0, dur, amp] = s;
    if (t >= t0 && t < t0 + dur) { const f = (1 - (t - t0) / dur) * amp; cam.x += noise1(t * 40, 3) * f; cam.y += noise1(t * 40, 7) * f; }
  }
  return cam;
}

// ---------- QA hook ----------
// Boxes are in design pixels (video.size), axis-aligned, after camera and item transforms.
const QA = { texts: [], items: [], counters: [], stack: [] };
function screenBox(ctx, x, y, w, h) {
  const m = ctx.getTransform(), b = F.base;
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => [(m.a * px + m.c * py + m.e) / b, (m.b * px + m.d * py + m.f) / b]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0];
}
function grow(box) {
  const cur = QA.stack[QA.stack.length - 1]; if (!cur) return;
  if (!cur.box) { cur.box = box.slice(); return; }
  const b = cur.box, x0 = Math.min(b[0], box[0]), y0 = Math.min(b[1], box[1]);
  cur.box = [x0, y0, Math.max(b[0] + b[2], box[0] + box[2]) - x0, Math.max(b[1] + b[3], box[1] + box[3]) - y0];
}
function qaGrow(ctx, x, y, w, h) { grow(screenBox(ctx, x, y, w, h)); }
function qaText(ctx, str, x, y, w, h, size) {
  if (ctx.globalAlpha < 0.05 || F._noQA) return;
  const m = ctx.getTransform(), s = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) / F.base;
  const box = screenBox(ctx, x, y, w, h);
  QA.texts.push({ str, box: box.map(v => Math.round(v)), size: Math.round(size * s * 10) / 10 });
  grow(box);
}

// ---------- the interpreter ----------
const ITEM_TYPES = ['actor', 'prop', 'image', 'text', 'label', 'pill', 'tag', 'board', 'counter', 'quote', 'card', 'map', 'arrow', 'web', 'chart', 'split', 'custom'];
const HOWS = ['pop', 'fade', 'slide-l', 'slide-r', 'slide-u', 'slide-d', 'draw', 'wipe', 'type', 'grow'];
const FX = ['flash', 'whoosh-lines', 'confetti', 'dust', 'rain', 'stars', 'smoke', 'sparkle'];
// types that animate their own content from a 0..1 reveal for "draw" / "type"; the rest fall back to a wipe
const REVEALS = { type: ['text', 'label', 'quote', 'pill', 'tag'], draw: ['arrow', 'map', 'web', 'chart', 'board', 'label'] };
const itemName = it => `item "${it.id ?? '?'}" (${it.type})`;

function lookupSet(id, where) {
  if (id == null) return null;
  if (typeof id === 'object') return id;
  const s = F.video.sets && F.video.sets[id];
  if (!s) throw new Error(`${where}: unknown set "${id}" (video.json sets: ${Object.keys(F.video.sets || {}).join(', ') || 'none'})`);
  return s;
}
function lookupProp(id, where) {
  if (typeof id === 'object') return id;
  const p = F.video.props && F.video.props[id];
  if (!p) throw new Error(`${where}: unknown prop "${id}" (video.json props: ${Object.keys(F.video.props || {}).join(', ') || 'none'})`);
  return p;
}
function lookupCast(id, where) {
  const c = F.video.cast && F.video.cast[id];
  if (!c) throw new Error(`${where}: unknown cast "${id}" (video.json cast: ${Object.keys(F.video.cast || {}).join(', ') || 'none'})`);
  return c;
}
function lookupImage(id, where) {
  const im = F.images[id];
  if (!im) throw new Error(`${where}: unknown image "${id}" (video.json images: ${Object.keys(F.video.images || {}).join(', ') || 'none'})`);
  return im;
}

// ---------- validation: every id and enum is checked before the first frame; errors name the item ----------
function checkScene(spec, where) {
  if (!spec || typeof spec !== 'object') throw new Error(`${where}: spec must be an object`);
  if (spec.set != null) { const s = lookupSet(spec.set, where); F.shapes.checkSet(s, `${where} set`); }
  (spec.camera || []).forEach(kf => { if (!Array.isArray(kf) || typeof kf[0] !== 'number' || typeof kf[1] !== 'object') throw new Error(`${where}: camera keys are [t, {x,y,zoom,rot}, ease]`); ease(kf[2], `${where} camera`); });
  (spec.shake || []).forEach(s => { if (!Array.isArray(s) || s.length < 3) throw new Error(`${where}: shake entries are [t, dur, amplitude]`); });
  (spec.fx || []).forEach((f, i) => { if (!FX.includes(f.kind)) throw new Error(`${where}: fx[${i}] unknown kind "${f.kind}" (use ${FX.join('|')})`); });
  const ids = new Set();
  (spec.items || []).forEach(it => checkItem(it, where, ids));
}
function checkItem(it, where, ids) {
  const nm = `${where} ${itemName(it)}`;
  if (!ITEM_TYPES.includes(it.type)) throw new Error(`${where}: item "${it.id ?? '?'}" has unknown type "${it.type}" (use ${ITEM_TYPES.join('|')})`);
  if (it.id != null) { if (ids.has(it.id)) throw new Error(`${nm}: duplicate id`); ids.add(it.id); }
  for (const key of ['enter', 'exit']) {
    const e = it[key]; if (!e) continue;
    if (!HOWS.includes(e.how)) throw new Error(`${nm}: ${key}.how "${e.how}" unknown (use ${HOWS.join('|')})`);
    if (typeof e.t !== 'number') throw new Error(`${nm}: ${key}.t must be a number (seconds from scene start)`);
  }
  if (it.anim) for (const [f, keys] of Object.entries(it.anim)) {
    if (!['x', 'y', 'dx', 'dy', 'scale', 'rot', 'opacity'].includes(f)) throw new Error(`${nm}: anim.${f} unknown (use x|y|dx|dy|scale|rot|opacity)`);
    keys.forEach(kf => ease(kf[2], `${nm} anim.${f}`));
  }
  try {
    switch (it.type) {
      case 'actor': lookupCast(it.cast, nm); F.rig.check(it, nm); break;
      case 'prop': F.shapes.check(it.shape || lookupProp(it.prop, nm), nm); break;
      case 'image': lookupImage(it.image, nm); F.ui.checkImage(it, nm); break;
      case 'card': lookupCast(it.cast, nm); break;
      case 'board': (it.items || []).forEach(c => checkItem(c, `${nm} >`, ids)); break;
      case 'split': if (!it.left || !it.right) throw new Error(`${nm}: split needs left and right SceneSpecs`); checkScene(it.left, `${nm} left`); checkScene(it.right, `${nm} right`); break;
      case 'web': (it.nodes || []).forEach(n => n.cast && lookupCast(n.cast, nm)); (it.links || []).forEach(l => { const has = id => (it.nodes || []).some(n => n.id === id); if (!has(l[0]) || !has(l[1])) throw new Error(`${nm}: link [${l[0]}, ${l[1]}] names a node that does not exist`); }); break;
      case 'map': F.ui.checkMap(it, nm); break;
      case 'chart': if (!['bar', 'line', 'pie'].includes(it.kind)) throw new Error(`${nm}: chart kind "${it.kind}" unknown (use bar|line|pie)`); if (!Array.isArray(it.data) || !it.data.length) throw new Error(`${nm}: chart data must be a non-empty array`); break;
      case 'counter': if (typeof it.to !== 'number') throw new Error(`${nm}: counter needs a numeric "to"`); break;
      case 'arrow': if (!it.from || !it.to) throw new Error(`${nm}: arrow needs from and to`); break;
      case 'custom': if (typeof F.custom[it.fn] !== 'function') throw new Error(`${nm}: custom fn "${it.fn}" is not defined in the package's custom.js (FLAT2D.custom has: ${Object.keys(F.custom).join(', ') || 'nothing'})`); break;
      case 'text': case 'label': case 'pill': case 'tag': case 'quote': if (typeof it.str !== 'string') throw new Error(`${nm}: needs a "str"`); break;
    }
    for (const c of ['fill', 'color']) if (it[c]) col(it[c]);
  } catch (e) {
    throw new Error(e.message.startsWith(where) ? e.message : `${nm}: ${e.message}`);
  }
}

// ---------- item rendering ----------
// Enter/exit presets turn a 0..1 progress into transform/alpha/reveal changes.
function applyHow(st, how, p) {
  const e = E.outC(p);
  switch (how) {
    case 'pop': st.s *= E.outB(p); st.a *= clamp(p * 3); break;
    case 'fade': st.a *= E.outQ(p); break;
    case 'grow': st.s *= e; break;
    case 'slide-l': st.dx -= (1 - e) * 320; st.a *= clamp(p * 2); break;
    case 'slide-r': st.dx += (1 - e) * 320; st.a *= clamp(p * 2); break;
    case 'slide-u': st.dy -= (1 - e) * 200; st.a *= clamp(p * 2); break;
    case 'slide-d': st.dy += (1 - e) * 200; st.a *= clamp(p * 2); break;
    case 'wipe': st.wipe = Math.min(st.wipe, E.ioC(p)); break;
    case 'draw': case 'type':
      if (REVEALS[how].includes(st.type)) st.reveal = Math.min(st.reveal, how === 'type' ? p : E.ioS(p));
      else st.wipe = Math.min(st.wipe, E.ioC(p));
      break;
  }
}
function itemState(it, t, nm) {
  const mo = F.look.motion;
  const st = { type: it.type, x: it.at ? it.at[0] : 0, y: it.at ? it.at[1] : 0, s: it.scale ?? 1, r: it.rot ?? 0, a: 1, dx: 0, dy: 0, reveal: 1, wipe: 1 };
  const en = it.enter, ex = it.exit;
  if (en) { if (t < en.t) return null; applyHow(st, en.how, inv(en.t, en.t + (en.dur ?? mo.in), t)); }
  if (ex && t >= ex.t) { const p = inv(ex.t, ex.t + (ex.dur ?? mo.out), t); if (p >= 1) return null; applyHow(st, ex.how, 1 - p); }
  const an = it.anim;
  if (an) {
    if (an.x) st.x = track(an.x, t, `${nm} anim.x`);
    if (an.y) st.y = track(an.y, t, `${nm} anim.y`);
    if (an.dx) st.dx += track(an.dx, t, `${nm} anim.dx`);
    if (an.dy) st.dy += track(an.dy, t, `${nm} anim.dy`);
    if (an.scale) st.s *= track(an.scale, t, `${nm} anim.scale`);
    if (an.rot) st.r += track(an.rot, t, `${nm} anim.rot`);
    if (an.opacity) st.a *= clamp(track(an.opacity, t, `${nm} anim.opacity`));
  }
  if (st.a <= 0.001 || st.s <= 0.001 || st.wipe <= 0.001) return null;
  return st;
}

function drawItem(ctx, it, t, env) {
  const nm = `${env.where} ${itemName(it)}`;
  const st = itemState(it, t, nm);
  if (!st) return;
  const rec = { id: env.prefix + (it.id ?? `#${env.idx}`), type: it.type, box: null };
  QA.stack.push(rec);
  const body = (c) => {
    c.save();
    if (env.cam) applyCam(c, env.cam, it.depth ?? 1);
    if (it.type === 'actor') { st.base = [st.x, st.y]; const p = F.rig.position(it, t, st.base); st.x = p[0]; st.y = p[1]; }
    c.translate(st.x + st.dx, st.y + st.dy);
    if (st.r) c.rotate(st.r * D2R);
    if (st.s !== 1) c.scale(st.s, st.s);
    c.globalAlpha *= st.a;
    try { RENDER[it.type](c, it, t, st, env, nm); }
    catch (e) { throw new Error(e.message.includes(nm) ? e.message : `${nm}: ${e.message}`); }
    c.restore();
  };
  if (st.wipe < 1) {
    // draw into a layer, then reveal its bounding box left to right
    const [cv, x] = layerCanvas('wipe', ctx.canvas.width, ctx.canvas.height);
    x.setTransform(ctx.getTransform());
    body(x);
    if (rec.box) {
      const b = F.base, [bx, by, bw, bh] = rec.box.map(v => v * b), pad = 40 * b;
      const w = (bw + pad * 2) * st.wipe;
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (w > 0.5) ctx.drawImage(cv, bx - pad, by - pad, w, bh + pad * 2, bx - pad, by - pad, w, bh + pad * 2);
      ctx.restore();
    }
  } else body(ctx);
  QA.stack.pop();
  if (rec.box) { rec.box = rec.box.map(v => Math.round(v)); QA.items.push(rec); }
}

const RENDER = {
  actor: (c, it, t, st, env, nm) => F.rig.drawActor(c, it, t, env, nm, st.base),
  prop: (c, it, t, st, env, nm) => {
    const sh = it.shape || lookupProp(it.prop, nm), [w, h] = sh.box || [100, 100];
    // a prop's "at" is the bottom centre of its box (it stands on y like an actor)
    c.translate(-w / 2, -h); F.shapes.draw(c, sh, t, nm); qaGrow(c, 0, 0, w, h);
  },
  image: (c, it, t, st, env, nm) => F.ui.image(c, it, t, env, nm),
  text: (c, it, t, st) => F.ui.textItem(c, it, t, st),
  label: (c, it, t, st) => F.ui.labelItem(c, it, t, st),
  pill: (c, it, t, st) => F.ui.pillItem(c, it, t, st),
  tag: (c, it, t, st) => F.ui.tagItem(c, it, t, st),
  board: (c, it, t, st, env, nm) => F.ui.board(c, it, t, st, env, nm, drawItem),
  counter: (c, it, t, st) => F.ui.counter(c, it, t, st),
  quote: (c, it, t, st) => F.ui.quote(c, it, t, st),
  card: (c, it, t, st, env, nm) => F.ui.card(c, it, t, st, env, nm),
  map: (c, it, t, st, env, nm) => F.ui.map(c, it, t, st, nm),
  arrow: (c, it, t, st) => F.ui.arrow(c, it, t, st),
  web: (c, it, t, st, env, nm) => F.ui.web(c, it, t, st, env, nm),
  chart: (c, it, t, st) => F.ui.chart(c, it, t, st),
  split: (c, it, t, st, env, nm) => {
    const W = F.W, H = F.H, gap = it.gap ?? 14, half = (W - gap) / 2;
    [['left', 0], ['right', half + gap]].forEach(([side, x0]) => {
      c.save(); c.beginPath(); c.rect(x0, 0, half, H); c.clip();
      c.translate(x0 + half / 2 - W / 2, 0);
      renderScene(c, it[side], t, { where: `${nm} ${side}`, prefix: `${rec_id(it)}.${side}.`, nested: true });
      c.restore();
      qaGrow(c, x0, 0, half, H);
    });
    if (gap > 0) { c.fillStyle = col(it.divider, F.look.palette.ink); c.fillRect(half, 0, gap, H); }
  },
  custom: (c, it, t, st, env, nm) => {
    const fn = F.custom[it.fn];
    if (typeof fn !== 'function') throw new Error(`custom fn "${it.fn}" is not defined in custom.js`);
    fn(c, t, it.params || {}, F.api, { item: it, reveal: st.reveal, grow: (x, y, w, h) => qaGrow(c, x, y, w, h) });
  },
};
const rec_id = it => it.id ?? 'split';

// ---------- sets ----------
function drawSetBack(ctx, set, cam, t, where) {
  const W = F.W, H = F.H, P = F.look.palette;
  ctx.save();
  if (set && set.board) F.ui.boardBG(ctx);
  else if (set && set.sky) {
    const sky = Array.isArray(set.sky) ? set.sky : [set.sky, set.sky];
    const g = ctx.createLinearGradient(0, 0, 0, H);
    sky.forEach((c, i) => g.addColorStop(sky.length === 1 ? 0 : i / (sky.length - 1), col(c)));
    ctx.fillStyle = g; ctx.fillRect(-W, -H, W * 3, H * 3);
  } else if (set && set.bg) { ctx.fillStyle = col(set.bg); ctx.fillRect(-W, -H, W * 3, H * 3); }
  else F.ui.boardBG(ctx);
  ctx.restore();
  if (F.extras.setBack) { ctx.save(); F.extras.setBack(ctx, set, cam, t, where); ctx.restore(); } // look atmosphere (bokeh, stars, glows)
  if (!set) return;
  const layers = (set.layers || []).map((l, i) => ({ l, i })).sort((a, b) => (a.l.depth ?? 0.5) - (b.l.depth ?? 0.5) || a.i - b.i);
  const back = layers.filter(o => (o.l.depth ?? 0.5) < 1 && !o.l.front), front = layers.filter(o => !back.includes(o));
  const drawLayer = ({ l, i }) => {
    const sh = l.shape || (l.prop != null ? lookupProp(l.prop, `${where} set layer ${i}`) : null);
    if (!sh) throw new Error(`${where} set layer ${i}: needs "shape" or "prop"`);
    ctx.save(); applyCam(ctx, cam, l.depth ?? 0.5);
    if (l.blur) ctx.filter = `blur(${l.blur * F.base}px)`; // depth of field: far / near layers out of focus
    const reps = l.repeat ? l.repeat : [0, 1];   // optional [dx, count]: tile a layer horizontally
    for (let r = 0; r < (reps[1] || 1); r++) {
      ctx.save(); ctx.translate((l.at ? l.at[0] : 0) + r * reps[0], l.at ? l.at[1] : 0); if (l.scale) ctx.scale(l.scale, l.scale);
      F.shapes.draw(ctx, sh, t, `${where} set layer ${i}`); ctx.restore();
    }
    ctx.restore();
  };
  back.filter(o => (o.l.depth ?? 0.5) < (set.ground ? set.ground.depth ?? 0.9 : 2)).forEach(drawLayer);
  if (set.ground) {
    ctx.save(); applyCam(ctx, cam, set.ground.depth ?? 1);
    ctx.fillStyle = col(set.ground.color, P.ground || '#c98f6a'); ctx.fillRect(-W * 2, set.ground.y, W * 5, H * 3);
    if (set.ground.line) { ctx.fillStyle = col(set.ground.line); ctx.fillRect(-W * 2, set.ground.y, W * 5, 6); }
    ctx.restore();
  }
  back.filter(o => (o.l.depth ?? 0.5) >= (set.ground ? set.ground.depth ?? 0.9 : 2)).forEach(drawLayer);
  return front.length ? () => front.forEach(drawLayer) : null;
}
function drawSetLight(ctx, set) {
  const v = set && set.light ? set.light.vignette ?? 0 : 0;
  if (v > 0) F.ui.vignette(ctx, v);
}

// ---------- fx ----------
function drawFx(ctx, fxs, t, cam, where) {
  const W = F.W, H = F.H;
  (fxs || []).forEach((f, i) => {
    const dur = f.dur ?? 0.6, p = (t - f.t) / dur;
    if (p < 0 || p >= 1) return;
    const [x, y] = f.at || [W / 2, H / 2], R = rng(hashStr(`${where}fx${i}`)), c = col(f.color, '#ffffff');
    ctx.save();
    if (f.kind !== 'flash' && f.kind !== 'rain' && f.kind !== 'whoosh-lines') applyCam(ctx, cam, f.depth ?? 1);
    switch (f.kind) {
      case 'flash': ctx.fillStyle = rgba(c, 0.85 * (1 - E.outQ(p))); ctx.fillRect(-W, -H, W * 3, H * 3); break;
      case 'whoosh-lines': for (let j = 0; j < 22; j++) {
        const ly = R() * H, len = 200 + R() * 500, sp = (R() * 0.5 + 0.75) * W * 1.8, lx = W + 200 - (p * sp + R() * W) % (W + 800) * (f.dir === 'r' ? -1 : 1);
        ctx.globalAlpha = 0.55 * Math.sin(Math.PI * p); line(ctx, lx, ly, lx + len, ly); stroke(ctx, c, 3 + R() * 4);
      } break;
      case 'confetti': { const cols = F.look.confetti || ['#e8574e', '#f5c26b', '#7cc3e6', '#ffffff', '#8bd17c'];
        for (let j = 0; j < 90; j++) {
          const sx = x + (R() - 0.5) * 900, vy = 300 + R() * 500, vx = (R() - 0.5) * 500, tt = p * dur;
          const px = sx + vx * tt, py = y - 380 + R() * 120 + vy * tt + 300 * tt * tt;
          ctx.save(); ctx.translate(px, py); ctx.rotate(R() * 6 + tt * (R() * 12 - 6)); ctx.globalAlpha = 1 - clamp((p - 0.75) * 4);
          ctx.fillStyle = cols[j % cols.length]; ctx.fillRect(-7, -4, 14, 8); ctx.restore();
        } } break;
      case 'dust': case 'smoke': { const smoke = f.kind === 'smoke', base = smoke ? '#cfd3da' : '#e9dcc4';
        for (let j = 0; j < (smoke ? 12 : 9); j++) {
          const a = smoke ? -Math.PI / 2 + (R() - 0.5) * 0.9 : R() * Math.PI, d = (smoke ? 220 : 120) * E.outC(p) * (0.4 + R() * 0.8);
          const r = (smoke ? 34 : 24) * (0.5 + R() * 0.7) * (smoke ? 0.6 + p : 1 - p * 0.5);
          ctx.globalAlpha = (1 - p) * (smoke ? 0.55 : 0.8); fillC(ctx, x + Math.cos(a) * d * (smoke ? 0.6 : 1.4), y + Math.sin(a) * d * (smoke ? 1 : -0.35), r, f.color ? c : base);
        } } break;
      case 'rain': { ctx.globalAlpha = 0.5 * Math.min(1, p * 6, (1 - p) * 6);
        for (let j = 0; j < 140; j++) { const rx = R() * (W + 300) - 150, ry = ((R() * H + t * 1400 * (0.8 + R() * 0.4)) % (H + 100)) - 50; line(ctx, rx, ry, rx - 12, ry + 38); stroke(ctx, f.color ? c : '#bcd3f0', 2.5); } } break;
      case 'stars': case 'sparkle': { const n = f.kind === 'stars' ? 14 : 7, spread = f.kind === 'stars' ? 360 : 140;
        for (let j = 0; j < n; j++) {
          const sx = x + (R() - 0.5) * spread * 2, sy = y + (R() - 0.5) * spread, ph = R();
          const q = clamp((p - ph * 0.4) / 0.5); if (q <= 0 || q >= 1) continue;
          sparkle(ctx, sx, sy, (f.kind === 'stars' ? 14 : 24) * Math.sin(Math.PI * q) * (0.6 + R() * 0.6), 1, f.color ? c : (j % 3 ? '#ffffff' : '#f5c26b'));
        } } break;
    }
    ctx.restore();
  });
}

// ---------- scene ----------
function renderScene(ctx, spec, t, env) {
  const where = env.where;
  const cam = camAt(spec, t, where);
  const set = lookupSet(spec.set, where);
  const front = drawSetBack(ctx, set, cam, t, where);
  const sub = { ...env, cam, set, rim: set && set.light ? set.light.rim ?? 'warm' : 'warm' };
  const items = (spec.items || []).map((it, i) => ({ it, i })).sort((a, b) => (a.it.z ?? 0) - (b.it.z ?? 0) || a.i - b.i);
  for (const { it, i } of items) drawItem(ctx, it, t, { ...sub, idx: i });
  if (front) front();
  drawSetLight(ctx, set);
  drawFx(ctx, spec.fx, t, cam, where);
}

// ---------- finish: letterbox, vignette, grain ----------
let grains = null;
function finish(ctx, t) {
  const L = F.look, W = F.W, H = F.H, fin = L.finish || {};
  if (F.extras.finish) { ctx.save(); F.extras.finish(ctx, t); ctx.restore(); } // look finish (bloom, tinted vignette)
  if (fin.vignette) F.ui.vignette(ctx, fin.vignette);
  if (fin.grain) {
    if (!grains) {
      const R = rng(4242);
      grains = [0, 1, 2, 3].map(() => {
        const c = document.createElement('canvas'); c.width = 480; c.height = 270; const x = c.getContext('2d'), im = x.createImageData(480, 270);
        for (let i = 0; i < im.data.length; i += 4) { const v = R() * 255 | 0; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
        x.putImageData(im, 0, 0); return c;
      });
    }
    ctx.save(); ctx.globalAlpha = fin.grain; ctx.globalCompositeOperation = 'overlay';
    ctx.drawImage(grains[Math.floor(t * (F.fps || 30)) % 4], 0, 0, W, H); ctx.restore();
  }
  const bar = L.letterbox || 0;
  if (bar) { ctx.fillStyle = L.palette.bar || '#000'; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar); }
}

// blank = the frame's luma range on a 32x18 thumbnail is tiny (nothing but a flat fill)
function isBlank(canvas) {
  const [, x] = layerCanvas('qa-thumb', 32, 18);
  x.drawImage(canvas, 0, 0, 32, 18);
  const d = x.getImageData(0, 0, 32, 18).data; let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; lo = Math.min(lo, y); hi = Math.max(hi, y); }
  return hi - lo < 10;
}

// ---------- public API ----------
F.init = function (canvas, scene) {
  const props = scene.props || {};
  if (!props.video || !props.spec) throw new Error('scene props must be {video, spec} (built by tools/build-package.mjs)');
  F.look = scene.tokens; F.video = props.video; F.spec = props.spec; F.duration = scene.duration; F.fps = scene.fps;
  if (!F.look || !F.look.palette) throw new Error('tokens.json is not a flat2d look (needs palette, rig, fonts)');
  const size = F.video.size || [1920, 1080];
  F.W = size[0]; F.H = size[1];
  canvas.width = scene.width || F.W; canvas.height = scene.height || F.H;
  F.base = canvas.width / F.W;
  F.ctx = canvas.getContext('2d');
  F.where = `scene ${scene.n ?? '?'}`;
  // images: data: URIs only (no network at render time)
  F.images = {};
  const loads = Object.entries(F.video.images || {}).map(([id, src]) => {
    if (typeof src !== 'string' || !src.startsWith('data:')) throw new Error(`video image "${id}" must be a data: URI (render time has no network)`);
    const im = new Image(); F.images[id] = im; im.src = src; return im.decode();
  });
  checkScene(F.spec, F.where);
  return Promise.all(loads);
};
F.seek = function (t) {
  const ctx = F.ctx, b = F.base;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = F.look.palette.bg || '#000'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  QA.texts = []; QA.items = []; QA.counters = []; QA.stack = [];
  ctx.setTransform(b, 0, 0, b, 0, 0);
  renderScene(ctx, F.spec, t, { where: F.where, prefix: '', nested: false });
  ctx.setTransform(b, 0, 0, b, 0, 0); ctx.globalAlpha = 1;
  finish(ctx, t);
  window.__qa = { texts: QA.texts, items: QA.items, counters: QA.counters, blank: isBlank(ctx.canvas) };
};

Object.assign(F, {
  clamp, lerp, inv, E, ease, k, pop, rng, hashStr, noise1, D2R,
  hex2rgb, rgba, mix, shade, col,
  rr, circ, ell, fillC, fillE, fillRR, poly, line, stroke, smoothPath, polyLen, partial, drawOn, bez, glowDot, sparkle, layerCanvas,
  track, trackObj, applyCam, qaGrow, QA, qaText, lookupCast, lookupProp, lookupImage, renderScene, drawItem,
  ITEM_TYPES, HOWS, FX,
});
// what custom.js functions get as `api`
F.api = new Proxy({}, { get: (_, key) => key === 'rig' ? F.rig : key === 'shapes' ? F.shapes : key === 'ui' ? F.ui : key === 'look' ? F.look : key === 'video' ? F.video : F[key] });
})();
