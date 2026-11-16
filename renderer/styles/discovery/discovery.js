// discovery.js — the whole Discovery Documentary look for ONE scene of the Video Factory render engine.
// Every template of this style (title, chapter, photo, map, compare, quote, end) is a thin HTML file that
// loads ../_shared/runtime.js and this file. The engine defines window.__scene before any script runs (props, tokens,
// duration, width, height, fps); this file builds the scene's DOM once and draws every frame in window.__seek(t),
// purely from t and __scene: no timers, no randomness, no network. Media arrives in props as data: URIs only.
//   props.kind      clip · photo · map · compare · black (media shots) · title · chapter · quote · end
//                   (default per template: body data-kind)
//   props.overlays  documentary text over the shot, times RELATIVE to the scene start (at may be < 0 when an
//                   overlay began in the previous scene: tools/plan.mjs splits overlays across cuts)
//   props.captions  burned-in captions (optional), relative times · props.endDim / props.fadeOut: relative times
// tokens.json holds every number (palette, size, grades, safe, low). STYLE.md explains each one.
(function () {
  "use strict";
  const S0 = VF.scene();
  const p = S0.props, W = S0.width, H = S0.height, FPS = S0.fps;
  // VF.scene() keeps only the shared token keys; this style's extras (size, grades, low) come from the raw tokens
  const T = Object.assign({}, (window.__scene && window.__scene.tokens) || {}, S0.tokens);
  const k = Math.min(W / 1920, H / 1080); // the look is specified at 1920×1080
  const C = T.palette, SZ = T.size || {}, GR = T.grades || {}, F = T.fonts;
  const sz = (n) => (SZ[n] || 40) * k;
  const SAFE = { x: Math.round(W * T.safe.x), y: Math.round(H * T.safe.y) };
  const LOW = Math.round(H * (T.low || 0.12));
  // single quotes: these stacks also go inside style="…" attributes
  const FONT = { display: `'${F.display}', serif`, text: `'${F.body}', sans-serif`, quote: `'${F.quote || F.display}', serif` };
  const kind = p.kind || document.body.dataset.kind || "photo";
  const grade = (g, d) => GR[g || d || "doc"] || "none";

  // ─── timing helpers (the same curves the style was designed with) ───
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const ramp = (t, a, b) => (b <= a ? (t >= a ? 1 : 0) : clamp01((t - a) / (b - a)));
  const lerp = (a, b, x) => a + (b - a) * x;
  const logLerp = (a, b, x) => Math.exp(lerp(Math.log(a), Math.log(b), x));
  // cubic-bezier(0.45, 0, 0.55, 1), solved for x by bisection (deterministic)
  const ease = (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bx = (s) => 3 * 0.45 * s * (1 - s) ** 2 + 3 * 0.55 * s * s * (1 - s) + s ** 3;
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; }
    const s = (lo + hi) / 2;
    return 3 * s * s * (1 - s) + s ** 3;
  };
  const PRESETS = {
    in: [[0.5, 0.5, 1.0], [0.5, 0.5, 1.08]], "in-slow": [[0.5, 0.5, 1.0], [0.5, 0.5, 1.04]], "in-fast": [[0.5, 0.5, 1.0], [0.5, 0.5, 1.16]],
    out: [[0.5, 0.5, 1.09], [0.5, 0.5, 1.0]], left: [[0.58, 0.5, 1.1], [0.42, 0.5, 1.1]], right: [[0.42, 0.5, 1.1], [0.58, 0.5, 1.1]],
    up: [[0.5, 0.6, 1.1], [0.5, 0.4, 1.1]], down: [[0.5, 0.4, 1.1], [0.5, 0.6, 1.1]], still: [[0.5, 0.5, 1.02], [0.5, 0.5, 1.035]],
  };
  const moveOf = (m, fb) => (m && typeof m === "object" ? [m.from, m.to] : PRESETS[m] || PRESETS[fb]);
  const moved = (mv, x) => { const e = ease(x); return [lerp(mv[0][0], mv[1][0], e), lerp(mv[0][1], mv[1][1], e), logLerp(mv[0][2], mv[1][2], e)]; };
  // put focus (fx, fy) of an iw×ih picture at the frame centre, zoomed z × cover, never showing an edge
  const frame = (node, iw, ih, fx, fy, z) => {
    const s = Math.max(W / iw, H / ih) * Math.max(1, z), dw = iw * s, dh = ih * s;
    const x = Math.min(0, Math.max(W - dw, W / 2 - fx * dw)), y = Math.min(0, Math.max(H - dh, H / 2 - fy * dh));
    node.style.width = dw + "px"; node.style.height = dh + "px"; node.style.transform = `translate(${x}px, ${y}px)`;
  };

  // ─── DOM ───
  const el = (tag, css, parent, text) => {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    (parent || stage).appendChild(n);
    return n;
  };
  const FILL = "position:absolute;left:0;top:0;width:100%;height:100%;";
  document.documentElement.style.cssText = `margin:0;background:#000;width:${W}px;height:${H}px;overflow:hidden`;
  document.body.style.cssText = `margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#000`;
  const stage = el("div", FILL + "overflow:hidden;background:#000", document.body);
  const isImg = (s) => typeof s === "string" && /^data:image\//.test(s);
  const img = (src, css, parent) => {
    const n = el("img", css, parent);
    if (isImg(src)) n.src = src; // data: URIs only — an http(s) or file path is refused (no network at render time)
    else { n.style.background = "#1a1a1a"; }
    return n;
  };
  const shot = el("div", FILL + "overflow:hidden");
  let draw = () => {};

  // a picture: a clip's frames (or its poster) or a photo, cover-fitted and moved
  const picture = (parent, src, size, mv, g, frames, framesFps, rate) => {
    const [iw, ih] = size || [W, H];
    const wrap = el("div", `position:absolute;left:0;top:0;filter:${g}`, parent);
    const list = Array.isArray(frames) && frames.length ? frames : [src];
    const ims = list.map((f) => img(f, FILL + "object-fit:cover", wrap));
    return (t, x) => {
      const [fx, fy, z] = moved(mv, x);
      frame(wrap, iw, ih, fx, fy, z);
      // a flipbook of pre-extracted frames (tools/plan.mjs --clip-fps): cross-fade neighbours for smooth slow motion
      const q = Math.max(0, t * (rate || 1) * (framesFps || 1));
      const i = Math.min(ims.length - 1, Math.floor(q)), j = Math.min(ims.length - 1, i + 1), a = q - Math.floor(q);
      ims.forEach((m, n) => (m.style.opacity = n === i ? "1" : n === j && j !== i ? String(a) : "0"));
    };
  };
  const bg = (dim, blur, rate) => {
    const box = el("div", FILL + `filter:brightness(${dim}) blur(${blur * k}px)`, shot);
    const inner = el("div", FILL, box);
    const pic = p.src || (p.frames && p.frames[0]) ? picture(inner, p.src, [W, H], PRESETS.still, grade(p.grade), p.frames, p.framesFps, p.rate ?? rate) : null;
    return (t, s) => { inner.style.transform = `scale(${s})`; if (pic) pic(t, 0); };
  };
  const D = S0.duration;

  if (kind === "clip" || kind === "photo") {
    if (kind === "photo" && p.fit === "print") {
      const [iw, ih] = p.size || [W, H];
      img(p.src, `position:absolute;left:${-60 * k}px;top:${-60 * k}px;width:${W + 120 * k}px;height:${H + 120 * k}px;object-fit:cover;filter:blur(${28 * k}px) brightness(0.35) ${grade(p.grade)}`, shot);
      const c = el("div", FILL + "display:flex;align-items:center;justify-content:center", shot);
      const fitS = Math.min((W * 0.62) / iw, (H * 0.78) / ih, 1.35 * k);
      const m = el("div", `padding:${14 * k}px;background:#efe6d2;box-shadow:0 ${30 * k}px ${80 * k}px rgba(0,0,0,0.7)`, c);
      img(p.src, `display:block;width:${iw * fitS}px;height:${ih * fitS}px;filter:${grade(p.grade)}`, m);
      draw = (t) => (c.style.transform = `scale(${logLerp(1, 1.1, ease(t / D))})`);
    } else {
      const pic = picture(shot, p.src, kind === "clip" ? [W, H] : p.size, moveOf(p.move, kind === "clip" ? "in-slow" : "in"), grade(p.grade), p.frames, p.framesFps, p.rate);
      draw = (t) => pic(t, t / D);
    }
  } else if (kind === "map") {
    const m = p.map || {};
    const merc = (lon, lat, z) => { const n = 256 * 2 ** z, r = (lat * Math.PI) / 180; return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n]; };
    shot.style.background = "#071019";
    const layer = (im) => im && img(im.src, "position:absolute;left:0;top:0;filter:saturate(0.85) contrast(1.05) brightness(0.92)", shot);
    const wide = layer(m.wide), close = layer(m.close);
    el("div", FILL + "background:radial-gradient(ellipse 70% 65% at 50% 50%, rgba(0,0,0,0) 45%, rgba(3,8,14,0.55) 100%)", shot);
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", W); svg.setAttribute("height", H); svg.style.cssText = "position:absolute;left:0;top:0";
    shot.appendChild(svg);
    const line = document.createElementNS(svgNS, "polyline");
    line.setAttribute("fill", "none"); line.setAttribute("stroke", C.gold); line.setAttribute("stroke-width", 6 * k);
    line.setAttribute("stroke-linecap", "round"); line.setAttribute("stroke-linejoin", "round");
    line.style.filter = "drop-shadow(0 0 6px rgba(224,173,76,0.8))";
    svg.appendChild(line);
    const pinLayer = el("div", FILL, shot);
    const label = m.label ? el("div", `position:absolute;left:${SAFE.x}px;top:${SAFE.y}px;padding:${10 * k}px ${24 * k}px;background:${C.panel};border-left:${4 * k}px solid ${C.gold};font-family:${FONT.display};font-weight:700;font-size:${sz("mapLabel")}px;color:${C.cream};letter-spacing:0.12em;text-transform:uppercase`, shot, m.label) : null;
    const wz = m.wide ? m.wide.z : 5;
    const [z0, z1] = m.zoom || [0.55, m.close ? 2 ** (m.close.z - wz) * 0.6 : 1.1];
    draw = (t) => {
      const sc = logLerp(z0, z1, ease(ramp(t, 0.2, Math.max(1.5, D - 0.6)))) * k;
      const [cx, cy] = merc(m.lon, m.lat, wz);
      const toScreen = (lon, lat) => { const [px, py] = merc(lon, lat, wz); return [W / 2 + (px - cx) * sc, H / 2 + (py - cy) * sc]; };
      const place = (node, im) => {
        if (!node) return;
        const s2 = sc / 2 ** (im.z - wz), [ix, iy] = merc(m.lon, m.lat, im.z);
        node.style.width = im.w * s2 + "px"; node.style.height = im.h * s2 + "px";
        node.style.transform = `translate(${W / 2 - (ix - im.x0) * s2}px, ${H / 2 - (iy - im.y0) * s2}px)`;
      };
      place(wide, m.wide); place(close, m.close);
      if (close) { const f = 2 ** (m.close.z - wz) * k; close.style.opacity = String(ramp(sc, f * 0.18, f * 0.32)); }
      const route = (m.route || []).map(([lo, la]) => toScreen(lo, la));
      let len = 0;
      for (let i = 1; i < route.length; i++) len += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
      line.setAttribute("points", route.map((q) => q.join(",")).join(" "));
      line.setAttribute("stroke-dasharray", len); line.setAttribute("stroke-dashoffset", len * (1 - ramp(t, 0.6, Math.min(D - 0.5, 3.5))));
      line.style.display = route.length > 1 ? "" : "none";
      pinLayer.innerHTML = (m.pins || []).map((pn) => {
        const [x, y] = toScreen(pn.lon, pn.lat), a = ramp(t, pn.at ?? 0.5, (pn.at ?? 0.5) + 0.5), pulse = (t * 0.8) % 1, left = pn.side === "left";
        return `<div style="position:absolute;left:${x}px;top:${y}px;opacity:${a}">
          <div style="position:absolute;width:${90 * k}px;height:${90 * k}px;left:${-45 * k}px;top:${-45 * k}px;border-radius:50%;border:${3 * k}px solid ${C.pin};transform:scale(${0.3 + pulse});opacity:${1 - pulse}"></div>
          <div style="position:absolute;width:${22 * k}px;height:${22 * k}px;left:${-11 * k}px;top:${-11 * k}px;border-radius:50%;background:${C.pin};box-shadow:0 0 ${18 * k}px ${C.pin}"></div>
          <div style="position:absolute;top:${-40 * k}px;${left ? "right" : "left"}:${34 * k}px;white-space:nowrap;text-align:${left ? "right" : "left"};padding:${10 * k}px ${22 * k}px;background:${C.panel};border-${left ? "right" : "left"}:${4 * k}px solid ${C.gold}">
            <div style="font-family:${FONT.display};font-weight:700;font-size:${sz("mapLabel")}px;color:${C.cream};letter-spacing:0.04em;line-height:1.1;text-transform:uppercase">${esc(pn.label)}</div>
            ${pn.sub ? `<div style="font-family:${FONT.text};font-weight:500;font-size:${sz("mapSmall")}px;color:${C.muted};margin-top:${4 * k}px">${esc(pn.sub)}</div>` : ""}
          </div></div>`;
      }).join("");
      if (label) label.style.opacity = String(ramp(t, 0.3, 0.9));
    };
  } else if (kind === "compare") {
    const side = (parent, src, size, g, frames, framesFps) => picture(parent, src, size, [[0.5, 0.5, 1.02], [0.5, 0.5, 1.08]], grade(g), frames, framesFps, 1);
    const a = side(shot, p.src, p.src && p.size ? p.size : [W, H], p.grade || "archival", p.frames, p.framesFps);
    const right = el("div", FILL, shot);
    const b = side(right, p.src2, p.size2 || [W, H], p.grade2 || "doc", p.frames2, p.framesFps);
    const bar = el("div", `position:absolute;top:0;width:${4 * k}px;height:${H}px;background:${C.gold};box-shadow:0 0 ${18 * k}px ${C.gold}`, shot);
    const [l1, l2] = p.labels || ["THEN", "NOW"];
    const tag = (text, left) => el("div", `position:absolute;top:${SAFE.y}px;left:${left}px;transform:translateX(-50%);padding:${8 * k}px ${26 * k}px;background:${C.panel};border-bottom:${3 * k}px solid ${C.gold};font-family:${FONT.text};font-weight:800;font-size:${sz("placeSub")}px;color:${C.cream};letter-spacing:0.12em;white-space:nowrap`, shot, text);
    const t1 = tag(l1, W / 4), t2 = tag(l2, (W * 3) / 4);
    const sweepEnd = Math.min(2.4, Math.max(1.2, D * 0.4));
    draw = (t) => {
      a(t, t / D); b(t, t / D);
      const split = lerp(W, W / 2, ease(ramp(t, 0.4, sweepEnd)));
      right.style.clipPath = `inset(0 0 0 ${split}px)`;
      bar.style.left = split - 2 * k + "px"; bar.style.opacity = split < W - 2 ? "1" : "0";
      t1.style.opacity = t2.style.opacity = String(ramp(t, sweepEnd - 0.2, sweepEnd + 0.4));
    };
  } else if (kind === "title" || kind === "chapter" || kind === "quote") {
    const cfg = { title: [0.42, 0, 1.04, 0.04], chapter: [0.38, 2, 1.03, 0.03], quote: [0.3, 6, 1.05, 0.03] }[kind];
    const b = bg(cfg[0], cfg[1], 0.7);
    const box = el("div", FILL + `display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;padding:0 ${kind === "quote" ? SAFE.x * 2.4 : SAFE.x}px`, shot);
    const maxW = W - 2 * (kind === "quote" ? SAFE.x * 2.4 : SAFE.x);
    let main, sub, rule;
    if (kind === "title") {
      if (p.kicker) el("div", `font-family:${FONT.text};font-weight:700;font-size:${sz("titleKicker")}px;color:${C.gold};letter-spacing:0.32em;margin-bottom:${26 * k}px;text-transform:uppercase`, box, p.kicker);
      main = el("div", `font-family:${FONT.display};font-weight:800;color:${C.cream};letter-spacing:0.06em;text-align:center;line-height:1.05;max-width:${maxW}px;text-transform:uppercase;text-shadow:0 6px 40px rgba(0,0,0,0.85)`, box, VF.req(p.text, "text"));
      rule = el("div", `height:${3 * k}px;background:linear-gradient(90deg, transparent, ${C.gold}, transparent);margin-top:${34 * k}px`, box);
    } else if (kind === "chapter") {
      el("div", `font-family:${FONT.text};font-weight:700;font-size:${sz("chapterNum")}px;color:${C.gold};letter-spacing:0.4em;margin-bottom:${22 * k}px`, box, p.num || "");
      main = el("div", `font-family:${FONT.display};font-weight:700;color:${C.cream};letter-spacing:0.05em;text-align:center;max-width:${maxW}px;text-transform:uppercase;text-shadow:0 4px 30px rgba(0,0,0,0.9)`, box, VF.req(p.text, "text"));
    } else {
      main = el("div", `font-family:${FONT.quote};font-style:italic;font-weight:500;color:${C.cream};line-height:1.32;text-align:center;text-shadow:0 3px 24px rgba(0,0,0,0.9)`, box, `“${VF.req(p.text, "text")}”`);
      if (p.by) sub = el("div", `font-family:${FONT.text};font-weight:700;font-size:${sz("quoteBy")}px;color:${C.gold};margin-top:${36 * k}px;letter-spacing:0.06em`, box, `— ${p.by}`);
    }
    const big = { title: "title", chapter: "chapter", quote: "quote" }[kind];
    VF.fitText(main, maxW, H * 0.5, sz(big), sz("MIN")); // never clipped; shrinks only when the line is too long
    draw = (t) => {
      if (kind === "title") {
        const a = ramp(t, 0.5, 1.6), out = 1 - ramp(t, D - 0.7, D);
        b(t, 1.04 + 0.04 * (t / D));
        box.style.opacity = String(a * out); box.style.transform = `scale(${1 + 0.03 * (t / D)})`;
        rule.style.width = 520 * k * a + "px";
      } else if (kind === "chapter") {
        b(t, 1.03 + 0.03 * (t / D));
        box.style.opacity = String(ramp(t, 0.35, 1.2) * (1 - ramp(t, D - 0.6, D)));
      } else {
        b(t, 1.05 + 0.03 * (t / D));
        box.style.opacity = String(ramp(t, 0.3, 1.0));
        if (sub) sub.style.opacity = String(ramp(t, 0.9, 1.5));
      }
    };
  } else if (kind === "end") {
    // the YouTube end screen: a calm wide picture, dimmed so the end cards read, no text
    const pic = p.src || p.frames ? picture(shot, p.src, p.size || [W, H], moveOf(p.move, "still"), grade(p.grade), p.frames, p.framesFps, p.rate) : null;
    draw = (t) => { if (pic) pic(t, t / D); };
  } // "black": nothing

  // ─── finish: vignette + one static grain plate that drifts a few pixels (no per-frame noise) ───
  let grainBox = null;
  if (kind !== "black") {
    const s = kind === "map" ? 0.6 : 1;
    el("div", FILL + `background:radial-gradient(ellipse 75% 70% at 50% 48%, rgba(0,0,0,0) 55%, rgba(0,0,0,${0.5 * s}) 100%)`);
    grainBox = el("div", FILL + `opacity:${0.05 * s};mix-blend-mode:overlay`);
    grainBox.innerHTML = `<svg width="${W}" height="${H}"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="${W}" height="${H}" filter="url(#grain)"/></svg>`;
  }
  if (p.credit) el("div", `position:absolute;right:${SAFE.x}px;top:${SAFE.y}px;padding:${4 * k}px ${12 * k}px;background:rgba(8,10,13,0.6);font-family:${FONT.text};font-weight:500;font-size:${sz("source")}px;color:${C.muted}`, stage, p.credit);
  if (p.recon) el("div", `position:absolute;left:${SAFE.x}px;top:${SAFE.y}px;padding:${6 * k}px ${16 * k}px;background:rgba(8,10,13,0.72);border-left:${4 * k}px solid ${C.red};font-family:${FONT.text};font-weight:700;font-size:${sz("source") + 4 * k}px;color:${C.cream};letter-spacing:0.08em`, stage, String(p.recon).toUpperCase());

  // ─── overlays + captions: redrawn from t every frame (text only, no images) ───
  function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
  const ovLayer = el("div", FILL);
  const capLayer = el("div", FILL);
  const endLayer = el("div", FILL + "background:#000;opacity:0");
  const overlay = (o, t) => {
    const a = ramp(t, 0, 0.45) * (1 - ramp(t, o.dur - 0.4, o.dur));
    const rise = (1 - ease(ramp(t, 0, 0.6))) * 14 * k;
    const box = `position:absolute;opacity:${a};transform:translateY(${rise}px);`;
    const txt = (w, size, color) => `font-family:${FONT.text};font-weight:${w};font-size:${size}px;color:${color};`;
    if (o.kind === "place") {
      return `<div style="${FILL}opacity:${a};background:linear-gradient(20deg, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.35) 34%, rgba(0,0,0,0) 55%)"></div>
        <div style="${box}left:${SAFE.x}px;bottom:${LOW}px;padding:${16 * k}px ${28 * k}px ${18 * k}px;background:rgba(8,10,13,0.62)">
          <div style="width:${120 * k * ramp(t, 0.15, 0.9)}px;height:${4 * k}px;background:${C.gold};margin-bottom:${16 * k}px"></div>
          <div style="font-family:${FONT.display};font-weight:700;font-size:${sz("place")}px;color:${C.cream};letter-spacing:0.07em;line-height:1.05;text-transform:uppercase;text-shadow:0 2px 14px rgba(0,0,0,0.8)">${esc(o.text)}</div>
          ${o.sub ? `<div style="${txt(600, sz("placeSub"), C.parchment)}margin-top:${10 * k}px;letter-spacing:0.05em;text-shadow:0 2px 10px rgba(0,0,0,0.9)">${esc(o.sub)}</div>` : ""}
        </div>`;
    }
    if (o.kind === "fact") {
      const right = o.pos === "right", center = o.pos === "center", big = o.big ?? "";
      const pos = center ? "left:0;right:0;align-items:center;text-align:center;" : right ? `right:${SAFE.x * 1.6}px;align-items:flex-end;text-align:right;max-width:${W * 0.46}px;` : `left:${SAFE.x * 1.6}px;max-width:${W * 0.46}px;`;
      return `<div style="${FILL}opacity:${a};background:${center ? "rgba(0,0,0,0.5)" : `linear-gradient(${right ? 270 : 90}deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.5) 38%, rgba(0,0,0,0) 62%)`}"></div>
        <div style="${box}top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;${pos}">
          <div style="${txt(800, big.length > 9 ? sz("factBig") * 0.72 : sz("factBig"), C.gold)}line-height:1;letter-spacing:-0.01em;text-shadow:0 4px 30px rgba(0,0,0,0.7)">${esc(big)}</div>
          <div style="${txt(600, sz("factSmall"), C.cream)}margin-top:${18 * k}px;line-height:1.2;text-shadow:0 2px 12px rgba(0,0,0,0.9)">${esc(o.text)}</div>
        </div>`;
    }
    if (o.kind === "key") {
      return `<div style="${box}left:0;right:0;bottom:${LOW}px;display:flex;justify-content:center">
        <div style="max-width:${W * 0.72}px;padding:${18 * k}px ${40 * k}px;background:${C.panel};border-top:${3 * k}px solid ${C.gold};${txt(700, sz("keyLine"), C.cream)}text-align:center;line-height:1.2">${esc(o.text)}</div></div>`;
    }
    if (o.kind === "source") {
      return `<div style="${box}right:${SAFE.x}px;bottom:${LOW}px;padding:${8 * k}px ${18 * k}px;background:rgba(8,10,13,0.62);${txt(500, sz("source"), C.muted)}"><span style="color:${C.gold};font-weight:700">SOURCE </span>${esc(o.text)}</div>`;
    }
    if (o.kind === "tag") {
      const record = /record|fact|documented/i.test(o.text);
      return `<div style="${box}left:${SAFE.x}px;top:${SAFE.y}px;padding:${8 * k}px ${22 * k}px;background:${C.panel};border-left:${5 * k}px solid ${record ? C.teal : C.gold};${txt(800, sz("placeSub"), C.cream)}letter-spacing:0.14em">${esc(String(o.text).toUpperCase())}${o.sub ? `<div style="font-weight:500;font-size:${sz("mapSmall")}px;color:${C.muted};letter-spacing:0.02em;margin-top:${2 * k}px">${esc(o.sub)}</div>` : ""}</div>`;
    }
    if (o.kind === "circle") {
      const cx = (o.x ?? 960) * k, cy = (o.y ?? 540) * k, r = (o.r ?? 120) * k, circ = 2 * Math.PI * r, d = ease(ramp(t, 0.1, 0.9)), right = (o.pos ?? "right") === "right";
      return `<div style="${FILL}opacity:${a * 0.55};background:radial-gradient(circle ${r * 1.6}px at ${cx}px ${cy}px, rgba(0,0,0,0) 60%, rgba(0,0,0,0.75) 100%)"></div>
        <svg width="${W}" height="${H}" style="position:absolute;left:0;top:0;opacity:${a}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.gold}" stroke-width="${7 * k}" stroke-linecap="round" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - d)}" transform="rotate(-110 ${cx} ${cy})" style="filter:drop-shadow(0 0 8px rgba(224,173,76,0.9))"/></svg>
        <div style="${box}top:${cy - 40 * k}px;${right ? `left:${cx + r + 30 * k}px;border-left:${4 * k}px solid ${C.gold}` : `right:${W - (cx - r - 30 * k)}px;border-right:${4 * k}px solid ${C.gold}`};padding:${10 * k}px ${24 * k}px;background:${C.panel};white-space:nowrap;opacity:${a * ramp(t, 0.6, 1.1)}">
          <div style="${txt(700, sz("mapLabel"), C.cream)}">${esc(o.text)}</div>${o.sub ? `<div style="${txt(500, sz("mapSmall"), C.muted)}margin-top:${4 * k}px">${esc(o.sub)}</div>` : ""}</div>`;
    }
    // timeline: a gold line across the lower third, labelled ticks, one lit point
    const x0 = SAFE.x * 2, x1 = W - SAFE.x * 2, y = H - LOW - 90 * k, dr = ease(ramp(t, 0.2, 1.4));
    const pts = (o.points || []).map((pt, i) => {
      const px = x0 + (x1 - x0) * pt.x, on = i === o.hi, pa = ramp(t, 0.3 + 1.1 * pt.x, 0.6 + 1.1 * pt.x), d = (on ? 28 : 18) * k;
      return `<div style="position:absolute;left:${px}px;top:${y}px;opacity:${pa}"><div style="position:absolute;left:${-d / 2}px;top:${-d / 2 + 2 * k}px;width:${d}px;height:${d}px;border-radius:50%;background:${on ? C.gold : C.cream};box-shadow:${on ? `0 0 ${20 * k}px ${C.gold}` : "none"}"></div>
        <div style="position:absolute;transform:translateX(-50%);top:${34 * k}px;white-space:nowrap;${txt(on ? 800 : 600, on ? sz("placeSub") + 4 * k : sz("mapSmall"), on ? C.gold : C.cream)}">${esc(pt.label)}</div></div>`;
    }).join("");
    return `<div style="${FILL}opacity:${a};background:linear-gradient(0deg, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.45) 30%, rgba(0,0,0,0) 52%)"></div>
      <div style="${box}left:0;top:0;width:${W}px;height:${H}px">
        <div style="position:absolute;left:${x0}px;top:${y}px;width:${(x1 - x0) * dr}px;height:${4 * k}px;background:${C.gold};opacity:0.9"></div>${pts}
        <div style="position:absolute;left:${x0}px;top:${y - 110 * k}px;font-family:${FONT.display};font-weight:700;font-size:${sz("placeSub") + 6 * k}px;color:${C.cream};letter-spacing:0.06em;text-transform:uppercase">${esc(o.text)}</div></div>`;
  };

  VF.boot(() => {}, (t) => {
    draw(t);
    if (grainBox) { const f = Math.round(t * FPS); grainBox.style.transform = `translate(${Math.round(6 * Math.sin(f * 0.07)) * k}px, ${Math.round(5 * Math.cos(f * 0.05)) * k}px) scale(1.02)`; }
    ovLayer.innerHTML = (p.overlays || []).filter((o) => t >= o.at && t < o.at + o.dur).map((o) => overlay(o, t - o.at)).join("");
    const c = (p.captions || []).find((q) => t >= q.t && t < q.end);
    capLayer.innerHTML = c ? `<div style="position:absolute;left:0;right:0;bottom:${LOW}px;display:flex;justify-content:center"><div style="max-width:${W * 0.7}px;padding:${8 * k}px ${26 * k}px;background:rgba(0,0,0,0.72);font-family:${FONT.text};font-weight:600;font-size:${sz("caption")}px;color:#fff;text-align:center;line-height:1.22">${esc(c.text)}</div></div>` : "";
    // the end screen dims to 55 %, then the film fades to black over its last 1.2 s
    const dim = p.endDim != null ? 0.45 * ramp(t, p.endDim, p.endDim + 1.5) : 0;
    const fade = p.fadeOut != null ? ramp(t, p.fadeOut, p.fadeOut + 1.1) : 0;
    endLayer.style.opacity = String(Math.max(dim, fade));
  });
})();
