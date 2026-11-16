// kit.js — the Stickman Explainer drawing kit (src/stickman/kit.js + broll.js from STICKMAN-EXPLAINER-KIT 1.0.0),
// unchanged except ES exports turned into a classic script (file:// pages cannot load ES modules). Exposes window.SK.
(() => {
const K1 = (() => {
// kit.js — the Stickman Explainer look in plain JavaScript (Canvas 2D, no framework, no dependencies): flat vector
// figures with round heads and a hoodie hero, rim light, a 2:1 letterbox. World = 1920×1080 at the wide framing, a camera transform,
// layers that can be blurred (depth of field), a film finish. Every function draws on a 2D context `x`.

// ── constants + time ───────────────────────────────────────────────────────────────────────────────────────────
const W = 1920;
const H = 1080;
const BAR = 62;
const SANS = '"Inter", sans-serif';
const C = {
  ink: "#0a080c", crowd: "#2f293a", hoodie: "#2f6fe0", hoodieDark: "#2459bd", hoodieShade: "#1f4ea6",
  rimWarm: "#f2b878", rimCool: "#e8eef8", eye: "#f4ecd8", navy: "#121828", navyDeep: "#05080d",
  cream: "#f9edd4", robot: "#1b1318", robotEdge: "#3b2a40", wood: "#8c6945", woodDark: "#5a432d",
};
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const E = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  sine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
};
const ramp = (t, a, b, ease = E.inOut) => ease(clamp((t - a) / (b - a)));
/** keyframes [[time, value, ease?], …] → value at t */
const track = (t, keys) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return lerp(v0, v1, (e ?? E.inOut)((t - t0) / (t1 - t0)));
    }
  }
  return keys[keys.length - 1][1];
};
const wob = (t, seed = 0, speed = 1) => Math.sin(t * 1.3 * speed + seed * 12.9) * 0.6 + Math.sin(t * 2.7 * speed + seed * 4.1) * 0.3 + Math.sin(t * 5.3 * speed + seed * 7.7) * 0.1;
const rnd = (i, seed = 1) => {
  const v = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const RAD = Math.PI / 180;

// ── colour + drawing helpers ───────────────────────────────────────────────────────────────────────────────────
const rgba = (hex, a = 1) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const rect = (x, X, Y, w, h, fill, r = 0) => {
  x.fillStyle = fill;
  x.beginPath();
  r ? x.roundRect(X, Y, w, h, Math.min(r, w / 2, h / 2)) : x.rect(X, Y, w, h);
  x.fill();
};
const circle = (x, cx, cy, r, fill) => {
  x.fillStyle = fill;
  x.beginPath();
  x.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
  x.fill();
};
const ellipse = (x, cx, cy, rx, ry, fill) => {
  x.fillStyle = fill;
  x.beginPath();
  x.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
  x.fill();
};
const poly = (x, pts, width, color, cap = "round") => {
  x.strokeStyle = color;
  x.lineWidth = width;
  x.lineCap = cap;
  x.lineJoin = "round";
  x.beginPath();
  pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])));
  x.stroke();
};
const line = (x, x1, y1, x2, y2, width, color, cap = "round") => poly(x, [[x1, y1], [x2, y2]], width, color, cap);
const path = (x, d, fill, stroke, width = 0) => {
  const p = new Path2D(d);
  if (fill) {
    x.fillStyle = fill;
    x.fill(p);
  }
  if (stroke) {
    x.strokeStyle = stroke;
    x.lineWidth = width;
    x.lineCap = "round";
    x.lineJoin = "round";
    x.stroke(p);
  }
};
/** run fn with a saved transform: translate, rotate (deg), scale */
const at = (x, tx, ty, rot, sx, sy, fn) => {
  x.save();
  x.translate(tx, ty);
  if (rot) x.rotate(rot * RAD);
  if (sx !== 1 || sy !== 1) x.scale(sx, sy ?? sx);
  fn();
  x.restore();
};
const alpha = (x, a, fn) => {
  if (a <= 0.001) return;
  x.save();
  x.globalAlpha *= a;
  fn();
  x.restore();
};
/** text with an optional two-radius glow (canvas shadows ≈ SVG Gaussian blur × 2) */
const text = (x, str, X, Y, o) => {
  x.save();
  x.font = `${o.italic ? "italic " : ""}${o.weight ?? 800} ${o.size}px ${o.family ?? SANS}`;
  x.textAlign = o.align ?? "left";
  x.textBaseline = "alphabetic";
  x.letterSpacing = `${(o.track ?? 0) * o.size}px`;
  if (o.glow) {
    const [color, r1, r2, k] = o.glow;
    x.fillStyle = o.fill;
    x.shadowColor = rgba(color, k);
    x.shadowBlur = r2 * 2;
    x.fillText(str, X, Y);
    x.shadowColor = rgba(color, 1);
    x.shadowBlur = r1 * 2;
    x.fillText(str, X, Y);
    x.shadowColor = "transparent";
  }
  if (o.stroke) {
    x.strokeStyle = o.stroke;
    x.lineWidth = o.strokeWidth;
    x.lineJoin = "round";
    x.strokeText(str, X, Y);
  }
  x.fillStyle = o.fill;
  x.fillText(str, X, Y);
  x.restore();
};
const glow = (x, cx, cy, r, color, op = 1) => {
  if (op <= 0.001) return;
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, rgba(color, op));
  g.addColorStop(0.45, rgba(color, op * 0.35));
  g.addColorStop(1, rgba(color, 0));
  circle(x, cx, cy, r, g);
};
const linGrad = (x, x1, y1, x2, y2, stops) => {
  const g = x.createLinearGradient(x1, y1, x2, y2);
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
};
const radGrad = (x, cx, cy, r, stops) => {
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
};

// ── camera + layers + finish ───────────────────────────────────────────────────────────────────────────────────
const CAM0 = { cx: 960, cy: 540, s: 1, rot: 0 };
const applyCam = (x, c) => {
  x.translate(960, 540);
  if (c.rot) x.rotate(c.rot * RAD);
  x.scale(c.s, c.s);
  x.translate(-c.cx, -c.cy);
};
const pool = [];
const offscreen = (i) => {
  if (!pool[i]) {
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    pool[i] = cv;
  }
  return pool[i];
};
let depth = 0;
/** one layer seen through the camera. blur = depth of field (px); opacity fades the layer as a whole. */
const layer = (x, o, fn) => {
  const cam = o.cam ?? CAM0;
  const blur = o.blur ?? 0;
  const op = o.opacity ?? 1;
  if (op <= 0.001) return;
  if (blur > 0.05 || op < 0.999) {
    const cv = offscreen(depth++);
    const y = cv.getContext("2d");
    y.setTransform(1, 0, 0, 1, 0, 0);
    y.clearRect(0, 0, W, H);
    y.save();
    applyCam(y, cam);
    fn(y);
    y.restore();
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    if (blur > 0.05) x.filter = `blur(${blur}px)`;
    x.globalAlpha = op;
    x.drawImage(cv, 0, 0);
    x.restore();
    depth--;
  } else {
    x.save();
    applyCam(x, cam);
    fn(x);
    x.restore();
  }
};
let grains = null;
const makeGrains = () => {
  grains = [...Array(6)].map((_, k) => {
    const cv = document.createElement("canvas");
    cv.width = W / 2;
    cv.height = H / 2;
    const y = cv.getContext("2d");
    const im = y.createImageData(cv.width, cv.height);
    let s = 12345 + k * 777;
    for (let i = 0; i < im.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const v = (s >> 8) & 255;
      im.data[i] = im.data[i + 1] = im.data[i + 2] = v;
      im.data[i + 3] = 255;
    }
    y.putImageData(im, 0, 0);
    return cv;
  });
};
/** vignette, moving grain, the 2:1 letterbox */
const finish = (x, frame, vignette = 0.6, grain = 0.06) => {
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  const g = x.createRadialGradient(960, 540, 0, 960, 540, 1100);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.45, "rgba(0,0,0,0)");
  g.addColorStop(0.8, `rgba(0,0,0,${vignette * 0.55})`);
  g.addColorStop(1, `rgba(0,0,0,${vignette})`);
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  if (grain > 0) {
    if (!grains) makeGrains();
    x.globalCompositeOperation = "overlay";
    x.globalAlpha = grain;
    x.drawImage(grains[frame % 6], 0, 0, W, H);
    x.globalCompositeOperation = "source-over";
    x.globalAlpha = 1;
  }
  x.fillStyle = "#000";
  x.fillRect(0, 0, W, BAR);
  x.fillRect(0, H - BAR, W, BAR);
  x.restore();
};

// ── the stickman rig ───────────────────────────────────────────────────────────────────────────────────────────
const R = 64, HEAD_Y = -588, NECK_Y = -526, SHOULDER_Y = -498, HIP_Y = -290, UPPER = 124, FORE = 118, THIGH = 150, SHIN = 142;
const dir = (a) => [Math.sin(a * RAD), Math.cos(a * RAD)];
const add = (p, a, L) => {
  const d = dir(a);
  return [p[0] + d[0] * L, p[1] + d[1] * L];
};
const STAND = { armL: [-6, 4], armR: [6, -4], legL: [-4, 0], legR: [4, 0], lean: 0, tilt: 0, bob: 0 };
const joints = (lean = 0, bob = 0, hoodie = true) => {
  const hip = [0, HIP_Y + bob];
  const sh = add(hip, 180 - lean, HIP_Y - SHOULDER_Y);
  return { head: add(hip, 180 - lean, HIP_Y - HEAD_Y), shL: [sh[0] - (hoodie ? 30 : 6), sh[1] + 4], shR: [sh[0] + (hoodie ? 30 : 6), sh[1] + 4] };
};
const armIK = (dx, dy, bend = 1) => {
  const d = Math.min(UPPER + FORE - 0.5, Math.max(Math.abs(UPPER - FORE) + 0.5, Math.hypot(dx, dy)));
  const base = Math.atan2(dx, dy) / RAD;
  const A = Math.acos((UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d)) / RAD;
  const a1 = base + bend * A;
  const e = add([0, 0], a1, UPPER);
  return [a1, Math.atan2(dx - e[0], dy - e[1]) / RAD - a1];
};
const walk = (phi, stride = 1) => {
  const sw = 24 * stride;
  const knee = (p) => 6 + 38 * Math.max(0, Math.cos(p)) * stride;
  return {
    legL: [sw * Math.sin(phi), knee(phi)],
    legR: [sw * Math.sin(phi + Math.PI), knee(phi + Math.PI)],
    armL: [-14 * stride * Math.sin(phi), 10],
    armR: [-14 * stride * Math.sin(phi + Math.PI), 10],
    bob: -7 * Math.abs(Math.cos(phi)) * stride,
  };
};

/** draw a figure. o: { x, y, s, pose, tone, color, hoodie, hood, face, rim:{color,width,dx,dy,glow}, holdR, holdL, flip,
 *  opacity, clip, front, hide, outfit:{hoodie,dark,shade,strings}, build:"muscular", hair:"quiff"|"bun", shoes,
 *  rot (degrees, about the hips — 90 = flying head-first to the right), flutter (seconds; cloth flapping in the wind) }.
 *  The rim light is the same silhouette, grown and shifted toward the light, drawn first. */
const figure = (x, o) => {
  const s = o.s ?? 1;
  alpha(x, o.opacity ?? 1, () =>
    at(x, o.x, o.y, 0, o.flip ? -s : s, s, () => {
      if (o.rot) {
        x.translate(0, HIP_Y);
        x.rotate(o.rot * RAD);
        x.translate(0, -HIP_Y);
      }
      if (o.rim) {
        x.save();
        x.translate(o.rim.dx ?? 3, o.rim.dy ?? -3);
        if (o.rim.glow) {
          x.shadowColor = o.rim.color;
          x.shadowBlur = o.rim.glow * 2 * s;
        }
        figureBody(x, o, { color: o.rim.color, grow: o.rim.width ?? 3 });
        x.restore();
      }
      figureBody(x, o, null);
    }),
  );
};

const figureBody = (x, o, sil) => {
  const tone = o.tone ?? "hero";
  const P = { ...STAND, ...(o.pose ?? {}) };
  const body = sil ? sil.color : o.color ?? (tone === "hero" ? C.ink : C.crowd);
  const hoodie = o.hoodie ?? tone === "hero";
  const fit = o.outfit ?? {};
  const HC = fit.hoodie ?? C.hoodie, HD = fit.dark ?? C.hoodieDark, HS = fit.shade ?? C.hoodieShade, STR = fit.strings ?? "#dfe7f5";
  const buff = o.build === "muscular";
  const g = sil ? sil.grow : 0;
  const col = (c) => (sil ? sil.color : c);
  const face = o.face ?? {};
  const lw = (tone === "hero" ? 22 : 21) + (buff ? 4 : 0);
  const look = face.look ?? 0;
  const turn = 1 - 0.55 * Math.abs(look);
  const hip = [0, HIP_Y + P.bob];
  const sh = add(hip, 180 - P.lean, HIP_Y - SHOULDER_Y);
  const neck = add(hip, 180 - P.lean, HIP_Y - NECK_Y);
  const head = add(hip, 180 - P.lean - P.tilt, HIP_Y - HEAD_Y);
  const shW = hoodie ? (buff ? 52 : 30) * turn : 6;
  const shL = [sh[0] - shW, sh[1] + 4];
  const shR = [sh[0] + shW, sh[1] + 4];
  const hipL = [hip[0] - 9, hip[1]];
  const hipR = [hip[0] + 9, hip[1]];
  const arm = (s0, l) => {
    const e = add(s0, l[0], UPPER);
    return { e, h: add(e, l[0] + l[1], FORE) };
  };
  const leg = (h0, l) => {
    const k = add(h0, l[0], THIGH);
    return { k, f: add(k, l[0] - l[1], SHIN) };
  };
  const aL = arm(shL, P.armL);
  const aR = arm(shR, P.armR);
  const gL = leg(hipL, P.legL);
  const gR = leg(hipR, P.legR);
  const ln = (pts, w, c) => poly(x, pts, w + 2 * g, col(c));

  const handProp = (p, h) => {
    if (!p) return;
    at(x, h[0], h[1], p.angle ?? 0, 1, 1, () => {
      if (p.kind === "phone") {
        const k = p.size ?? 1;
        const w = 26 * k;
        const hh = 46 * k;
        if (p.glow && !sil) circle(x, 0, -hh * 0.45, hh * 0.9, rgba(p.screen, 0.18));
        rect(x, -w / 2 - g, -hh - g, w + 2 * g, hh + 2 * g, col("#141418"), 5 * k + g);
        if (!sil) rect(x, -w / 2 + 3 * k, -hh + 4 * k, w - 6 * k, hh - 8 * k, p.screen, 3 * k);
      } else if (p.kind === "custom") {
        p.draw(x, sil, g);
      } else {
        rect(x, -12 - g, -36 - g, 24 + 2 * g, 40 + 2 * g, col("#26272c"), 4 + g);
        if (!sil) {
          rect(x, -12, -36, 24, 5, "#3a3b41", 2);
          text(x, "60.0", 0, -12, { size: 8, weight: 700, fill: "#f0b64a", align: "center", family: "sans-serif" });
        }
      }
    });
  };
  const drawArm = (s0, a, p) => {
    if (hoodie) {
      const cuff = [a.e[0] + (a.h[0] - a.e[0]) * 0.82, a.e[1] + (a.h[1] - a.e[1]) * 0.82];
      const sw = buff ? 42 : 34;
      ln([s0, a.e, a.h], lw, body);
      ln([s0, a.e, cuff], sw + 8, body);
      if (buff) {
        // the biceps: a fuller upper sleeve
        const m = [s0[0] + (a.e[0] - s0[0]) * 0.5, s0[1] + (a.e[1] - s0[1]) * 0.5];
        const ang = Math.atan2(a.e[1] - s0[1], a.e[0] - s0[0]);
        x.save();
        x.translate(m[0], m[1]);
        x.rotate(ang);
        ellipse(x, 0, 0, UPPER * 0.42 + 4 + g, sw * 0.68 + 4 + g, body);
        if (!sil) ellipse(x, 0, 0, UPPER * 0.42, sw * 0.68, HC);
        x.restore();
      }
      if (!sil) ln([s0, a.e, cuff], sw, HC);
      circle(x, a.h[0], a.h[1], (buff ? 15 : 13) + g, body);
    } else ln([s0, a.e, a.h], lw, body);
    handProp(p, a.h);
  };
  const shoe = (f, k) => {
    if (!o.shoes) return;
    const dirx = Math.sign(look || 1);
    ellipse(x, f[0] + dirx * 9, f[1] + 2, 25 + g, 13 + g, col(o.shoes));
    if (!sil) rect(x, f[0] + dirx * 9 - 24, f[1] + 8, 48, 6, "#8d8f98", 3);
  };

  // cloth flapping in the wind (flying): the hem and the hood stream back toward the feet
  const flutter = (t) => {
    const pts = [];
    const w0 = 50 * turn;
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      pts.push([hip[0] - w0 + 2 * w0 * u, hip[1] + 16 + 34 + 16 * Math.sin(t * 22 + u * 7) * (0.4 + 0.6 * u)]);
    }
    const d = `M ${hip[0] - w0} ${hip[1] + 10} L ${hip[0] + w0} ${hip[1] + 10} ` + pts.reverse().map((p) => `L ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ") + " Z";
    path(x, d, col(HC), sil ? sil.color : null, 2 * g);
    if (!sil) alpha(x, 0.5, () => path(x, `M ${hip[0] - w0 * 0.4} ${hip[1] + 20} q 10 ${12 + 6 * Math.sin(t * 19)} 0 30 M ${hip[0] + w0 * 0.3} ${hip[1] + 18} q -8 ${10 + 6 * Math.sin(t * 17)} 0 28`, null, HD, 4));
  };

  // legs (+ sneakers)
  ln([hipL, gL.k, gL.f], lw + (buff ? 4 : 2), body);
  ln([hipR, gR.k, gR.f], lw + (buff ? 4 : 2), body);
  shoe(gL.f);
  shoe(gR.f);
  // hood + torso
  if (hoodie) {
    if (o.hood !== false) {
      const fl = o.flutter !== undefined ? Math.sin(o.flutter * 18) * 6 : 0;
      ellipse(x, head[0] - look * R * 0.8, head[1] + R * (0.55 + 0.35 * Math.abs(look)) + fl, R * 1.02 + g, R * (0.9 + 0.35 * Math.abs(look)) + g, col(HC));
      if (!sil && Math.abs(look) > 0.01) {
        x.save();
        x.globalAlpha *= Math.abs(look);
        path(x, `M ${head[0] - look * R * 1.1} ${head[1] + R * 0.2} Q ${head[0] - look * R * 1.45} ${head[1] + R * 1.0} ${head[0] - look * R * 0.9} ${head[1] + R * 1.6}`, null, HS, R * 0.09);
        x.restore();
      }
    }
    if (o.flutter !== undefined) flutter(o.flutter);
    const top = buff ? 22 : 8;
    const waist = (buff ? 34 : 50) * turn;
    const d = `M ${shL[0] - top} ${shL[1] - 6} Q ${sh[0]} ${sh[1] - 24} ${shR[0] + top} ${shR[1] - 6} L ${hip[0] + waist} ${hip[1] + 18} Q ${hip[0]} ${hip[1] + 28} ${hip[0] - waist} ${hip[1] + 18} Z`;
    path(x, d, col(HC), sil ? sil.color : null, 2 * g);
    if (buff) {
      circle(x, shL[0] - 4, shL[1] + 6, 30 + g, col(HC));
      circle(x, shR[0] + 4, shR[1] + 6, 30 + g, col(HC));
    }
    if (!sil) {
      x.save();
      if (buff) {
        // chest + a hint of abs under the hoodie
        x.globalAlpha *= 0.55;
        path(x, `M ${sh[0] - 34 * turn + look * 12} ${sh[1] + 52} q ${30 * turn} 16 ${32 * turn} -4 M ${sh[0] + 2 + look * 12} ${sh[1] + 48} q ${30 * turn} 18 ${34 * turn} -2`, null, HD, 5);
        x.globalAlpha = 1;
      }
      x.globalAlpha *= 0.7;
      path(x, `M ${hip[0] - 32} ${hip[1] - 52} L ${hip[0] + 32} ${hip[1] - 52} L ${hip[0] + 38} ${hip[1] - 6} L ${hip[0] - 38} ${hip[1] - 6} Z`, HD);
      x.globalAlpha = 0.85;
      if (o.hood !== false) path(x, `M ${neck[0] - 9 + look * 10} ${neck[1] + 18} l -2 52 M ${neck[0] + 9 + look * 10} ${neck[1] + 18} l 2 52`, null, STR, 3);
      x.restore();
    }
  } else ln([neck, hip], 26, body);
  if (o.front !== "L" && o.hide !== "L") drawArm(shL, aL, o.holdL);
  if (o.front !== "R" && o.hide !== "R") drawArm(shR, aR, o.holdR);
  // hair behind the head (bun), head, hair on top (quiff) — scaled about the head centre (smaller on the big build)
  const dir = look >= 0 ? 1 : -1;
  const hk = buff ? 0.92 : 1;
  x.save();
  x.translate(head[0], head[1]);
  x.scale(hk, hk);
  x.translate(-head[0], -head[1]);
  if (o.hair === "bun") circle(x, head[0] - dir * R * 0.7, head[1] - R * 0.7, R * 0.42 + g, body);
  circle(x, head[0], head[1], R + g, body);
  if (o.hair === "quiff") {
    // a swept quiff: rises from the back of the crown, sweeps up and breaks forward over the brow
    const hx = head[0], hy = head[1];
    const d = `M ${hx - dir * R * 0.9} ${hy - R * 0.42} C ${hx - dir * R * 0.86} ${hy - R * 1.32} ${hx + dir * R * 0.05} ${hy - R * 1.62} ${hx + dir * R * 0.62} ${hy - R * 1.42} C ${hx + dir * R * 1.12} ${hy - R * 1.24} ${hx + dir * R * 1.16} ${hy - R * 0.9} ${hx + dir * R * 0.92} ${hy - R * 0.58} Q ${hx + dir * R * 0.5} ${hy - R * 0.86} ${hx} ${hy - R * 0.78} Z`;
    path(x, d, body, sil ? sil.color : null, 2 * g);
    if (!sil) {
      alpha(x, 0.9, () => path(x, `M ${hx - dir * R * 0.55} ${hy - R * 1.02} Q ${hx + dir * R * 0.1} ${hy - R * 1.48} ${hx + dir * R * 0.78} ${hy - R * 1.26}`, null, "#4d4656", 5));
      alpha(x, 0.7, () => path(x, `M ${hx - dir * R * 0.2} ${hy - R * 0.9} Q ${hx + dir * R * 0.4} ${hy - R * 1.24} ${hx + dir * R * 0.92} ${hy - R * 0.98}`, null, "#4d4656", 4));
    }
  }
  if (o.clip && !sil) {
    at(x, head[0], head[1], -12, 1, 1, () => rect(x, -4, -R - 6, 30, 14, o.clip, 6));
  }
  if (!sil) face2(x, head, face, tone, body);
  x.restore();
  if (o.front === "L") drawArm(shL, aL, o.holdL);
  if (o.front === "R") drawArm(shR, aR, o.holdR);
};

const face2 = (x, head, face, tone, body) => {
  const look = face.look ?? 0;
  const up = face.up ?? 0;
  const eyes = face.eyes ?? (tone === "hero" ? "dot" : "none");
  const mouth = face.mouth ?? (tone === "hero" ? "flat" : "none");
  const fx = head[0] + look * R * 0.42;
  const fy = head[1] + R * 0.12 - up * R * 0.25;
  const gap = R * 0.34 * (1 - Math.abs(look) * 0.35);
  const er = R * 0.14;
  const blink = face.blink ?? 0;
  const eye = (cx, side) => {
    const cy = fy - R * 0.05;
    if (eyes === "dot") ellipse(x, cx, cy, er, er * 1.12 * (1 - blink * 0.9), C.eye);
    else if (eyes === "wide") {
      circle(x, cx, cy, er * 1.9, C.eye);
      circle(x, cx + look * er * 0.6, cy + er * 0.2, er * 0.85, body);
    } else if (eyes === "smug") {
      const w = er * 1.55;
      const hh = er * 1.15 * (1 - blink);
      at(x, cx, cy, -side * 13, 1, 1, () => path(x, `M ${-w} ${-hh * 0.35} L ${w} ${-hh * 0.35} Q ${w * 0.8} ${hh} 0 ${hh} Q ${-w * 0.8} ${hh} ${-w} ${-hh * 0.35} Z`, C.eye));
    } else if (eyes === "happy") path(x, `M ${cx - er * 1.3} ${cy + er * 0.55} Q ${cx} ${cy - er * 1.6} ${cx + er * 1.3} ${cy + er * 0.55}`, null, C.eye, er * 0.62);
    else if (eyes === "closed") path(x, `M ${cx - er * 1.2} ${cy} Q ${cx} ${cy + er * 1.2} ${cx + er * 1.2} ${cy}`, null, C.eye, er * 0.55);
    if (face.brows) {
      // confident brows: short strokes, outer end lifted (or knitted inward when brows = "worried")
      const worried = face.brows === "worried";
      const by = cy - er * (eyes === "wide" ? 2.6 : 2.1);
      const tilt = (worried ? 0.5 : -0.35) * side;
      line(x, cx - er * 1.25, by + tilt * er * 1.25, cx + er * 1.25, by - tilt * er * 1.25, er * 0.42, C.eye);
    }
  };
  eye(fx - gap, -1);
  eye(fx + gap, 1);
  const my = fy + R * 0.42;
  const mx = fx + look * R * 0.08;
  if (mouth === "smile") path(x, `M ${mx - R * 0.27} ${my - R * 0.06} Q ${mx} ${my + R * 0.24} ${mx + R * 0.27} ${my - R * 0.06}`, null, C.eye, R * 0.085);
  else if (mouth === "smirk") path(x, `M ${mx - R * 0.2} ${my} Q ${mx + R * 0.05} ${my + R * 0.1} ${mx + R * 0.26} ${my - R * 0.12}`, null, C.eye, R * 0.08);
  else if (mouth === "grin") path(x, `M ${mx - R * 0.3} ${my - R * 0.08} Q ${mx} ${my + R * 0.36} ${mx + R * 0.3} ${my - R * 0.08} Z`, C.eye);
  else if (mouth === "flat") line(x, mx - R * 0.17, my, mx + R * 0.17, my - R * 0.01, R * 0.07, C.eye);
  else if (mouth === "o") ellipse(x, mx, my, R * 0.1, R * 0.13, C.eye);
  else if (mouth === "chatter") {
    // teeth chattering: a white zigzag
    path(x, `M ${mx - R * 0.22} ${my} l ${R * 0.073} ${-R * 0.06} l ${R * 0.073} ${R * 0.06} l ${R * 0.073} ${-R * 0.06} l ${R * 0.073} ${R * 0.06} l ${R * 0.073} ${-R * 0.06} l ${R * 0.073} ${R * 0.06}`, null, C.eye, R * 0.06);
  }
};

// ── props ──────────────────────────────────────────────────────────────────────────────────────────────────────
const EDGE = C.robotEdge;
const seg = (x, x0, x1, y, w) => {
  const L = Math.max(w, x1 - x0);
  const p = new Path2D();
  p.roundRect(x0, y - w / 2, L, w, w / 2);
  x.fillStyle = "#130b11";
  x.fill(p);
  x.strokeStyle = EDGE;
  x.lineWidth = 4.5;
  x.stroke(p);
  x.save();
  x.clip(p);
  x.translate(x0 + L * 0.45, y);
  x.scale(L * 0.5, w * 0.5);
  const gr = x.createRadialGradient(0, 0, 0, 0, 0, 1);
  gr.addColorStop(0, "rgba(91,70,57,0.55)");
  gr.addColorStop(1, "rgba(20,12,18,0)");
  x.fillStyle = gr;
  x.fillRect(-2, -2, 4, 4);
  x.restore();
  x.save();
  x.globalAlpha *= 0.55;
  line(x, x0 + L * 0.3, y - w * 0.08, x0 + L * 0.72, y - w * 0.16, 6, "#7d6c66");
  x.restore();
};
const finger = (x, fx, fy, len, w = 70, angle = 0) =>
  at(x, fx, fy, angle, 1, 1, () => {
    seg(x, 0, len * 0.62, 0, w);
    seg(x, len * 0.44, len, 0, w * 0.97);
  });

const watch = (x, wx, wy, angle = 0, s = 1) =>
  at(x, wx, wy, angle, s, s, () => {
    rect(x, -92, 40, 184, 400, C.hoodie);
    rect(x, -92, 40, 184, 18, "#c98f55");
    rect(x, -80, -70, 160, 118, "#c3c6cb", 16);
    x.strokeStyle = "#8d9097";
    x.lineWidth = 3;
    x.beginPath();
    x.roundRect(-80, -70, 160, 118, 16);
    x.stroke();
    rect(x, -52, -70, 8, 118, "#9a9da3");
    rect(x, 44, -70, 8, 118, "#9a9da3");
    circle(x, 0, -8, 48.5, "#6d7077");
    circle(x, 0, -8, 39.5, "#dcdde0");
    line(x, 0, -8, -26, -14, 7, "#55585f");
    line(x, 0, -8, 4, 22, 7, "#55585f");
  });

/** a robot hand from above, pointing +x, wrist at the origin; pose "flat" or "point" */
const robotHand = (x, o) => {
  const s = o.s ?? 1;
  at(x, o.x, o.y, o.angle ?? 0, s, o.flipY ? -s : s, () => {
    path(x, "M -1400 -150 L -40 -150 Q 60 -160 120 -150 L 120 150 Q 60 160 -40 150 L -1400 150 Z", "#120a10", EDGE, 4);
    path(x, "M -40 -160 Q 160 -196 330 -166 Q 372 -20 360 150 Q 170 190 -40 162 Z", "#140c12", EDGE, 4);
    alpha(x, 0.75, () => path(x, "M -40 -161 Q 160 -197 330 -167", null, o.rim ?? "#e4a456", 5));
    alpha(x, 0.8, () => [-96, -34, 30, 92].forEach((yy) => line(x, 60, yy * 0.45, 290, yy, 3.5, "#3a2c35")));
    if ((o.pose ?? "flat") === "flat") {
      finger(x, 90, 186, 300, 68, 6);
      [[-118, 330, -3], [-40, 385, -1], [38, 372, 1], [114, 312, 3]].forEach(([y, len, a]) => finger(x, 292, y, len, 70, a));
    } else {
      finger(x, 210, -124, 230, 70, 4);
      finger(x, 235, -48, 240, 70, 3);
      finger(x, 255, 26, 232, 70, 2);
      finger(x, 270, 106, 430, 70, -1);
      finger(x, 60, 186, 210, 68, 18);
    }
    if (o.watch !== false) watch(x, -200, 0, 90, 2.3);
  });
};
const handAt = (tip, angle, s, pose = "point", flipY = false) => {
  const loc = pose === "point" ? [700, 106] : [677, -40];
  const ly = flipY ? -loc[1] : loc[1];
  const a = angle * RAD;
  return [tip[0] - s * (loc[0] * Math.cos(a) - ly * Math.sin(a)), tip[1] - s * (loc[0] * Math.sin(a) + ly * Math.cos(a))];
};
/** a robot hand holding an upright phone, in the phone's coordinates (0..w, 0..h) */
const holdHand = (x, o) =>
  at(x, o.x, o.y, o.angle ?? 0, 1, 1, () => {
    const { w, h } = o;
    const k = w / 320;
    path(x, `M ${w * 0.12} ${h * 0.55} Q ${w * 0.05} ${h * 1.05} ${w * 0.3} ${h * 1.5} L ${w * 1.02} ${h * 1.5} Q ${w * 1.16} ${h * 1.05} ${w * 1.04} ${h * 0.5} Z`, "#140c12", EDGE, 4 * k);
    at(x, 0, 0, 0, k, k, () => {
      finger(x, -22, (h / k) * 0.62, 250, 64, -78);
      finger(x, 300, (h / k) * 0.36, 190, 66, 84);
      finger(x, 312, (h / k) * 0.6, 170, 64, 88);
    });
  });

/** a modern phone; screen(x) draws in screen coordinates (0..w, 0..h) under a rounded clip */
const phone = (x, o, screen) =>
  at(x, o.x, o.y, o.angle ?? 0, 1, 1, () => {
    const { w, h } = o;
    const b = w * 0.045;
    const r = w * 0.14;
    alpha(x, 0.28, () => rect(x, w * 0.03, h * 0.02, w, h, "#000", r));
    rect(x, 0, 0, w, h, "#24262d", r);
    x.strokeStyle = "#4b4e58";
    x.lineWidth = w * 0.012;
    x.beginPath();
    x.roundRect(0, 0, w, h, r);
    x.stroke();
    if (o.edgeLight) rect(x, w - w * 0.03, h * 0.03, w * 0.025, h * 0.82, o.edgeLight, w * 0.012);
    rect(x, -w * 0.012, h * 0.2, w * 0.016, h * 0.09, "#4b4e58", w * 0.008);
    x.save();
    const clip = new Path2D();
    clip.roundRect(b, b, w - 2 * b, h - 2 * b, r - b);
    x.clip(clip);
    x.fillStyle = linGrad(x, b, b, w - b, h - b, [[0, o.screen ?? "#0f1320"], [1, "#0a0d16"]]);
    x.fillRect(b, b, w - 2 * b, h - 2 * b);
    if (screen) screen(x);
    alpha(x, o.reflection ?? 0.06, () => path(x, `M ${b} ${h * 0.62} L ${w - b} ${h * 0.18} L ${w - b} ${h * 0.34} L ${b} ${h * 0.78} Z`, "#fff"));
    x.restore();
    if (o.status !== false) {
      rect(x, w * 0.36, b + h * 0.012, w * 0.28, h * 0.028, "#05060a", h * 0.014);
      text(x, "7:42", w * 0.13, b + h * 0.04, { size: w * 0.055, weight: 700, fill: "#e8e8ee" });
    }
  });
const bars = (x, bx, by, h, o = {}) => {
  const bw = o.w ?? h * 0.22;
  const gp = o.gap ?? bw * 0.45;
  for (let i = 0; i < 5; i++) {
    const hh = h * (0.36 + i * 0.16);
    rect(x, bx + i * (bw + gp), by + h - hh, bw, hh, i < (o.n ?? 5) ? o.color ?? "#fff" : o.dim ?? "#555", bw * 0.18);
  }
};
const battery = (x, bx, by, w, on = 1, color = "#f6bd55") =>
  at(x, bx, by, 0, 1, 1, () => {
    const h = w * 0.43;
    const st = w * 0.045;
    alpha(x, 0.35 + on * 0.65, () => {
      x.strokeStyle = color;
      x.lineWidth = st;
      x.beginPath();
      x.roundRect(st / 2, st / 2, w - st, h - st, h * 0.16);
      x.stroke();
      rect(x, w, h * 0.32, w * 0.05, h * 0.36, color, w * 0.012);
    });
    alpha(x, on, () => rect(x, st * 1.9, st * 1.9, w - st * 3.8, h - st * 3.8, color, h * 0.08));
    alpha(x, 0.25 + on * 0.75, () => path(x, `M ${w * 0.53} ${h * 0.2} L ${w * 0.42} ${h * 0.53} L ${w * 0.5} ${h * 0.53} L ${w * 0.46} ${h * 0.82} L ${w * 0.58} ${h * 0.45} L ${w * 0.5} ${h * 0.45} Z`, "#2a1d0a"));
  });
const steam = (x, sx, sy, t, scale = 1, vertical = false) =>
  at(x, sx, sy, 0, scale, scale, () =>
    alpha(x, 0.5, () => {
      for (let i = 0; i < 3; i++) {
        const ph = (t * 0.6 + i / 3) % 1;
        const dy = -ph * 160;
        const sw = wob(t, i, 1.2) * 14;
        const d = vertical ? `M ${-18 + i * 18} ${dy} q ${sw} -30 0 -60 q ${-sw} -30 0 -60` : `M ${-40 + i * 30} ${dy * 0.4} q 40 ${-20 + sw} 80 ${-10 - sw} q 40 10 80 -20`;
        alpha(x, Math.sin(ph * Math.PI) * 0.9, () => path(x, d, null, "#ffffff", vertical ? 7 : 16));
      }
    }),
  );
const mug = (x, mx, my, r, t) =>
  at(x, mx, my, 0, 1, 1, () => {
    alpha(x, 0.22, () => circle(x, 10, 14, r * 1.08, "#000"));
    x.strokeStyle = "#3a3b40";
    x.lineWidth = r * 0.2;
    x.beginPath();
    x.arc(-r * 1.05, r * 0.25, r * 0.52, 0, Math.PI * 2);
    x.stroke();
    circle(x, 0, 0, r, "#45464c");
    circle(x, 0, 0, r * 0.86, "#6e3e1c");
    alpha(x, 0.6, () => circle(x, r * 0.12, -r * 0.1, r * 0.62, "#8a5428"));
    alpha(x, 0.5, () => path(x, `M ${-r * 0.5} ${-r * 0.55} Q ${-r * 0.1} ${-r * 0.85} ${r * 0.4} ${-r * 0.6}`, null, "#c58a54", r * 0.06));
    steam(x, 0, -r * 0.2, t, r / 120);
  });
const plateToast = (x, px, py, r, angle = -8) =>
  at(x, px, py, 0, 1, 1, () => {
    alpha(x, 0.22, () => circle(x, 14, 18, r, "#000"));
    circle(x, 0, 0, r, "#d7d4ca");
    x.strokeStyle = "#c3c0b5";
    x.lineWidth = 5;
    x.beginPath();
    x.arc(0, 0, r * 0.8, 0, Math.PI * 2);
    x.stroke();
    at(x, 0, 0, angle, 1, 1, () => {
      rect(x, -r * 0.48, -r * 0.45, r * 0.98, r * 0.95, "#b5824a", r * 0.14);
      rect(x, -r * 0.4, -r * 0.36, r * 0.82, r * 0.78, "#dcc08b", r * 0.1);
      for (let i = 0; i < 9; i++) circle(x, -r * 0.3 + ((i * 37) % 7) * r * 0.1, -r * 0.25 + ((i * 53) % 6) * r * 0.1, r * 0.014, "#b08550");
    });
  });
const tweezers = (x, tx, ty, angle, len = 420, open = 0.06) =>
  at(x, tx, ty, angle, 1, 1, () => {
    [-1, 1].forEach((k) => path(x, `M 0 0 L ${len} ${k * len * open} L ${len} ${k * len * open + k * 14} L 0 ${k * 5} Z`, "#c9ccd2", "#8a8e96", 2));
    rect(x, len - 10, -len * open - 16, 30, 2 * len * open + 32, "#b5b8bf", 6);
  });
const chip = (x, cx, cy, w = 60, angle = 0) =>
  at(x, cx, cy, angle, 1, 1, () => {
    for (let i = 0; i < 4; i++)
      for (const side of [0, 1, 2, 3]) {
        const o = -w * 0.3 + i * w * 0.2;
        const len = w * 0.18;
        const p = side === 0 ? [o, -w / 2 - len, 3, len] : side === 1 ? [w / 2, o, len, 3] : side === 2 ? [o, w / 2, 3, len] : [-w / 2 - len, o, len, 3];
        rect(x, p[0], p[1], p[2], p[3], "#9da0a6");
      }
    rect(x, -w / 2, -w / 2, w, w, "#17171b", w * 0.06);
    circle(x, -w * 0.3, -w * 0.3, w * 0.06, "#333");
  });
const screwTray = (x, sx, sy, r = 105) =>
  at(x, sx, sy, 0, 1, 1, () => {
    alpha(x, 0.2, () => circle(x, 8, 10, r, "#000"));
    circle(x, 0, 0, r + 4, "#6b6d72");
    circle(x, 0, 0, r - 4, "#8d8f93");
    circle(x, 0, 0, r * 0.8, "#9a9ca0");
    [[-0.35, -0.2], [0, -0.35], [0.15, 0], [-0.1, 0.3], [0.45, 0.25]].forEach(([a, b]) => {
      circle(x, a * r, b * r, r * 0.08 + 1, "#555");
      circle(x, a * r, b * r, r * 0.08 - 1, "#e6e6e8");
      line(x, a * r - r * 0.04, b * r, a * r + r * 0.04, b * r, 3, "#444");
    });
  });
const car = (x, cx, cy, w, color, dark = "#2e3440") =>
  at(x, cx, cy, 0, 1, 1, () => {
    const h = w * 0.22;
    alpha(x, 0.25, () => ellipse(x, 0, 4, w * 0.52, h * 0.12, "#000"));
    path(x, `M ${-w * 0.5} ${-h * 0.25} L ${-w * 0.48} ${-h * 0.95} L ${-w * 0.2} ${-h * 1.05} L ${-w * 0.08} ${-h * 1.85} L ${w * 0.26} ${-h * 1.85} L ${w * 0.4} ${-h * 1.05} L ${w * 0.5} ${-h * 0.95} L ${w * 0.5} ${-h * 0.25} Z`, color);
    path(x, `M ${-w * 0.16} ${-h * 1.08} L ${-w * 0.05} ${-h * 1.7} L ${w * 0.23} ${-h * 1.7} L ${w * 0.35} ${-h * 1.08} Z`, dark);
    alpha(x, 0.12, () => rect(x, -w * 0.5, -h * 0.5, w, h * 0.08, "#000"));
    [-0.3, 0.3].forEach((k) => {
      circle(x, k * w, -h * 0.2, h * 0.55, "#141418");
      circle(x, k * w, -h * 0.2, h * 0.27, "#8c8f95");
    });
  });

// ── sets ───────────────────────────────────────────────────────────────────────────────────────────────────────
const desk = (x) => {
  rect(x, -1500, -1000, 4920, 3080, C.woodDark);
  x.fillStyle = (() => {
    const g = x.createRadialGradient(-300 + 2520 * 0.42, -300 + 1680 * 0.32, 0, -300 + 2520 * 0.42, -300 + 1680 * 0.32, 2520 * 0.75);
    g.addColorStop(0, "#a07a50");
    g.addColorStop(0.55, "#8a6644");
    g.addColorStop(1, "#5a432d");
    return g;
  })();
  x.fillRect(-300, -300, 2520, 1680);
  for (let i = 0; i < 34; i++) {
    const y = -360 + i * 88 + (rnd(i, 3) - 0.5) * 10;
    alpha(x, 0.75, () => line(x, -1500, y, 3420, y + (rnd(i, 5) - 0.5) * 8, 2.4, "#5e4429", "butt"));
    alpha(x, 0.25, () => line(x, -1500, y + 3, 3420, y + 3, 1.2, "#b08a60", "butt"));
    const jx = (rnd(i, 9) * 2400 - 200) | 0;
    alpha(x, 0.5, () => line(x, jx, y, jx, y + 88, 2, "#5e4429", "butt"));
  }
};

const elevatorHall = (x, doors, inside, floor = "L", up = false) => {
  const L = 660, Rr = 1260;
  const d = ((Rr - L) / 2) * doors;
  x.fillStyle = radGrad(x, 960, 0.35 * 1080, 0.7 * 2320, [[0, "#bdb39a"], [1, "#8f8873"]]);
  x.fillRect(-200, 0, 2320, 1080);
  [105, 325, 548, 1438, 1660, 1882].forEach((px) => {
    line(x, px, 0, px, 965, 3, "#857e6a", "butt");
    alpha(x, 0.5, () => line(x, px + 3, 0, px + 3, 965, 1.5, "#c9c0a8", "butt"));
  });
  rect(x, -200, 963, 2320, 120, "#6f6a5d");
  rect(x, -200, 963, 2320, 6, "#5c584d");
  x.fillStyle = linGrad(x, 0, 186, 0, 963, [[0, "#e6e8ec"], [1, "#c3c6cc"]]);
  x.fillRect(L, 186, Rr - L, 777);
  [745, 900, 1020, 1145].forEach((px) => line(x, px, 186, px, 770, 3, "#b9bcc3", "butt"));
  alpha(x, 0.35, () => rect(x, 745, 186, 400, 240, "#f2f3f5"));
  rect(x, L, 770, Rr - L, 193, "#57595d");
  rect(x, L, 770, Rr - L, 30, "#4a4c50");
  rect(x, 680, 480, 470, 11, "#eceef1", 5);
  if (inside) inside(x);
  const door = linGrad(x, L, 0, L + 300, 0, [[0, "#c9ccd2"], [1, "#aeb2b9"]]);
  rect(x, L, 186, d, 777, door);
  rect(x, Rr - d, 186, d, 777, door);
  if (doors > 0.01) {
    rect(x, L + d - 3, 186, 6, 777, "#8e9299");
    rect(x, Rr - d - 3, 186, 6, 777, "#8e9299");
  }
  path(x, `M 628 963 L 628 156 L 1290 156 L 1290 963 L ${Rr} 963 L ${Rr} 186 L ${L} 186 L ${L} 963 Z`, "#a1a4aa");
  rect(x, 628, 156, 662, 8, "#c4c7cc");
  rect(x, 1282, 156, 8, 807, "#7f8389");
  rect(x, 878, 58, 163, 68, "#131316", 8);
  path(x, up ? "M 926 106 L 956 106 L 941 80 Z" : "M 926 80 L 956 80 L 941 106 Z", "#e8553f");
  text(x, floor, 972, 107, { size: 34, fill: "#e8553f" });
  rect(x, 1354, 513, 36, 88, "#8e9098", 6);
  circle(x, 1372, 538, 9, "#e8c45a");
  circle(x, 1372, 575, 9, "#e8c45a");
};

const hazard = (x, hx, hy, w, h) => {
  x.save();
  x.beginPath();
  x.rect(hx, hy, w, h);
  x.clip();
  rect(x, hx, hy, w, h, "#e2c049");
  x.translate(hx, hy);
  x.rotate(-45 * RAD);
  for (let k = -10; k < 10; k++) rect(x, k * 34, -200, 17, 400, "#151515");
  x.restore();
};
const garage = (x, o = {}) => {
  const x0 = o.x0 ?? -900;
  const bays = o.bays ?? 6;
  const cars = o.cars ?? [
    [300, "#a33a36"], [1150, "#e4e2dc"], [1990, "#454a52", "#262b33"], [2840, "#e4e2dc"], [-560, "#3b5f8a"],
  ];
  const span = bays * 922 + 800;
  x.fillStyle = linGrad(x, 0, -200, 0, 300, [[0, "#3f4442"], [1, "#6f746f"]]);
  x.fillRect(x0 - 400, -200, span, 500);
  rect(x, x0 - 400, 200, span, 16, "#3b403e");
  x.fillStyle = linGrad(x, 0, 290, 0, 710, [[0, "#8a8f8a"], [1, "#707570"]]);
  x.fillRect(x0 - 400, 290, span, 420);
  x.fillStyle = linGrad(x, 0, 700, 0, 1200, [[0, "#4a504e"], [1, "#2f3433"]]);
  x.fillRect(x0 - 400, 700, span, 500);
  for (let i = 0; i <= bays; i++) {
    const lx = x0 + i * 810;
    path(x, `M ${lx + 300} 150 L ${lx + 630} 150 L ${lx + 642} 185 L ${lx + 314} 185 Z`, "#e8eee8");
    alpha(x, 0.85, () => {
      rect(x, lx + 160, 316, 190, 8, "#dfe6df");
      rect(x, lx + 720, 316, 190, 8, "#dfe6df");
    });
  }
  rect(x, x0 - 400, 362, span, 60, "#dcbb46");
  for (let i = 0; i < bays; i++) {
    const bx = x0 + i * 922;
    text(x, o.level ?? "LEVEL −3", bx + 48, 406, { size: 38, italic: true, track: 0.09, fill: "#2a2924" });
    text(x, `${o.bay ?? "B3"}${i}`, bx + 504, 402, { size: 22, italic: true, fill: "#3a382f" });
  }
  cars.forEach(([cx, color, dark]) => car(x, cx, 712, 620, color, dark));
  for (let i = 0; i < bays; i++) {
    const px = x0 + 613 + i * 922;
    rect(x, px, 300, 92, 465, "#a3a6a2");
    rect(x, px, 300, 18, 465, "#b9bcb8");
    rect(x, px + 70, 300, 22, 465, "#8d908c");
    rect(x, px - 2, 436, 96, 102, "#e2c049");
    text(x, o.pillar ?? "−3", px + 46, 512, { size: 70, italic: true, fill: "#151515", align: "center" });
    hazard(x, px, 672, 92, 92);
  }
  rect(x, x0 - 400, 798, span, 6, "#c9a93a");
  for (let i = 0; i < bays * 2; i++) {
    const fx = x0 + 440 + i * 461;
    alpha(x, 0.6, () => line(x, fx, 672, fx - 120, 788, 3, "#cfd3cf"));
  }
  glow(x, 1000, 160, 900, "#e9f0ea", 0.18);
};

const kitchen = (x) => {
  x.fillStyle = linGrad(x, 0, -100, 0, 1200, [[0, "#7d7262"], [0.5, "#8b7f6c"], [1, "#857865"]]);
  x.fillRect(-300, -100, 2520, 1300);
  rect(x, -300, 195, 2520, 14, "#9b8f7b");
  rect(x, -20, 318, 170, 400, "#2e2622");
  rect(x, 150, 318, 10, 400, "#6b5e50");
  circle(x, 270, 322, 26, "#b9b2a5");
  circle(x, 270, 322, 22, "#e6e1d6");
  rect(x, 234, 392, 82, 92, "#dcd6cb");
  rect(x, 234, 392, 82, 14, "#c94a3e");
  rect(x, 182, 462, 18, 26, "#d2ccc0");
  rect(x, 374, 284, 292, 128, "#5f7a64");
  [447, 520, 593].forEach((px) => line(x, px, 284, px, 412, 4, "#516954", "butt"));
  rect(x, 374, 412, 292, 132, "#d8d4c7");
  rect(x, 740, 222, 48, 112, "#a9a59b");
  rect(x, 300, 538, 300, 44, "#e8e4da");
  ellipse(x, 510, 556, 56, 13, "#5e6f7c");
  rect(x, 312, 582, 92, 190, "#5b7360");
  rect(x, 404, 582, 160, 190, "#3a2e28");
  line(x, 1028, 60, 1028, 340, 4, "#3f3a34", "butt");
  path(x, "M 990 372 L 1010 340 L 1046 340 L 1068 372 Z", "#3f5c51");
  glow(x, 1028, 380, 200, "#ffe7b5", 0.35);
  rect(x, 1040, 278, 282, 246, "#d4e2ea");
  rect(x, 1185, 358, 86, 166, "#c3c8d0");
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) rect(x, 1196 + c * 26, 372 + r * 28, 14, 16, "#9ea6b2");
  rect(x, 1060, 400, 100, 124, "#cfd5dc");
  rect(x, 1040, 518, 282, 12, "#e9e6df");
  circle(x, 1282, 485, 20, "#6c9a5b");
  rect(x, 1272, 498, 22, 22, "#b5523f");
  rect(x, 980, 262, 60, 318, "#c9a24a");
  rect(x, 1322, 262, 60, 318, "#c9a24a");
  rect(x, 970, 258, 420, 8, "#8a7a62");
  rect(x, 1405, 278, 134, 62, "#c7d6e5");
  rect(x, 1436, 292, 14, 48, "#3a4f78");
  rect(x, 1462, 286, 14, 54, "#5873a8");
  rect(x, 1490, 296, 14, 44, "#3a8a6a");
  rect(x, 1386, 362, 176, 92, "#121214");
  rect(x, 1624, 350, 146, 372, "#e7e6e1");
  line(x, 1624, 470, 1770, 470, 4, "#c9c7c0", "butt");
  rect(x, 1660, 505, 22, 28, "#e9a07a");
  rect(x, 1715, 540, 22, 22, "#8ab2dc");
  rect(x, 1670, 600, 24, 20, "#b6d48a");
  rect(x, -300, 705, 2520, 400, "#6b553f");
  rect(x, 1240, 690, 680, 130, "#735b43");
  rect(x, 820, 700, 426, 110, "#ece9e2");
  rect(x, 1010, 622, 66, 90, "#6e5440");
  rect(x, 1380, 680, 16, 180, "#5f4836");
  alpha(x, 0.08, () => path(x, "M 1040 520 L 1322 520 L 1180 900 L 880 900 Z", "#fff6e0"));
};
const tileCounter = (x, y = 900) => {
  rect(x, -300, y, 2520, 300, "#cdc9b8");
  rect(x, -300, y, 2520, 6, "#ebe8dc");
  for (let i = 0; i < 44; i++) line(x, -300 + i * 60, y + 6, -300 + i * 60, y + 300, 2, "#a7aa98", "butt");
  for (let r = 1; r <= 3; r++) line(x, -300, y + 6 + r * 37, 2220, y + 6 + r * 37, 2, "#a7aa98", "butt");
};
const steelWall = (x) => {
  x.fillStyle = linGrad(x, 0, -100, 0, 1200, [[0, "#a8acb0"], [0.7, "#9a9ea2"], [1, "#7c8084"]]);
  x.fillRect(-300, -100, 2520, 1300);
  alpha(x, 0.55, () => {
    for (let i = 0; i < 26; i++) rect(x, -300 + i * 96, -100, 44, 1300, i % 2 ? "#b6babe" : "#8f9397");
  });
  rect(x, -300, 745, 2520, 26, "#dfe2e5");
  alpha(x, 0.6, () => rect(x, -300, 771, 2520, 20, "#6e7276"));
};
/** the navy void: a deep vignette around a lifted centre (screen space) */
const voidBg = (x, tint = "#1d2740", cx = 960, cy = 540) => {
  rect(x, -100, -100, W + 200, H + 200, C.navyDeep);
  x.fillStyle = radGrad(x, cx, cy, 1250, [[0, tint], [1, C.navyDeep]]);
  x.fillRect(-100, -100, W + 200, H + 200);
};

// ── the bell curve made of people ──────────────────────────────────────────────────────────────────────────────
const K = 15;
const iqX = (iq) => (iq - 100) * K;
const curveY = (iq) => -9 - 592 * Math.exp(-0.5 * Math.pow((iq - 100) / 15, 2));
let people = null;
const buildPeople = () => {
  const m = "M 1.2 11 Q 1.2 9.2 3 9.2 L 11 9.2 Q 12.8 9.2 12.8 11 L 12.8 21 L 10.8 21 L 10.8 31 L 7.6 31 L 7.6 22 L 6.4 22 L 6.4 31 L 3.2 31 L 3.2 21 L 1.2 21 Z M 11.4 4.6 A 4.4 4.4 0 1 0 2.6 4.6 A 4.4 4.4 0 1 0 11.4 4.6 Z";
  const f = "M 2.6 11 Q 2.6 9.2 4.4 9.2 L 9.6 9.2 Q 11.4 9.2 11.4 11 L 13.4 23 L 10.4 23 L 10.4 31 L 7.8 31 L 7.8 23 L 6.2 23 L 6.2 31 L 3.6 31 L 3.6 23 L 0.6 23 Z M 11.4 4.6 A 4.4 4.4 0 1 0 2.6 4.6 A 4.4 4.4 0 1 0 11.4 4.6 Z";
  const pm = new Path2D(m);
  const pf = new Path2D(f);
  const all = new Path2D();
  for (let iq = 40 + 0.625; iq < 160; iq += 1.25) {
    const n = Math.floor(16 * Math.exp(-0.5 * Math.pow((iq - 100) / 15, 2)) + 0.65);
    for (let r = 0; r < n; r++) {
      const i = Math.round(iq * 8) * 37 + r;
      all.addPath(rnd(i, 4) < 0.5 ? pm : pf, new DOMMatrix().translate(iqX(iq) - 7, -8 - (r + 1) * 36.5 + 4));
    }
  }
  people = all;
};
const peopleBell = (x, color = "#8e8d9e") => {
  if (!people) buildPeople();
  x.fillStyle = color;
  x.fill(people);
};
const bellCurve = (x, draw) => {
  if (draw <= 0) return;
  const pts = [];
  for (let iq = 40; iq <= 160.001; iq += 0.5) pts.push([iqX(iq), curveY(iq)]);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  x.save();
  x.setLineDash([len * clamp(draw), len * 2]);
  x.shadowColor = rgba("#ffe9c4", 0.7);
  x.shadowBlur = 20;
  poly(x, pts, 4, "#fbf3e2");
  x.shadowBlur = 6;
  x.shadowColor = rgba("#ffe9c4", 1);
  poly(x, pts, 4, "#fbf3e2");
  x.restore();
  if (draw > 0.995) {
    x.save();
    x.shadowColor = "#ffe9c4";
    x.shadowBlur = 12;
    circle(x, iqX(160), curveY(160), 6, "#fff");
    x.restore();
  }
};
const rulerTick = (x, iq) => {
  const big = iq % 10 === 0;
  const mid = iq % 5 === 0;
  line(x, iqX(iq), 0, iqX(iq), big ? 11 : mid ? 8 : 5, big ? 2 : 1.4, "#6d6247", "butt");
};
/** the ruler: snap breaks it at 160 (the stub kinks up, the end piece drops); fall carries the piece away */
const ruler = (x, snap = 0, fall = 0, numbers = true) => {
  const x0 = iqX(36), xk = iqX(157.5), xb = iqX(160), xe = iqX(172);
  glow(x, 0, 80, 900, "#4b5a7c", 0.35);
  const body = linGrad(x, 0, 0, 0, 23, [[0, "#efe2b8"], [1, "#cfbf8c"]]);
  rect(x, x0, 0, xk - x0, 23, body);
  for (let iq = 36; iq <= 157; iq++) rulerTick(x, iq);
  if (numbers) for (let k = 4; k <= 15; k++) text(x, String(k * 10), iqX(k * 10), 20, { size: 10.5, weight: 700, fill: "#4a4231", align: "center" });
  const broken = snap > 0.001;
  at(x, xk, 0, -32 * clamp(snap * 1.6), 1, 1, () => {
    x.translate(-xk, 0);
    rect(x, xk, 0, xb - xk, 23, body);
    for (let iq = 158; iq <= 160; iq++) rulerTick(x, iq);
    if (broken) path(x, `M ${xb} 0 l 8 -7 M ${xb} 6 l 10 -3 M ${xb} 12 l 9 3 M ${xb} 18 l 8 6`, null, "#d9c995", 2);
  });
  if (!broken) {
    rect(x, xb, 0, xe - xb, 23, linGrad(x, xb, 0, xe, 0, [[0, "rgba(230,216,168,1)"], [0.3, "rgba(230,216,168,0.9)"], [1, "rgba(230,216,168,0)"]]));
    for (let iq = 161; iq <= 171; iq++) rulerTick(x, iq);
  } else
    alpha(x, 1 - clamp((fall - 0.6) * 2.5), () =>
      at(x, 16 + 90 * fall + xb, 30 + 380 * fall * fall, 12 + 40 * fall, 1, 1, () => rect(x, 0, 0, iqX(169) - xb, 23, "#d8ca98")),
    );
};
const valueLabel = (x, iq, y, str, o = {}) =>
  alpha(x, o.opacity ?? 1, () => {
    if (o.pin) alpha(x, 1, () => line(x, iqX(iq), y + 12, iqX(iq), y + 12 + o.pin, 1.6, "#e8e3d8", "butt"));
    text(x, str, iqX(iq), y, { size: o.size ?? 40, fill: C.cream, align: "center", glow: ["#ffdca0", 2.5, 9, 0.8] });
  });
const farAxis = (x, op = 1) =>
  alpha(x, op, () => {
    alpha(x, 0.75, () => line(x, iqX(160), 0, iqX(620), 0, 2.2, "#b9c3d8", "butt"));
    let i = 0;
    for (let iq = 164; iq < 420; iq += 15, i++) {
      const hi = i % 6 === 3;
      alpha(x, hi ? 0.9 : 0.75, () => rect(x, iqX(iq), hi ? -16 : -6, K * 13.8, hi ? 16 : 6, hi ? "#7f889c" : "#4f586c"));
    }
    for (let iq = 400; iq < 540; iq += 18.5) line(x, iqX(iq), 0, iqX(iq), -12, 2, "#9aa5bd", "butt");
  });
return { W,H,BAR,SANS,C,clamp,lerp,E,ramp,track,wob,rnd,rgba,rect,circle,ellipse,poly,line,path,at,alpha,text,glow,linGrad,radGrad,CAM0,applyCam,layer,finish,STAND,joints,armIK,walk,figure,watch,robotHand,handAt,holdHand,phone,bars,battery,steam,mug,plateToast,tweezers,chip,screwTray,car,desk,elevatorHall,garage,kitchen,tileCounter,steelWall,voidBg,K,iqX,curveY,peopleBell,bellCurve,ruler,valueLabel,farAxis };
})();
const K2 = (() => {
const { C, E, W, H, alpha, at, circle, clamp, ellipse, figure, glow, joints, line, linGrad, path, radGrad, rect, rgba, rnd, text } = K1;
// broll.js — the B-roll devices of the Stickman Explainer: what a video over a real voiceover needs beyond the figures
// and sets of kit.js. Real photos (framed print, full bleed, a moving lamp, a credit in the letterbox bar), the label
// pill, a faceless figure for real people, light motes, a flat map and a globe with coarse real coastlines, stars, a
// thermometer, a thought bubble, a dinosaur silhouette. Proven on "Antarctica" (src/examples/antarctica.js).
//
// Photos: a video lists its photos in PHOTOS and keeps its own IMG store (decoded by style/stickman/stage.js before the
// first frame; see templates/stickman/). Draw them with drawPhoto / fullBleed / framedPrint, passing IMG.<key>.

const RAD = Math.PI / 180;
const GOLD = "#f4b748";
const TEAL = "#2f9c94";
const ICE = "#4fa3ff";
const RED = "#d23b45";

// ── labels ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** a label pill: springs in (k 0→1) on the word it echoes; cue a marimba tag (tag-d / tag-fs / tag-a) on that frame */
const pill = (x, str, px, py, k, o = {}) =>
  alpha(x, clamp(k * 1.4), () =>
    at(x, px, py, 0, 0.85 + 0.15 * E.out(clamp(k)), 0.85 + 0.15 * E.out(clamp(k)), () => {
      x.font = `800 ${o.size ?? 30}px "Inter"`;
      x.letterSpacing = "2px";
      const w = x.measureText(str).width + 44;
      const h = (o.size ?? 30) * 1.7;
      rect(x, -w / 2, -h / 2, w, h, rgba(o.bg ?? "#0d1118", 0.72), h / 2);
      if (o.accent) rect(x, -w / 2, -h / 2, 10, h, o.accent, 5);
      text(x, str, 0, (o.size ?? 30) * 0.36, { size: o.size ?? 30, fill: o.fill ?? "#f6efe2", align: "center", track: 0.06 });
    }),
  );

// ── real photos ──────────────────────────────────────────────────────────────────────────────────────────────────
/** drawImage with a grey placeholder while a photo is missing */
const drawPhoto = (x, im, sx, sy, sw, sh, dx, dy, dw, dh) => {
  if (im) x.drawImage(im, sx, sy, sw, sh, dx, dy, dw, dh);
  else rect(x, dx, dy, dw, dh, "#2a2a2a");
};
/** a 2:1 source window (sx, sy, sw, sw/2) filling the letterboxed picture. Animate the window for a slow drift. */
const fullBleed = (x, im, sx, sy, sw) => {
  rect(x, 0, 0, W, H, "#0b0908");
  drawPhoto(x, im, sx, sy, sw, sw / 2, 0, 60, 1920, 960);
};
/** a moving pool of lamp light over a photo (k 0→1 moves it from `from` to `to`): "uncovered", "found" */
const lampSweep = (x, k, from = [620, 400], to = [1080, 600]) => {
  const lx = from[0] + (to[0] - from[0]) * k, ly = from[1] + (to[1] - from[1]) * k;
  x.fillStyle = radGrad(x, lx, ly, 1150, [[0, "rgba(255,226,170,0)"], [0.32, "rgba(12,9,6,0.12)"], [1, "rgba(6,4,3,0.85)"]]);
  x.fillRect(0, 0, W, H);
  glow(x, lx, ly, 360, "#ffd9a0", 0.1);
};
/** a portrait as a framed print on a dark wall under a picture light. iw × ih = the photo's pixel size. */
const framedPrint = (x, im, iw, ih, cx, cy, fh = 740) => {
  x.fillStyle = radGrad(x, cx, cy - 130, 1300, [[0, "#3b2c2a"], [1, "#100b0b"]]);
  x.fillRect(-200, -200, W + 400, H + 400);
  for (let i = 0; i < 15; i++) alpha(x, 0.14, () => rect(x, -200 + i * 160, 0, 3, H, "#000"));
  glow(x, cx, cy - 300, 560, "#ffd9a6", 0.22);
  const fw = (fh * iw) / ih;
  const fx = cx - fw / 2, fy = cy - fh / 2;
  alpha(x, 0.55, () => rect(x, fx - 10, fy - 4, fw + 52, fh + 52, "#000", 6));
  rect(x, fx - 26, fy - 26, fw + 52, fh + 52, "#24180f", 6);
  rect(x, fx - 18, fy - 18, fw + 36, fh + 36, "#6b4a2e", 4);
  rect(x, fx - 6, fy - 6, fw + 12, fh + 12, "#150f0b", 2);
  drawPhoto(x, im, 0, 0, iw, ih, fx, fy, fw, fh);
  alpha(x, 0.16, () => {
    x.fillStyle = linGrad(x, 0, fy, 0, fy + fh, [[0, "#ffdca8"], [1, "rgba(0,0,0,0)"]]);
    x.fillRect(fx, fy, fw, fh);
  });
  rect(x, cx - 110, fy - 74, 220, 20, "#c9a45c", 10);
  rect(x, cx - 6, fy - 56, 12, 30, "#8a6c36");
};
/** the photo credit, small, in the bottom letterbox bar: draw it AFTER finish() */
const credit = (x, str) => text(x, str, W - 36, H - 22, { size: 17, weight: 600, fill: "rgba(246,239,226,0.55)", align: "right", track: 0.02 });

// ── a real person, without their face ───────────────────────────────────────────────────────────────────────────
const COAT = { hoodie: "#5b4a3a", dark: "#4a3b2e", shade: "#3d3026", strings: "#5b4a3a" };
const bowler = (x, hx, hy, s, color = C.ink) =>
  at(x, hx, hy, 0, s, s, () => {
    ellipse(x, 0, -40, 92, 16, color);
    path(x, "M -58 -40 Q -60 -112 0 -116 Q 60 -112 58 -40 Z", color);
    alpha(x, 0.5, () => rect(x, -56, -54, 112, 12, "#3a2c22"));
  });
/** a faceless figure in a period coat (+ a bowler unless hat: false): how a real person appears when not in a photo */
const scholar = (x, o) => {
  const s = o.s ?? 1;
  const P = o.pose ?? {};
  figure(x, { tone: "hero", hood: false, outfit: o.outfit ?? COAT, ...o, face: { eyes: "none", mouth: "none", look: o.look ?? 0 } });
  if (o.hat === false) return;
  const j = joints(P.lean ?? 0, P.bob ?? 0);
  bowler(x, o.x + j.head[0] * s, o.y + j.head[1] * s, s);
};

// ── light ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** dust motes drifting in a light (life for a held shot) */
const dust = (x, t, cx, cy, w, h, n, seed, color = "#ffe9c4") => {
  for (let i = 0; i < n; i++) {
    const px = cx - w / 2 + ((((rnd(i, seed) * w + t * 14 * (rnd(i, seed + 1) - 0.5)) % w) + w) % w);
    const py = cy - h / 2 + ((((rnd(i, seed + 2) * h - t * 10 * (0.3 + rnd(i, seed + 3))) % h) + h) % h);
    alpha(x, 0.2 + 0.45 * rnd(i, seed + 4), () => circle(x, px, py, 1.4 + rnd(i, seed + 5) * 2.4, color));
  }
};
/** a soft cone of lamp light from (lx, ly) down to y = by */
const cone = (x, lx, ly, bw, by, op, color = "#ffe2a8") => {
  x.save();
  x.fillStyle = linGrad(x, 0, ly, 0, by, [[0, rgba(color, op)], [1, rgba(color, 0)]]);
  x.beginPath();
  x.moveTo(lx - 54, ly);
  x.lineTo(lx + 54, ly);
  x.lineTo(lx + bw / 2, by);
  x.lineTo(lx - bw / 2, by);
  x.closePath();
  x.fill();
  x.restore();
};
/** a hanging green-glass lamp that sways; returns the shade's mouth [x, y] for a cone() */
const hangingLamp = (x, lx, t, len = 320) => {
  const sway = Math.sin(t * 1.1) * 2.2;
  at(x, lx, 0, sway, 1, 1, () => {
    line(x, 0, -40, 0, len, 4, "#140e0b");
    path(x, `M -78 ${len + 64} L 78 ${len + 64} L 34 ${len} L -34 ${len} Z`, "#2f5a45");
    alpha(x, 0.6, () => path(x, `M -60 ${len + 58} L -24 ${len + 8} L -14 ${len + 8} L -40 ${len + 58} Z`, "#4f8a6c"));
    ellipse(x, 0, len + 64, 78, 12, "#ffe7b4");
    glow(x, 0, len + 70, 220, "#ffd9a0", 0.55);
  });
  return [lx + Math.sin(sway * RAD) * (len + 64), Math.cos(sway * RAD) * (len + 64)];
};
const stars = (x, t, n = 90, seed = 7) => {
  for (let i = 0; i < n; i++) alpha(x, 0.25 + 0.5 * rnd(i, seed) * (0.7 + 0.3 * Math.sin(t * 2 + i)), () => circle(x, rnd(i, seed + 1) * W, rnd(i, seed + 2) * H, 0.8 + rnd(i, seed + 3) * 1.6, "#e8eeff"));
};

// ── props ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** a thermometer; level 0..1, mercury colour (red warm → ICE cold) */
const thermometer = (x, px, py, level, color) =>
  at(x, px, py, 0, 1, 1, () => {
    rect(x, -28, -320, 56, 352, rgba("#0b0f16", 0.6), 28);
    rect(x, -13, -300, 26, 312, "#e9eef5", 13);
    circle(x, 0, 22, 36, "#e9eef5");
    const top = -40 + (-286 + 40) * level;
    rect(x, -7, top, 14, 20 - top, color, 7);
    circle(x, 0, 22, 27, color);
    for (let i = 0; i < 8; i++) line(x, 16, -60 - i * 30, 26, -60 - i * 30, 3, rgba("#0b0f16", 0.5), "butt");
  });
/** a thought bubble (k 0→1 pops it); fn draws its contents around (0, 0) */
const bubble = (x, bx, by, w, h, k, fn) =>
  alpha(x, clamp(k * 1.5), () =>
    at(x, bx, by, 0, 0.8 + 0.2 * E.out(clamp(k)), 0.8 + 0.2 * E.out(clamp(k)), () => {
      const c = "#f6efe2";
      ellipse(x, 0, 0, w / 2, h / 2, c);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        circle(x, Math.cos(a) * w * 0.42, Math.sin(a) * h * 0.4, h * 0.22, c);
      }
      fn();
    }),
  );
/** a T. rex silhouette facing right, feet on y = 0 (~300 × 125 units). rot 180 + a lift of 99·s = fallen, legs up. */
const trex = (x, tx, ty, s, color, rot = 0) =>
  at(x, tx, ty, rot, s, s, () => {
    path(x, "M -40 -64 Q -110 -66 -170 -34 Q -110 -44 -40 -40 Z", color);
    at(x, 0, -60, -14, 1, 1, () => ellipse(x, 0, 0, 64, 36, color));
    path(x, "M 34 -84 Q 52 -116 78 -124 L 124 -124 Q 136 -120 136 -108 L 136 -102 L 110 -100 L 132 -92 Q 130 -82 118 -82 L 80 -82 Q 64 -68 50 -48 Z", color);
    line(x, 10, -36, 24, -10, 20, color);
    line(x, 24, -10, 8, 0, 20, color);
    line(x, -18, -36, -24, -10, 18, color);
    line(x, -24, -10, -36, 0, 18, color);
    line(x, 54, -62, 70, -48, 7, color);
  });

// ── geography: coarse real coastlines (lon, lat pairs) — a flat map or a globe ────────────────────────────────
const EURASIA = [-5.6,36.0,-6.3,36.8,-7.4,37.2,-8.9,37.0,-8.8,38.5,-9.5,38.8,-8.9,40.2,-8.8,42.0,-9.3,43.0,-7.9,43.8,-5.8,43.6,-3.8,43.5,-1.8,43.4,-1.3,44.5,-1.2,46.0,-2.2,47.1,-4.7,48.0,-4.7,48.6,-3.0,48.8,-1.6,48.7,-1.9,49.7,-1.2,49.6,0.2,49.5,1.6,50.4,1.6,50.9,3.2,51.3,4.0,51.9,4.7,52.9,6.0,53.4,7.2,53.6,8.6,53.9,8.9,54.9,8.2,55.6,8.1,56.5,8.6,57.1,10.5,57.7,10.5,56.5,10.0,55.6,9.8,54.8,10.9,54.4,11.5,54.1,13.0,54.4,14.2,53.9,16.0,54.3,18.6,54.5,19.9,54.9,21.1,55.7,21.0,56.8,22.0,57.6,23.5,57.2,24.1,57.1,24.4,58.3,23.5,59.2,25.0,59.6,28.0,59.5,30.2,59.9,28.8,60.5,26.9,60.4,25.0,60.2,22.9,59.8,21.4,60.7,21.4,61.8,21.0,62.8,22.3,63.8,24.5,64.9,25.4,65.4,24.6,65.8,22.3,65.8,21.3,64.8,19.8,63.6,18.0,62.6,17.3,61.6,17.2,60.7,18.7,60.1,18.9,59.3,17.0,58.5,16.6,57.3,16.0,56.2,14.4,55.6,13.0,55.4,12.6,56.2,11.9,57.4,11.2,58.9,10.5,59.4,9.5,58.9,8.0,58.1,6.6,58.1,5.6,58.8,5.0,60.0,5.0,61.6,5.7,62.6,8.5,63.5,10.0,64.5,12.4,66.0,14.0,67.5,15.5,68.6,17.5,69.4,19.0,70.0,21.5,70.3,24.0,71.0,27.0,71.0,29.5,70.5,31.0,70.0,33.0,69.3,36.0,69.0,41.0,67.0,44.0,68.5,50.0,68.0,54.0,68.6,60.0,69.5,66.0,69.5,70.0,73.0,80.0,73.5,95.0,76.0,110.0,77.0,130.0,71.0,150.0,71.0,170.0,69.5,180.0,68.0,180.0,65.0,175.0,64.5,165.0,60.0,163.0,56.0,156.0,51.0,156.0,57.5,151.0,59.5,143.0,59.3,137.0,54.0,141.0,52.5,140.0,48.5,135.0,43.5,131.0,42.5,129.5,40.5,129.5,36.0,127.0,34.5,126.3,37.5,124.5,39.8,121.5,40.9,121.0,37.5,120.0,36.0,121.5,32.0,122.0,30.0,120.5,27.0,117.0,23.5,113.5,22.2,110.5,20.4,108.5,21.5,106.5,20.0,106.0,18.0,108.5,15.0,109.2,12.0,107.0,10.5,105.0,8.6,104.8,10.5,103.0,11.0,100.5,13.5,100.0,12.0,99.2,9.5,100.3,7.0,103.4,4.0,104.2,1.4,101.0,3.0,98.5,8.0,98.0,10.0,97.5,16.5,94.5,16.0,94.0,19.0,91.9,22.3,89.0,21.6,86.9,21.0,85.0,19.5,80.3,15.5,80.2,13.0,79.8,10.3,77.5,8.1,76.0,10.0,74.8,12.8,73.0,17.0,72.8,20.5,72.5,21.8,70.0,22.5,68.8,23.8,66.6,25.4,61.5,25.2,57.3,25.8,56.4,27.1,54.0,26.7,51.5,27.9,50.0,30.0,48.0,30.0,48.5,28.5,50.2,26.2,51.6,24.2,54.5,24.2,56.4,26.2,56.3,24.5,59.8,22.4,57.8,19.0,55.0,17.2,52.0,16.0,48.5,14.0,45.0,12.8,43.4,12.7,42.7,15.5,40.0,20.0,38.5,23.0,36.5,26.0,34.9,28.1,34.5,29.5,34.3,31.3,34.9,32.5,35.9,35.4,36.2,36.6,35.0,36.8,32.5,36.1,30.5,36.4,28.3,36.8,27.3,37.5,26.4,38.4,26.8,39.4,26.2,40.0,26.7,40.4,27.5,40.4,29.0,40.9,31.4,41.2,33.0,42.0,35.2,42.0,37.5,41.0,39.7,41.0,41.6,41.6,41.0,43.0,39.0,44.5,37.8,44.7,36.6,45.3,35.4,45.1,34.0,44.4,33.4,44.6,32.5,45.4,33.6,46.1,31.5,46.6,30.7,46.5,29.6,45.4,28.7,44.3,28.0,43.0,27.9,42.0,28.9,41.2,26.0,40.7,24.0,40.8,23.0,40.6,22.6,40.0,23.0,39.2,24.0,38.0,23.1,37.4,23.0,36.5,22.4,36.5,21.7,36.8,21.2,37.8,21.0,38.4,20.7,39.0,20.0,39.7,19.4,40.3,19.5,41.6,18.6,42.4,17.4,43.0,16.0,43.5,15.2,44.2,14.5,45.2,13.7,45.6,12.3,45.3,12.4,44.3,13.6,43.5,14.7,42.1,16.1,41.9,16.0,41.4,17.2,40.9,18.5,40.1,18.0,39.9,17.0,40.4,16.6,39.6,17.1,39.0,16.5,38.4,15.7,37.9,16.0,38.9,15.6,40.1,14.8,40.6,14.2,40.8,13.0,41.2,11.8,42.1,10.5,42.9,10.1,44.0,8.9,44.4,7.6,43.8,6.6,43.2,5.4,43.2,4.5,43.5,3.2,43.1,3.2,41.9,1.0,41.1,0.0,40.0,-0.3,39.4,0.2,38.7,-0.7,37.6,-2.1,36.7,-4.4,36.7];
const AFRICA = [-17.5,14.7,-16.9,21.0,-13.0,27.5,-9.8,29.8,-9.6,32.5,-6.8,34.0,-5.9,35.8,-2.0,35.1,1.0,36.5,3.0,36.8,7.0,37.0,10.0,37.3,11.0,36.8,10.4,35.0,11.0,33.5,15.0,32.4,19.0,30.3,20.0,32.0,22.0,32.9,25.0,31.7,29.0,30.9,32.3,31.3,34.2,31.2,34.3,27.8,32.6,29.9,35.0,24.0,37.3,21.0,37.5,18.5,39.5,15.5,43.3,12.6,44.5,10.4,51.2,11.8,51.0,10.4,48.0,5.0,43.0,0.0,40.0,-3.0,39.3,-6.5,40.5,-10.5,40.6,-15.0,35.5,-22.0,35.3,-24.0,32.6,-26.0,32.4,-28.8,30.0,-31.3,25.6,-34.0,20.0,-34.8,18.4,-34.0,17.9,-31.0,16.5,-28.6,15.0,-26.5,14.4,-22.5,11.8,-17.3,12.3,-13.0,13.4,-10.0,12.3,-6.0,9.0,-1.0,9.5,4.0,8.0,4.5,6.0,4.3,3.0,6.3,-1.0,5.0,-4.0,5.2,-7.5,4.4,-11.0,6.8,-13.2,8.5,-15.0,11.0,-16.7,12.5];
const NAMERICA = [-168.0,65.6,-162.0,70.3,-156.0,71.3,-141.0,69.6,-128.0,70.2,-110.0,68.5,-95.0,68.0,-90.0,66.0,-94.5,59.0,-92.0,57.0,-82.5,54.5,-79.5,51.5,-77.0,56.0,-78.0,62.0,-71.0,61.5,-64.5,60.3,-61.5,56.0,-56.0,52.0,-59.5,48.5,-64.5,47.0,-61.0,45.5,-66.0,44.5,-70.5,43.0,-70.0,41.8,-74.0,40.6,-75.5,38.0,-76.0,36.8,-75.5,35.2,-78.0,33.8,-81.0,31.8,-80.0,27.0,-80.4,25.2,-81.8,26.8,-82.8,28.0,-84.0,30.0,-88.0,30.4,-89.5,29.2,-94.0,29.6,-97.3,27.8,-97.5,24.0,-97.0,21.5,-96.0,19.0,-94.5,18.2,-91.0,18.6,-90.4,21.0,-87.0,21.5,-88.0,18.5,-88.5,15.8,-84.0,15.8,-83.5,11.0,-81.0,8.8,-77.5,8.5,-79.5,7.3,-82.0,8.2,-85.7,10.8,-87.5,13.0,-91.5,14.0,-94.5,16.0,-97.0,15.8,-101.5,17.5,-105.5,20.5,-105.2,22.8,-109.0,25.8,-112.0,29.0,-114.7,31.6,-117.0,32.5,-120.6,34.5,-122.5,37.7,-124.2,40.4,-124.0,46.2,-124.6,48.4,-127.0,50.5,-130.0,54.5,-135.0,57.0,-140.0,59.7,-146.0,60.8,-151.0,59.5,-154.0,57.5,-158.0,56.5,-163.0,55.0,-160.0,58.6,-165.0,60.5,-165.0,62.5,-164.5,63.2];
const SAMERICA = [-71.5,12.2,-63.0,10.7,-60.0,8.5,-57.0,6.0,-52.0,4.5,-50.0,1.8,-48.5,-1.0,-44.0,-2.5,-39.0,-3.5,-35.2,-5.5,-35.0,-9.0,-38.5,-13.0,-39.0,-17.5,-41.0,-22.0,-44.0,-23.0,-48.5,-26.0,-48.8,-28.5,-52.5,-32.5,-54.0,-34.6,-57.5,-35.0,-57.0,-38.0,-62.0,-39.0,-65.0,-42.0,-67.0,-46.0,-65.8,-47.8,-69.0,-51.5,-68.5,-52.5,-70.0,-54.8,-74.0,-52.5,-75.5,-48.0,-73.5,-43.0,-73.5,-37.0,-71.6,-33.0,-71.4,-28.0,-70.3,-18.5,-75.5,-15.0,-79.5,-7.5,-81.3,-4.5,-80.0,-1.0,-80.0,1.0,-78.8,1.8,-77.5,4.0,-77.4,7.0,-76.5,8.6,-75.5,10.5];
const ISLANDS = [
  [-73,78,-60,82,-30,83.5,-20,81,-18,76,-22,70.5,-32,68.2,-40,65,-43.5,60,-50,62,-53,66,-55,70,-58,75,-66,76], // Greenland
  [-24,65.5,-22,66.4,-16,66.5,-13.5,65.2,-15,64.3,-18.5,63.4,-22.5,63.8], // Iceland
  [-5.7,50.1,-4.2,50.4,-3.4,50.6,-1.5,50.7,0.3,50.8,1.4,51.2,1.0,51.8,1.7,52.6,1.3,53.0,0.2,53.4,-0.2,54.1,-1.2,54.6,-1.6,55.6,-2.5,56.0,-1.8,57.5,-3.3,57.7,-3.1,58.6,-5.0,58.6,-5.3,57.9,-5.8,57.0,-5.6,56.3,-5.6,55.3,-4.9,54.8,-3.4,54.9,-3.2,54.2,-2.9,53.4,-4.6,53.3,-4.2,52.8,-4.1,52.3,-5.1,51.8,-4.2,51.6,-3.0,51.5,-3.3,51.2,-4.2,51.2], // Britain
  [-6.0,52.2,-6.0,53.0,-6.2,53.6,-5.9,54.6,-6.2,55.2,-7.3,55.3,-8.3,55.1,-8.6,54.6,-10.0,54.2,-9.9,53.4,-9.4,52.6,-10.3,51.8,-9.6,51.5,-8.2,51.8,-7.0,52.1], // Ireland
  [12.4,37.9,13.3,38.2,15.6,38.3,15.1,37.3,15.1,36.7,14.3,36.8,12.4,37.6], // Sicily
  [8.2,40.9,9.2,41.2,9.7,40.5,9.6,39.2,9.0,39.1,8.4,38.9,8.4,39.8], // Sardinia
  [9.4,43.0,9.5,42.2,9.2,41.4,8.6,41.8,8.6,42.4,9.0,42.9], // Corsica
  [23.5,35.3,24.5,35.6,26.3,35.2,25.0,34.9,23.6,35.2], // Crete
  [130.0,31.0,131.5,31.5,132.0,33.8,135.0,33.5,137.0,34.6,139.8,35.0,140.8,35.7,141.0,38.3,142.0,40.5,141.4,41.5,140.0,40.4,139.7,38.6,137.3,37.4,136.2,36.0,133.0,35.5,131.0,34.4,129.6,33.4], // Japan
  [140.0,41.5,141.0,43.2,141.8,45.4,143.8,44.2,145.5,43.3,143.3,42.0,141.0,41.8], // Hokkaido
  [109.0,1.5,110.5,-2.9,114.5,-4.0,116.5,-1.5,117.6,1.0,119.0,5.0,117.0,7.0,115.0,5.0,113.0,3.0,110.0,1.8], // Borneo
  [95.3,5.6,98.0,4.0,103.8,-1.0,106.0,-5.9,104.5,-5.9,101.0,-2.5,98.5,1.0], // Sumatra
  [105.5,-6.0,106.0,-7.0,112.0,-8.2,114.5,-8.6,114.4,-7.8,110.5,-6.8,106.5,-6.0], // Java
  [131.0,-1.0,135.0,-3.4,138.0,-1.6,141.0,-2.6,146.0,-5.5,150.0,-10.5,147.0,-10.1,143.0,-9.0,141.0,-9.2,138.0,-8.3,137.5,-5.0,133.5,-4.0,132.0,-2.5], // New Guinea
  [120.0,18.5,122.3,18.4,122.0,16.0,124.0,13.0,121.5,13.8,120.5,14.5,120.0,16.0], // Luzon
  [79.8,9.8,81.9,7.5,81.0,6.0,80.0,6.2], // Sri Lanka
  [-84.9,21.9,-80.0,23.1,-74.2,20.2,-77.7,19.9,-81.0,21.6], // Cuba
  [49.3,-12.0,50.5,-15.5,47.0,-25.0,44.0,-25.0,43.3,-22.0,44.4,-16.2,47.0,-13.5], // Madagascar
  [113.5,-22.0,114.0,-26.5,115.0,-34.0,118.0,-35.0,123.5,-33.8,129.0,-31.6,131.5,-31.5,135.5,-34.8,138.0,-35.6,140.0,-38.0,144.0,-38.3,146.5,-39.0,150.0,-37.5,151.3,-33.8,153.6,-28.0,153.0,-25.0,150.0,-22.5,146.0,-19.0,145.3,-15.0,143.5,-14.0,142.5,-10.7,141.5,-13.0,141.6,-17.0,139.5,-17.5,136.5,-15.5,137.0,-12.0,132.6,-11.5,130.0,-13.0,129.0,-15.0,126.0,-14.0,122.0,-17.0,121.0,-19.5,117.0,-20.5], // Australia
  [144.6,-40.7,148.3,-40.9,148.0,-43.2,146.0,-43.6,145.2,-42.2], // Tasmania
  [172.7,-34.4,174.8,-36.8,178.5,-37.7,177.0,-39.5,175.2,-41.6,174.6,-39.5], // New Zealand, north
  [172.6,-40.5,174.3,-41.7,171.2,-44.4,169.0,-46.6,166.5,-46.0,168.0,-44.0,170.5,-42.8], // New Zealand, south
];
const LAND = [EURASIA, AFRICA, NAMERICA, SAMERICA, ...ISLANDS];
const CASPIAN = [47.5,45.5,49.0,46.6,51.5,46.9,53.0,46.0,51.5,44.5,52.5,42.0,54.0,40.5,53.8,37.5,51.0,36.8,49.0,37.5,49.5,40.5,48.0,42.0,47.5,43.5];
const ANTARCTICA = [-180,-78.0,-165,-78.5,-158,-77.0,-150,-76.0,-140,-75.0,-130,-74.0,-120,-73.5,-110,-74.0,-100,-73.0,-90,-72.5,-80,-73.0,-75,-71.0,-68,-69.5,-66,-67.0,-64,-65.0,-58,-63.3,-60,-64.8,-62,-66.5,-63,-69.0,-61,-72.0,-60,-74.5,-55,-76.5,-45,-78.0,-36,-77.5,-30,-76.0,-25,-74.0,-15,-72.5,-5,-70.5,5,-70.0,15,-70.0,25,-70.0,35,-69.0,45,-67.5,55,-66.5,65,-67.5,70,-71.0,75,-69.5,80,-67.5,90,-66.5,100,-66.0,110,-66.0,120,-66.5,130,-66.0,140,-66.5,150,-68.5,160,-70.0,165,-72.0,170,-71.5,168,-74.0,165,-77.5,170,-78.0,180,-78.0];

const fillPts = (x, pts, fill, stroke, w = 0) => {
  x.beginPath();
  pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])));
  x.closePath();
  if (fill) {
    x.fillStyle = fill;
    x.fill();
  }
  if (stroke) {
    x.strokeStyle = stroke;
    x.lineWidth = w;
    x.lineJoin = "round";
    x.stroke();
  }
};
/** flat map projection: v = { lon, lat, k } (k px per degree of longitude; latitude stretched ×1.6 for mid-latitudes) */
const flat = (lon, lat, v) => [960 + (lon - v.lon) * v.k, 540 - (lat - v.lat) * v.k * 1.6];
const flatPoly = (arr, v) => {
  const pts = [];
  for (let i = 0; i < arr.length; i += 2) pts.push(flat(arr[i], arr[i + 1], v));
  return pts;
};
/** a navy flat map with a graticule. Europe: { lon: 6, lat: 49, k: 19 } · Europe + Asia: { lon: 40, lat: 47, k: 10.5 } */
const flatMap = (x, v, o = {}) => {
  rect(x, -200, -200, W + 400, H + 400, o.sea ?? "#0f2033");
  for (let lon = -180; lon <= 180; lon += 10) {
    const a = flat(lon, 80, v), b = flat(lon, -60, v);
    if (Math.max(a[0], b[0]) > -50 && Math.min(a[0], b[0]) < W + 50) line(x, a[0], a[1], b[0], b[1], 1.5, rgba("#5a7aa0", 0.16), "butt");
  }
  for (let lat = -60; lat <= 80; lat += 10) {
    const a = flat(-180, lat, v), b = flat(180, lat, v);
    line(x, a[0], a[1], b[0], b[1], 1.5, rgba("#5a7aa0", 0.16), "butt");
  }
  LAND.forEach((p) => fillPts(x, flatPoly(p, v), o.land ?? "#2f4561", o.coast ?? "#5a7a9e", 2.5));
  fillPts(x, flatPoly(CASPIAN, v), o.sea ?? "#0f2033", o.coast ?? "#5a7a9e", 2.5);
};
/** orthographic projection for a globe centred on v = { lon, lat }: [x, y, z] on the unit sphere (z > 0 = facing us) */
const ortho = (lon, lat, v) => {
  const l = lat * RAD, d = (lon - v.lon) * RAD, l0 = v.lat * RAD;
  return [
    Math.cos(l) * Math.sin(d),
    Math.cos(l0) * Math.sin(l) - Math.sin(l0) * Math.cos(l) * Math.cos(d),
    Math.sin(l0) * Math.sin(l) + Math.cos(l0) * Math.cos(l) * Math.cos(d),
  ];
};
/** one coastline on the globe; points behind it are pushed onto the limb. dLat grows a polar ring (sea ice). */
const globePoly = (x, arr, gx, gy, R, v, fill, stroke, dLat = 0) => {
  const pts = [];
  let vis = 0;
  for (let i = 0; i < arr.length; i += 2) {
    let [px, py, z] = ortho(arr[i], arr[i + 1] + dLat, v);
    if (z > 0) vis++;
    else {
      const m = Math.hypot(px, py) || 1;
      px /= m;
      py /= m;
    }
    pts.push([gx + px * R, gy - py * R]);
  }
  if (vis) fillPts(x, pts, fill, stroke, 2);
};
/** a globe at (gx, gy), radius R, seen from v = { lon, lat } (rotate v.lon over time for a spin; lat −57 shows
 *  Antarctica). o: { sea, seaLight, land, ant, antEdge, trees (colour: tree dots on Antarctica), seaIce (0..1), atmo } */
const globe = (x, gx, gy, R, v, o) => {
  glow(x, gx, gy, R * 1.25, o.atmo ?? "#6fb6ff", 0.22);
  x.save();
  x.beginPath();
  x.arc(gx, gy, R, 0, Math.PI * 2);
  x.clip();
  x.fillStyle = radGrad(x, gx - R * 0.3, gy - R * 0.35, R * 1.6, [[0, o.seaLight ?? "#3d7fc0"], [1, o.sea ?? "#0d2748"]]);
  x.fillRect(gx - R, gy - R, 2 * R, 2 * R);
  x.strokeStyle = rgba("#bfe0ff", 0.1);
  x.lineWidth = 1.5;
  for (let lat = -60; lat <= 60; lat += 30) {
    x.beginPath();
    let pen = false;
    for (let lon = -180; lon <= 180; lon += 6) {
      const [px, py, z] = ortho(lon, lat, v);
      if (z > 0) {
        pen ? x.lineTo(gx + px * R, gy - py * R) : x.moveTo(gx + px * R, gy - py * R);
        pen = true;
      } else pen = false;
    }
    x.stroke();
  }
  LAND.forEach((p) => globePoly(x, p, gx, gy, R, v, o.land ?? "#5d955c", rgba("#0b1a2c", 0.35)));
  globePoly(x, CASPIAN, gx, gy, R, v, o.sea ?? "#0d2748");
  if (o.seaIce) globePoly(x, ANTARCTICA, gx, gy, R, v, rgba("#e9f4ff", 0.55 * o.seaIce), null, 6);
  globePoly(x, ANTARCTICA, gx, gy, R, v, o.ant ?? "#e6f0fa", o.antEdge);
  if (o.trees)
    for (let i = 0; i < 70; i++) {
      const [px, py, z] = ortho(rnd(i, 51) * 360 - 180, -72 - rnd(i, 52) * 14, v);
      if (z > 0) at(x, gx + px * R, gy - py * R, 0, 1, 1, () => path(x, "M 0 -9 L 6 3 L -6 3 Z", o.trees));
    }
  x.fillStyle = radGrad(x, gx - R * 0.35, gy - R * 0.4, R * 2.1, [[0, "rgba(255,255,255,0.10)"], [0.45, "rgba(0,0,0,0)"], [1, "rgba(0,4,12,0.75)"]]);
  x.fillRect(gx - R, gy - R, 2 * R, 2 * R);
  x.restore();
  x.strokeStyle = rgba(o.atmo ?? "#6fb6ff", 0.55);
  x.lineWidth = 3;
  x.beginPath();
  x.arc(gx, gy, R + 1, 0, Math.PI * 2);
  x.stroke();
};
/** a pulsing red marker on the globe at (lon, lat), popping at time tm (hidden when it turns away) */
const globeMarker = (x, t, lon, lat, tm, gx, gy, R, v) => {
  const [px, py, z] = ortho(lon, lat, v);
  const k = Math.min(1, Math.max(0, (t - tm) / 0.25));
  if (k <= 0 || z < 0.08) return;
  const mx = gx + px * R, my = gy - py * R;
  const ring = ((t - tm) * 1.3) % 1;
  alpha(x, clamp(z * 4), () => {
    glow(x, mx, my, 50, "#ff4a3d", 0.7 * k);
    circle(x, mx, my, 9 * k, "#ff6a5d");
    x.strokeStyle = rgba("#ff5a50", 0.8 * (1 - ring));
    x.lineWidth = 3;
    x.beginPath();
    x.arc(mx, my, 14 + ring * 50, 0, Math.PI * 2);
    x.stroke();
  });
};
return { GOLD,TEAL,ICE,RED,pill,drawPhoto,fullBleed,lampSweep,framedPrint,credit,COAT,bowler,scholar,dust,cone,hangingLamp,stars,thermometer,bubble,trex,EURASIA,AFRICA,NAMERICA,SAMERICA,ISLANDS,LAND,CASPIAN,ANTARCTICA,fillPts,flat,flatMap,ortho,globePoly,globe,globeMarker };
})();
window.SK = Object.assign({}, K1, K2);
})();
