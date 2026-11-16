// pov-entry.js — the generic, prop-driven scene runtime of the `pov` style (POV Escalation look).
// Bundled with three.js and the kit's world (src/pov/{core,hud,post,world}.js from style-kits/POV-claude style.md)
// into ONE classic script, ../pov.js (no ES modules over file://, no network):
//   unpack the kit (its Part A unpacker) into a scratch dir K, `npm i three@0.179.0 esbuild@0.28.1` there, copy this
//   file to K/src/pov-entry.js, then: npx esbuild src/pov-entry.js --bundle --minify --format=iife \
//       --legal-comments=eof --outfile=<repo>/renderer/styles/pov/pov.js
// No per-video code: every scene is built from window.__scene.props (docs/styles/pov.md). Pure in t.
import { clamp, ramp, wob, speedKmh, dist, commas, sig3 } from "./pov/core.js";
import { caption, title, panelLeft, panelRight, wash, endCard, SERIF } from "./pov/hud.js";
import { makePost } from "./pov/post.js";
import { makeWorld, bikeRig, runRig } from "./pov/world.js";

const GOLD = { top: "#8790bc", mid: "#b5adc4", hor: "#f3c7a3", below: "#d9b08e", fogColor: "#e9c3a4", sunElev: 2.6, sunAz: 0, sunAmt: 1, space: 0, haze: 1, fogNear: 40, sunSize: 1.2 };
const R = 6.371e6;
// biome → world kind, eye, default speed (km/h, from → to), look
const BIOMES = {
  suburb: { kind: "suburb", y: 1.5, x: 0, speed: [18, 40], sky: { fogFar: 700 }, traffic: true },
  city: { kind: "city", y: 1.5, x: 1.9, speed: [40, 110], sky: { fogFar: 1300 }, traffic: true },
  highway: { kind: "highway", y: 1.5, x: 1.9, speed: [120, 400], sky: { fogFar: 2800, fogNear: 200 }, traffic: true },
  fields: { kind: "fields", y: 9, x: 0, speed: [400, 1500], sky: { fogNear: 1500, fogFar: 60000, hor: "#f5cba6", fogColor: "#eecbab" } },
  desert: { kind: "desert", y: 3, x: 0, speed: [1200, 4000], sky: { fogNear: 3000, fogFar: 110000, hor: "#f6c9a0", fogColor: "#e9c29f" } },
  mountains: { kind: "desert", y: 3, x: 0, speed: [2000, 6000], sky: { fogNear: 3000, fogFar: 110000, hor: "#f6c9a0", fogColor: "#e9c29f" }, range: true },
  sky: { kind: "fields", y: 4200, x: 0, speed: [8000, 25000], sky: { top: "#7c82a2", mid: "#b6a6a2", hor: "#e8b98c", below: "#4a4f5c", fogColor: "#c9a98f", fogNear: 3000, fogFar: 40000, sunSize: 1.4 }, clouds: true },
  orbit: { kind: "fields", y: 400e3, x: 0, speed: [28000, 40000], sky: { top: "#173257", mid: "#1d3a60", hor: "#28466c", below: "#0c1828", space: 0.6, haze: 0, sunAmt: 0.9 }, ground: false, earth: true },
  space: { kind: "fields", y: 1e9, x: 0, speed: [1e5, 2e6], sky: { top: "#000", mid: "#000", hor: "#000", below: "#000", space: 1, haze: 0, sunAmt: 0.75, sunSize: 0.5 }, ground: false, stars: true },
};
const COLORS = ["#b8322c", "#2f6b45", "#c9c9cf", "#2b2f3a", "#d9b23a", "#3d5f9c", "#8c8f96"];

const num = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
// a number shown on the HUD: 7.94 · 79.4 · 794 · 12,345
const fmt = (v) => (Math.abs(v) >= 1000 ? commas(v) : sig3(v));
// counts from → to across the scene (log when both > 0 and they differ by 10x+, so escalation reads evenly)
const count = (o, p) => {
  if (str(o.value)) return o.value;
  const a = num(o.from, NaN), b = num(o.to, a);
  if (!isFinite(a)) return "[missing value]";
  const lg = a > 0 && b > 0 && (b / a > 10 || a / b > 10);
  return fmt(lg ? a * (b / a) ** p : a + (b - a) * p);
};

window.POV = {
  mount(mode) {
    const SC = window.__scene || { props: {}, duration: 5, width: 1920, height: 1080, fps: 30 };
    const P = SC.props || {};
    const W = SC.width || 1920, H = SC.height || 1080, D = Math.max(0.1, SC.duration || 5);
    const $ = (id) => document.getElementById(id);
    for (const id of ["gl", "add", "ui"]) Object.assign($(id), { width: W, height: H }), Object.assign($(id).style, { width: W + "px", height: H + "px" });
    const B = BIOMES[P.biome] || BIOMES.city;
    const sp = Array.isArray(P.speed) && P.speed.length ? [num(P.speed[0], B.speed[0]), num(P.speed[1] ?? P.speed[0], B.speed[1])] : B.speed;
    const [u0, u1] = [Math.max(1, sp[0]), Math.max(1, sp[1])];
    const U = (t) => u0 * (u1 / u0) ** clamp(t / D); // km/h, exponential: the escalation
    const L = Math.log(u1 / u0);
    const d0 = 120 + num(P.seed, 0) * 997;
    const Dm = (t) => d0 + (Math.abs(L) < 1e-6 ? (u0 / 3.6) * t : ((u0 / 3.6) * D * ((u1 / u0) ** clamp(t / D) - 1)) / L); // metres
    const rig = P.rig === "bike" ? bikeRig : P.rig === "run" ? runRig : null;
    const range = B.range ? { at: d0 + 9000, depth: 14000, span: 170000, gap: 3500, step: 800 } : null;
    const route = [{ from: 0, kind: B.kind }];
    const cam = P.camera || "forward";
    const ending = mode === "end" ? (P.ending === "card" ? "card" : "whiteout") : null;
    const titleLines = mode === "title" ? (Array.isArray(P.title) ? P.title.map(String).slice(0, 3) : str(P.title) ? [P.title] : ["[missing title]"]) : null;
    let world, post, x, xa;

    window.__ready = Promise.all(["400 64px Newsreader", "italic 400 64px Newsreader", "500 64px Newsreader", "600 64px Newsreader", "700 16px Inter"].map((f) => document.fonts.load(f))).then(() => {
      world = makeWorld({ canvas: $("gl"), width: W, height: H, route, body: rig, range });
      post = makePost(world.renderer, W, H);
      x = $("ui").getContext("2d");
      xa = $("add").getContext("2d");
    });

    const state = (t) => {
      const v = U(t), d = Dm(t), p = clamp(t / D);
      const yaw = cam === "look-back" ? 180 * Math.min(ramp(p, 0.2, 0.4), 1 - ramp(p, 0.7, 0.9)) : 0;
      const pitch = cam === "look-down" ? -36 * Math.min(ramp(p, 0.15, 0.35), 1 - ramp(p, 0.75, 0.95)) : cam === "look-up" ? 28 * Math.min(ramp(p, 0.15, 0.35), 1 - ramp(p, 0.75, 0.95)) : 0;
      const y = B.y * (cam === "rise" ? 1 + 5 * ramp(p, 0, 1) : 1);
      const ground = B.ground !== false;
      const sky = { ...GOLD, ...B.sky };
      const traffic = [];
      if (B.traffic && P.traffic !== false) {
        for (let k = 0; k < 14; k++) traffic.push({ d: d0 + 25 + k * 70 + 9.5 * t, x: B.kind === "highway" ? 9.6 : B.kind === "city" ? 5.1 : 3.0, color: COLORS[(k + 2) % 7], dir: 1 });
        for (let k = 0; k < 14; k++) traffic.push({ d: d0 + 160 + k * 90 - 12 * t, x: B.kind === "highway" ? -5.1 : -2.9, color: COLORS[(k + 4) % 7], dir: -1 });
        if (B.kind === "suburb") for (let k = 0; k < 9; k++) traffic.push({ d: d0 + 30 + k * 26, x: -5.6, color: COLORS[k % 7], dir: -1 });
      }
      const s = {
        cam: { d, x: B.x, y: y + (ground && B.y < 20 ? Math.abs(wob(t * 2.1, 1)) * 0.02 : 0), pitch: pitch + (ground ? -3.5 : 0), yaw, roll: wob(t, 3) * 0.6 * (ground ? 1 : 0.2), fov: 78 + clamp((Math.log(v) - Math.log(300)) / 5) * 6 },
        sky, ground, traffic,
        skyClouds: ground ? { a: 1, drift: t * 0.15, sink: Math.max(0, y - 1.45) * 0.9 } : { a: 0 },
        range,
        clouds: B.clouds ? { y0: 1500, y1: 3400, density: 0.12, cell: 750, size: 460, reach: 30000 } : null,
        earth: B.earth ? { show: true, r: R, below: R + y, ahead: 0, atmo: 0.25, glow: 0.85 * ramp(yaw, 90, 160), tone: "#8fa0bb" } : null,
        globeClouds: B.earth ? { a: 0.8, color: "#e8edf4", y: 2600, tile: 320000 } : null,
        bodies: B.stars ? { sun: { at: [0, 6e9, -1e11], r: 6.957e8, glow: 0.9, glowDeg: 5 } } : {},
        stars: B.stars || B.earth ? { a: B.stars ? 0.95 : 0.5, streak: B.stars ? 0.5 : 0, count: 0.3, flow: t * 200, len: 8, beta: 0, doppler: 0, band: 0.3 } : { a: 0 },
        body: { show: true, t, shake: ground ? clamp((Math.log(v) - Math.log(60)) / 6) * 0.006 : 0, spin: t * 30, look: -pitch, steer: -yaw, phase: t * (6 + Math.min(10, v / 10)), bob: 0 },
      };
      const blooms = B.stars
        ? [{ at: [0, 6e9, -1e11], r: 160 + (ending === "whiteout" ? 1400 * ramp(t / D, 0.1, 0.8) : 0), a: 0.6 + (ending === "whiteout" ? 0.4 * ramp(t / D, 0.1, 0.6) : 0), color: [255, 214, 160] }]
        : [{ at: [0, Math.tan((2.6 * Math.PI) / 180) * 9e4, -9e4], r: 200, a: 0.42, color: [255, 238, 210] }, { at: [0, Math.tan((2.6 * Math.PI) / 180) * 9e4, -9e4], r: 900, a: 0.2, color: [255, 210, 165], sy: 0.42 }];
      if (ground && B.y < 20) blooms.push({ x: W / 2, y: H * 0.74, r: 340, a: 0.14, color: [255, 222, 188], sy: 0.55 });
      const onRoad = ground && B.y < 20;
      s.fx = {
        blur: (onRoad ? clamp((Math.log(v) - Math.log(180)) / (Math.log(9000) - Math.log(180))) * 0.21 : 0) + (B.stars ? 0.1 : 0),
        // sub-frame motion blur (N full renders per frame): off by default, it multiplies the software-GL frame cost
        mblur: P.motionBlur ? (onRoad ? clamp((Math.log(v) - Math.log(25)) / (Math.log(300) - Math.log(25))) : 0.4) : 0,
        heat: onRoad ? clamp((Math.log(v) - Math.log(7000)) / (Math.log(20000) - Math.log(7000))) : 0,
        center: [W / 2, H * 0.48 - pitch * 14],
        glow: 0.16, vignette: 0.55, blooms,
      };
      return s;
    };

    // portrait: the HUD keeps its 16:9 size at the top, the caption sits at the bottom, the title in the middle
    const uiH = Math.min(H, (W * 1080) / 1920);
    const fitCaption = (text, italic, a) => {
      const k = uiH / 1080;
      let size = italic ? 64 : 68;
      x.font = `${italic ? "italic " : ""}400 ${size * k}px ${SERIF}`;
      const w = x.measureText(text).width, max = W * 0.86;
      if (w > max) size *= max / w;
      x.save();
      x.translate(0, H - uiH);
      caption(x, W, uiH, text, a, { italic, size });
      x.restore();
    };

    window.__seek = (t) => {
      const s = state(t);
      const p = clamp(t / D);
      const N = 1 + Math.round(clamp(s.fx.mblur) * 5);
      x.clearRect(0, 0, W, H);
      xa.clearRect(0, 0, W, H);
      if (N > 1) {
        const sh = 0.5 / (SC.fps || 30);
        for (let i = N - 1; i >= 0; i--) {
          world.update(i === 0 ? s : state(t - (sh * i) / (N - 1)));
          world.render();
          post.accumulate(i, N, false);
        }
      } else {
        world.update(s);
        world.render();
      }
      const blooms = s.fx.blooms.map((b) => {
        if (!b.at) return b;
        const q = world.project(...b.at);
        return { ...b, x: q.x, y: q.y, a: q.visible ? b.a : 0 };
      });
      post.finish({ ...s.fx, blooms, grade: { warm: 0.06, sat: 0.94 } }, N > 1);
      world.drawStreaks(xa);

      const cream = ending === "whiteout" ? ramp(p, 0.3, 0.8) : 0;
      wash(x, W, H, "#f4ead8", cream);
      const uiA = 1 - cream;
      // HUD: "speed" (default) shows your speed; an object { label, value | from/to, unit, sub, next } counts; false hides
      const hud = P.hud === undefined ? "speed" : P.hud;
      let left = null;
      if (hud === "speed") {
        const k = speedKmh(U(t));
        left = { label: "YOUR SPEED", num: k.num, unit: k.unit };
      } else if (hud && typeof hud === "object") left = { label: str(hud.label) || "", num: count(hud, p), unit: str(hud.unit) };
      if (left && hud && typeof hud === "object") {
        left.sub = str(hud.sub);
        if (hud.next && str(hud.next.name)) left.next = { name: hud.next.name, value: str(hud.next.value) || (num(hud.next.meters, NaN) >= 0 ? dist(Math.max(0, hud.next.meters - (Dm(t) - d0))) : null) };
      }
      panelLeft(x, uiH, left, uiA);
      if (P.counter && typeof P.counter === "object") panelRight(x, W, uiH, { label: str(P.counter.label) || "", num: count(P.counter, p), sub: str(P.counter.sub) }, uiA);
      if (titleLines) {
        const a = Math.min(ramp(t, 0.3, 1.1), 1 - ramp(t, D - 0.6, D - 0.05));
        x.save();
        x.translate(0, (H - uiH) / 2);
        title(x, W, uiH, titleLines, a, { size: Math.min(82, (82 * W * 0.86) / Math.max(...titleLines.map((l) => (x.font = `600 ${(82 * uiH) / 1080}px ${SERIF}`, x.measureText(l).width)))) });
        x.restore();
      }
      const cap = str(P.caption);
      if (cap) fitCaption(cap, P.upright !== true, Math.min(ramp(t, 0.2, 0.7), 1 - ramp(t, D - 0.55, D - 0.05)) * uiA);
      if (ending === "whiteout") wash(x, W, H, "#000000", p >= 0.86 ? 1 : 0); // the hard cut to black
      if (ending === "card") {
        const lines = Array.isArray(P.lines) ? P.lines.map(String).slice(0, 4) : [str(P.title) || "Thanks for watching"];
        const small = Array.isArray(P.small) ? P.small.map(String).slice(0, 3) : [];
        endCard(x, W, H, lines, small, ramp(p, 0.3, 0.5));
      }
    };
  },
};
