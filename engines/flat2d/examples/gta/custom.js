// custom.js — this video's escape hatch: code for what the scene language cannot express.
// FLAT2D.custom[fn] = (ctx, t, params, api, info) => {}; drawn at the item's "at" (origin = at).
FLAT2D.custom.siren = (ctx, t, p, api, info) => {
  const c = api.col(p.color, '#e8574e'), on = Math.floor(t * 6) % 2 === 0;
  api.glowDot(ctx, -22, 0, 90, on ? c : '#7cc3e6', 0.9);
  api.fillRR(ctx, -40, -18, 80, 22, 8, '#1d2130');
  api.fillRR(ctx, -36, -16, 34, 16, 6, on ? c : api.shade(c, -0.5));
  api.fillRR(ctx, 2, -16, 34, 16, 6, on ? '#2f4a8a' : '#7cc3e6');
  info.grow(-40, -18, 80, 22);
};
