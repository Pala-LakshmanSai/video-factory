// Shared, deterministic helpers for style templates. Exposed as window.VF.
// No timers, no randomness, no network: every frame is a pure function of t and window.__scene.
(function () {
  "use strict";
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const easings = {
    linear: (p) => p,
    cubicOut: (p) => 1 - Math.pow(1 - p, 3),
    cubicInOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    backOut: (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
  };
  // 0..1 progress of t through [start, start+dur].
  const progress = (t, start, dur) => (dur <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / dur, 0, 1));

  // Binary-search an integer font-size (px) so el.scrollWidth <= maxW and el.scrollHeight <= maxH.
  // el should be a block (or fit-content block with max-width) with height:auto and a unitless line-height.
  // If even minPx overflows, long words are allowed to break so nothing spills sideways.
  function fitText(el, maxW, maxH, maxPx, minPx) {
    let lo = Math.max(1, Math.floor(minPx || 8)), hi = Math.max(lo, Math.floor(maxPx)), best = lo;
    el.style.overflowWrap = "normal";
    const fits = () => el.scrollWidth <= maxW + 1 && el.scrollHeight <= maxH + 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      el.style.fontSize = mid + "px";
      if (fits()) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    el.style.fontSize = best + "px";
    if (!fits()) el.style.overflowWrap = "anywhere";
    return best;
  }

  const DEFAULT_TOKENS = {
    palette: { bg: "#0e1116", fg: "#f5f7fa", accent: "#ffb000", muted: "#8a93a3" },
    fonts: { display: "Inter", body: "Inter", weightDisplay: 800, weightBody: 500 },
    safe: { x: 0.08, y: 0.1 },
    motion: { in: 0.45, out: 0.35, stagger: 0.12, ease: "cubicOut" },
    pacing: { wordsPerSecond: 2.6, minScene: 2.0, maxScene: 9.0 },
  };
  const FALLBACK_FONTS = '"Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR", "Noto Sans CJK", "Noto Color Emoji"';
  const stack = (name, generic) => `"${String(name).replace(/"/g, "")}", ${FALLBACK_FONTS}, ${generic}`;

  // Normalised view of window.__scene with defaults filled in; never throws.
  function scene() {
    const s = (window.__scene && typeof window.__scene === "object") ? window.__scene : {};
    const tk = (s.tokens && typeof s.tokens === "object") ? s.tokens : {};
    const tokens = {};
    for (const k of Object.keys(DEFAULT_TOKENS)) tokens[k] = Object.assign({}, DEFAULT_TOKENS[k], tk[k] || {});
    const width = s.width > 0 ? s.width : window.innerWidth;
    const height = s.height > 0 ? s.height : window.innerHeight;
    const duration = s.duration > 0 ? s.duration : 5;
    const m = tokens.motion;
    // Shrink in/out proportionally when the scene is too short to hold both.
    const k = Math.min(1, (duration * 0.8) / Math.max(1e-6, m.in + m.out));
    const sx = Math.round(width * tokens.safe.x), sy = Math.round(height * tokens.safe.y);
    return {
      props: (s.props && typeof s.props === "object") ? s.props : {},
      tokens, width, height, duration,
      fps: s.fps > 0 ? s.fps : 30, n: s.n || 1, total: s.total || 1,
      narration: typeof s.narration === "string" ? s.narration : "",
      inD: m.in * k, outD: m.out * k, stagger: m.stagger,
      ease: easings[m.ease] || easings.cubicOut,
      box: { x: sx, y: sy, w: width - 2 * sx, h: height - 2 * sy },
      portrait: height > width,
      u: Math.min(width, height) / 100, // 1% of the short side, for decoration sizes
    };
  }

  // Exposes tokens + geometry as CSS variables on :root.
  function applyTokens(S) {
    const p = S.tokens.palette, f = S.tokens.fonts, r = document.documentElement.style;
    const serif = (n) => /serif/i.test(n) && !/sans/i.test(n);
    const vars = {
      "--bg": p.bg, "--fg": p.fg, "--accent": p.accent, "--muted": p.muted,
      "--display": stack(f.display, serif(f.display) ? "serif" : "sans-serif"),
      "--body": stack(f.body, serif(f.body) ? "serif" : "sans-serif"),
      "--wd": f.weightDisplay, "--wb": f.weightBody,
      "--W": S.width + "px", "--H": S.height + "px",
      "--sx": S.box.x + "px", "--sy": S.box.y + "px", "--sw": S.box.w + "px", "--sh": S.box.h + "px",
      "--u": S.u + "px",
    };
    for (const [k, v] of Object.entries(vars)) r.setProperty(k, String(v));
  }

  // Prop helpers: required strings get a visible placeholder instead of throwing.
  const str = (v) => (typeof v === "string" ? v.trim() : (typeof v === "number" ? String(v) : ""));
  const req = (v, name) => str(v) || `[missing ${name}]`;
  const opt = (v, def) => str(v) || def;
  const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

  // Entrance (0→1) starting at `start`, and exit (0→1) over the last outD seconds.
  const enter = (t, S, start) => S.ease(progress(t, start || 0, S.inD));
  const exit = (t, S) => easings.cubicInOut(progress(t, S.duration - S.outD, S.outD));

  // Sets opacity (clamped) and transform from an entrance value a. When a === 1 exactly (every easing
  // ends at exactly 1) both are cleared, so resting elements are not left on composited layers, which
  // keeps resting frames pixel-stable. Overshoot (backOut > 1) still applies the transform.
  function show(el, a, transform) {
    if (!el) return;
    el.style.opacity = a >= 1 ? "" : String(clamp(a, 0, 1));
    el.style.transform = a === 1 ? "" : (transform || "");
  }

  // Wires window.__ready / window.__seek. layout(S) runs once; seek(t, S) must set every animated style.
  function boot(layout, seek) {
    const S = scene();
    applyTokens(S);
    let laid = false;
    const doLayout = () => { if (!laid) { laid = true; layout(S); } };
    window.__seek = (t) => { doLayout(); seek(clamp(Number(t) || 0, 0, S.duration), S); };
    const imgs = Array.from(document.images).map((im) => (im.decode ? im.decode().catch(() => {}) : null));
    window.__ready = Promise.all([document.fonts ? document.fonts.ready : null, ...imgs])
      .then(() => { doLayout(); window.__seek(0); });
    return S;
  }

  window.VF = { easings, clamp, lerp, progress, fitText, scene, applyTokens, str, req, opt, list, enter, exit, show, boot };
})();
