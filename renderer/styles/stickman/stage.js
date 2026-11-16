// stage.js — shared stage for every stickman template. Each template is one 1920×1080 canvas (the kit's world), drawn by
// a pure function draw(x, t, frame, S) from window.SK (kit.js); hard cuts, no exit animation (the kit's editing rule). 16:9 is native; other frames are fitted with black around.
// Defines window.__ready (fonts + data: images decoded) and window.__seek(t). No network, no randomness (SK.rnd is seeded).
window.stickman = (draw, images = []) => {
  const SK = window.SK;
  const S0 = window.__scene || {};
  const S = {
    props: S0.props && typeof S0.props === "object" ? S0.props : {},
    duration: S0.duration > 0 ? S0.duration : 5,
    width: S0.width > 0 ? S0.width : 1920,
    height: S0.height > 0 ? S0.height : 1080,
    fps: S0.fps > 0 ? S0.fps : 24,
    img: {},
  };
  document.documentElement.style.cssText = "margin:0;background:#000;overflow:hidden";
  document.body.style.cssText = `margin:0;width:${S.width}px;height:${S.height}px;overflow:hidden;background:#000`;
  const cv = document.createElement("canvas");
  cv.width = 1920;
  cv.height = 1080;
  const k = Math.min(S.width / 1920, S.height / 1080);
  cv.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:translate(${(S.width - 1920 * k) / 2}px,${(S.height - 1080 * k) / 2}px) scale(${k})`;
  document.body.appendChild(cv);
  const x = cv.getContext("2d");
  const fonts = ['700 20px "Inter"', '800 20px "Inter"', 'italic 800 20px "Inter"'].map((f) => document.fonts.load(f).catch(() => {}));
  const pics = images.map((key) => {
    const src = S.props[key];
    if (typeof src !== "string" || !src.startsWith("data:image/")) return null; // never http(s): no network at render
    const im = new Image();
    im.src = src;
    return im.decode().then(() => (S.img[key] = im), () => {});
  });
  window.__ready = Promise.all([...fonts, ...pics]);
  window.__seek = (t) => {
    t = Math.min(Math.max(Number(t) || 0, 0), S.duration);
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1;
    x.filter = "none";
    x.clearRect(0, 0, 1920, 1080);
    const after = draw(x, t, Math.round(t * S.fps), S); // may return a function drawn over the letterbox (credits)
    SK.finish(x, Math.round(t * 24), 0.55, 0.035);
    if (typeof after === "function") after();
  };
  return S;
};

// helpers shared by the templates
window.SM = {
  str: (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""),
  req(v, name) {
    return this.str(v) || `[missing ${name}]`;
  },
  list(v) {
    return Array.isArray(v) ? v.map((s) => this.str(s)).filter(Boolean) : [];
  },
  /** largest font size ≤ max (step 2) at which str fits maxW on one line */
  fit(x, str, maxW, max, min = 18, weight = 800, track = 0) {
    let s = max;
    for (; s > min; s -= 2) {
      x.font = `${weight} ${s}px "Inter", sans-serif`;
      x.letterSpacing = `${track * s}px`;
      if (x.measureText(str).width <= maxW) break;
    }
    x.letterSpacing = "0px";
    return s;
  },
  /** word-wrap str into ≤ lines lines of maxW, shrinking from max; returns { size, rows } */
  wrap(x, str, maxW, lines, max, min = 22) {
    for (let s = max; ; s -= 2) {
      x.font = `800 ${s}px "Inter", sans-serif`;
      x.letterSpacing = "0px";
      const rows = [];
      let row = "";
      for (const w of str.split(/\s+/)) {
        const tryRow = row ? `${row} ${w}` : w;
        if (row && x.measureText(tryRow).width > maxW) {
          rows.push(row);
          row = w;
        } else row = tryRow;
      }
      if (row) rows.push(row);
      if ((rows.length <= lines && rows.every((r) => x.measureText(r).width <= maxW)) || s <= min) return { size: s, rows };
    }
  },
  ACCENT: { teal: "#2f9c94", red: "#d23b45", gold: "#f4b748", blue: "#4fa3ff" },
  accent(v, i) {
    return this.ACCENT[v] || ["#2f9c94", "#f4b748", "#d23b45"][i % 3];
  },
};
