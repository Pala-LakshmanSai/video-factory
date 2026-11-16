// looks/stickman.js — look-only drawing for the Stickman Explainer look (STICKMAN-EXPLAINER-KIT 2, kit.js + broll.js):
// the kit's hoodie as a top kind (hood behind the head, outlined sleeves to the cuff, pocket, drawstrings), the grown
// rim-light silhouette, the dark label pill with an accent bar, and the gold number with an orange bloom.
// No scenes, no named characters: the hoodie is only how this look draws top.kind "hoodie" for any cast member.
'use strict';
(function () {
const F = window.FLAT2D;
const { clamp, lerp, E, rr, poly, stroke, fillRR, ell, rgba, mix } = F;

// ---------- hoodie (kit figureBody, hoodie branch), sized from the rig: s = R / 64 (the kit's head radius) ----------
F.extras.tops = F.extras.tops || {};
F.extras.tops.hoodie = {
  torso(ctx, a) {
    const { of, D, tw, shY, hipY, headY, face, C, rimPass } = a, R = D.R, s = R / 64;
    const look = face * 0.6, turn = 1 - 0.55 * Math.abs(look), hx = face * 4;
    const H = F.look.hoodie || {};
    // hood: an ellipse behind the head, pushed back when the figure turns
    ell(ctx, hx - look * R * 0.8, headY + R * (0.55 + 0.35 * Math.abs(look)), R * 1.02, R * (0.9 + 0.35 * Math.abs(look)));
    ctx.fillStyle = C(of.torso); ctx.fill();
    if (!rimPass && look) {
      ctx.save(); ctx.globalAlpha *= Math.abs(look); ctx.beginPath();
      ctx.moveTo(hx - look * R * 1.1, headY + R * 0.2); ctx.quadraticCurveTo(hx - look * R * 1.45, headY + R, hx - look * R * 0.9, headY + R * 1.6);
      stroke(ctx, F.shade(of.torsoDark, -0.12), R * 0.09); ctx.restore();
    }
    // body: shoulders arch up, the hem hangs wider than the shoulders
    const sy = shY + 6 * s, tx = tw * 0.375 * turn, wx = tw * 0.49 * turn;
    ctx.beginPath(); ctx.moveTo(-tx, sy - 2 * s); ctx.quadraticCurveTo(0, sy - 24 * s, tx, sy - 2 * s);
    ctx.lineTo(wx, hipY + 18 * s); ctx.quadraticCurveTo(0, hipY + 28 * s, -wx, hipY + 18 * s); ctx.closePath();
    ctx.fillStyle = C(of.torso); ctx.fill();
    if (rimPass) return;
    // pocket + drawstrings
    ctx.save(); ctx.globalAlpha *= H.pocket ?? 0.7;
    poly(ctx, [[-32 * s * turn, hipY - 52 * s], [32 * s * turn, hipY - 52 * s], [38 * s * turn, hipY - 6 * s], [-38 * s * turn, hipY - 6 * s]]);
    ctx.fillStyle = of.torsoDark; ctx.fill(); ctx.restore();
    ctx.save(); ctx.globalAlpha *= H.strings ?? 0.85; ctx.beginPath();
    const nk = sy - 28 * s, lx = look * 10 * s;
    ctx.moveTo(-9 * s + lx, nk + 18 * s); ctx.lineTo(-11 * s + lx, nk + 70 * s); ctx.moveTo(9 * s + lx, nk + 18 * s); ctx.lineTo(11 * s + lx, nk + 70 * s);
    stroke(ctx, of.patternColor || mix(of.torso, '#ffffff', 0.82), 3 * s); ctx.restore();
  },
  // ink arm, then an ink-edged sleeve down to the cuff (82 % of the forearm); the rig adds the round hand
  arm(ctx, a) {
    const { pts, of, sl, C, rimPass, D } = a, w = D.ARMW;
    const cuff = [lerp(pts[1][0], pts[2][0], 0.82), lerp(pts[1][1], pts[2][1], 0.82)];
    poly(ctx, pts, false); stroke(ctx, C(of.ink), w);
    poly(ctx, [pts[0], pts[1], cuff], false); stroke(ctx, C(of.ink), w * 1.91);
    if (!rimPass) { poly(ctx, [pts[0], pts[1], cuff], false); stroke(ctx, sl, w * 1.55); }
  },
};

// ---------- rim light: the silhouette grown and shifted toward the light (kit: figure() rim) ----------
F.extras.rim = (ctx, o, silhouette) => {
  const L = F.look.rimLight || {}, r = (o.rim === F.look.rim.cool ? L.cool : L.warm) || { dx: 4, dy: -4, grow: 3 };
  for (let i = 0; i < 8; i++) { // ponytail: 8-way offset dilation, a true grown outline would need per-primitive line widths
    const an = i * Math.PI / 4;
    ctx.save(); ctx.translate(r.dx + Math.cos(an) * r.grow, r.dy + Math.sin(an) * r.grow); silhouette(); ctx.restore();
  }
};

// ---------- label pill (broll.js pill): dark glass, an accent bar on the left, tracked cream caps ----------
F.extras.pill = (ctx, str, o) => {
  const S = F.look.pillStyle, size = o.size || F.ui.DEF.pill, k = size / 30;
  const tw = F.ui.textW(ctx, str, size, S.spacing, 800), w = tw + 44 * k, h = size * 1.7;
  fillRR(ctx, -w / 2, -h / 2, w, h, h / 2, rgba(o.bg || S.bg, S.alpha));
  const acc = o.accent || o.ring || S.accent;
  if (acc) fillRR(ctx, -w / 2, -h / 2, S.bar * k, h, 5 * k, acc);
  F.ui.txt(ctx, o.shown ?? str, -tw / 2, 0, { size, weight: 800, color: o.color || S.text, spacing: S.spacing, align: 'left', qa: false });
  F.qaText(ctx, str, -tw / 2, -size * 0.55, tw, size * 1.1, size);
  F.qaGrow(ctx, -w / 2, -h / 2, w, h);
  return w;
};

// ---------- numbers (number.html): gold with an orange bloom; a fixed value (from == to) drops in digit by digit ----------
F.extras.number = (ctx, shown, o) => {
  const N = F.look.number, { size, color, it, p } = o;
  const m = ctx.getTransform(), sc = Math.hypot(m.a, m.b);
  const chars = [...shown], ws = chars.map(c => F.ui.textW(ctx, c, size, 0, 800)), total = ws.reduce((a, b) => a + b, 0);
  const drop = it.from === it.to;
  const glyph = (c, x, y, a) => {
    if (a <= 0) return;
    ctx.save(); ctx.globalAlpha *= a; ctx.font = `800 ${size}px "${F.look.fonts.display}"`; ctx.letterSpacing = '0px';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
    ctx.shadowColor = rgba(N.glow, N.k); ctx.shadowBlur = N.r2 * 2 * sc; ctx.fillText(c, x, y);
    ctx.shadowColor = rgba(N.glow, 1); ctx.shadowBlur = N.r1 * 2 * sc; ctx.fillText(c, x, y);
    ctx.shadowColor = 'transparent'; ctx.fillText(c, x, y); ctx.restore();
  };
  let x = -total / 2;
  chars.forEach((c, i) => {
    const a = drop ? E.outC(clamp(p * (chars.length + 1) - i)) : 1;
    glyph(c, x + ws[i] / 2, size * 0.04 - (1 - a) * N.drop, a); x += ws[i];
  });
  F.qaText(ctx, shown, -total / 2, -size * 0.55, total, size * 1.1, size);
};
})();
