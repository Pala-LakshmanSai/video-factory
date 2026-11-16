// looks/kurg.js — look-only drawing extras for the kurg (Kurzgesagt-like "Flatglow") look. Drawing basics only: no
// scenes, no named characters. Ported from the Flatglow kit (style-kits/claude kurg.. style .md: tone(), body(),
// lit(), glow(), finish()). Registers on FLAT2D.extras:
//   body.blob   the rounded flat person (look.rig.body = "blob"), driven by the same ActorSpec / pose data as the stick rig
//   paint       ShapeSpec part fields "glow" (soft light halo) and "shade" (two-tone shadow + highlight crescents)
//   setBack     set atmosphere: "stars", "bokeh", "glows", "motes" (look.atmo gives the defaults)
//   finish      bloom + violet-tinted vignette (look.finish.bloom / .tint)
// and restyles three ui items in the kit's sentence case: gradient pills, line labels, solid tags.
'use strict';
(function () {
const F = window.FLAT2D;
const { clamp, lerp, rr, circ, fillC, fillE, line, stroke, rgba, rng, hashStr } = F;
const X = F.extras;

// ---------- colour: the house way to shade (darker = toward violet, lighter = toward warm) ----------
function hsl(hex) {
  let [r, g, b] = F.hex2rgb(hex).map(v => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6; }
  return [h, s, l];
}
function hex(h, s, l) {
  const f = n => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * clamp(l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
}
function tone(c, k) {
  if (typeof c !== 'string' || c[0] !== '#') return c;
  const [h, s, l] = hsl(c), to = k < 0 ? 0.75 : 0.14, a = Math.abs(k);
  let dh = to - h; if (dh > 0.5) dh -= 1; if (dh < -0.5) dh += 1;
  const nh = (h + Math.sign(dh) * Math.min(Math.abs(dh), (k < 0 ? 0.06 : 0.04) * a * 2) + 1) % 1;
  return k < 0 ? hex(nh, clamp(s + 0.08 * a), clamp(l * (1 - 0.85 * a))) : hex(nh, clamp(s - 0.05 * a), clamp(l + (1 - l) * 0.8 * a));
}
const rgbaAny = (c, a) => c[0] === '#' ? rgba(c, a) : c;
const scaleOf = ctx => { const m = ctx.getTransform(); return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); };
// additive radial light (kit glow())
function glow(ctx, x, y, r, c, op = 1) {
  if (op <= 0.001 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgbaAny(c, op)); g.addColorStop(0.25, rgbaAny(c, op * 0.55)); g.addColorStop(0.6, rgbaAny(c, op * 0.16)); g.addColorStop(1, rgbaAny(c, 0));
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; circ(ctx, x, y, r); ctx.fill(); ctx.restore();
}

// ---------- ShapeSpec parts: "glow" and "shade" ----------
// glow: true (part colour) | "#hex"/"@token" | {color, r (blur px, 36), op (0.9), halo (circle/ellipse halo x radius, 2.2; 0 = none)}
// shade: true | k (0.3) | {k, off (px, ~16 % of size), hi (+0.18 highlight; 0 = none), dir ([-0.6,-0.8] = light from top-left)}
function partSize(k, v) {
  if (k === 'rect') return Math.min(v[2], v[3]);
  if (k === 'circle') return v[2] * 2;
  if (k === 'ellipse') return 2 * Math.min(v[2], v[3]);
  const pts = k === 'poly' ? v : k === 'path' ? (v.match(/-?\d*\.?\d+/g) || []).map(Number).reduce((o, n, i) => (i % 2 ? o[o.length - 1].push(n) : o.push([n]), o), []).filter(p => p.length === 2) : null;
  if (!pts || !pts.length) return 60;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return Math.max(8, Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
}
X.paint = function (ctx, p, path, closed, k, v) {
  const fill = p.fill ? F.col(p.fill) : closed && !p.stroke ? F.look.palette.ink : null;
  const sc = p.stroke ? F.col(p.stroke) : null, lw = p.lw ?? F.look.lineWeight ?? 4;
  const strokeIt = c => { c.strokeStyle = sc; c.lineWidth = lw; c.lineCap = p.cap || 'round'; c.lineJoin = 'round'; if (p.dash) c.setLineDash(p.dash); c.stroke(path); c.setLineDash([]); };
  if (p.glow) {
    const g = typeof p.glow === 'object' ? p.glow : { color: p.glow === true ? null : p.glow };
    const c = F.col(g.color, fill || sc || '#ffffff');
    if ((k === 'circle' || k === 'ellipse') && g.halo !== 0) glow(ctx, v[0], v[1], (k === 'circle' ? v[2] : Math.max(v[2], v[3])) * (g.halo ?? 2.2), c, (g.op ?? 0.9) * 0.6);
    ctx.save(); ctx.shadowColor = rgbaAny(c, g.op ?? 0.9); ctx.shadowBlur = (g.r ?? 36) * scaleOf(ctx);
    for (let i = 0; i < 2; i++) { if (fill) { ctx.fillStyle = fill; ctx.fill(path); } if (sc) strokeIt(ctx); }
    ctx.restore();
  }
  if (fill) {
    ctx.fillStyle = fill; ctx.fill(path);
    if (p.shade) {
      const s = typeof p.shade === 'object' ? p.shade : { k: p.shade === true ? 0.3 : p.shade };
      const L = s.dir || [-0.6, -0.8], size = partSize(k, v), off = s.off ?? size * 0.16, hi = s.hi ?? 0.18, hOff = off * 0.4;
      ctx.save(); ctx.clip(path);
      const sh = new Path2D(); sh.rect(-1e5, -1e5, 2e5, 2e5); sh.addPath(path, new DOMMatrix([1, 0, 0, 1, L[0] * off, L[1] * off]));
      ctx.fillStyle = tone(fill, -(s.k ?? 0.3)); ctx.fill(sh, 'evenodd');
      if (hi) { const hp = new Path2D(path); hp.addPath(path, new DOMMatrix([1, 0, 0, 1, -L[0] * hOff, -L[1] * hOff])); ctx.fillStyle = tone(fill, hi); ctx.fill(hp, 'evenodd'); }
      ctx.restore();
    }
  }
  if (sc) strokeIt(ctx);
};

// ---------- the "blob" body: a rounded flat person ----------
function limbPts(jx, jy, a1, a2, L1, L2, dir) {
  const ex = jx + Math.sin(a1) * L1 * dir, ey = jy + Math.cos(a1) * L1;
  return [[jx, jy], [ex, ey], [ex + Math.sin(a1 + a2) * L2 * dir, ey + Math.cos(a1 + a2) * L2]];
}
function capsule(ctx, pts, w, c) { ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); stroke(ctx, c, w); }
function headPath(ctx, shape, R) {
  ctx.beginPath();
  if (shape === 'oval') ctx.ellipse(0, 0, R * 0.9, R * 1.08, 0, 0, Math.PI * 2);
  else if (shape === 'square') ctx.roundRect(-R, -R, R * 2, R * 2, R * 0.5);
  else if (shape === 'egg') { ctx.ellipse(0, 0, R * 0.86, R * 1.06, 0, Math.PI, Math.PI * 2); ctx.ellipse(0, 0, R, R, 0, 0, Math.PI); ctx.closePath(); }
  else ctx.ellipse(0, 0, R, R * 1.04, 0, 0, Math.PI * 2);
}
const DARK = '#2a1a2a', LIP = '#7a2a3a';

function drawBlob(ctx, o) {
  const { app, D, pose, face } = o, spec = F.lookupCast(o.castId, o.where);
  const skin = spec.ink ? app.ink : F.col(F.look.actor.skin, '#f2c4a0');
  const { LEG, TORSO, UA, FA, TH, SH, ARMW, LEGW, HAND, TW } = D, R = D.R;
  const breath = Math.sin((o.t || 0) * 1.6 + (hashStr(String(o.castId)) % 7)) * 1.6;
  const hipY = -LEG + (pose.bob || 0), shY = hipY - TORSO;
  const torsoC = app.kind === 'none' ? skin : app.torso, dk = tone(torsoC, -0.22);
  const sleeve = ['vest', 'dress', 'none'].includes(app.kind) ? skin : torsoC;
  const thighC = app.bottom === 'skirt' || app.kind === 'dress' ? skin : app.trousers, shinC = app.bottom === 'trousers' ? app.trousers : skin;
  const legW = LEGW * (app.bottom === 'trousers' ? 1 : 0.8);

  // ---- legs (+ shoes)
  const shoe = (x, y, dir, far) => fillE(ctx, x + dir * 8, y - 6, 19, 11, far ? tone(app.shoe, -0.12) : app.shoe);
  const drawLeg = (key, hx, far) => {
    const [h, kn] = pose[key], dir = face === 0 ? (hx < 0 ? -1 : 1) : face;
    const pts = limbPts(hx, hipY, h, -kn, TH, SH, dir), d = c => far ? tone(c, -0.14) : c;
    capsule(ctx, [pts[1], pts[2]], legW, d(shinC)); capsule(ctx, [pts[0], pts[1]], legW * (app.bottom === 'shorts' ? 1.15 : 1), d(thighC));
    shoe(pts[2][0], pts[2][1] + 4, face === 0 ? (hx < 0 ? -0.4 : 0.4) : dir, far);
  };
  if (face === 0 && pose.seat > 0.5) [-1, 1].forEach(sd => { capsule(ctx, [[sd * 20, hipY], [sd * 26, hipY + 20]], legW + 8, tone(thighC, 0.06)); capsule(ctx, [[sd * 26, hipY + 20], [sd * 28, -12]], legW, shinC); shoe(sd * 28, -2, sd * 0.4, false); });
  else if (face !== 0) { drawLeg(face > 0 ? 'll' : 'rl', 0, true); drawLeg(face > 0 ? 'rl' : 'll', 0, false); }
  else { drawLeg('ll', -TW * 0.2, false); drawLeg('rl', TW * 0.2, false); }

  // lean about the hip
  ctx.translate(0, hipY); ctx.rotate((pose.lean || 0) * (face || 1)); ctx.translate(0, -hipY);

  // ---- arms (far arm behind the torso in side view)
  const armSh = side => face === 0 ? [side * (TW / 2 - 9), shY + 14] : [side * face * -6 + face * 4, shY + 14];
  const drawArm = (key, side, far) => {
    const [a1, a2] = pose[key], dir = face === 0 ? side : face, [sx, sy] = armSh(side);
    const pts = limbPts(sx, sy, a1, a2, UA, FA, dir), d = c => far ? tone(c, -0.14) : c;
    if (app.kind === 'tee' || app.kind === 'hawaii') {
      const mid = [lerp(pts[0][0], pts[1][0], 0.7), lerp(pts[0][1], pts[1][1], 0.7)];
      capsule(ctx, [mid, pts[1], pts[2]], ARMW * 0.82, d(skin)); capsule(ctx, [pts[0], mid], ARMW * 1.1, d(sleeve));
    } else capsule(ctx, pts, sleeve === skin ? ARMW * 0.82 : ARMW, d(sleeve));
    const [hx, hy] = pts[2], hand = key === 'la' ? 'L' : 'R';
    fillC(ctx, hx, hy, HAND, d(skin));
    if (app.acc.has('watch') && hand === (face < 0 ? 'L' : 'R')) { const wx = lerp(pts[1][0], hx, 0.8), wy = lerp(pts[1][1], hy, 0.8); fillC(ctx, wx, wy, 8, '#e7ecf5'); fillC(ctx, wx, wy, 4.5, '#2b3152'); }
    const held = o.holds[hand];
    if (held) { ctx.save(); ctx.translate(hx, hy); F.rig.drawHeld(ctx, F.lookupProp(held, o.where), o.t, `${o.where} held prop`); ctx.restore(); }
    app.extra.forEach((x, i) => { if (x.anchor === 'hand' + hand) { ctx.save(); ctx.translate(hx, hy); F.rig.drawHeld(ctx, x.shape, o.t, `${o.where} extra ${i}`); ctx.restore(); } });
  };
  if (face !== 0) drawArm(face > 0 ? 'la' : 'ra', face > 0 ? -1 : 1, true);

  // ---- hair behind the head (the stick rig's hair, scaled to this head: R 50 units)
  const k = R / 50, hy = shY - R + 8 + (pose.headDy || 0) + breath * 0.6, C = c => c;
  ctx.save(); ctx.translate(0, hy); ctx.scale(k, k); F.rig.hairBack(ctx, app, 50, face, 0, pose, C); ctx.restore();

  // ---- torso: a bean, darker hem, outfit details clipped inside
  const tw = face === 0 ? TW : TW * 0.82, tTop = shY - 8 + breath, tBot = hipY + 18 + (app.kind === 'lab' ? 34 : 0);
  if (app.kind === 'dress' || app.bottom === 'skirt') {
    const sk = app.kind === 'dress' ? torsoC : app.trousers;
    ctx.beginPath(); ctx.moveTo(-tw / 2 + 6, hipY - 12); ctx.lineTo(tw / 2 - 6, hipY - 12); ctx.quadraticCurveTo(tw / 2 + 26, hipY + TH * 0.7, tw / 2 + 22, hipY + TH * 0.72); ctx.lineTo(-tw / 2 - 22, hipY + TH * 0.72); ctx.quadraticCurveTo(-tw / 2 - 26, hipY + TH * 0.7, -tw / 2 + 6, hipY - 12); ctx.fillStyle = sk; ctx.fill();
  }
  const bean = () => { ctx.beginPath(); ctx.roundRect(-tw / 2, tTop, tw, tBot - tTop, [tw * 0.46, tw * 0.46, tw * 0.3, tw * 0.3]); };
  bean(); ctx.fillStyle = torsoC; ctx.fill();
  ctx.save(); bean(); ctx.clip();
  const pc = app.patternColor || tone(torsoC, app.kind === 'hawaii' ? -0.35 : -0.28), R2 = rng(hashStr(String(o.castId)));
  if (app.pattern === 'stripes') for (let y = tTop + 16; y < tBot; y += 24) { ctx.fillStyle = pc; ctx.fillRect(-tw, y, tw * 2, 10); }
  else if (app.pattern === 'dots' || app.pattern === 'flowers') for (let y = tTop + 14; y < tBot; y += 24) for (let x = -tw / 2 + ((y / 24) % 2 ? 6 : 18); x < tw / 2; x += 24) fillC(ctx, x, y, app.pattern === 'dots' ? 4.5 : 6, app.pattern === 'dots' ? pc : (Math.round(x + y) % 3 ? '#ffd9a8' : '#ff8a8a'));
  else if (app.pattern === 'camo') for (let i = 0; i < 12; i++) fillE(ctx, -tw / 2 + R2() * tw, tTop + R2() * (tBot - tTop), 14 + R2() * 10, 8 + R2() * 6, i % 2 ? pc : tone(torsoC, 0.15), R2() * 3);
  const cx = face * 8, neckV = (w, d, c) => { ctx.beginPath(); ctx.moveTo(cx - w, tTop - 2); ctx.lineTo(cx, tTop + d); ctx.lineTo(cx + w, tTop - 2); ctx.closePath(); ctx.fillStyle = c; ctx.fill(); };
  switch (app.kind) {
    case 'jacket': neckV(20, 26, dk); line(ctx, cx, tTop + 26, cx, tBot); stroke(ctx, dk, 4); break;
    case 'suit': neckV(18, 52, '#f6f2ea'); ctx.beginPath(); ctx.moveTo(cx - 5, tTop + 6); ctx.lineTo(cx + 5, tTop + 6); ctx.lineTo(cx + 7, tTop + 42); ctx.lineTo(cx, tTop + 52); ctx.lineTo(cx - 7, tTop + 42); ctx.closePath(); ctx.fillStyle = F.look.palette.red || '#e8285a'; ctx.fill(); break;
    case 'hoodie': fillRR(ctx, cx - 26, tBot - 52, 52, 28, 10, dk); line(ctx, cx - 9, tTop + 8, cx - 11, tTop + 40); stroke(ctx, '#ffffff', 3); line(ctx, cx + 9, tTop + 8, cx + 11, tTop + 40); stroke(ctx, '#ffffff', 3); break;
    case 'tee': neckV(16, 14, skin); break;
    case 'hawaii': neckV(18, 26, skin); line(ctx, cx, tTop + 26, cx, tBot); stroke(ctx, dk, 3); break;
    case 'open': neckV(20, 44, skin); line(ctx, cx, tTop + 44, cx, tBot); stroke(ctx, dk, 3); break;
    case 'vest': neckV(18, 36, skin); break;
    case 'lab': neckV(16, 34, '#9fd0ff'); line(ctx, cx, tTop + 34, cx, tBot); stroke(ctx, dk, 3); fillRR(ctx, cx + (face >= 0 ? 14 : -34), tTop + 40, 20, 24, 4, dk); break;
    case 'dress': ctx.beginPath(); ctx.arc(cx, tTop - 8, 20, 0.15 * Math.PI, 0.85 * Math.PI); stroke(ctx, dk, 4); break;
  }
  if (app.bottom === 'trousers' && !['dress', 'lab'].includes(app.kind)) { ctx.fillStyle = tone(app.trousers, -0.25); ctx.fillRect(-tw, hipY + 6, tw * 2, 12); }
  ctx.restore();
  if (app.acc.has('badge')) { fillC(ctx, cx - face * 18 - (face === 0 ? tw * 0.22 : 0), tTop + 50, 10, '#ffc93c'); fillC(ctx, cx - face * 18 - (face === 0 ? tw * 0.22 : 0), tTop + 50, 4, '#b8862b'); }
  if (app.acc.has('chain')) { ctx.beginPath(); ctx.arc(cx, tTop - 2, 30, 0.2 * Math.PI, 0.8 * Math.PI); stroke(ctx, '#ffc93c', 5); }
  if (app.acc.has('bandana')) { ctx.beginPath(); ctx.moveTo(cx - 30, tTop + 2); ctx.lineTo(cx + 30, tTop + 2); ctx.lineTo(cx + face * 8, tTop + 40); ctx.closePath(); ctx.fillStyle = '#e8285a'; ctx.fill(); }
  app.extra.forEach((x, i) => {
    const pt = x.anchor === 'neck' ? [cx, tTop + 4] : x.anchor === 'chest' ? [cx, tTop + 52] : x.anchor === 'hip' ? [0, hipY] : null;
    if (pt) { ctx.save(); ctx.translate(pt[0], pt[1]); F.rig.drawHeld(ctx, x.shape, o.t, `${o.where} extra ${i}`); ctx.restore(); }
  });

  // ---- head: skin, ears, face, hair, hat, accessories (R 50 units)
  ctx.save(); ctx.translate(face * 4 * k, hy); ctx.scale(k, k); ctx.rotate(pose.tilt || 0);
  const ear = tone(skin, -0.1);
  if (face === 0) [-1, 1].forEach(d => fillE(ctx, d * 49, 6, 9, 13, ear)); else fillE(ctx, -face * 14, 6, 9, 13, ear);
  headPath(ctx, D.headShape, 50); ctx.fillStyle = skin; ctx.fill();
  if (face === 0) [-1, 1].forEach(d => fillE(ctx, d * 47, 6, 6, 9, ear));
  else fillE(ctx, -face * 14, 6, 7, 10, tone(skin, -0.16));
  if (face !== 0) fillE(ctx, face * 50, 4, 8, 10, skin); // nose
  drawFace(ctx, o, app);
  // the stick rig's bun is a flat cap (invisible on a black head); on skin it reads as a helmet: bun + fringe instead
  if (app.hair.style === 'bun') fillC(ctx, -face * 10, -49, 18, app.hair.color);
  F.rig.hairTop(ctx, app.hair.style === 'bun' ? Object.assign({}, app, { hair: Object.assign({}, app.hair, { style: 'short' }) }) : app, 50, face, C, false);
  F.rig.hat(ctx, app, 50, face, C, false);
  const acc2 = Object.assign({}, app, { acc: new Set([...app.acc].filter(a => a !== 'glasses')) });
  F.rig.accHead(ctx, acc2, 50, face, C, false);
  if (app.acc.has('glasses')) { const ex = face * 8; [-17, 17].forEach(dx => { circ(ctx, ex + dx, -4, 13); stroke(ctx, DARK, 3.5); }); line(ctx, ex - 4, -4, ex + 4, -4); stroke(ctx, DARK, 3.5); }
  app.extra.forEach((x, i) => { if (x.anchor === 'head') F.rig.drawHeld(ctx, x.shape, o.t, `${o.where} extra ${i}`); });
  ctx.restore();

  // ---- near arms in front
  if (face === 0) { drawArm('la', -1, false); drawArm('ra', 1, false); }
  else drawArm(face > 0 ? 'ra' : 'la', face > 0 ? 1 : -1, false);
  return -(LEG + TORSO + R * 2 + 16) + (pose.bob || 0);
}
function fillRR(ctx, x, y, w, h, r, c) { rr(ctx, x, y, w, h, r); ctx.fillStyle = c; ctx.fill(); }

// face in head units (R = 50): dark eyes with a glint, brows, rosy cheeks, a small mouth
function drawFace(ctx, o, app) {
  const face = o.face, ex = Object.assign({}, app.face, o.poseExpr || {}, o.expr || {});
  const lk = o.look || [face * 0.6, 0], lx = lk[0] * 8 + face * 8, ly = lk[1] * 5;
  const eyeY = -2 + ly, exs = face === 0 ? [-17 + lx, 17 + lx] : [lx - 4, lx + 22].map(x => face > 0 ? x : x - 18);
  const open = 1 - clamp(o.blink || 0), sun = app.acc.has('sunglasses');
  const dotEye = (x, ry = 8, clipFn) => { ctx.save(); if (clipFn) clipFn(x); fillE(ctx, x, eyeY, 5.6, Math.max(0.8, ry * open), DARK); if (open > 0.5) fillC(ctx, x + 1.8, eyeY - 2.6, 1.9, '#ffffff'); ctx.restore(); };
  if (!sun) switch (ex.eyes) {
    case 'wide': exs.forEach(x => { fillE(ctx, x, eyeY, 9, Math.max(0.8, 11 * open), '#ffffff'); fillC(ctx, x + lk[0] * 2, eyeY + 1, 4.6, DARK); fillC(ctx, x + lk[0] * 2 + 1.5, eyeY - 1, 1.6, '#ffffff'); }); break;
    case 'happy': exs.forEach(x => { ctx.beginPath(); ctx.arc(x, eyeY + 4, 7, Math.PI * 1.12, Math.PI * 1.88); stroke(ctx, DARK, 4.5); }); break;
    case 'sleepy': exs.forEach(x => { dotEye(x, 8, x0 => { ctx.beginPath(); ctx.rect(x0 - 10, eyeY, 20, 20); ctx.clip(); }); line(ctx, x - 8, eyeY, x + 8, eyeY); stroke(ctx, DARK, 3.5); }); break;
    case 'angry': exs.forEach((x, i) => dotEye(x, 8, x0 => { const s = i ? -1 : 1; ctx.beginPath(); ctx.moveTo(x0 - 10, eyeY - 6 - s * 4); ctx.lineTo(x0 + 10, eyeY - 6 + s * 4); ctx.lineTo(x0 + 10, eyeY + 14); ctx.lineTo(x0 - 10, eyeY + 14); ctx.closePath(); ctx.clip(); })); break;
    case 'smug': exs.forEach(x => dotEye(x, 8, x0 => { ctx.beginPath(); ctx.rect(x0 - 10, eyeY - 1, 20, 20); ctx.clip(); })); break;
    default: exs.forEach(x => dotEye(x));
  }
  const bc = tone(app.hair.color && app.hair.style !== 'none' && app.hair.style !== 'bald' ? app.hair.color : DARK, -0.1), by = eyeY - 15;
  switch (ex.brows) {
    case 'up': exs.forEach(x => { ctx.beginPath(); ctx.arc(x, eyeY - 2, 14, Math.PI * 1.3, Math.PI * 1.7); stroke(ctx, bc, 4); }); break;
    case 'down': ctx.beginPath(); ctx.moveTo(exs[0] - 9, by - 2); ctx.lineTo(exs[0] + 8, by + 4); ctx.moveTo(exs[1] + 9, by - 2); ctx.lineTo(exs[1] - 8, by + 4); stroke(ctx, bc, 4.5); break;
    case 'worried': ctx.beginPath(); ctx.moveTo(exs[0] - 9, by + 3); ctx.lineTo(exs[0] + 7, by - 3); ctx.moveTo(exs[1] + 9, by + 3); ctx.lineTo(exs[1] - 7, by - 3); stroke(ctx, bc, 4); break;
  }
  ctx.save(); ctx.globalAlpha *= 0.32; exs.forEach(x => fillE(ctx, x + (x < lx ? -7 : 7), 16, 9, 6, '#ff8a8a')); ctx.restore();
  const mx = (exs[0] + exs[1]) / 2, my = 22 + ly * 0.5;
  if (o.talk > 0.2) { fillE(ctx, mx, my + 2, 7, 3 + 7 * o.talk, LIP); return; }
  switch (ex.mouth) {
    case 'smile': ctx.beginPath(); ctx.arc(mx, my - 8, 11, Math.PI * 0.2, Math.PI * 0.8); stroke(ctx, LIP, 4); break;
    case 'grin': ctx.beginPath(); ctx.moveTo(mx - 13, my - 3); ctx.quadraticCurveTo(mx, my + 15, mx + 13, my - 3); ctx.closePath(); ctx.fillStyle = LIP; ctx.fill(); fillE(ctx, mx, my + 4, 5, 2.5, '#ff8a8a'); break;
    case 'o': fillE(ctx, mx, my + 3, 6, 8, LIP); break;
    case 'frown': ctx.beginPath(); ctx.arc(mx, my + 10, 9, Math.PI * 1.2, Math.PI * 1.8); stroke(ctx, LIP, 4); break;
    case 'smirk': ctx.beginPath(); ctx.moveTo(mx - 8, my + 2); ctx.quadraticCurveTo(mx + 2, my + 5, mx + 10, my - 4); stroke(ctx, LIP, 4); break;
    default: line(ctx, mx - 7, my + 1, mx + 7, my); stroke(ctx, LIP, 4);
  }
}

// the figure is drawn into a layer, then lit like the kit's lit(): a rim-light silhouette behind (offset toward the
// back light) and a shade band inside the far edge. One composite, so alpha fades the figure as a whole.
X.body = X.body || {};
X.body.blob = function (ctx, o) {
  const { pose, D, face } = o, RG = F.look.rig, f = face || 1;
  ctx.save();
  if (pose.lift) ctx.translate(0, pose.lift);
  if (pose.rotAll) ctx.rotate(pose.rotAll * F.D2R * f);
  const m = ctx.getTransform(), cw = ctx.canvas.width, ch = ctx.canvas.height, s = scaleOf(ctx);
  const [A, a] = F.layerCanvas('kurg-fig', cw, ch);
  a.setTransform(m);
  const top = drawBlob(a, o);
  a.setTransform(1, 0, 0, 1, 0, 0);
  const [rx, ry] = RG.rimOff || [7, -4];
  if (RG.shade) {
    const [C, c] = F.layerCanvas('kurg-shade', cw, ch);
    c.drawImage(A, 0, 0); c.globalCompositeOperation = 'source-in'; c.fillStyle = RG.shade[0]; c.fillRect(0, 0, cw, ch);
    c.globalCompositeOperation = 'destination-out'; c.drawImage(A, -rx * 1.6 * f * s, -ry * 1.6 * s);
    a.globalCompositeOperation = 'source-atop'; a.globalAlpha = RG.shade[1]; a.drawImage(C, 0, 0); a.globalAlpha = 1; a.globalCompositeOperation = 'source-over';
  }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (o.rim) {
    const [B, b] = F.layerCanvas('kurg-rim', cw, ch);
    b.drawImage(A, 0, 0); b.globalCompositeOperation = 'source-in'; b.fillStyle = o.rim; b.fillRect(0, 0, cw, ch);
    ctx.drawImage(B, rx * f * s, ry * s);
  }
  ctx.drawImage(A, 0, 0);
  ctx.restore();
  F.qaGrow(ctx, -(D.TW / 2 + 40), top, D.TW + 80, -top);
  ctx.restore();
};

// ---------- set atmosphere (drawn after the sky, before the layers; with the camera at low depth) ----------
// set fields: "stars": n, "bokeh": true | {n, colors, op}, "glows": [{at, r, color, op, depth, pulse}], "motes": n
X.setBack = function (ctx, set, cam, t, where) {
  const S = set || {}, A = F.look.atmo || {}, W = F.W, H = F.H, seed = s => rng(hashStr(where + s));
  const at = (depth, fn) => { ctx.save(); F.applyCam(ctx, cam, depth); fn(); ctx.restore(); };
  if (S.stars) at(0.05, () => {
    const R = seed('stars');
    for (let i = 0; i < S.stars; i++) {
      const x = -200 + R() * (W + 400), y = -200 + R() * (H + 400), r = 0.8 + R() * 2.2, tw = 0.55 + 0.45 * Math.sin(t * (0.8 + R() * 2) + R() * 6);
      fillC(ctx, x, y, r, rgba(i % 9 ? '#ffffff' : '#ffd9a8', 0.85 * tw));
      if (i % 23 === 0) F.sparkle(ctx, x, y, 9 + r * 3, tw, '#ffffff');
    }
  });
  const bk = S.bokeh === true ? {} : S.bokeh;
  if (bk) at(0.25, () => {
    const R = seed('bokeh'), cols = (bk.colors || A.bokeh || ['#b94ce3']).map(c => F.col(c)), op = bk.op ?? 0.32;
    for (let i = 0; i < (bk.n ?? 16); i++) {
      const ph = R() * 6.28, x = -100 + R() * (W + 200) + Math.sin(t * 0.18 + ph) * 40, y = -100 + R() * (H + 200) + Math.cos(t * 0.15 + ph) * 26, r = 30 + R() * 110;
      const g = ctx.createRadialGradient(x, y, r * 0.55, x, y, r), c = cols[i % cols.length];
      g.addColorStop(0, rgbaAny(c, op)); g.addColorStop(0.85, rgbaAny(c, op * 0.8)); g.addColorStop(1, rgbaAny(c, 0));
      ctx.fillStyle = g; circ(ctx, x, y, r); ctx.fill();
    }
  });
  (S.glows || []).forEach(g => at(g.depth ?? 0.4, () => glow(ctx, g.at[0], g.at[1], (g.r ?? 300) * (1 + (g.pulse ?? 0) * Math.sin(t * 2.2)), F.col(g.color, '#ffffff'), g.op ?? 0.5)));
  const nm = S.motes ?? A.motes ?? 0;
  if (nm) at(0.7, () => {
    const R = seed('motes'), c = F.col(A.moteColor, '#ffffff');
    for (let i = 0; i < nm; i++) {
      const x = -100 + ((R() * (W + 200) + t * (6 + R() * 14)) % (W + 200)), y = -100 + ((R() * (H + 200) - t * (10 + R() * 18)) % (H + 200) + H + 200) % (H + 200);
      fillC(ctx, x, y, 1.2 + R() * 2.4, rgba(c, 0.15 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.3 + i))));
    }
  });
};

// ---------- finish: bloom (bright things glow softly) + violet-tinted vignette ----------
X.finish = function (ctx, t) {
  const fin = F.look.finish || {}, cv = ctx.canvas, W = cv.width, H = cv.height, b = W / 1920;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (fin.bloom) {
    const [Q, q] = F.layerCanvas('kurg-bloom', Math.round(W / 4), Math.round(H / 4));
    q.drawImage(cv, 0, 0, Q.width, Q.height);
    q.globalCompositeOperation = 'multiply'; q.drawImage(Q, 0, 0); // square the values: only bright parts survive
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = fin.bloom; ctx.filter = `blur(${18 * b}px)`; ctx.drawImage(Q, 0, 0, W, H);
    ctx.globalAlpha = fin.bloom * 0.5; ctx.filter = `blur(${6 * b}px)`; ctx.drawImage(Q, 0, 0, W, H);
    ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  if (fin.tint) {
    const [c, v] = fin.tint, g = ctx.createRadialGradient(W / 2, H / 2, 300 * b, W / 2, H / 2, 1150 * b);
    g.addColorStop(0, rgba(c, 0)); g.addColorStop(0.6, rgba(c, v * 0.35)); g.addColorStop(1, rgba(c, v));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
};

// ---------- ui restyles: sentence case like the kit (pill = gradient, label = thin text on an underline with a
// leader line, tag = solid rectangle, radius 6) ----------
const DEF = F.ui.DEF;
F.ui.pillItem = function (ctx, it, t, st) {
  const gr = F.look.label.pillGrad, str = it.str, size = it.size || DEF.pill, w = F.ui.textW(ctx, str, size, F.look.label.spacing) + size * 1.9;
  let bg = F.col(it.color, F.look.palette.pill);
  if (gr && !it.color) { bg = ctx.createLinearGradient(-w / 2, 0, w / 2, 0); bg.addColorStop(0, F.col(gr[0])); bg.addColorStop(1, F.col(gr[1])); }
  F.ui.pill(ctx, str, { size: it.size, bg, color: F.col(it.fill, F.look.palette.white), ring: it.ring ? F.col(it.ring) : null, shown: str.slice(0, Math.round(str.length * st.reveal)) });
};
F.ui.labelItem = function (ctx, it, t, st) {
  const size = it.size || DEF.label + 4, str = it.str, c = F.col(it.color || it.fill, F.look.palette.lavender || '#ffffff');
  const w = F.ui.textW(ctx, str, size, 0.01, 600), u = size * 0.75;
  const px = it.point ? (it.point[0] - st.x) / st.s : null, py = it.point ? (it.point[1] - st.y) / st.s : null, dir = px == null || px >= 0 ? 1 : -1;
  const pts = [[-dir * (w / 2 + 8), u], [dir * (w / 2 + 8), u]];
  if (it.point) pts.push([px, py]);
  F.drawOn(ctx, pts, st.reveal, c, 3);
  if (it.point && st.reveal > 0.95) fillC(ctx, px, py, 7, c);
  F.ui.txt(ctx, it.point ? str : str.slice(0, Math.round(str.length * st.reveal)), -w / 2, 0, { size, weight: 600, color: c, spacing: 0.01, align: 'left', qa: false, glow: F.look.label.glow, glowColor: F.look.label.glowColor });
  F.qaText(ctx, str, -w / 2, -size * 0.55, w, size * 1.1, size);
};
F.ui.tagItem = function (ctx, it, t, st) {
  const size = it.size || DEF.tag, str = it.str, tw = F.ui.textW(ctx, str, size, 0.01, 700), w = tw + size * 0.9, h = size * 1.45;
  ctx.save(); if (it.tilt) ctx.rotate(it.tilt * F.D2R);
  rr(ctx, -w / 2, -h / 2, w, h, 6); ctx.fillStyle = F.col(it.color, F.look.palette.violet || F.look.palette.accent); ctx.fill();
  F.ui.txt(ctx, str.slice(0, Math.round(str.length * st.reveal)), -tw / 2, 0, { size, weight: 700, color: F.col(it.fill, '#ffffff'), spacing: 0.01, align: 'left', qa: false });
  F.qaText(ctx, str, -tw / 2, -size * 0.55, tw, size * 1.1, size); F.qaGrow(ctx, -w / 2, -h / 2, w, h);
  ctx.restore();
};

X.kurg = { tone, glow };
})();
