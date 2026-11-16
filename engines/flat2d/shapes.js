// shapes.js — ShapeSpec renderer: props, set layers, accessories and icons drawn as data.
// { box:[w,h], parts:[ {rect|circle|ellipse|path|poly|line|text|image|group, fill, stroke, lw, opacity, rot, anim}, ... ] }
// Local units are px inside the box (origin top-left). rot is in degrees. anim keys use scene time.
'use strict';
(function () {
const F = window.FLAT2D;
const KINDS = ['rect', 'circle', 'ellipse', 'path', 'poly', 'line', 'text', 'image', 'group'];
const paths = new Map();
const path2d = d => { let p = paths.get(d); if (!p) { p = new Path2D(d); paths.set(d, p); } return p; };

function kindOf(p, where) {
  const ks = KINDS.filter(k => p[k] !== undefined);
  if (ks.length !== 1) throw new Error(`${where}: shape part needs exactly one of ${KINDS.join('|')} (got keys ${Object.keys(p).join(', ')})`);
  return ks[0];
}
function check(sh, where) {
  if (!sh || !Array.isArray(sh.parts)) throw new Error(`${where}: shape needs "parts": [...]`);
  const walk = (parts, w) => parts.forEach((p, i) => {
    const k = kindOf(p, `${w} part ${i}`);
    if (k === 'group') walk(p.group, `${w} part ${i}`);
    if (k === 'image') F.lookupImage(p.image, `${w} part ${i}`);
    for (const c of ['fill', 'stroke']) if (p[c]) F.col(p[c]);
    if (p.anim) for (const [f, keys] of Object.entries(p.anim)) {
      if (!['rot', 'opacity', 'dx', 'dy', 'scale'].includes(f)) throw new Error(`${w} part ${i}: anim.${f} unknown (use rot|opacity|dx|dy|scale)`);
      keys.forEach(kf => F.ease(kf[2], `${w} part ${i} anim.${f}`));
    }
  });
  walk(sh.parts, where);
}
function checkSet(set, where) {
  (set.layers || []).forEach((l, i) => { if (l.shape) check(l.shape, `${where} layer ${i}`); else if (l.prop != null) F.lookupProp(l.prop, `${where} layer ${i}`); else throw new Error(`${where} layer ${i}: needs "shape" or "prop"`); });
  if (set.light && set.light.rim && !['warm', 'cool', 'none'].includes(set.light.rim)) throw new Error(`${where}: light.rim "${set.light.rim}" unknown (use warm|cool|none)`);
}
// the point a part rotates/scales about
function pivot(p, k) {
  if (p.pivot) return p.pivot;
  const v = p[k];
  switch (k) {
    case 'rect': return [v[0] + v[2] / 2, v[1] + v[3] / 2];
    case 'circle': case 'ellipse': return [v[0], v[1]];
    case 'line': return [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2];
    case 'poly': { const xs = v.map(q => q[0]), ys = v.map(q => q[1]); return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; }
    case 'text': return p.at || [0, 0];
    case 'image': return [p.at[0] + p.at[2] / 2, p.at[1] + p.at[3] / 2];
    default: return [0, 0];
  }
}
// "glow" / "shade" on a part are drawn by the look's extras (FLAT2D.extras.paint) from the part's Path2D
function partPath(p, k, v) {
  if (k === 'path') return path2d(v);
  const P = new Path2D();
  if (k === 'rect') P.roundRect(v[0], v[1], v[2], v[3], p.r || 0);
  else if (k === 'circle') P.arc(v[0], v[1], Math.max(0, v[2]), 0, Math.PI * 2);
  else if (k === 'ellipse') P.ellipse(v[0], v[1], Math.max(0, v[2]), Math.max(0, v[3]), 0, 0, Math.PI * 2);
  else if (k === 'line') { P.moveTo(v[0], v[1]); P.lineTo(v[2], v[3]); }
  else if (k === 'poly') { if (p.smooth) F.smoothPath(Object.assign(P, { beginPath() {} }), v, p.close !== false); else { v.forEach((q, i) => i ? P.lineTo(q[0], q[1]) : P.moveTo(q[0], q[1])); if (p.close !== false) P.closePath(); } }
  return P;
}
function paint(ctx, p, closed, k, v) {
  if ((p.glow || p.shade) && k) {
    if (typeof F.extras.paint !== 'function') throw new Error(`shape part "glow"/"shade" needs a look whose extras draw them (look "${F.look.name}" has none)`);
    return F.extras.paint(ctx, p, partPath(p, k, v), closed, k, v);
  }
  const lw = p.lw ?? F.look.lineWeight ?? 5;
  if (p.fill) { ctx.fillStyle = F.col(p.fill); (p._path ? ctx.fill(p._path) : ctx.fill()); }
  if (p.stroke) { ctx.strokeStyle = F.col(p.stroke); ctx.lineWidth = lw; ctx.lineCap = p.cap || 'round'; ctx.lineJoin = 'round'; if (p.dash) ctx.setLineDash(p.dash); (p._path ? ctx.stroke(p._path) : ctx.stroke()); ctx.setLineDash([]); }
  if (!p.fill && !p.stroke && closed) { ctx.fillStyle = F.look.palette.ink; (p._path ? ctx.fill(p._path) : ctx.fill()); }
}
function drawParts(ctx, parts, t, where) {
  parts.forEach((p, i) => {
    const k = kindOf(p, `${where} part ${i}`), v = p[k];
    ctx.save();
    if (p.opacity != null) ctx.globalAlpha *= p.opacity;
    let rot = p.rot || 0, sc = 1, dx = 0, dy = 0;
    if (p.anim) {
      const a = p.anim, w = `${where} part ${i}`;
      if (a.rot) rot += F.track(a.rot, t, `${w} anim.rot`);
      if (a.opacity) ctx.globalAlpha *= F.clamp(F.track(a.opacity, t, `${w} anim.opacity`));
      if (a.dx) dx = F.track(a.dx, t, `${w} anim.dx`);
      if (a.dy) dy = F.track(a.dy, t, `${w} anim.dy`);
      if (a.scale) sc = F.track(a.scale, t, `${w} anim.scale`);
    }
    if (k === 'group') {
      const at = p.at || [0, 0];
      ctx.translate(at[0] + dx, at[1] + dy); if (rot) ctx.rotate(rot * F.D2R); const s = (p.scale ?? 1) * sc; if (s !== 1) ctx.scale(s, s);
      drawParts(ctx, v, t, `${where} part ${i}`);
      ctx.restore(); return;
    }
    if (dx || dy) ctx.translate(dx, dy);
    if (rot || sc !== 1) { const [px, py] = pivot(p, k); ctx.translate(px, py); ctx.rotate(rot * F.D2R); ctx.scale(sc, sc); ctx.translate(-px, -py); }
    if (ctx.globalAlpha > 0.001) switch (k) {
      case 'rect': F.rr(ctx, v[0], v[1], v[2], v[3], p.r || 0); paint(ctx, p, true, k, v); break;
      case 'circle': F.circ(ctx, v[0], v[1], v[2]); paint(ctx, p, true, k, v); break;
      case 'ellipse': F.ell(ctx, v[0], v[1], v[2], v[3]); paint(ctx, p, true, k, v); break;
      case 'path': { const q = Object.assign({}, p, { _path: path2d(v) }); ctx.beginPath(); paint(ctx, q, true, k, v); break; }
      case 'poly': F.poly(ctx, v, p.close !== false); if (p.smooth) F.smoothPath(ctx, v, p.close !== false); paint(ctx, p, p.close !== false, k, v); break;
      case 'line': F.line(ctx, v[0], v[1], v[2], v[3]); paint(ctx, Object.assign({ stroke: '@ink' }, p), false, k, v); break;
      case 'text': F.ui.txt(ctx, v, p.at[0], p.at[1], { size: p.size || 32, weight: p.weight || 800, color: F.col(p.fill, '#ffffff'), align: p.align || 'center', spacing: p.spacing, qa: p.qa !== false }); break;
      case 'image': { const im = F.lookupImage(v, `${where} part ${i}`), [x, y, w, h] = p.at; F.ui.drawImageFit(ctx, im, x, y, w, h, p.fit || 'cover'); break; }
    }
    ctx.restore();
  });
}
function draw(ctx, sh, t, where) { drawParts(ctx, sh.parts, t, where); }

F.shapes = { draw, drawParts, check, checkSet, KINDS };
})();
