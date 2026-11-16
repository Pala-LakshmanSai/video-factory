// rig.js — the stick-figure rig: appearance from an ActorSpec (data), named poses, walk/run, faces, say flaps,
// holding props, raw joints. Geometry follows the approved part-1 figure (black body + round head, white face,
// rim light). Proportions and default outfit colours come from the look (look.rig, look.actor). No named characters.
// Joint convention: [upper, lower] angles in radians from straight down; positive = forward (side view) or
// outward (front view). Poses name the near/far arm (n/f) and leg (nl/fl) so they read right facing either way.
'use strict';
(function () {
const F = window.FLAT2D;
const { clamp, lerp, E, rr, circ, ell, fillC, fillE, fillRR, poly, line, stroke, smoothPath, shade, rgba, rng, hashStr } = F;

const ENUM = {
  headShape: ['round', 'oval', 'square', 'egg'],
  top: ['tee', 'hoodie', 'jacket', 'suit', 'hawaii', 'open', 'vest', 'dress', 'lab', 'none'],
  pattern: ['none', 'stripes', 'dots', 'flowers', 'camo'],
  bottom: ['trousers', 'shorts', 'skirt'],
  hair: ['none', 'short', 'slick', 'ponytail', 'bun', 'long', 'curly', 'afro', 'white', 'bald', 'braids'],
  hat: ['none', 'cap', 'capBack', 'beanie', 'fedora', 'homburg', 'headband', 'crown'],
  acc: ['glasses', 'sunglasses', 'chain', 'headset', 'headphones', 'bandana', 'beard', 'mustache', 'watch', 'badge'],
  anchor: ['head', 'neck', 'chest', 'hip', 'handL', 'handR'],
  eyes: ['dot', 'wide', 'happy', 'sleepy', 'angry', 'smug'],
  mouth: ['flat', 'smile', 'grin', 'o', 'frown', 'smirk'],
  brows: ['none', 'up', 'down', 'worried'],
  actions: ['stand', 'walk', 'run', 'pose', 'face', 'look', 'hold', 'drop', 'joints'],
};
const HANDS = { L: 'L', l: 'L', left: 'L', handL: 'L', R: 'R', r: 'R', right: 'R', handR: 'R' };

// ---------- poses: (tl = seconds since the pose started, D = rig dims) -> partial pose ----------
const sin = Math.sin, abs = Math.abs;
const once = (tl, d) => E.outC(clamp(tl / d));
const POSES = {
  stand: () => ({}),
  point: () => ({ n: [1.5, 0.05] }),
  wave: tl => ({ n: [2.5, 0.45 + 0.42 * sin(tl * 11)], tilt: 0.04 }),
  cheer: tl => ({ n: [2.75, 0.15], f: [2.75, 0.15], tilt: -0.06, lift: -10 * abs(sin(tl * 6)), expr: { mouth: 'grin', eyes: 'happy' } }),
  shrug: () => ({ n: [0.55, 1.35], f: [0.55, 1.35], headDy: 7, tilt: 0.14, expr: { mouth: 'flat', brows: 'up' }, side: { n: [0.3, 1.6], f: [-0.2, 1.7] } }),
  think: () => ({ nT: 'chin', f: [0.2, -1.55], tilt: 0.1, look: [0.4, -0.8], expr: { mouth: 'flat' }, side: { f: [0.3, 1.4] } }),
  facepalm: () => ({ nT: 'face', tilt: 0.28, headDy: 5, expr: { eyes: 'sleepy', mouth: 'frown' } }),
  'cross-arms': () => ({ n: [0.2, -1.75], f: [0.2, -1.75], expr: { mouth: 'flat' }, side: { n: [0.25, 1.55], f: [0.25, 1.55] } }),
  'hands-hips': () => ({ nT: 'hip', fT: 'hip', side: { nT: null, fT: null, n: [-0.45, 1.3], f: [-0.45, 1.3] } }),
  sit: (tl, D) => ({ seat: 1, bob: D.LEG - D.SH * 1.0 - 4, n: [0.55, 0.5], f: [0.55, 0.5], nl: [1.57, 1.57], fl: [1.5, 1.5] }),
  lie: () => ({ rotAll: -88, lift: -30, n: [0.25, 0.05], f: [0.15, 0.05], expr: { eyes: 'sleepy', mouth: 'flat' } }),
  crouch: (tl, D) => ({ bob: D.LEG * 0.4, nl: [1.3, 2.25], fl: [0.95, 2.05], lean: 0.35, n: [0.95, 0.6], f: [0.6, 0.8] }),
  fight: tl => ({ n: [0.9, 2.05], f: [0.7, 2.25], nl: [0.32, 0.15], fl: [-0.3, 0.12], lean: 0.12, bob: 10 + 4 * sin(tl * 8), expr: { eyes: 'angry', brows: 'down', mouth: 'flat' } }),
  punch: tl => { const e = once(tl, 0.13); return { n: [lerp(0.9, 1.55, e), lerp(2.05, 0, e)], f: [0.7, 2.25], nl: [0.35, 0.12], fl: [-0.35, 0.1], lean: 0.12 + 0.18 * e, expr: { eyes: 'angry', brows: 'down', mouth: 'grin' } }; },
  kick: tl => { const e = once(tl, 0.16); return { nl: [lerp(0.04, 1.65, e), lerp(0, 0.1, e)], fl: [-0.12, 0.05], lean: -0.32 * e, n: [1.2, 0.4], f: [-0.9, 0.5], expr: { eyes: 'angry', brows: 'down', mouth: 'grin' } }; },
  fall: tl => { const e = E.inQ(clamp(tl / 0.55)); return { rotAll: -86 * e, lift: -28 * e, n: [lerp(0.6, 2.5, clamp(tl / 0.3)), 0.3], f: [lerp(0.5, 2.6, clamp(tl / 0.3)), 0.2], nl: [0.3 * e, 0.2], expr: { eyes: 'wide', mouth: 'o', brows: 'up' } }; },
  jump: tl => { const h = sin(Math.PI * clamp(tl / 0.7)); return { lift: -150 * h, nl: [0.7 * h, 1.3 * h], fl: [0.4 * h, 1.1 * h], n: [0.12 + 2.5 * h, 0.2], f: [0.12 + 2.5 * h, 0.2], expr: { mouth: 'grin', eyes: 'happy' } }; },
  celebrate: tl => ({ lift: -55 * abs(sin(tl * 6.5)), n: [2.8, 0.1 + 0.3 * sin(tl * 13)], f: [2.7, 0.2], nl: [0.1, 0.3 * abs(sin(tl * 6.5))], expr: { mouth: 'grin', eyes: 'happy' } }),
  phone: () => ({ nT: 'ear', tilt: 0.1 }),
  drink: () => ({ nT: 'mouth', tilt: -0.15 }),
  type: tl => ({ n: [0.35, -1.25 + 0.08 * sin(tl * 25)], f: [0.35, -1.25 + 0.08 * sin(tl * 23 + 1)], lean: 0.05, side: { n: [0.85, 0.75 + 0.1 * sin(tl * 25)], f: [0.8, 0.8 + 0.1 * sin(tl * 23 + 1)], lean: 0.1 } }),
  carry: () => ({ n: [0.15, -1.5], f: [0.15, -1.5], lean: -0.04, side: { n: [0.55, 0.95], f: [0.5, 1.0] } }),
  'hands-up': () => ({ n: [1.65, 1.45], f: [1.65, 1.45], expr: { eyes: 'wide', mouth: 'o', brows: 'worried' }, side: { n: [2.4, 0.5], f: [2.5, 0.4] } }),
  hug: () => ({ n: [1.05, -1.9], f: [1.05, -1.9], expr: { eyes: 'happy', mouth: 'smile' }, side: { n: [1.4, 0.75], f: [1.3, 0.85], lean: 0.12 } }),
  sneak: (tl, D) => ({ bob: 30, lean: 0.3, nl: [0.5, 0.9], fl: [-0.2, 0.5], n: [0.9, 1.6], f: [0.5, 1.8], expr: { eyes: 'smug', mouth: 'flat' } }),
  talk: tl => ({ n: [0.55 + 0.15 * sin(tl * 3.3), 1.3 + 0.25 * sin(tl * 4.1)], side: { n: [0.6 + 0.15 * sin(tl * 3.3), 1.0 + 0.25 * sin(tl * 4.1)] } }),
};
const BASE = { la: [0.12, 0.08], ra: [0.12, 0.08], ll: [0.04, 0], rl: [0.04, 0], lean: 0, tilt: 0, bob: 0, headDy: 0, lift: 0, rotAll: 0, seat: 0 };
const NUMS = ['lean', 'tilt', 'bob', 'headDy', 'lift', 'rotAll', 'seat'];
// 2-bone IK: shoulder S -> hand target T; returns [upper, lower] in the joint convention, elbow outward/forward
function ik(S, T, L1, L2, dir) {
  const dx = (T[0] - S[0]) * dir, dy = T[1] - S[1], d = clamp(Math.hypot(dx, dy), Math.abs(L1 - L2) + 1, L1 + L2 - 0.5);
  const phi = Math.atan2(dx, dy), A = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const a1 = Math.sin(phi + A) > Math.sin(phi - A) ? phi + A : phi - A;
  const ex = Math.sin(a1) * L1, ey = Math.cos(a1) * L1;
  return [a1, Math.atan2(dx - ex, dy - ey) - a1];
}
// named hand targets, relative to the shoulder line (y = 0 at shY)
function handTarget(name, side, face, D, headDy) {
  const hx = face * 4, hy = -D.R + 8 - D.NECK + (headDy || 0), R = D.R;
  switch (name) {
    case 'mouth': return [hx + face * 8, hy + 22];
    case 'chin': return [hx + face * 10 + (face === 0 ? side * 6 : 0), hy + R * 0.95];
    case 'face': return [hx + face * 16 + (face === 0 ? side * 10 : 0), hy + 4];
    case 'ear': return face === 0 ? [hx + side * R * 0.92, hy + 6] : [hx - face * R * 0.15, hy + 8];
    case 'hip': return face === 0 ? [side * (D.TW / 2 + 2), D.TORSO - 8] : [-face * 10, D.TORSO - 8];
    default: return name;
  }
}
// partial pose (n/f naming) -> full pose (la/ra/ll/rl) for this facing
function resolve(part, face, D) {
  const p = Object.assign({}, part, face !== 0 && part.side ? part.side : {});
  const o = { la: BASE.la, ra: BASE.ra, ll: BASE.ll, rl: BASE.rl };
  const near = face < 0 ? 'l' : 'r', far = face < 0 ? 'r' : 'l';
  if (face !== 0) { o[near + 'l'] = [0.1, 0.03]; o[far + 'l'] = [-0.07, 0.03]; }
  if (p.n) o[near + 'a'] = p.n; if (p.f) o[far + 'a'] = p.f;
  if (D) for (const [key, arm] of [['nT', near], ['fT', far]]) {
    if (!p[key]) continue;
    const side = arm === 'l' ? -1 : 1, dir = face === 0 ? side : face;
    const S = face === 0 ? [side * (D.TW / 2 - 9), 14] : [side * face * -6 + face * 4, 14];
    o[arm + 'a'] = ik(S, handTarget(p[key], side, face, D, p.headDy), D.UA, D.FA, dir);
  }
  if (p.nl) o[near + 'l'] = p.nl; if (p.fl) o[far + 'l'] = p.fl;
  for (const k of ['la', 'ra', 'll', 'rl']) if (p[k]) o[k] = p[k];
  for (const k of NUMS) o[k] = p[k] ?? BASE[k];
  o.expr = p.expr || null; o.look = p.look || null;
  return o;
}
function blend(a, b, t) {
  if (t <= 0) return a; if (t >= 1) return b;
  const o = {};
  for (const k of ['la', 'ra', 'll', 'rl']) o[k] = [lerp(a[k][0], b[k][0], t), lerp(a[k][1], b[k][1], t)];
  for (const k of NUMS) o[k] = lerp(a[k], b[k], t);
  o.expr = t > 0.5 ? b.expr : a.expr; o.look = t > 0.5 ? b.look : a.look;
  return o;
}
function walkPose(ph, amt, run) {
  const s = sin(ph), c = Math.cos(ph);
  if (run) return { ll: [0.75 * s * amt, (0.35 + 1.25 * Math.max(0, c)) * amt], rl: [-0.75 * s * amt, (0.35 + 1.25 * Math.max(0, -c)) * amt], la: [-0.95 * s * amt, 1.55], ra: [0.95 * s * amt, 1.55], lean: 0.22 * amt, tilt: 0, bob: -abs(c) * 14 * amt + 6 };
  return { ll: [0.42 * s * amt, (0.12 + 0.62 * Math.max(0, c)) * amt], rl: [-0.42 * s * amt, (0.12 + 0.62 * Math.max(0, -c)) * amt], la: [-0.38 * s * amt, 0.3 + 0.15 * s], ra: [0.38 * s * amt, 0.3 - 0.15 * s], lean: 0.05 * amt, tilt: 0.02 * sin(ph * 2), bob: -abs(c) * 7 * amt + 3 };
}

// ---------- appearance: ActorSpec + look defaults ----------
function dims(spec) {
  const R0 = F.look.rig, b = spec.build || {}, h = b.height ?? 1, w = b.width ?? 1, hd = b.head ?? 1;
  return { R: R0.R * hd, LEG: R0.LEG * h, TORSO: R0.TORSO * h, TW: R0.TW * w, UA: R0.UA * h, FA: R0.FA * h, TH: R0.TH * h, SH: R0.SH * h, ARMW: R0.ARMW * Math.sqrt(w), LEGW: R0.LEGW * Math.sqrt(w), HAND: R0.HAND, NECK: (R0.NECK || 0) * h, headShape: b.headShape || 'round' };
}
function appearance(spec) {
  const d = F.look.actor, top = Object.assign({}, d.top, spec.top), bot = Object.assign({}, d.bottom, spec.bottom);
  const ink = F.col(spec.ink, F.look.palette.ink);
  const hair = Object.assign({ style: 'none', color: '#2b211b' }, d.hair, spec.hair);
  const hat = Object.assign({ kind: 'none', color: '#3c4458' }, d.hat, spec.hat);
  const torso = top.kind === 'none' ? ink : F.col(top.color);
  return {
    ink, kind: top.kind, pattern: top.pattern || (top.kind === 'hawaii' ? 'flowers' : 'none'),
    torso, torsoDark: top.dark ? F.col(top.dark) : shade(torso, -0.18), patternColor: top.patternColor ? F.col(top.patternColor) : null,
    sleeve: ['vest', 'dress', 'none'].includes(top.kind) ? ink : torso,
    bottom: bot.kind, trousers: F.col(bot.color), shoe: F.col((spec.shoes && spec.shoes.color) || d.shoes.color),
    hair: { style: hair.style, color: visible(F.col(hair.color), ink) }, hat: { kind: hat.kind, color: F.col(hat.color) },
    acc: new Set(spec.acc || []), extra: spec.extra || [], face: Object.assign({}, d.face, spec.face),
  };
}
// a colour drawn on the black head must still read: lift near-black colours a little
function visible(c, ink) { if (c[0] !== '#') return c; const [r, g, b] = F.hex2rgb(c), [ir, ig, ib] = F.hex2rgb(ink); return Math.abs(r - ir) + Math.abs(g - ig) + Math.abs(b - ib) < 60 ? shade(c, 0.22) : c; }

function check(it, nm) {
  const spec = F.lookupCast(it.cast, nm);
  const bad = (field, v, list) => { if (v !== undefined && !ENUM[list].includes(v)) throw new Error(`${nm}: cast "${it.cast}" ${field} "${v}" unknown (use ${ENUM[list].join('|')})`); };
  bad('build.headShape', spec.build && spec.build.headShape, 'headShape');
  bad('top.kind', spec.top && spec.top.kind, 'top'); bad('top.pattern', spec.top && spec.top.pattern, 'pattern');
  bad('bottom.kind', spec.bottom && spec.bottom.kind, 'bottom'); bad('hair.style', spec.hair && spec.hair.style, 'hair'); bad('hat.kind', spec.hat && spec.hat.kind, 'hat');
  (spec.acc || []).forEach(a => bad('acc', a, 'acc'));
  (spec.extra || []).forEach(x => { bad('extra.anchor', x.anchor, 'anchor'); F.shapes.check(x.shape, `${nm} cast "${it.cast}" extra`); });
  if (spec.face) { bad('face.eyes', spec.face.eyes, 'eyes'); bad('face.mouth', spec.face.mouth, 'mouth'); bad('face.brows', spec.face.brows, 'brows'); }
  appearance(spec); // resolves colour tokens (throws on unknown)
  if (it.face !== undefined && ![-1, 0, 1].includes(it.face)) throw new Error(`${nm}: face must be -1, 0 or 1`);
  (it.do || []).forEach((a, i) => {
    const [t, name, args = {}] = a;
    const w = `${nm} do[${i}] "${name}"`;
    if (typeof t !== 'number') throw new Error(`${w}: first element must be the time in seconds`);
    if (!ENUM.actions.includes(name)) throw new Error(`${w}: unknown action (use ${ENUM.actions.join('|')})`);
    if (name === 'pose' && !POSES[args.name]) throw new Error(`${w}: unknown pose "${args.name}" (use ${Object.keys(POSES).join('|')})`);
    if ((name === 'walk' || name === 'run') && args.to == null) throw new Error(`${w}: needs {to, dur}`);
    if (name === 'face') { bad('eyes', args.eyes, 'eyes'); bad('mouth', args.mouth, 'mouth'); bad('brows', args.brows, 'brows'); }
    if (name === 'look' && ![-1, 0, 1].includes(args.dir)) throw new Error(`${w}: dir must be -1, 0 or 1`);
    if ((name === 'hold' || name === 'drop') && args.hand !== undefined && !HANDS[args.hand]) throw new Error(`${w}: hand "${args.hand}" unknown (use L|R)`);
    if (name === 'hold') F.lookupProp(args.prop, w);
    if (name === 'joints') for (const k of Object.keys(args)) if (!['la', 'ra', 'll', 'rl', 'lean', 'tilt', 'bob'].includes(k)) throw new Error(`${w}: joint "${k}" unknown (use la|ra|ll|rl|lean|tilt|bob)`);
  });
  (it.say || []).forEach(s => { if (!Array.isArray(s) || s.length !== 2) throw new Error(`${nm}: say entries are [t0, t1]`); });
}

// ---------- the do-timeline at time t ----------
const BLEND = 0.2;
const target = (to, x, y) => Array.isArray(to) ? [to[0], to[1] ?? y] : [to, y];
function evalActor(it, t, base) {
  const at = base || it.at || [960, 900];
  let x = at[0], y = at[1], face = it.face ?? 1;
  const D = dims(F.lookupCast(it.cast, ''));
  let fromSnap = resolve({}, face, D), toDef = POSES.stand, toRaw = null, t0 = -1, legsOf = null;
  let expr = {}, holds = {}, move = null;
  // upper-body poses (only arms/head) keep the legs of the pose before them, so "type" after "sit" stays seated
  const LOWER = ['nl', 'fl', 'll', 'rl', 'bob', 'seat', 'lift', 'rotAll'];
  const targetAt = (tt) => {
    if (toRaw) return toRaw;
    const part = toDef(tt - t0, D), r = resolve(part, face, D);
    if (legsOf && !LOWER.some(k => k in part)) { const L = resolve(legsOf.def(legsOf.tl, D), face, D); for (const k of ['ll', 'rl', 'bob', 'seat']) r[k] = L[k]; }
    return r;
  };
  const poseAt = (tt) => blend(fromSnap, targetAt(tt), E.ioS(clamp((tt - t0) / BLEND)));
  const acts = (it.do || []).map((a, i) => ({ a, i })).sort((p, q) => p.a[0] - q.a[0] || p.i - q.i).map(o => o.a);
  for (const [ta, name, args = {}] of acts) {
    if (ta > t) break;
    if (move && ta >= move.t1) { x = move.x1; y = move.y1; move = null; }
    switch (name) {
      case 'stand': case 'pose': case 'joints':
        fromSnap = poseAt(ta); t0 = ta;
        if (name === 'joints') { const r = Object.assign({}, resolve({}, face, D)); for (const k of ['la', 'ra', 'll', 'rl']) if (args[k]) r[k] = args[k].map(v => v * F.D2R); for (const k of ['lean', 'tilt']) if (args[k] != null) r[k] = args[k] * F.D2R; if (args.bob != null) r.bob = args.bob; toRaw = r; }
        else {
          const def = name === 'stand' ? POSES.stand : POSES[args.name], prev = toRaw ? null : toDef;
          const prevPart = prev ? prev(1, D) : {};
          if (name === 'pose' && prev && LOWER.some(k => k in prevPart) && !LOWER.some(k => k in def(0, D))) legsOf = { def: prev, tl: 1 };
          else if (name !== 'pose' || LOWER.some(k => k in def(0, D))) legsOf = null;
          toRaw = null; toDef = def;
        }
        break;
      case 'walk': case 'run': {
        const [x1, y1] = target(args.to, x, y), dur = args.dur ?? Math.max(0.4, Math.hypot(x1 - x, y1 - y) / (name === 'run' ? 700 : 280));
        move = { t0: ta, t1: ta + dur, x0: x, y0: y, x1, y1, run: name === 'run' };
        if (x1 !== x) face = x1 > x ? 1 : -1;
        fromSnap = poseAt(ta); toRaw = null; toDef = POSES.stand; t0 = ta; legsOf = null;
        break;
      }
      case 'face': expr = Object.assign({}, expr, args); break;
      case 'look': fromSnap = poseAt(ta); face = args.dir; t0 = ta; break;
      case 'hold': holds[HANDS[args.hand || 'R']] = args.prop; break;
      case 'drop': if (args.hand) delete holds[HANDS[args.hand]]; else holds = {}; break;
    }
  }
  let pose = poseAt(t);
  if (move && t >= move.t1) { x = move.x1; y = move.y1; move = null; }
  if (move) {
    const p = clamp((t - move.t0) / (move.t1 - move.t0));
    x = lerp(move.x0, move.x1, p); y = lerp(move.y0, move.y1, p);
    const dist = Math.hypot(x - move.x0, y - move.y0), stride = (move.run ? 1.35 : 1) * D.TH * 1.25;
    const amt = Math.min(clamp((t - move.t0) / 0.15), clamp((move.t1 - t) / 0.15));
    const w = walkPose(dist / stride * Math.PI, 1, move.run);
    pose = blend(pose, Object.assign({}, pose, w, { headDy: pose.headDy, lift: 0, rotAll: 0, seat: 0 }), amt);
  }
  return { x, y, face, pose, expr, holds, D };
}
function position(it, t, base) { const s = evalActor(it, t, base); return [s.x, s.y]; }

// ---------- drawing ----------
function limbPts(jx, jy, a1, a2, L1, L2, dir) {
  const ex = jx + Math.sin(a1) * L1 * dir, ey = jy + Math.cos(a1) * L1;
  return [[jx, jy], [ex, ey], [ex + Math.sin(a1 + a2) * L2 * dir, ey + Math.cos(a1 + a2) * L2]];
}
function headPath(ctx, shape, R) {
  ctx.beginPath();
  if (shape === 'oval') ctx.ellipse(0, 0, R * 0.88, R * 1.1, 0, 0, Math.PI * 2);
  else if (shape === 'square') ctx.roundRect(-R * 0.98, -R * 0.98, R * 1.96, R * 1.96, R * 0.38);
  else if (shape === 'egg') { ctx.ellipse(0, 0, R * 0.84, R * 1.06, 0, Math.PI, Math.PI * 2); ctx.ellipse(0, 0, R * 1.0, R * 1.0, 0, 0, Math.PI); ctx.closePath(); }
  else ctx.arc(0, 0, R, 0, Math.PI * 2);
}
function grip(sh) { const [w, h] = sh.box || [100, 100]; return sh.grip || [w / 2, h / 2]; }
function drawHeld(ctx, sh, t, where) { const [gx, gy] = grip(sh); ctx.save(); ctx.translate(-gx, -gy); F.shapes.draw(ctx, sh, t, where); ctx.restore(); }

// o: {app, D, pose, face, expr, talk, blink, holds, rim, t, where}
function drawFigure(ctx, o) {
  // look body style switch (look.rig.body): a look's extras may draw the figure its own way from the same pose data
  const bs = F.look.rig && F.look.rig.body;
  if (bs && bs !== 'stick') {
    const fn = F.extras.body && F.extras.body[bs];
    if (typeof fn !== 'function') throw new Error(`look rig.body "${bs}" has no drawer (looks/<kit>.js must define FLAT2D.extras.body["${bs}"])`);
    return fn(ctx, o);
  }
  const { pose, D } = o;
  ctx.save();
  if (pose.lift) ctx.translate(0, pose.lift);
  if (pose.rotAll) { ctx.rotate(pose.rotAll * F.D2R * (o.face || 1)); }
  // look hook: F.extras.rim(ctx, o, drawSilhouette) replaces the default shifted rim pass
  if (o.rim) { if (F.extras.rim) F.extras.rim(ctx, o, () => body(ctx, o, true)); else { ctx.save(); ctx.translate(5, -4); body(ctx, o, true); ctx.restore(); } }
  body(ctx, o, false);
  const top = -(D.LEG + D.TORSO + D.R * 2 + 12 + D.NECK) + (pose.bob || 0);
  F.qaGrow(ctx, -(D.TW / 2 + 40), top, D.TW + 80, -top);
  ctx.restore();
}

function body(ctx, o, rimPass) {
  const { app: of, D, pose, face } = o;
  const { R, LEG, TORSO, UA, FA, TH, SH, ARMW, LEGW, HAND } = D;
  const C = c => rimPass ? o.rim : c;
  const tw = D.TW * (of.kind === 'none' ? 0.5 : 1);
  const TOP = F.extras.tops && F.extras.tops[of.kind]; // look hook: a look may draw a top kind its own way (torso, arm)
  const hipY = -LEG + (pose.bob || 0), shY = hipY - TORSO;
  const tTop = shY - 4, tH = TORSO + 12;
  const legCols = of.bottom === 'trousers' ? [of.trousers, of.trousers] : of.bottom === 'shorts' ? [of.trousers, of.ink] : [of.ink, of.ink];
  const skirtLike = of.bottom === 'skirt' || of.kind === 'dress';
  const legW = of.bottom === 'trousers' ? LEGW : LEGW * 0.72;

  const leg = (pts, far) => {
    const dk = c => far ? shade(c, -0.12) : c;
    poly(ctx, [pts[1], pts[2]], false); stroke(ctx, C(dk(legCols[1])), legW);
    poly(ctx, [pts[0], pts[1]], false); stroke(ctx, C(dk(legCols[0])), of.bottom === 'shorts' ? LEGW * 1.15 : legW);
  };
  const shoe = (x, y, rot, toe, far) => { if (of.shoe === 'none') return; ctx.save(); ctx.translate(x, y); ctx.rotate(rot); rr(ctx, -11 + toe * 9 - 8, -5, 34, 14, 7); ctx.fillStyle = C(far ? shade(of.shoe, -0.08) : of.shoe); ctx.fill(); ctx.restore(); };
  const drawLeg = (key, hx, far) => {
    const [h, kn] = pose[key];
    const dir = face === 0 ? (hx < 0 ? -1 : 1) : face;
    const pts = limbPts(hx, hipY, h, -kn, TH, SH, dir);
    leg(pts, far);
    const sa = h - kn;
    shoe(pts[2][0], pts[2][1], face === 0 ? 0 : -sa * 0.3 * dir, face === 0 ? (hx < 0 ? -1 : 1) * 0.5 : dir, far);
  };
  ctx.save();
  // ---- legs
  if (face === 0 && pose.seat > 0.5) {
    [-1, 1].forEach(sd => {
      const hx = sd * 18, kx = sd * 28, ky = hipY + 26, fy = -9, fx = kx + sd * 3;
      line(ctx, hx, hipY, kx, ky); stroke(ctx, C(shade(legCols[0], 0.06)), LEGW + 10);
      line(ctx, kx, ky, fx, fy); stroke(ctx, C(legCols[1]), legW);
      shoe(fx, fy, 0, sd * 0.4, false);
    });
  } else if (face !== 0) { drawLeg(face > 0 ? 'll' : 'rl', 0, true); drawLeg(face > 0 ? 'rl' : 'll', 0, false); }
  else { drawLeg('ll', -15, false); drawLeg('rl', 15, false); }

  // lean torso + arms + head about the hip
  ctx.translate(0, hipY); ctx.rotate((pose.lean || 0) * (face || 1)); ctx.translate(0, -hipY);

  const handPos = {};
  const armSh = side => face === 0 ? [side * (tw / 2 - 9), shY + 14] : [side * face * -6 + face * 4, shY + 14];
  const drawArm = (key, side, far) => {
    const [a1, a2] = pose[key];
    const dir = face === 0 ? side : face;
    const [sx, sy] = armSh(side);
    const pts = limbPts(sx, sy, a1, a2, UA, FA, dir);
    const sl = far ? shade(of.sleeve, -0.13) : of.sleeve;
    if (TOP && TOP.arm) TOP.arm(ctx, { pts, of, far, sl, C, rimPass, D, face });
    else if (of.kind === 'tee' || of.kind === 'hawaii') { // short sleeve: forearm bare (ink)
      const mid = [lerp(pts[0][0], pts[1][0], 0.62), lerp(pts[0][1], pts[1][1], 0.62)];
      poly(ctx, [mid, pts[1], pts[2]], false); stroke(ctx, C(far ? shade(of.ink, 0.06) : of.ink), ARMW * 0.72);
      poly(ctx, [pts[0], mid], false); stroke(ctx, C(sl), ARMW * 1.08);
    } else { poly(ctx, pts, false); stroke(ctx, C(sl), of.sleeve === of.ink ? ARMW * 0.72 : ARMW); }
    const hx = pts[2][0], hy = pts[2][1];
    fillC(ctx, hx, hy, HAND, C(of.ink));
    const hand = key === 'la' ? 'L' : 'R';
    handPos[hand] = [hx, hy];
    if (!rimPass) {
      if (of.acc.has('watch') && hand === (face < 0 ? 'L' : 'R')) { const wx = lerp(pts[1][0], hx, 0.82), wy = lerp(pts[1][1], hy, 0.82); fillC(ctx, wx, wy, 8, '#d9dde5'); fillC(ctx, wx, wy, 4.5, '#3b4152'); }
      const held = o.holds[hand];
      if (held) { ctx.save(); ctx.translate(hx, hy); drawHeld(ctx, F.lookupProp(held, o.where), o.t, `${o.where} held prop`); ctx.restore(); }
      of.extra.forEach((x, i) => { if (x.anchor === 'hand' + hand) { ctx.save(); ctx.translate(hx, hy); drawHeld(ctx, x.shape, o.t, `${o.where} extra ${i}`); ctx.restore(); } });
    }
  };
  // far arm behind torso in side view
  if (face !== 0) withHand(ctx, () => drawArm(face > 0 ? 'la' : 'ra', face > 0 ? -1 : 1, true));

  const headY = shY - R + 8 - D.NECK + (pose.headDy || 0); // look.rig.NECK lifts the head off the shoulders
  // ---- hair behind the head
  hairBack(ctx, of, R, face, headY, pose, C);
  // ---- torso
  if (of.kind === 'dress' || skirtLike) {
    const sk = of.kind === 'dress' ? of.torso : of.trousers;
    ctx.beginPath(); ctx.moveTo(-tw / 2 + 4, hipY - 10); ctx.lineTo(tw / 2 - 4, hipY - 10); ctx.lineTo(tw / 2 + 22, hipY + TH * 0.62); ctx.lineTo(-tw / 2 - 22, hipY + TH * 0.62); ctx.closePath();
    ctx.fillStyle = C(sk); ctx.fill();
    if (!rimPass) { ctx.save(); ctx.clip(); const g = ctx.createLinearGradient(-tw, 0, tw, 0); g.addColorStop(0, rgba(shade(sk, -0.2), 0.8)); g.addColorStop(0.4, rgba(shade(sk, -0.2), 0)); ctx.fillStyle = g; ctx.fillRect(-tw, hipY - 10, tw * 2, TH); ctx.restore(); }
  }
  const tLen = of.kind === 'lab' ? tH + 34 : tH;
  if (TOP && TOP.torso) TOP.torso(ctx, { of, D, tw, tTop, tH: tLen, shY, hipY, headY, face, pose, C, rimPass, o });
  else {
    rr(ctx, -tw / 2, tTop, tw, tLen, [26, 26, 12, 12]); ctx.fillStyle = C(of.torso); ctx.fill();
    if (!rimPass && of.kind !== 'none') torsoDetail(ctx, of, tw, tTop, tLen, face, o);
  }
  if (!rimPass && of.acc.has('badge')) { const bx = (face === 0 ? -tw * 0.22 : face * 14), by = tTop + 44; ctx.save(); ctx.translate(bx, by); poly(ctx, [[0, -12], [11, -6], [9, 8], [0, 13], [-9, 8], [-11, -6]]); ctx.fillStyle = '#f2c14e'; ctx.fill(); fillC(ctx, 0, 0, 3.5, '#b8862b'); ctx.restore(); }

  // ---- head
  ctx.save(); ctx.translate(face * 4, headY); ctx.rotate(pose.tilt || 0);
  headPath(ctx, D.headShape, R); ctx.fillStyle = C(of.ink); ctx.fill();
  if (!rimPass) {
    const g = ctx.createRadialGradient(-R * 0.3, -R * 0.35, 4, 0, 0, R);
    g.addColorStop(0, 'rgba(255,255,255,0.07)'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; headPath(ctx, D.headShape, R); ctx.fill();
    const FS = F.look.rig.FACE; // optional look face scale/offset: {scale, dy}
    if (FS) { ctx.save(); ctx.translate(0, FS.dy || 0); ctx.scale(FS.scale || 1, FS.scale || 1); drawFace(ctx, o, R); ctx.restore(); } else drawFace(ctx, o, R);
  }
  hairTop(ctx, of, R, face, C, rimPass);
  hat(ctx, of, R, face, C, rimPass);
  accHead(ctx, of, R, face, C, rimPass);
  if (!rimPass) of.extra.forEach((x, i) => { if (x.anchor === 'head') drawHeld(ctx, x.shape, o.t, `${o.where} extra ${i}`); });
  ctx.restore();
  // ---- neck items over the chin
  if (of.acc.has('chain')) { ctx.beginPath(); ctx.arc(face * 6, tTop - 2, 34, 0.18 * Math.PI, 0.82 * Math.PI); stroke(ctx, C('#f2c14e'), 6); if (!rimPass) fillC(ctx, face * 6, tTop + 33, 8, '#f2c14e'); }
  if (of.acc.has('bandana')) {
    const bx = face * 10;
    ctx.beginPath(); ctx.moveTo(bx - 32, tTop + 6); ctx.lineTo(bx + 32, tTop + 6); ctx.lineTo(bx + face * 10, tTop + 48); ctx.closePath(); ctx.fillStyle = C('#d8343a'); ctx.fill();
    if (!rimPass) { rr(ctx, bx - 32, tTop, 64, 12, 6); ctx.fillStyle = '#b8262d'; ctx.fill(); [[-10, 16], [10, 18], [0, 30]].forEach(([a, b]) => fillC(ctx, bx + a, tTop + b, 2.6, '#f6e7d8')); }
  }
  if (!rimPass) of.extra.forEach((x, i) => {
    const pt = x.anchor === 'neck' ? [face * 6, tTop + 4] : x.anchor === 'chest' ? [face * 8, tTop + 52] : x.anchor === 'hip' ? [0, hipY] : null;
    if (pt) { ctx.save(); ctx.translate(pt[0], pt[1]); drawHeld(ctx, x.shape, o.t, `${o.where} extra ${i}`); ctx.restore(); }
  });
  // ---- arms in front (front view: both; side view: near arm) — after the head so hands can reach the face
  if (face === 0) { withHand(ctx, () => drawArm('la', -1, false)); withHand(ctx, () => drawArm('ra', 1, false)); }
  else withHand(ctx, () => drawArm(face > 0 ? 'ra' : 'la', face > 0 ? 1 : -1, false));
  ctx.restore();

  function withHand(c, fn) { c.save(); fn(); c.restore(); }
}

function torsoDetail(ctx, of, tw, tTop, tH, face, o) {
  ctx.save(); rr(ctx, -tw / 2, tTop, tw, tH, [26, 26, 12, 12]); ctx.clip();
  // pattern
  const pc = of.patternColor || shade(of.torso, of.kind === 'hawaii' ? -0.35 : -0.25);
  const R2 = rng(hashStr(o.castId || 'p'));
  if (of.pattern === 'stripes') for (let y = tTop + 14; y < tTop + tH; y += 22) { ctx.fillStyle = pc; ctx.fillRect(-tw, y, tw * 2, 9); }
  else if (of.pattern === 'dots') for (let y = tTop + 12; y < tTop + tH; y += 22) for (let x = -tw / 2 + ((y / 22) % 2 ? 6 : 17); x < tw / 2; x += 22) fillC(ctx, x, y, 4.5, pc);
  else if (of.pattern === 'camo') for (let i = 0; i < 14; i++) { ctx.save(); ctx.translate(-tw / 2 + R2() * tw, tTop + R2() * tH); ctx.rotate(R2() * 3); fillE(ctx, 0, 0, 14 + R2() * 10, 7 + R2() * 6, i % 2 ? pc : shade(of.torso, 0.15)); ctx.restore(); }
  else if (of.pattern === 'flowers') for (let i = 0; i < 26; i++) {
    const fx = -tw / 2 + R2() * tw, fy = tTop + R2() * tH, fr = 5 + R2() * 4;
    if (i % 3 === 0) { ctx.save(); ctx.translate(fx, fy); ctx.rotate(R2() * 6); fillE(ctx, 0, 0, fr * 1.8, fr * 0.7, pc); ctx.restore(); }
    else { for (let p = 0; p < 5; p++) fillC(ctx, fx + Math.cos(p * 1.256) * fr * 0.6, fy + Math.sin(p * 1.256) * fr * 0.6, fr * 0.5, i % 2 ? '#f6e7c1' : '#f29a8a'); fillC(ctx, fx, fy, fr * 0.3, '#f5c26b'); }
  }
  // soft shading away from the light
  const g = ctx.createLinearGradient(-tw / 2, 0, tw / 2, 0); g.addColorStop(0, rgba(of.torsoDark, 0.85)); g.addColorStop(0.35, rgba(of.torsoDark, 0)); ctx.fillStyle = g; ctx.fillRect(-tw, tTop, tw * 2, tH);
  const cx = face * 6, dk = of.torsoDark;
  switch (of.kind) {
    case 'jacket':
      line(ctx, cx, tTop + 18, cx, tTop + tH); stroke(ctx, dk, 3);
      fillRR(ctx, -tw / 2 + 8, tTop + tH - 44, 20, 5, 2, dk); fillRR(ctx, tw / 2 - 28, tTop + tH - 44, 20, 5, 2, dk);
      fillRR(ctx, -tw / 2, tTop + tH - 12, tw, 12, 4, dk);
      poly(ctx, [[-22 + cx, tTop + 2], [cx, tTop + 22], [22 + cx, tTop + 2], [18 + cx, tTop - 4], [-18 + cx, tTop - 4]]); ctx.fillStyle = dk; ctx.fill(); break;
    case 'suit': {
      poly(ctx, [[-16 + cx, tTop], [cx, tTop + 46], [16 + cx, tTop]]); ctx.fillStyle = '#f7f4ee'; ctx.fill();
      poly(ctx, [[cx - 5, tTop + 6], [cx + 5, tTop + 6], [cx + 7, tTop + 40], [cx, tTop + 50], [cx - 7, tTop + 40]]); ctx.fillStyle = shade(dk, -0.35); ctx.fill();
      line(ctx, -16 + cx, tTop, cx - 2, tTop + 60); stroke(ctx, dk, 3); line(ctx, 16 + cx, tTop, cx + 2, tTop + 60); stroke(ctx, dk, 3);
      fillC(ctx, cx, tTop + 74, 3, dk); fillC(ctx, cx, tTop + 96, 3, dk); break;
    }
    case 'hoodie':
      fillRR(ctx, -24, tTop + tH - 52, 48, 28, 8, dk);
      line(ctx, -9, tTop + 6, -11, tTop + 40); stroke(ctx, '#ffffff', 2.5); line(ctx, 9, tTop + 6, 11, tTop + 40); stroke(ctx, '#ffffff', 2.5); break;
    case 'tee': ctx.beginPath(); ctx.arc(cx, tTop - 6, 22, 0.15 * Math.PI, 0.85 * Math.PI); stroke(ctx, dk, 4); fillRR(ctx, -tw / 2, tTop + tH - 10, tw, 10, 3, rgba(dk, .7)); break;
    case 'hawaii': poly(ctx, [[-20 + cx, tTop - 2], [cx, tTop + 26], [20 + cx, tTop - 2]]); ctx.fillStyle = of.ink; ctx.fill(); line(ctx, cx, tTop + 26, cx, tTop + tH); stroke(ctx, dk, 3); break;
    case 'open':
      poly(ctx, [[-18 + cx, tTop - 2], [cx, tTop + 40], [18 + cx, tTop - 2]]); ctx.fillStyle = of.ink; ctx.fill();
      ctx.beginPath(); ctx.moveTo(-18 + cx, tTop - 2); ctx.lineTo(-30 + cx, tTop + 16); ctx.lineTo(-8 + cx, tTop + 30); ctx.moveTo(18 + cx, tTop - 2); ctx.lineTo(30 + cx, tTop + 16); ctx.lineTo(8 + cx, tTop + 30); stroke(ctx, dk, 3);
      line(ctx, cx, tTop + 40, cx, tTop + tH); stroke(ctx, dk, 2.5); break;
    case 'vest': poly(ctx, [[-16 + cx, tTop - 2], [cx, tTop + 34], [16 + cx, tTop - 2]]); ctx.fillStyle = of.ink; ctx.fill(); fillC(ctx, cx, tTop + 58, 3, dk); fillC(ctx, cx, tTop + 82, 3, dk); break;
    case 'dress': ctx.beginPath(); ctx.arc(cx, tTop - 8, 20, 0.15 * Math.PI, 0.85 * Math.PI); stroke(ctx, dk, 4); fillRR(ctx, -tw / 2, tTop + tH - 16, tw, 7, 3, dk); break;
    case 'lab': line(ctx, cx, tTop + 6, cx, tTop + tH); stroke(ctx, dk, 3); fillRR(ctx, tw / 2 - 26, tTop + 30, 16, 20, 3, dk); poly(ctx, [[-14 + cx, tTop - 2], [cx, tTop + 30], [14 + cx, tTop - 2]]); ctx.fillStyle = '#9fb3c8'; ctx.fill(); break;
  }
  ctx.restore();
}

function hairBack(ctx, of, R, face, headY, pose, C) {
  const st = of.hair.style, hc = of.hair.color;
  if (!['ponytail', 'long', 'afro', 'braids', 'curly'].includes(st)) return;
  ctx.save(); ctx.translate(face * 4, headY); ctx.rotate(pose.tilt || 0);
  if (st === 'ponytail') {
    const dir = face === 0 ? 1 : -face;
    ctx.save(); ctx.translate(dir * R * (face === 0 ? 0.8 : 0.55), -R * (face === 0 ? 0.3 : 0.45)); ctx.rotate(-dir * (face === 0 ? 0.55 : 0.5));
    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.quadraticCurveTo(dir * 26, 40, dir * 8, 92); ctx.quadraticCurveTo(dir * 2, 60, -14, 22); ctx.closePath();
    ctx.fillStyle = C(hc); ctx.fill(); ctx.restore();
  } else if (st === 'long') {
    const back = face === 0 ? 0 : -face * R * 0.25;
    rr(ctx, -R * 1.08 + back, -R * 0.6, R * 2.16, R * 2.15, [R, R, R * 0.4, R * 0.4]); ctx.fillStyle = C(hc); ctx.fill();
  } else if (st === 'afro') { fillC(ctx, -face * R * 0.1, -R * 0.18, R * 1.42, C(hc)); }
  else if (st === 'curly') { for (let i = 0; i < 9; i++) { const a = Math.PI * (0.95 + i * 0.14); fillC(ctx, Math.cos(a) * R * 1.0, Math.sin(a) * R * 1.0, R * 0.32, C(hc)); } }
  else if (st === 'braids') { [-1, 1].forEach(sd => { if (face !== 0 && sd === face) return; for (let j = 0; j < 4; j++) fillE(ctx, sd * R * 0.85 + (face === 0 ? 0 : -face * 6), R * 0.3 + j * 20, 9, 12, C(hc)); }); }
  ctx.restore();
}
function hairTop(ctx, of, R, face, C, rimPass) {
  const st = of.hair.style, hc = of.hair.color;
  if (of.hat.kind === 'beanie') return;
  switch (st) {
    case 'short': case 'braids': case 'long':
      ctx.beginPath(); ctx.arc(0, 0, R * 1.04, Math.PI * 1.02, Math.PI * 1.98); ctx.quadraticCurveTo(R * 0.4, -R * 0.42, -face * R * 0.1, -R * 0.5); ctx.quadraticCurveTo(-R * 0.6, -R * 0.42, -R * 1.04, -R * 0.06); ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill(); break;
    case 'curly': for (let i = 0; i < 7; i++) { const a = Math.PI * (1.1 + i * 0.13); fillC(ctx, Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86, R * 0.27, C(hc)); } break;
    case 'afro': ctx.beginPath(); ctx.arc(0, 0, R * 1.02, Math.PI * 1.1, Math.PI * 1.9); ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill(); break;
    case 'ponytail':
      ctx.beginPath(); ctx.arc(0, 0, R * 1.03, Math.PI * 1.05, Math.PI * 1.95); ctx.quadraticCurveTo(R * 0.2, -R * 0.55, -R * 0.2, -R * 0.62); ctx.quadraticCurveTo(-R * 0.6, -R * 0.4, -R * 1.02, -R * 0.12); ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill();
      if (!rimPass) { ctx.save(); ctx.translate((face === 0 ? 1 : -face) * R * 0.8, -R * 0.35); fillC(ctx, 0, 0, 8, '#d8343a'); ctx.restore(); } break;
    case 'bun':
      fillC(ctx, -face * R * 0.2, -R * 0.98, R * 0.36, C(hc));
      ctx.beginPath(); ctx.arc(0, 0, R * 1.02, Math.PI * 1.08, Math.PI * 1.92); ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill(); break;
    case 'white':
      ctx.beginPath(); ctx.arc(0, 0, R * 1.07, Math.PI * 1.06, Math.PI * 1.94);
      for (let i = 0; i <= 10; i++) ctx.lineTo(lerp(R, -R, i / 10), -R * (0.36 + (i % 2 ? 0.1 : 0) + 0.12 * Math.sin(i / 10 * Math.PI)));
      ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill();
      [-1, 1].forEach(sd => { if (face === 0 || sd === -face) fillE(ctx, sd * R * 0.9, -R * 0.12, R * 0.2, R * 0.3, C(hc)); }); break;
    case 'slick':
      ctx.beginPath(); ctx.arc(0, 0, R * 1.05, Math.PI, Math.PI * 2); ctx.quadraticCurveTo(R * 0.6, -R * 0.5, 0, -R * 0.55); ctx.quadraticCurveTo(-R * 0.7, -R * 0.55, -R * 1.05, 0); ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill();
      if (!rimPass) for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(R * 0.4, R * 0.2, R * (0.85 + i * 0.12), Math.PI * 1.2, Math.PI * 1.6); stroke(ctx, 'rgba(255,255,255,.25)', 2.5); } break;
    case 'bald': if (!rimPass) fillE(ctx, -R * 0.35, -R * 0.55, R * 0.22, R * 0.12, 'rgba(255,255,255,.18)', -0.5); break;
  }
}
function hat(ctx, of, R, face, C, rimPass) {
  const k = of.hat.kind, hc = of.hat.color;
  if (k === 'none') return;
  ctx.save();
  if (k === 'cap') {
    ctx.translate(0, -R * 0.55);
    ctx.beginPath(); ctx.arc(0, 8, R * 0.98, Math.PI * 1.02, Math.PI * 1.98); ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill();
    if (face === 0) { ell(ctx, 0, 8, R * 0.9, 9); ctx.fill(); } else { rr(ctx, face > 0 ? 10 : -R * 1.25, 0, R * 1.15, 10, 5); ctx.fill(); }
    if (!rimPass) fillC(ctx, 0, 8 - R * 0.98, 4, shade(hc, 0.25));
  } else if (k === 'capBack') {
    const bd = face === 0 ? 0 : -face;
    ctx.translate(0, -R * 0.5);
    ctx.beginPath(); ctx.arc(0, 8, R, Math.PI * 1.03, Math.PI * 1.97); ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill();
    if (bd !== 0) { rr(ctx, bd > 0 ? R * 0.55 : -R * 1.55, 2, R, 10, 5); ctx.fill(); }
    else if (!rimPass) { ctx.beginPath(); ctx.arc(0, 8, 12, Math.PI, 0); ctx.fillStyle = of.ink; ctx.fill(); fillRR(ctx, -16, 4, 32, 5, 2, shade(hc, 0.2)); }
    if (!rimPass) fillC(ctx, 0, 8 - R, 4, shade(hc, 0.25));
  } else if (k === 'beanie') {
    ctx.beginPath(); ctx.arc(0, -R * 0.12, R * 1.04, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill();
    rr(ctx, -R * 1.08, -R * 0.3, R * 2.16, R * 0.34, 8); ctx.fillStyle = C(shade(hc, -0.15)); ctx.fill();
    fillC(ctx, 0, -R * 1.18, R * 0.2, C(shade(hc, 0.2)));
    if (!rimPass) for (let i = -3; i <= 3; i++) { line(ctx, i * R * 0.28, -R * 0.28, i * R * 0.28, -R * 0.0); stroke(ctx, rgba(shade(hc, -0.35), .6), 2); }
  } else if (k === 'fedora' || k === 'homburg') {
    ctx.translate(0, -R * 0.62); ctx.rotate(-0.06 * (face || 1));
    ell(ctx, 0, 6, R * (k === 'fedora' ? 1.32 : 1.12), 9); ctx.fillStyle = C(shade(hc, -0.12)); ctx.fill();
    if (k === 'fedora') { ctx.beginPath(); ctx.moveTo(-R * 0.72, 4); ctx.lineTo(-R * 0.62, -R * 0.62); ctx.quadraticCurveTo(0, -R * 0.45, R * 0.62, -R * 0.62); ctx.lineTo(R * 0.72, 4); ctx.closePath(); ctx.fillStyle = C(hc); ctx.fill(); }
    else { rr(ctx, -R * 0.7, -R * 0.62, R * 1.4, R * 0.7, [16, 16, 2, 2]); ctx.fillStyle = C(hc); ctx.fill(); }
    if (!rimPass) fillRR(ctx, -R * 0.7, -8, R * 1.4, 9, 2, shade(hc, -0.4));
  } else if (k === 'headband') {
    ctx.beginPath(); ctx.arc(0, 0, R * 1.0, Math.PI * 1.1, Math.PI * 1.9); stroke(ctx, C(hc), 11, 'butt');
    if (face !== 0 && !rimPass) { ctx.beginPath(); ctx.moveTo(-face * R * 0.9, -R * 0.4); ctx.lineTo(-face * R * 1.35, -R * 0.1); ctx.lineTo(-face * R * 1.25, -R * 0.35); ctx.closePath(); ctx.fillStyle = hc; ctx.fill(); }
  } else if (k === 'crown') {
    ctx.translate(0, -R * 0.78);
    poly(ctx, [[-R * 0.7, 6], [-R * 0.78, -R * 0.55], [-R * 0.38, -R * 0.2], [0, -R * 0.7], [R * 0.38, -R * 0.2], [R * 0.78, -R * 0.55], [R * 0.7, 6]]); ctx.fillStyle = C(hc); ctx.fill();
    if (!rimPass) { fillC(ctx, 0, -R * 0.1, 5, '#e8574e'); fillC(ctx, -R * 0.4, -2, 4, '#7cc3e6'); fillC(ctx, R * 0.4, -2, 4, '#7cc3e6'); }
  }
  ctx.restore();
}
function accHead(ctx, of, R, face, C, rimPass) {
  const A = of.acc;
  if (A.has('headset')) {
    const sd = face === 0 ? 1 : face;
    ctx.beginPath(); ctx.arc(0, 0, R * 1.08, Math.PI * 1.1, Math.PI * 1.9); stroke(ctx, C('#2b2f3a'), 6);
    fillRR(ctx, sd * R * 0.82 - 9, -14, 18, 30, 8, C('#2b2f3a'));
    if (!rimPass) { ctx.beginPath(); ctx.moveTo(sd * R * 0.85, 10); ctx.quadraticCurveTo(sd * R * 0.7, 32, sd * 12, 26); stroke(ctx, '#2b2f3a', 4); fillC(ctx, sd * 10, 26, 4.5, '#4a4f5e'); }
  }
  if (A.has('headphones')) {
    ctx.beginPath(); ctx.arc(0, -4, R * 1.12, Math.PI * 1.05, Math.PI * 1.95); stroke(ctx, C('#f1f1ee'), 9);
    [-1, 1].forEach(sd => { if (face !== 0 && sd === face) return; fillRR(ctx, sd * R * (face === 0 ? 0.95 : 0.1) - 13, -18, 26, 40, 11, C('#f1f1ee')); if (!rimPass) fillRR(ctx, sd * R * (face === 0 ? 0.95 : 0.1) - 7, -10, 14, 24, 6, F.look.palette.accent || '#e8574e'); });
  }
  if (rimPass) return;
  const ex = face * 6, ey = -6;
  if (A.has('sunglasses')) {
    [-15, 15].forEach(dx => { fillRR(ctx, ex + dx - 13, ey - 8, 26, 17, 6, '#0b0c10'); fillRR(ctx, ex + dx - 8, ey - 5, 7, 3, 1.5, 'rgba(255,255,255,.55)'); });
    line(ctx, ex - 3, ey - 3, ex + 3, ey - 3); stroke(ctx, '#0b0c10', 4);
    ctx.beginPath(); ctx.moveTo(ex - 28, ey - 4); ctx.lineTo(-R * 0.98, ey - 7); ctx.moveTo(ex + 28, ey - 4); ctx.lineTo(R * 0.98, ey - 7); stroke(ctx, 'rgba(230,236,245,.6)', 2.5);
  }
  if (A.has('glasses')) { [-15, 15].forEach(dx => { circ(ctx, dx + ex, ey, 13); stroke(ctx, '#e7ecf5', 3); }); line(ctx, -2 + ex, ey, 2 + ex, ey); stroke(ctx, '#e7ecf5', 3); }
  const fh = of.hair.color === of.ink ? '#5b5f6b' : shade(of.hair.color, 0.08);
  if (A.has('beard')) { ctx.beginPath(); ctx.arc(face * 5, 2, R * 0.92, Math.PI * 0.08, Math.PI * 0.92); ctx.quadraticCurveTo(face * 5, R * 1.25, R * 0.92 * Math.cos(Math.PI * 0.08) + face * 5, R * 0.92 * Math.sin(Math.PI * 0.08) + 2); ctx.closePath(); ctx.fillStyle = fh; ctx.fill(); }
  if (A.has('mustache') || A.has('beard')) { ctx.beginPath(); ctx.moveTo(ex - 16, 12); ctx.quadraticCurveTo(ex, 4, ex + 16, 12); ctx.quadraticCurveTo(ex, 9, ex - 16, 12); stroke(ctx, A.has('beard') ? shade(fh, 0.15) : fh, 6); }
}

function drawFace(ctx, o, R) {
  const face = o.face, ex = Object.assign({}, o.app.face, o.poseExpr || {}, o.expr || {});
  const look = o.look || [face * 0.6, 0];
  const lx = look[0] * 10, ly = look[1] * 6;
  const W_ = F.look.palette.eye || '#ffffff';
  const sun = o.app.acc.has('sunglasses');
  const eyeY = -6 + ly, exs = [-15 + lx, 15 + lx];
  const bl = 1 - clamp(o.blink || 0);
  if (!sun) {
    switch (ex.eyes) {
      case 'wide': exs.forEach(x => fillE(ctx, x, eyeY, 8, Math.max(0.8, 12 * bl), W_)); exs.forEach(x => fillC(ctx, x + lx * 0.2, eyeY + 1, 3.2, F.look.palette.ink)); break;
      case 'happy': exs.forEach(x => { ctx.beginPath(); ctx.arc(x, eyeY + 4, 8, Math.PI * 1.1, Math.PI * 1.9); stroke(ctx, W_, 4.5); }); break;
      case 'sleepy': exs.forEach(x => { ctx.save(); ctx.beginPath(); ctx.rect(x - 10, eyeY, 20, 20); ctx.clip(); fillE(ctx, x, eyeY, 6.5, Math.max(0.8, 9 * bl), W_); ctx.restore(); line(ctx, x - 9, eyeY, x + 9, eyeY); stroke(ctx, W_, 3.5); }); break;
      case 'angry': exs.forEach((x, i) => { ctx.save(); ctx.beginPath(); const s = i ? -1 : 1; ctx.moveTo(x - 10, eyeY - 4 - s * 4); ctx.lineTo(x + 10, eyeY - 4 + s * 4); ctx.lineTo(x + 10, eyeY + 14); ctx.lineTo(x - 10, eyeY + 14); ctx.closePath(); ctx.clip(); fillE(ctx, x, eyeY + 1, 6.4, Math.max(0.8, 9 * bl), W_); ctx.restore(); }); break;
      case 'smug': exs.forEach(x => { ctx.save(); ctx.beginPath(); ctx.rect(x - 10, eyeY + 1, 20, 20); ctx.clip(); fillE(ctx, x, eyeY, 6.5, Math.max(0.8, 9.5 * bl), W_); ctx.restore(); }); break;
      default: exs.forEach(x => fillE(ctx, x, eyeY, 6.2, Math.max(0.8, 9.5 * bl), W_));
    }
  }
  // brows
  const by = eyeY - (sun ? 16 : 17);
  switch (ex.brows) {
    case 'up': exs.forEach(x => { ctx.beginPath(); ctx.arc(x, eyeY - 4, 15, Math.PI * 1.3, Math.PI * 1.7); stroke(ctx, W_, 3.5); }); break;
    case 'down': ctx.beginPath(); ctx.moveTo(exs[0] - 9, by); ctx.lineTo(exs[0] + 8, by + 6); ctx.moveTo(exs[1] + 9, by); ctx.lineTo(exs[1] - 8, by + 6); stroke(ctx, W_, 4); break;
    case 'worried': ctx.beginPath(); ctx.moveTo(exs[0] - 9, by + 3); ctx.lineTo(exs[0] + 7, by - 3); ctx.moveTo(exs[1] + 9, by + 3); ctx.lineTo(exs[1] - 7, by - 3); stroke(ctx, W_, 3.5); break;
  }
  // mouth (say flaps override)
  const mx = lx * 0.8, my = 16 + ly * 0.5;
  if (o.talk > 0.2) { fillE(ctx, mx, my + 2, 8, 3 + 8 * o.talk, W_); return; }
  switch (ex.mouth) {
    case 'smile': ctx.beginPath(); ctx.arc(mx, my - 8, 13, Math.PI * 0.18, Math.PI * 0.82); stroke(ctx, W_, 4.5); break;
    case 'grin': ctx.beginPath(); ctx.moveTo(mx - 15, my - 4); ctx.quadraticCurveTo(mx, my + 16, mx + 15, my - 4); ctx.closePath(); ctx.fillStyle = W_; ctx.fill(); break;
    case 'o': fillE(ctx, mx, my + 3, 6.5, 8.5, W_); break;
    case 'frown': ctx.beginPath(); ctx.arc(mx, my + 10, 10, Math.PI * 1.2, Math.PI * 1.8); stroke(ctx, W_, 4); break;
    case 'smirk': ctx.beginPath(); ctx.moveTo(mx - 9, my + 2); ctx.quadraticCurveTo(mx + 2, my + 6, mx + 11, my - 4); stroke(ctx, W_, 4); break;
    default: line(ctx, mx - 7, my + 1, mx + 7, my + 1); stroke(ctx, W_, 4);
  }
}

// ---------- item entry points ----------
function rimColour(env) { const r = env.rim || 'warm'; return r === 'none' ? null : (F.look.rim && F.look.rim[r]) || (r === 'cool' ? '#a9d8f5' : '#f7cf9f'); }
function drawActor(ctx, it, t, env, nm, base) {
  const spec = F.lookupCast(it.cast, nm), st = evalActor(it, t, base), app = appearance(spec);
  // say: mouth flaps
  let talk = 0;
  for (const [a, b] of it.say || []) if (t >= a && t < b) talk = Math.max(talk, Math.abs(Math.sin((t - a) * 11)) * Math.min(1, (b - t) * 8, (t - a) * 8 + 0.3));
  // blink: seeded per actor
  const R1 = rng(hashStr(String(it.id ?? it.cast))), per = 2.6 + R1() * 1.8, ph = R1() * per, bt = (t + ph) % per;
  const blink = bt < 0.14 ? Math.sin(bt / 0.14 * Math.PI) : 0;
  if (it.shadow !== false && !st.pose.rotAll) fillE(ctx, 0, 4, 62 * st.D.TW / 92, 11, `rgba(0,0,0,${F.look.actor.shadow ?? 0.18})`);
  drawFigure(ctx, { app, D: st.D, pose: st.pose, face: st.face, expr: st.expr, poseExpr: st.pose.expr, look: st.pose.look, talk, blink, holds: st.holds, rim: rimColour(env), t, where: nm, castId: it.cast });
}
// a static front-view figure of a cast member (cards, web nodes, custom code)
function drawCast(ctx, castId, o = {}) {
  const spec = F.lookupCast(castId, o.where || 'cast'), D = dims(spec);
  drawFigure(ctx, { app: appearance(spec), D, pose: resolve(o.pose ? POSES[o.pose](o.tl || 0, D) : {}, o.face ?? 0, D), face: o.face ?? 0, expr: o.expr || {}, talk: 0, blink: 0, holds: {}, rim: o.rim ?? null, t: o.t || 0, where: o.where || 'cast', castId });
}
function headTop(castId) { const D = dims(F.lookupCast(castId, 'cast')); return { hipY: -D.LEG, shY: -D.LEG - D.TORSO, headY: -D.LEG - D.TORSO - D.R + 8 - D.NECK, R: D.R }; }

F.rig = { POSES, ENUM, check, position, drawActor, drawCast, drawFigure, evalActor, appearance, dims, walkPose, headTop, drawHeld, hairBack, hairTop, hat, accHead };
})();
