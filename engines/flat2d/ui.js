// ui.js — text, labels, pills, tags, boards, counters, quote cards, character cards, maps (built-in florida),
// arrows, relationship webs, charts, image frames. All styling comes from the look; text is recorded for QA.
// Conventions: an item's "at" is its centre (text: centre point, vertical middle). Sizes in px at 1080p.
'use strict';
(function () {
const F = window.FLAT2D;
const { clamp, lerp, E, inv, rr, circ, ell, fillC, fillE, fillRR, poly, line, stroke, rgba, shade, drawOn, bez, partial, glowDot, pop } = F;
const P = () => F.look.palette;
const font = () => F.look.fonts.display;
const DEF = { text: 48, label: 32, pill: 32, tag: 40, quote: 40 };

// ---------- text ----------
function setFont(ctx, size, weight, spacing) { ctx.font = `${weight} ${size}px "${font()}"`; ctx.letterSpacing = `${(spacing ?? 0) * size}px`; }
function textW(ctx, str, size, spacing = F.look.label.spacing, weight = 800) { ctx.save(); setFont(ctx, size, weight, spacing); const w = ctx.measureText(str).width - (spacing ?? 0) * size; ctx.restore(); return w; }
// one line, baseline middle; returns its width. o: {size, weight, color, align, spacing, glow, glowColor, qa}
function txt(ctx, str, x, y, o = {}) {
  const size = o.size || 32, sp = o.spacing ?? 0.02, align = o.align || 'center';
  ctx.save();
  setFont(ctx, size, o.weight || 800, sp);
  const w = ctx.measureText(str).width - sp * size;
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  if (o.glow) { ctx.shadowColor = o.glowColor || 'rgba(8,10,28,.85)'; ctx.shadowBlur = o.glow; }
  ctx.fillStyle = o.color || '#fff';
  if (str) ctx.fillText(str, x0, y + size * 0.04);
  ctx.restore();
  if (o.qa !== false && str.trim()) F.qaText(ctx, str, x0, y - size * 0.55, w, size * 1.1, size);
  return w;
}
function wrap(ctx, str, size, weight, maxW, sp) {
  if (!maxW) return str.split('\n');
  ctx.save(); setFont(ctx, size, weight, sp);
  const out = [];
  for (const para of str.split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/)) {
      const tryS = cur ? cur + ' ' + word : word;
      if (cur && ctx.measureText(tryS).width - sp * size > maxW) { out.push(cur); cur = word; } else cur = tryS;
    }
    out.push(cur);
  }
  ctx.restore(); return out;
}
// multi-line text with highlighted words (hi) and a typewriter reveal (0..1 of the characters)
function block(ctx, str, o) {
  const size = o.size, weight = o.weight || 800, sp = o.spacing ?? 0.02, lh = size * (o.lh || 1.18), align = o.align || 'center';
  const lines = wrap(ctx, str, size, weight, o.maxW, sp);
  const total = lines.reduce((a, l) => a + l.length, 0);
  let left = Math.floor((o.reveal ?? 1) * total + 1e-6);
  const hi = new Set((o.hi || []).map(w => w.toLowerCase().replace(/[^\w$%]/g, '')));
  const y0 = -(lines.length - 1) * lh / 2;
  lines.forEach((ln, i) => {
    const shown = ln.slice(0, Math.max(0, left)); left -= ln.length;
    const y = y0 + i * lh;
    // measure the whole line so typing does not shift it
    const full = textW(ctx, ln, size, sp, weight);
    let x = align === 'center' ? -full / 2 : align === 'right' ? -full : 0;
    if (!hi.size) { txt(ctx, shown, x, y, { ...o, size, weight, spacing: sp, align: 'left', qa: false }); }
    else {
      const words = shown.split(/(\s+)/);
      for (const w of words) {
        const c = hi.has(w.toLowerCase().replace(/[^\w$%]/g, '')) ? o.hiColor : o.color;
        x += txt(ctx, w, x, y, { ...o, color: c, size, weight, spacing: sp, align: 'left', qa: false }) + (w ? sp * size : 0);
      }
    }
    if (ln.trim()) F.qaText(ctx, ln, align === 'center' ? -full / 2 : align === 'right' ? -full : 0, y - size * 0.55, full, size * 1.1, size);
  });
  return { lines, h: lines.length * lh };
}
function textItem(ctx, it, t, st) {
  block(ctx, it.str, { size: it.size || DEF.text, weight: it.weight || 800, color: F.col(it.fill, P().white), align: it.align, maxW: it.maxW, hi: it.hi, hiColor: F.col(it.hiColor, P().accent), reveal: st.reveal, spacing: it.spacing, glow: it.glow ?? (F.look.text.glow || 0), glowColor: F.look.text.glowColor });
}
function labelItem(ctx, it, t, st) {
  const size = it.size || DEF.label, str = it.str.toUpperCase(), L = F.look.label;
  if (it.point) {
    const px = (it.point[0] - st.x) / st.s, py = (it.point[1] - st.y) / st.s;
    const w = textW(ctx, str, size, L.spacing), dir = px >= 0 ? 1 : -1, sx = dir * (w / 2 + 18);
    const pts = [[sx, 0], [lerp(sx, px, 0.5), 0], [px, py]];
    drawOn(ctx, pts, st.reveal, F.col(it.lineColor, P().white), 3);
    if (st.reveal > 0.95) { fillC(ctx, px, py, 9, F.col(it.lineColor, P().white)); fillC(ctx, px, py, 4, F.col(it.color || it.fill, P().accent)); }
  }
  ctx.save(); ctx.globalAlpha *= it.point ? clamp(st.reveal * 3) : 1;
  const shown = it.point ? str : str.slice(0, Math.round(str.length * st.reveal));
  const w = textW(ctx, str, size, L.spacing);
  txt(ctx, shown, -w / 2, 0, { size, weight: 800, color: F.col(it.color || it.fill, P().white), spacing: L.spacing, align: 'left', glow: L.glow, glowColor: L.glowColor, qa: false });
  F.qaText(ctx, str, -w / 2, -size * 0.55, w, size * 1.1, size);
  ctx.restore();
}
function pill(ctx, str, o) {
  if (F.extras.pill) return F.extras.pill(ctx, str, o); // look hook: the look's own pill (must record QA itself)
  const size = o.size || DEF.pill, L = F.look.label, w = textW(ctx, str, size, L.spacing) + size * 1.9, h = size * 1.9;
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
  fillRR(ctx, -w / 2, -h / 2, w, h, h / 2, o.bg); ctx.restore();
  if (o.ring) { rr(ctx, -w / 2, -h / 2, w, h, h / 2); stroke(ctx, o.ring, 3); }
  txt(ctx, o.shown ?? str, -textW(ctx, str, size, L.spacing) / 2, 0, { size, color: o.color || '#fff', spacing: L.spacing, align: 'left', qa: false });
  F.qaText(ctx, str, -w / 2 + size * 0.95, -size * 0.55, w - size * 1.9, size * 1.1, size);
  F.qaGrow(ctx, -w / 2, -h / 2, w, h);
  return w;
}
function pillItem(ctx, it, t, st) {
  const str = it.str.toUpperCase();
  pill(ctx, str, { size: it.size, bg: F.col(it.color, P().pill), color: F.col(it.fill, P().white), ring: it.ring ? F.col(it.ring) : null, accent: it.accent ? F.col(it.accent) : null, shown: str.slice(0, Math.round(str.length * st.reveal)) });
}
function tagItem(ctx, it, t, st) {
  const size = it.size || DEF.tag, str = it.str.toUpperCase(), c = F.col(it.color, P().accent);
  const w = textW(ctx, str, size, 0.06) + size * 1.1, h = size * 1.65;
  ctx.save(); ctx.rotate((it.tilt ?? -7) * F.D2R);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6; fillRR(ctx, -w / 2, -h / 2, w, h, 8, c); ctx.restore();
  rr(ctx, -w / 2 + 6, -h / 2 + 6, w - 12, h - 12, 5); stroke(ctx, 'rgba(255,255,255,.55)', 2.5);
  txt(ctx, str.slice(0, Math.round(str.length * st.reveal)), -textW(ctx, str, size, 0.06) / 2, 0, { size, color: F.col(it.fill, '#ffffff'), spacing: 0.06, align: 'left', qa: false });
  F.qaText(ctx, str, -w / 2 + size * 0.55, -size * 0.55, w - size * 1.1, size * 1.1, size);
  ctx.restore();
}

// ---------- backgrounds ----------
function boardBG(ctx) {
  const W = F.W, H = F.H, B = F.look.board;
  const g = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.6);
  g.addColorStop(0, B.mid); g.addColorStop(0.55, B.body); g.addColorStop(1, B.edge);
  ctx.fillStyle = g; ctx.fillRect(-W, -H, W * 3, H * 3);
  if (B.grid) { ctx.save(); ctx.strokeStyle = B.grid; ctx.lineWidth = 1.5; for (let x = 0; x <= W; x += 80) { line(ctx, x, 0, x, H); ctx.stroke(); } for (let y = 0; y <= H; y += 80) { line(ctx, 0, y, W, y); ctx.stroke(); } ctx.restore(); }
}
function vignette(ctx, s = 0.35) {
  const W = F.W, H = F.H, g = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.1);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${s})`);
  ctx.save(); ctx.setTransform(F.base, 0, 0, F.base, 0, 0); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); ctx.restore();
}
function panel(ctx, w, h, o = {}) {
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 14; fillRR(ctx, -w / 2, -h / 2, w, h, o.r ?? 16, o.fill || F.look.board.panel); ctx.restore();
  if (o.outline !== false && F.look.board.outline !== false) { rr(ctx, -w / 2, -h / 2, w, h, o.r ?? 16); stroke(ctx, o.line || P().white, o.lw ?? 3.5); }
}

// ---------- board: a navy panel with nested items (child "at" is relative to the board's top-left) ----------
function board(ctx, it, t, st, env, nm, drawItem) {
  const w = it.w || 900, h = it.h || 560, r = st.reveal;
  if (r < 1) { const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]; ctx.save(); ctx.globalAlpha *= clamp(r * 2 - 1); fillRR(ctx, -w / 2, -h / 2, w, h, 16, F.look.board.panel); ctx.restore(); drawOn(ctx, pts, E.ioC(clamp(r * 1.4)), P().white, 3.5, true); }
  else panel(ctx, w, h, { fill: F.col(it.fill, F.look.board.panel) });
  F.qaGrow(ctx, -w / 2, -h / 2, w, h);
  if (r < 0.7) return;
  ctx.save(); ctx.globalAlpha *= clamp((r - 0.7) / 0.3);
  let top = -h / 2;
  if (it.title) { const s = it.titleSize || 32; txt(ctx, it.title.toUpperCase(), 0, top + 44, { size: s, color: F.col(it.titleColor, P().white), spacing: F.look.label.spacing }); top += 44 + s * 0.6; }
  ctx.translate(-w / 2, -h / 2);
  const kids = it.items || [], free = kids.filter(c => !c.at);
  const y0 = top + h / 2 + 30, step = (h - (y0) - 30) / Math.max(1, free.length);
  kids.forEach((c, i) => {
    const cc = c.at ? c : Object.assign({}, c, { at: [w / 2, y0 + step * (free.indexOf(c) + 0.5)] });
    drawItem(ctx, cc, t, { ...env, cam: null, idx: i, prefix: `${env.prefix}${it.id ?? 'board'}.`, where: `${nm} >`, nested: true });
  });
  ctx.restore();
}

// ---------- counter ----------
function fmt(v, d) { const s = Math.abs(v).toFixed(d), [i, f] = s.split('.'); return (v < 0 ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : ''); }
function counter(ctx, it, t, st) {
  const from = it.from ?? 0, to = it.to, t0 = it.t0 ?? 0, t1 = it.t1 ?? t0 + 1.2, d = it.decimals ?? 0;
  const v = t >= t1 ? to : lerp(from, to, E.outC(inv(t0, t1, t)));
  const shown = (it.prefix || '') + fmt(t >= t1 ? to : v, d) + (it.suffix || '');
  const size = it.size || 140;
  const nc = F.col(it.fill || it.color, P().accent);
  if (F.extras.number) F.extras.number(ctx, shown, { size, color: nc, it, t, p: inv(t0, t1, t) }); // look hook: number style (records QA itself)
  else txt(ctx, shown, 0, 0, { size, weight: 800, color: nc, spacing: 0.01, glow: it.glow ?? 0 });
  if (it.label) txt(ctx, it.label.toUpperCase(), 0, size * 0.62 + 26, { size: it.labelSize || 40, color: P().white, spacing: F.look.label.spacing });
  F.QA.counters.push({ id: it.id ?? null, value: +(t >= t1 ? to : v).toFixed(d), to, t1 });
}

// ---------- quote card (typewriter) ----------
function quote(ctx, it, t, st) {
  const size = it.size || DEF.quote, maxW = it.maxW || 1000, w = maxW + 120;
  const lines = wrap(ctx, it.str, size, 700, maxW, 0.01), h = lines.length * size * 1.3 + (it.by ? 110 : 70) + 40;
  panel(ctx, w, h, { fill: F.col(it.color, F.look.board.panel) });
  txt(ctx, '“', -w / 2 + 22, -h / 2 + 52, { size: 110, color: P().accent, align: 'left', qa: false });
  let rev = st.reveal;
  if (it.t0 != null) rev = Math.min(rev, inv(it.t0, it.t1 ?? it.t0 + it.str.length * 0.035, t));
  ctx.save(); ctx.translate(0, -h / 2 + 40 + lines.length * size * 1.3 / 2 + 6);
  block(ctx, it.str, { size, weight: 700, color: F.col(it.fill, P().white), maxW, reveal: rev, spacing: 0.01, lh: 1.3, hi: it.hi, hiColor: P().accent });
  ctx.restore();
  if (it.by) { ctx.save(); ctx.globalAlpha *= clamp(rev * 4 - 3); txt(ctx, '— ' + it.by.toUpperCase(), w / 2 - 60, h / 2 - 50, { size: 30, color: P().accent, align: 'right', spacing: F.look.label.spacing }); ctx.restore(); }
}

// ---------- character card (portrait + name + role) ----------
function card(ctx, it, t, st, env, nm) {
  const w = it.w || 820, h = it.h || 320, ph = h - 60, pw = ph * 0.86;
  panel(ctx, w, h);
  const px = -w / 2 + 30, py = -h / 2 + 30;
  ctx.save(); rr(ctx, px, py, pw, ph, 10); ctx.clip();
  const cg = F.look.card.portrait, g = ctx.createLinearGradient(0, py, 0, py + ph); cg.forEach((c, i) => g.addColorStop(i / (cg.length - 1), c));
  ctx.fillStyle = g; ctx.fillRect(px, py, pw, ph);
  const ht = F.rig.headTop(it.cast), s = ph / (ht.R * 4.4);
  ctx.translate(px + pw / 2, py + ph * 0.42); ctx.scale(s, s); ctx.translate(0, -ht.headY);
  F._noQA = true; F.rig.drawCast(ctx, it.cast, { where: nm, expr: it.expr }); F._noQA = false;
  ctx.restore();
  rr(ctx, px, py, pw, ph, 10); stroke(ctx, P().white, 3);
  const tx = px + pw + 36, tw = w / 2 - 36 - tx;
  const name = (it.name || it.cast).toUpperCase(), ns = Math.min(it.size || 48, 48);
  txt(ctx, name, tx, py + 34, { size: ns, align: 'left', spacing: F.look.label.spacing, color: P().white });
  if (it.role) { const rs = 28, rw = textW(ctx, it.role.toUpperCase(), rs) + 34; ctx.save(); ctx.translate(tx + rw / 2, py + 34 + ns * 0.6 + 32); rr(ctx, -rw / 2, -22, rw, 44, 22); stroke(ctx, P().accent, 3); txt(ctx, it.role.toUpperCase(), 0, 0, { size: rs, color: P().accent, spacing: F.look.label.spacing }); ctx.restore(); }
  for (let i = 0; i < 3; i++) fillRR(ctx, tx, py + 150 + i * 26, tw * (0.95 - i * 0.18), 9, 4.5, 'rgba(255,255,255,.28)');
  fillRR(ctx, tx, py + ph - 26, tw * 0.92 * clamp(st.reveal), 14, 7, P().accent);
}

// ---------- map ----------
// Leonida-style simplified Florida outline (our own line drawing), local box 0..756 x 0..726
const FL = [[640, 250], [1010, 262], [1040, 300], [1130, 296], [1215, 320], [1250, 360], [1262, 420], [1300, 520], [1330, 610],
  [1352, 700], [1356, 770], [1330, 830], [1286, 860], [1240, 846], [1196, 800], [1160, 740], [1112, 690], [1078, 640], [1062, 590],
  [1040, 548], [1008, 500], [960, 470], [930, 420], [890, 380], [840, 352], [790, 344], [740, 360], [690, 352], [650, 320]].map(([x, y]) => [x - 620, y - 230]);
const FL_KEYS = [[1250, 880, 13], [1210, 902, 11], [1168, 918, 10], [1126, 928, 9], [1084, 934, 8], [1044, 936, 7]].map(([x, y, r]) => [x - 620, y - 230, r]);
const OUTLINES = { florida: { box: [756, 726], pts: FL, islands: FL_KEYS } };
function checkMap(it, nm) {
  if (typeof it.outline === 'string' && !OUTLINES[it.outline]) throw new Error(`${nm}: unknown built-in outline "${it.outline}" (use ${Object.keys(OUTLINES).join('|')} or a ShapeSpec)`);
  if (it.outline && typeof it.outline === 'object') F.shapes.check(it.outline, nm);
}
function map(ctx, it, t, st, nm) {
  const o = typeof it.outline === 'object' ? it.outline : OUTLINES[it.outline || 'florida'];
  const [bw, bh] = o.box || [800, 600], line_ = P().white, acc = P().accent, r = st.reveal;
  ctx.translate(-bw / 2, -bh / 2);
  if (o.pts) {
    const fill = clamp(r * 2 - 1);
    poly(ctx, o.pts); ctx.fillStyle = `rgba(255,255,255,${0.06 * fill})`; ctx.fill();
    if (it.fill) { ctx.save(); ctx.globalAlpha *= fill; poly(ctx, o.pts); ctx.fillStyle = F.col(it.fill); ctx.fill(); ctx.restore(); }
    drawOn(ctx, o.pts, r, line_, 4, true);
    (o.islands || []).forEach(([x, y, rr_], i) => { if (r > 0.85 + i * 0.02) { circ(ctx, x, y, rr_); stroke(ctx, line_, 3); } });
  } else {
    // ShapeSpec outline: wipe it on left to right
    ctx.save(); ctx.beginPath(); ctx.rect(-20, -20, (bw + 40) * r, bh + 40); ctx.clip(); F.shapes.draw(ctx, o, t, nm); ctx.restore();
  }
  F.qaGrow(ctx, 0, 0, bw, bh);
  (it.routes || []).forEach(rt => {
    const p = E.ioS(inv(rt.t0 ?? 0, rt.t1 ?? (rt.t0 ?? 0) + 1, t)) * clamp(r * 2 - 1); if (p <= 0) return;
    const pts = rt.pts.length === 2 ? bez(rt.pts[0], [(rt.pts[0][0] + rt.pts[1][0]) / 2, Math.min(rt.pts[0][1], rt.pts[1][1]) - 120], rt.pts[1]) : rt.pts;
    ctx.save(); ctx.setLineDash([16, 12]); drawOn(ctx, pts, p, F.col(rt.color, acc), 6); ctx.restore();
    const hd = partial(pts, p).pop(); glowDot(ctx, hd[0], hd[1], 34, F.col(rt.color, acc)); fillC(ctx, hd[0], hd[1], 9, F.col(rt.color, acc));
  });
  (it.pins || []).forEach((pn, i) => {
    const s = pop(t, pn.t ?? (it.enter ? it.enter.t + (it.enter.dur ?? 0.4) : 0) + 0.15 * i, 0.4); if (s <= 0) return;
    const [x, y] = pn.at, c = F.col(pn.color, acc);
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    glowDot(ctx, 0, 0, 46, c); fillC(ctx, 0, 0, 13, c); fillC(ctx, 0, 0, 5, '#fff');
    if (pn.label) { const dir = pn.side === 'l' ? -1 : 1; txt(ctx, pn.label.toUpperCase(), dir * 26, 0, { size: pn.size || 30, align: dir > 0 ? 'left' : 'right', spacing: F.look.label.spacing, glow: 12, glowColor: 'rgba(8,10,28,.8)' }); }
    ctx.restore();
  });
}

// ---------- arrow ----------
function arrow(ctx, it, t, st) {
  const a = it.from, b = it.to, c = F.col(it.color, P().accent), lw = it.lw || 8;
  const p = E.ioC(inv(it.t0 ?? 0, it.t1 ?? (it.t0 ?? 0) + 0.6, t)) * st.reveal;
  if (p <= 0) return;
  const bend = it.curve ?? 0, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
  const pts = bez(a, [mx - dy * bend, my + dx * bend], b, 40), q = partial(pts, p);
  poly(ctx, q, false); stroke(ctx, c, lw);
  const e = q[q.length - 1], pr = q[Math.max(0, q.length - 3)], ang = Math.atan2(e[1] - pr[1], e[0] - pr[0]), hs = lw * 3.2;
  if (q.length > 2) { ctx.save(); ctx.translate(e[0], e[1]); ctx.rotate(ang); poly(ctx, [[hs * 0.4, 0], [-hs, -hs * 0.75], [-hs * 0.6, 0], [-hs, hs * 0.75]]); ctx.fillStyle = c; ctx.fill(); ctx.restore(); }
  const xs = pts.map(v => v[0]), ys = pts.map(v => v[1]);
  F.qaGrow(ctx, Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1);
}

// ---------- relationship web ----------
function web(ctx, it, t, st, env, nm) {
  const nodes = it.nodes || [], links = it.links || [], byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  const appear = n => { const lt = links.filter(l => l[0] === n.id || l[1] === n.id).map(l => l[2] ?? 0); return n.t ?? (lt.length ? Math.max(0, Math.min(...lt) - 0.35) : 0); };
  links.forEach(([a, b, lt = 0, label]) => {
    const p = E.ioC(inv(lt, lt + 0.45, t)) * st.reveal; if (p <= 0) return;
    const A = byId[a].at, B = byId[b].at;
    line(ctx, A[0], A[1], lerp(A[0], B[0], p), lerp(A[1], B[1], p)); stroke(ctx, F.col(it.lineColor, P().accent), 5);
    if (label && p >= 1) txt(ctx, String(label).toUpperCase(), (A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - 24, { size: 28, spacing: F.look.label.spacing, glow: 10 });
  });
  nodes.forEach(n => {
    const s = pop(t, appear(n), 0.4); if (s <= 0) return;
    ctx.save(); ctx.translate(n.at[0], n.at[1]); ctx.scale(s, s);
    if (n.cast) {
      const r = n.r || 78;
      ctx.save(); circ(ctx, 0, 0, r); ctx.fillStyle = F.look.board.panel; ctx.fill(); ctx.clip();
      const cg = F.look.card.portrait, g = ctx.createLinearGradient(0, -r, 0, r); cg.forEach((c, i) => g.addColorStop(i / (cg.length - 1), c)); ctx.fillStyle = g; ctx.fillRect(-r, -r, r * 2, r * 2);
      const ht = F.rig.headTop(n.cast), sc = r * 1.5 / (ht.R * 4.4);
      ctx.translate(0, r * 0.05); ctx.scale(sc, sc); ctx.translate(0, -ht.headY);
      F._noQA = true; F.rig.drawCast(ctx, n.cast, { where: nm }); F._noQA = false;
      ctx.restore();
      circ(ctx, 0, 0, r); stroke(ctx, P().white, 4);
      F.qaGrow(ctx, -r, -r, r * 2, r * 2);
      if (n.label) txt(ctx, n.label.toUpperCase(), 0, r + 34, { size: 30, spacing: F.look.label.spacing, glow: 10 });
    } else pill(ctx, String(n.label || n.id).toUpperCase(), { size: n.size || 30, bg: F.col(n.color, P().pill), ring: P().white });
    ctx.restore();
  });
}

// ---------- chart ----------
function chart(ctx, it, t, st) {
  const w = it.w || 900, h = it.h || 480, data = it.data.map((d, i) => typeof d === 'number' ? { label: '', value: d } : d);
  const p = E.ioC(inv(it.t0 ?? 0, it.t1 ?? (it.t0 ?? 0) + 1.2, t)) * st.reveal;
  const cols = F.look.chart.colors, max = Math.max(...data.map(d => d.value)) || 1, lab = 28;
  F.qaGrow(ctx, -w / 2, -h / 2, w, h);
  if (it.kind === 'pie') {
    const R = Math.min(w, h) / 2 - 20, tot = data.reduce((a, d) => a + d.value, 0) || 1;
    let a0 = -Math.PI / 2;
    data.forEach((d, i) => {
      const a1 = a0 + d.value / tot * Math.PI * 2 * p;
      ctx.beginPath(); ctx.moveTo(-w / 4, 0); ctx.arc(-w / 4, 0, R, a0, a1); ctx.closePath(); ctx.fillStyle = F.col(d.color, cols[i % cols.length]); ctx.fill(); stroke(ctx, F.look.board.panel, 4);
      if (p > 0.95) { fillRR(ctx, w / 4 - 40, -data.length * 30 + i * 60 - 12, 24, 24, 6, F.col(d.color, cols[i % cols.length])); txt(ctx, `${(d.label || '').toUpperCase()} ${Math.round(d.value / tot * 100)}%`, w / 4, -data.length * 30 + i * 60, { size: lab, align: 'left', spacing: 0.04 }); }
      a0 = a1;
    });
    return;
  }
  const x0 = -w / 2, y0 = h / 2 - 50, ch = h - 110;
  line(ctx, x0, y0, x0 + w, y0); stroke(ctx, 'rgba(255,255,255,.6)', 3);
  if (it.kind === 'bar') {
    const bw = w / data.length;
    data.forEach((d, i) => {
      const g = E.outC(clamp(p * (data.length + 1) - i));
      const bh = ch * d.value / max * g, cx = x0 + bw * (i + 0.5);
      fillRR(ctx, cx - bw * 0.3, y0 - bh, bw * 0.6, bh, [8, 8, 0, 0], F.col(d.color, cols[i % cols.length]));
      if (d.label) txt(ctx, d.label.toUpperCase(), cx, y0 + 30, { size: lab, spacing: 0.04 });
      if (g > 0.98) txt(ctx, (it.prefix || '') + fmt(d.value, it.decimals ?? 0) + (it.suffix || ''), cx, y0 - bh - 26, { size: lab + 2, spacing: 0.02 });
    });
  } else {
    const pts = data.map((d, i) => [x0 + w * (i + 0.5) / data.length, y0 - ch * d.value / max]);
    drawOn(ctx, pts, p, F.col(it.color, P().accent), 7);
    pts.forEach((q, i) => {
      if (p * (pts.length - 1) + 1e-6 >= i) { fillC(ctx, q[0], q[1], 11, P().white); fillC(ctx, q[0], q[1], 6, F.col(it.color, P().accent)); }
      if (data[i].label) txt(ctx, data[i].label.toUpperCase(), q[0], y0 + 30, { size: lab, spacing: 0.04 });
    });
  }
}

// ---------- images ----------
function drawImageFit(ctx, im, x, y, w, h, fit, zoom = 1) {
  const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
  const s = (fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih)) * zoom;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.drawImage(im, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s); ctx.restore();
}
function checkImage(it, nm) {
  if (it.fit && !['cover', 'contain'].includes(it.fit)) throw new Error(`${nm}: fit "${it.fit}" unknown (use cover|contain)`);
  if (it.frame && !['none', 'polaroid', 'tv', 'phone', 'board'].includes(it.frame)) throw new Error(`${nm}: frame "${it.frame}" unknown (use none|polaroid|tv|phone|board)`);
}
function image(ctx, it, t, env, nm) {
  const im = F.lookupImage(it.image, nm), fr = it.frame || 'none';
  const w = it.w || (fr === 'phone' ? 380 : 960), h = it.h || (fr === 'phone' ? 680 : 540);
  const kb = it.kenburns ? lerp(it.kenburns[0], it.kenburns[1], E.ioS(clamp(t / (F.duration || 5)))) : 1;
  const shadow = () => { ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 16; };
  if (fr === 'polaroid') { ctx.save(); shadow(); fillRR(ctx, -w / 2 - 22, -h / 2 - 22, w + 44, h + 110, 6, '#f7f4ee'); ctx.restore(); }
  if (fr === 'tv') { ctx.save(); shadow(); fillRR(ctx, -w / 2 - 26, -h / 2 - 26, w + 52, h + 52, 18, '#1d2130'); ctx.restore(); fillRR(ctx, -60, h / 2 + 26, 120, 26, 4, '#1d2130'); fillRR(ctx, -150, h / 2 + 48, 300, 12, 6, '#1d2130'); }
  if (fr === 'phone') { ctx.save(); shadow(); fillRR(ctx, -w / 2 - 20, -h / 2 - 50, w + 40, h + 100, 46, '#121420'); ctx.restore(); fillRR(ctx, -40, -h / 2 - 32, 80, 12, 6, '#2a2e3d'); }
  if (fr === 'board' || fr === 'none') { ctx.save(); shadow(); fillRR(ctx, -w / 2, -h / 2, w, h, fr === 'board' ? 12 : 0, '#0d1020'); ctx.restore(); }
  ctx.save(); rr(ctx, -w / 2, -h / 2, w, h, fr === 'board' ? 12 : fr === 'phone' ? 14 : 0); ctx.clip();
  drawImageFit(ctx, im, -w / 2, -h / 2, w, h, it.fit || 'cover', kb); ctx.restore();
  if (fr === 'board') { rr(ctx, -w / 2, -h / 2, w, h, 12); stroke(ctx, P().white, 3.5); }
  F.qaGrow(ctx, -w / 2 - (fr === 'none' ? 0 : 26), -h / 2 - (fr === 'phone' ? 50 : fr === 'none' ? 0 : 26), w + (fr === 'none' ? 0 : 52), h + (fr === 'polaroid' ? 110 : fr === 'tv' ? 86 : fr === 'phone' ? 100 : fr === 'none' ? 0 : 52));
}

F.ui = { txt, textW, wrap, block, pill, panel, textItem, labelItem, pillItem, tagItem, boardBG, vignette, board, counter, quote, card, map, arrow, web, chart, image, drawImageFit, checkImage, checkMap, OUTLINES, fmt, DEF };
})();
