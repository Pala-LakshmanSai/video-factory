// flatglow.js — the prop-driven templates of the Flatglow style (flat vector shapes, two-tone shading, glow, a camera
// that never stops). Classic script (file://, no modules). Needs kit.js (window.FG: the Flatglow drawing kit, an
// esbuild IIFE of the audited kit's src/flatglow/*.js). Each <template>.html calls FGT.run("<template>").
// The canvas is a logical world whose short side is 1080 px (1920x1080 at 16:9, 1080x1920 at 9:16), CSS-scaled to
// the viewport. Every frame is a pure function of t and window.__scene (seeded noise only).
(function () {
  "use strict";
  const F = window.FG, E = F.E, clamp = F.clamp, lerp = F.lerp;
  const S0 = window.__scene && typeof window.__scene === "object" ? window.__scene : {};
  const P = S0.props && typeof S0.props === "object" ? S0.props : {};
  const TK = S0.tokens || {};
  const VW = S0.width > 0 ? S0.width : window.innerWidth, VH = S0.height > 0 ? S0.height : window.innerHeight;
  const LW = Math.round((1080 * VW) / Math.min(VW, VH)), LH = Math.round((1080 * VH) / Math.min(VW, VH));
  const D = S0.duration > 0 ? S0.duration : 5;
  const BG = (TK.palette && TK.palette.bg) || "#0b0b2a";
  const OUT = Math.min((TK.motion && TK.motion.out) || 0.35, D * 0.2);
  const portrait = LH > LW;

  // ── prop helpers ────────────────────────────────────────────────────────────────────────────────────────────
  const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  const req = (v, n) => str(v) || `[missing ${n}]`;
  const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
  const list = (v) => (Array.isArray(v) ? v : []);
  const seed0 = num(P.seed, 1);

  // ── worlds: background + ambient life, screen space ─────────────────────────────────────────────────────────
  const WORLDS = {
    space: { a: "#2a2380", b: "#0b0a2a", fg: "#ffffff", ink: "#c9c2ff", accent: ["#ff5a8a", "#ffb84a"], tag: F.TAG.purple },
    bio: { a: "#49068e", b: "#12052e", fg: "#ffffff", ink: "#ffd0ef", accent: ["#e8287a", "#ffc93c"], tag: F.TAG.magenta },
    tech: { a: "#1d154d", b: "#060f28", fg: "#ffffff", ink: "#9fe8ff", accent: ["#3df2ff", "#9c1dae"], tag: F.TAG.blue },
    day: { a: "#8fd8ff", b: "#fdf0dc", fg: "#241a3a", ink: "#1f2a6b", accent: ["#2a5bd7", "#3fc0c8"], tag: F.TAG.red, light: true },
    dusk: { a: "#a02566", b: "#2b0b4a", fg: "#ffffff", ink: "#ffd9a8", accent: ["#ff8a2a", "#ffc24a"], tag: F.TAG.orange },
  };
  const worldId = WORLDS[P.world] ? P.world : null;
  const area = [-200, -200, LW + 400, LH + 400];
  function drawWorld(x, t, id) {
    const w = WORLDS[id];
    x.save();
    if (id === "day") {
      F.rect(x, 0, 0, LW, LH, F.linGrad(x, 0, 0, 0, LH, [[0, w.a], [1, w.b]]));
      F.hills(x, t, { y: LH * 0.86, color: F.PAL.day.grass2, amp: 50, seed: seed0 + 1 });
      F.hills(x, t, { y: LH * 0.92, color: F.PAL.day.grass, amp: 40, seed: seed0 + 2 });
    } else if (id === "dusk") {
      const c = [F.PAL.dusk.b0, F.PAL.dusk.b1, F.PAL.dusk.b2, F.PAL.dusk.b3, F.PAL.dusk.b4];
      c.forEach((col, i) => F.rect(x, 0, (LH * i) / c.length, LW, LH / c.length + 2, col));
      F.glow(x, LW * 0.5, LH * 0.78, LH * 0.5, F.PAL.dusk.b5, 0.6);
      F.hills(x, t, { y: LH * 0.85, color: F.PAL.dusk.hill, amp: 60, seed: seed0 + 3, crest: false });
      F.hills(x, t, { y: LH * 0.93, color: F.PAL.dusk.hill2, amp: 40, seed: seed0 + 4, crest: false });
    } else {
      F.rect(x, 0, 0, LW, LH, F.radGrad(x, LW / 2, LH * 0.45, Math.max(LW, LH) * 0.75, [[0, w.a], [1, w.b]]));
      if (id === "space") F.stars(x, t, { n: Math.round((LW * LH) / 9000), seed: seed0 + 7, area });
      if (id === "bio") F.bokeh(x, t, { seed: seed0 + 5, area, op: 0.35 });
      if (id === "tech") {
        x.strokeStyle = F.rgba("#3df2ff", 0.07);
        x.lineWidth = 2;
        const g = 90, off = (t * 12) % g;
        for (let X = -off; X < LW; X += g) F.line(x, X, 0, X, LH, 2, F.rgba("#3df2ff", 0.07));
        for (let Y = -off; Y < LH; Y += g) F.line(x, 0, Y, LW, Y, 2, F.rgba("#3df2ff", 0.07));
      }
    }
    F.motes(x, t, { seed: seed0 + 11, area, color: w.light ? "#ffffff" : "#ffffff", op: w.light ? 0.5 : 0.35 });
    x.restore();
  }
  // vignette + soft bloom over the whole frame (the kit's finish(), minus grain/dots, sized to this canvas)
  let bloomCv = null;
  function finish(x, light) {
    if (!bloomCv) {
      bloomCv = document.createElement("canvas");
      bloomCv.width = Math.round(LW / 4);
      bloomCv.height = Math.round(LH / 4);
    }
    const y = bloomCv.getContext("2d");
    y.globalCompositeOperation = "source-over";
    y.drawImage(x.canvas, 0, 0, bloomCv.width, bloomCv.height);
    y.globalCompositeOperation = "multiply";
    y.drawImage(bloomCv, 0, 0);
    x.save();
    x.globalCompositeOperation = "screen";
    x.globalAlpha = light ? 0.12 : 0.3;
    x.filter = "blur(16px)";
    x.drawImage(bloomCv, 0, 0, LW, LH);
    x.restore();
    if (light) return;
    const g = x.createRadialGradient(LW / 2, LH / 2, Math.min(LW, LH) * 0.3, LW / 2, LH / 2, Math.hypot(LW, LH) * 0.6);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(5,0,20,0.32)");
    F.rect(x, 0, 0, LW, LH, g);
  }

  // ── text layout: greedy wrap + shrink to fit ────────────────────────────────────────────────────────────────
  function fit(x, s, maxW, maxH, maxSize, minSize, weight, lh, upper) {
    const words = (upper ? s.toUpperCase() : s).split(/\s+/).filter(Boolean);
    for (let size = maxSize; size >= minSize; size -= 2) {
      const lines = [];
      let cur = "";
      let ok = true;
      for (const w of words) {
        const tryS = cur ? cur + " " + w : w;
        if (F.measure(x, tryS, size, weight) <= maxW) cur = tryS;
        else {
          if (cur) lines.push(cur);
          cur = w;
          if (F.measure(x, w, size, weight) > maxW) ok = false;
        }
      }
      if (cur) lines.push(cur);
      if (ok && lines.length * size * lh <= maxH) return { lines, size };
    }
    const size = minSize, lines = [];
    let cur = "";
    for (const w of words) {
      const tryS = cur ? cur + " " + w : w;
      if (F.measure(x, tryS, size, weight) <= maxW || !cur) cur = tryS;
      else (lines.push(cur), (cur = w));
    }
    if (cur) lines.push(cur);
    return { lines, size };
  }
  const SX = LW * ((TK.safe && TK.safe.x) || 0.06), SY = LH * ((TK.safe && TK.safe.y) || 0.08);
  const SW = LW - 2 * SX, SH = LH - 2 * SY;

  // ── objects: { kind, x, y (0..1 of frame), size (0..1 of short side), color, label, labelStyle, at, seed } ──
  const KINDS = {
    planet: (x, o, X, Y, r, t) => F.planet(x, { x: X, y: Y, r, t, seed: o.seed, bands: o.color ? [o.color, F.tone(o.color, 0.18), F.tone(o.color, -0.15), F.tone(o.color, 0.3)] : undefined, atmo: o.color || "#7ab8ff" }),
    star: (x, o, X, Y, r, t) => F.star(x, { x: X, y: Y, r, t, seed: o.seed, type: ["sun", "blue", "white", "orange"].includes(o.variant) ? o.variant : undefined }),
    moon: (x, o, X, Y, r) => F.moon(x, { x: X, y: Y, r, seed: o.seed, color: o.color }),
    asteroid: (x, o, X, Y, r, t) => F.asteroid(x, { x: X, y: Y, r, t, seed: o.seed, color: o.color }),
    galaxy: (x, o, X, Y, r, t) => F.galaxy(x, { x: X, y: Y, r, t, seed: o.seed }),
    cell: (x, o, X, Y, r, t) => F.cell(x, { x: X, y: Y, r, t, seed: o.seed, color: o.color }),
    virus: (x, o, X, Y, r, t) => F.virus(x, { x: X, y: Y, r: r * 0.7, t, seed: o.seed, body: o.color }),
    bacterium: (x, o, X, Y, r, t) => F.bacterium(x, { x: X, y: Y, len: r * 2, r: r * 0.42, t, seed: o.seed, color: o.color, rot: -15 }),
    "blood-cell": (x, o, X, Y, r) => F.bloodCell(x, { x: X, y: Y, r, color: o.color }),
    orb: (x, o, X, Y, r, t) => F.orb(x, { x: X, y: Y, r: r * 0.6, t, color: o.color }),
    ball: (x, o, X, Y, r) => F.ball(x, X, Y, r, o.color || "#3fc0c8"),
    critter: (x, o, X, Y, r, t) => F.critter(x, { x: X, y: Y + r, s: r / 90, t, seed: o.seed, color: o.color, hop: 0.4 }),
    character: (x, o, X, Y, r, t) => F.character(x, { x: X, y: Y + r, s: (r * 2) / 470, t, seed: o.seed, shirt: o.color, mood: o.mood, flip: !!o.flip, view: o.view }),
    box: (x, o, X, Y, r) => F.isoBox(x, { x: X, y: Y + r * 0.4, w: r * 0.9, d: r * 0.9, h: r * 0.9, top: o.color ? F.tone(o.color, 0.3) : undefined, left: o.color, right: o.color ? F.tone(o.color, -0.2) : undefined }),
    tree: (x, o, X, Y, r, t) => F.tree(x, X, Y + r, r / 160, { t, seed: o.seed, leaf: o.color }),
    dna: (x, o, X, Y, r, t) => F.dna(x, { x0: X - r * 1.6, x1: X + r * 1.6, y: Y, amp: r * 0.45, t }),
    sparkle: (x, o, X, Y, r) => F.sparkle(x, X, Y, r * 0.5, o.color || "#ffffff"),
  };
  const kindNames = Object.keys(KINDS);
  function placeholder(x, X, Y, r, s) {
    F.circle(x, X, Y, r, F.rgba("#ffffff", 0.08));
    F.text(x, s, X, Y + 12, { size: 34, weight: 600, fill: "#ff6f8f", align: "center" });
  }
  // pop-in progress of an object appearing at `a` seconds
  const pop = (t, a) => clamp((t - a) / 0.45);
  function drawObject(x, o, i, t, w) {
    o = o && typeof o === "object" ? o : {};
    const a = num(o.at, 0.15 + i * 0.25);
    const k = pop(t, a);
    if (k <= 0) return null;
    const X = num(o.x, 0.5) * LW, Y = num(o.y, 0.5) * LH;
    const r = (clamp(num(o.size, 0.22), 0.02, 1) * 1080) / 2;
    const e = E.back(k);
    const bobY = 6 * F.wob(t * 0.6, i + 1);
    const kind = KINDS[o.kind] ? o.kind : null;
    const ob = Object.assign({ seed: i + seed0 }, o);
    F.alpha(x, clamp(k * 3), () =>
      F.at(x, X, Y + bobY, 0, e, e, () => (kind ? KINDS[kind](x, ob, 0, 0, r, t) : placeholder(x, 0, 0, r, `[unknown kind ${str(o.kind) || "?"}]`))),
    );
    return { X, Y: Y + bobY, r, a, o, w };
  }
  function drawLabel(x, L, t, w) {
    const s = str(L.o.label);
    if (!s) return;
    const k = clamp((t - L.a - 0.3) / 0.35);
    if (k <= 0) return;
    const st = L.o.labelStyle || "tag", size = 40;
    const above = L.Y - L.r - 30 > SY + 40;
    const ly = above ? L.Y - L.r - 24 : L.Y + L.r + 70;
    if (st === "pill") F.pill(x, s, L.X, ly, k, { grad: w.accent, size });
    else if (st === "name") F.nameLabel(x, s, L.X, ly, k, { color: w.ink, size: 52, align: "center", sub: str(L.o.sub) || undefined });
    else if (st === "line") {
      const side = L.X > LW * 0.6 ? -1 : 1;
      F.lineLabel(x, s, L.X + side * L.r * 0.9, L.Y - L.r * 0.9, k, { color: w.ink, size: 38, side, tx: L.X + side * L.r * 0.55, ty: L.Y - L.r * 0.55 });
    } else F.tag(x, s, L.X, ly + (above ? 0 : -40), k, { bg: str(L.o.labelColor) && F.TAG[L.o.labelColor] ? F.TAG[L.o.labelColor] : w.tag, size, tail: above });
  }

  // camera: a slow push + float around the frame centre (layer z: 0.3 far … 1 focal)
  function cam(x, t, z, fn) {
    const push = num(P.push, 0.05), panDir = P.camera === "pan-left" ? -1 : P.camera === "pan-right" ? 1 : 0;
    const still = P.camera === "still";
    const s = still ? 1 : 1 + push * (t / 10) * z * 2;
    const dx = (still ? 0 : 6 * F.wob(t * 0.35, seed0)) * z + panDir * t * 18 * z;
    const dy = (still ? 0 : 4 * F.wob(t * 0.3, seed0 + 3)) * z;
    x.save();
    x.translate(LW / 2 - dx, LH / 2 - dy);
    x.scale(s, s);
    x.translate(-LW / 2, -LH / 2);
    fn();
    x.restore();
  }
  // gradient underline / title block used by title + end-card
  function titleBlock(x, t, w, title, opts) {
    const weight = 800;
    const f = fit(x, title, SW * 0.92, opts.maxH, opts.maxSize, 44, weight, 1.08);
    const lh = f.size * 1.08;
    let y = opts.y - ((f.lines.length - 1) * lh) / 2;
    opts.top = y - f.size;
    const all = f.lines.join(" ").length;
    let shown = clamp((t - opts.a) / Math.max(0.5, Math.min(1.2, all * 0.03))) * all;
    let widest = 0;
    f.lines.forEach((ln) => {
      widest = Math.max(widest, F.measure(x, ln, f.size, weight));
      F.text(x, ln, LW / 2, y, { size: f.size, weight, fill: w.fg, align: "center", maxChars: shown });
      shown -= ln.length + 1;
      y += lh;
    });
    const ku = E.out(clamp((t - opts.a - 0.35) / 0.6));
    if (ku > 0) {
      const ux = LW / 2 - widest / 2, uy = y - lh + f.size * 0.26;
      x.fillStyle = F.linGrad(x, ux, 0, ux + widest, 0, [[0, w.accent[0]], [1, w.accent[1]]]);
      x.beginPath();
      x.roundRect(ux, uy, widest * ku, f.size * 0.08, f.size * 0.04);
      x.fill();
    }
    return y - lh + f.size * 0.26;
  }
  function textLine(x, s, y, t, a, w, size, weight, color, maxW) {
    if (!s) return y;
    const f = fit(x, s, maxW || SW * 0.85, size * 2.6, size, Math.round(size * 0.55), weight, 1.25);
    const k = clamp((t - a) / 0.4);
    F.alpha(x, k, () => f.lines.forEach((ln, i) => F.text(x, ln, LW / 2, y + i * f.size * 1.25 + (1 - E.out(k)) * 14, { size: f.size, weight, fill: color, align: "center" })));
    return y + f.lines.length * f.size * 1.25;
  }

  // ── templates ───────────────────────────────────────────────────────────────────────────────────────────────
  const T = {};
  T.title = (x, t) => {
    const w = WORLDS[worldId || "space"];
    drawWorld(x, t, worldId || "space");
    cam(x, t, 0.6, () => {
      F.planet(x, { x: LW * 0.86, y: LH * 0.2, r: 120, t, seed: seed0, atmo: "#7ab8ff" });
      F.moon(x, { x: LW * 0.12, y: LH * 0.82, r: 60, seed: seed0 + 2 });
    });
    if (P.emblem !== false) F.brandMark(x, LW / 2, LH * 0.2, 56, t, clamp(t / 0.6));
    const o = { y: LH * 0.55, a: 0.35, maxH: LH * 0.3, maxSize: portrait ? 120 : 140 };
    const yEnd = titleBlock(x, t, w, req(P.title, "title"), o);
    const kick = str(P.kicker);
    if (kick) F.tag(x, kick.toUpperCase(), LW / 2, o.top - 40, clamp((t - 0.2) / 0.35), { bg: w.tag, size: 34 });
    textLine(x, str(P.subtitle), yEnd + 90, t, 1.1, w, 44, 500, F.rgba(w.fg, 0.8));
  };
  T.scene = (x, t) => {
    const id = worldId || "space", w = WORLDS[id];
    drawWorld(x, t, id);
    const objs = list(P.objects).slice(0, 8);
    const labels = [];
    cam(x, t, 1, () => {
      if (!objs.length) placeholder(x, LW / 2, LH / 2, 160, "[missing objects]");
      objs.forEach((o, i) => {
        const L = drawObject(x, o, i, t, w);
        if (L) labels.push(L);
      });
      labels.forEach((L) => drawLabel(x, L, t, w));
    });
    const c = str(P.caption);
    if (c) {
      const k = clamp((t - num(P.captionAt, 0.6)) / 0.4);
      const f = fit(x, c, SW * 0.8, 150, 48, 28, 600, 1.2);
      const bh = f.lines.length * f.size * 1.2 + 36, bw = Math.max(...f.lines.map((l) => F.measure(x, l, f.size, 600))) + 64;
      const by = LH - SY - bh;
      F.alpha(x, k, () => {
        F.rect(x, LW / 2 - bw / 2, by + (1 - E.out(k)) * 20, bw, bh, F.rgba(w.light ? "#ffffff" : "#0b0a2a", 0.72), 14);
        f.lines.forEach((ln, i) => F.text(x, ln, LW / 2, by + 18 + f.size * 0.92 + i * f.size * 1.2 + (1 - E.out(k)) * 20, { size: f.size, weight: 600, fill: w.fg, align: "center" }));
      });
    }
  };
  T.kinetic = (x, t) => {
    const id = worldId || "tech", w = WORLDS[id];
    drawWorld(x, t, id);
    const s = req(P.text, "text");
    const emph = new Set(list(P.emphasis).map((e) => str(e).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean));
    const f = fit(x, s, SW * 0.9, SH * 0.62, portrait ? 120 : 130, 40, 800, 1.12, true);
    const words = f.lines.join(" ").split(" ");
    const span = Math.max(0.6, (D - OUT) * 0.7 - 0.2);
    const shown = clamp((t - 0.2) / span) * (words.length + 0.6);
    const lh = f.size * 1.12;
    const neon = w.accent[1] || "#7b4bff", neon2 = w.accent[0];
    let y = LH * 0.48 - ((f.lines.length - 1) * lh) / 2 + f.size * 0.35;
    let wi = 0;
    f.lines.forEach((ln) => {
      const ws = ln.split(" ");
      let cx = LW / 2 - F.measure(x, ln, f.size, 800, 0.02) / 2;
      ws.forEach((wd) => {
        const kk = clamp(shown - wi);
        const ww = F.measure(x, wd + " ", f.size, 800, 0.02);
        if (kk > 0) {
          const hot = emph.has(wd.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
          const lift = (1 - E.out(kk)) * 18;
          F.alpha(x, clamp(kk * 2.5), () => {
            F.text(x, wd, cx, y - lift, { size: f.size, weight: 800, track: 0.02, fill: "transparent", stroke: neon, strokeWidth: f.size * 0.16, glow: [neon, f.size * 0.18] });
            F.text(x, wd, cx, y - lift, { size: f.size, weight: 800, track: 0.02, fill: hot ? "#ffcf3f" : "#ffffff", stroke: neon2, strokeWidth: f.size * 0.06 });
          });
        }
        cx += ww;
        wi++;
      });
      y += lh;
    });
    const aside = str(P.aside);
    if (aside && shown >= words.length) textLine(x, aside, y + 10, t, 0.2 + span, w, 40, 500, F.rgba("#ffffff", 0.9));
  };
  T.diagram = (x, t) => {
    const id = worldId || "space", w = WORLDS[id];
    drawWorld(x, t, id);
    const nodes = list(P.nodes).slice(0, 6).map((n) => (typeof n === "string" ? { label: n } : n && typeof n === "object" ? n : {}));
    const head = str(P.heading);
    let top = SY;
    if (head) top = textLine(x, head, SY + 60, t, 0.1, w, 64, 800, w.fg) + 10;
    if (nodes.length < 2) return placeholder(x, LW / 2, LH / 2, 160, "[missing nodes]");
    const n = nodes.length, cycle = P.layout === "cycle";
    const vertical = !cycle && (portrait || P.layout === "column");
    const midY = (top + LH - SY) / 2;
    const R = cycle ? Math.min(SW, LH - SY - top) * 0.34 : 0;
    const pos = nodes.map((_, i) => {
      if (cycle) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        return [LW / 2 + Math.cos(a) * R * (portrait ? 1 : 1.35), midY + Math.sin(a) * R];
      }
      if (vertical) return [LW / 2, lerp(top + 120, LH - SY - 100, n === 1 ? 0.5 : i / (n - 1))];
      return [lerp(SX + SW / (2 * n), LW - SX - SW / (2 * n), i / (n - 1)), midY];
    });
    const r = Math.min(120, cycle ? R * 0.42 : vertical ? (LH - SY - top) / (n * 2.6) : SW / (n * 3));
    const step = Math.max(0.3, Math.min(0.9, ((D - OUT) * 0.65) / n));
    const links = Array.isArray(P.links) ? P.links : nodes.map((_, i) => [i, i + 1]).filter((l) => l[1] < n || cycle).map((l) => [l[0], l[1] % n]);
    // arrows first (under the nodes)
    links.forEach((l) => {
      if (!Array.isArray(l) || !pos[l[0]] || !pos[l[1]] || l[0] === l[1]) return;
      const [a, b] = [pos[l[0]], pos[l[1]]];
      const k = E.inOut(clamp((t - 0.3 - Math.max(l[0], l[1]) * step + step * 0.4) / 0.5));
      if (k <= 0) return;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const x0 = a[0] + Math.cos(ang) * (r + 14), y0 = a[1] + Math.sin(ang) * (r + 14);
      const x1 = b[0] - Math.cos(ang) * (r + 24), y1 = b[1] - Math.sin(ang) * (r + 24);
      const ex = lerp(x0, x1, k), ey = lerp(y0, y1, k);
      x.save();
      x.setLineDash([18, 14]);
      x.lineDashOffset = -t * 40;
      F.line(x, x0, y0, ex, ey, 6, F.rgba(w.ink, 0.85));
      x.restore();
      F.fillPoly(x, [[ex + Math.cos(ang) * 18, ey + Math.sin(ang) * 18], [ex + Math.cos(ang + 2.4) * 18, ey + Math.sin(ang + 2.4) * 18], [ex + Math.cos(ang - 2.4) * 18, ey + Math.sin(ang - 2.4) * 18]], w.ink);
    });
    const cols = ["#2f6cf0", "#e8285a", "#16b35a", "#f07a1a", "#7b2ff7", "#13a3a0"];
    nodes.forEach((nd, i) => {
      const [X, Y] = pos[i];
      const L = drawObject(x, { kind: KINDS[nd.kind] ? nd.kind : "ball", x: X / LW, y: Y / LH, size: (r * 2) / 1080, color: str(nd.color) || cols[i % cols.length], at: 0.3 + i * step }, i, t, w);
      const lab = str(nd.label) || `[missing nodes[${i}].label]`;
      const k = clamp((t - 0.55 - i * step) / 0.35);
      const size = Math.max(28, Math.min(40, (SW / n) * 0.12));
      if (L) F.tag(x, lab, vertical ? X + r + 30 : X, vertical ? Y : Y + r + size * 1.4, k, { bg: w.tag, size, align: vertical ? "left" : "center" });
    });
  };
  T.list = (x, t) => {
    const id = worldId || "bio", w = WORLDS[id];
    drawWorld(x, t, id);
    const items = list(P.items).map(str).filter(Boolean).slice(0, 6);
    const head = str(P.heading);
    let top = SY + 20;
    if (head) top = textLine(x, head, SY + 60, t, 0.1, w, 68, 800, w.fg) + 30;
    if (!items.length) items.push("[missing items]");
    const n = items.length, rowH = Math.min(150, (LH - SY - top) / n);
    const size = Math.min(54, rowH * 0.42);
    const step = Math.max(0.25, ((D - OUT) * 0.6) / n);
    const cols = ["#2f6cf0", "#e8285a", "#16b35a", "#f07a1a", "#7b2ff7", "#13a3a0"];
    const maxW = SW - rowH * 1.4;
    const fits = items.map((s) => fit(x, s, maxW, rowH * 0.9, size, 24, 700, 1.15));
    const widest = Math.max(...fits.map((f) => Math.max(...f.lines.map((l) => F.measure(x, l, f.size, 700)))));
    const x0 = Math.max(SX, LW / 2 - (widest + rowH * 1.2) / 2);
    items.forEach((_, i) => {
      const k = clamp((t - 0.3 - i * step) / 0.45);
      if (k <= 0) return;
      const cy = top + rowH * (i + 0.5), br = rowH * 0.3;
      const e = E.back(k);
      F.alpha(x, clamp(k * 3), () => {
        F.at(x, x0 + br, cy, 0, e, e, () => {
          F.ball(x, 0, 0, br, cols[i % cols.length]);
          F.text(x, String(i + 1), 0, br * 0.36, { size: br, weight: 800, fill: "#ffffff", align: "center" });
        });
        const f = fits[i];
        const lh = f.size * 1.15;
        f.lines.forEach((ln, j) => F.text(x, ln, x0 + br * 2 + 30 + (1 - E.out(k)) * 30, cy - ((f.lines.length - 1) * lh) / 2 + f.size * 0.35 + j * lh, { size: f.size, weight: 700, fill: w.fg }));
      });
    });
  };
  T["end-card"] = (x, t) => {
    const id = worldId || "space", w = WORLDS[id];
    drawWorld(x, t, id);
    F.brandMark(x, LW / 2, LH * 0.3, 80, t, clamp(t / 0.6));
    const yEnd = titleBlock(x, t, w, str(P.title) || "Thanks for watching!", { y: LH * 0.5, a: 0.3, maxH: LH * 0.2, maxSize: 96 });
    const y2 = textLine(x, str(P.tagline), yEnd + 80, t, 0.9, w, 38, 500, F.rgba(w.fg, 0.75));
    const cta = str(P.cta) || "Subscribe";
    F.pill(x, cta, LW / 2, Math.max(y2 + 70, LH * 0.72), clamp((t - 1.1) / 0.4), { grad: w.accent, size: 44 });
    const src = list(P.sources).map(str).filter(Boolean).slice(0, 4);
    F.alpha(x, 0.7 * clamp((t - 1.4) / 0.4), () => src.forEach((s, i) => F.text(x, s, SX, LH - SY + 20 - (src.length - 1 - i) * 30, { size: 22, weight: 500, fill: w.fg, family: F.MONO })));
  };

  // ── boot ────────────────────────────────────────────────────────────────────────────────────────────────────
  window.FGT = {
    kinds: kindNames,
    run(name) {
      const cv = document.getElementById("c");
      cv.width = LW;
      cv.height = LH;
      const x = cv.getContext("2d");
      const draw = T[name];
      window.__seek = (t0) => {
        const t = clamp(Number(t0) || 0, 0, D);
        x.setTransform(1, 0, 0, 1, 0, 0);
        x.globalAlpha = 1;
        x.globalCompositeOperation = "source-over";
        F.rect(x, 0, 0, LW, LH, BG);
        draw(x, t);
        finish(x, !!WORLDS[worldId || ""]?.light);
        // exit to the style background so the engine's fade/slide into the next scene is seamless
        const ex = OUT > 0 ? clamp((t - (D - OUT)) / OUT) : 0;
        if (ex > 0) F.alpha(x, E.inOut(ex), () => F.rect(x, 0, 0, LW, LH, BG));
      };
      const fonts = ['500 40px "Poppins"', '600 40px "Poppins"', '700 40px "Poppins"', '800 40px "Poppins"', '400 20px "Space Mono"'];
      window.__ready = Promise.all(fonts.map((f) => document.fonts.load(f))).then(() => window.__seek(0));
    },
  };
})();
