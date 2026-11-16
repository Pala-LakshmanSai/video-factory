"""Shared audio building blocks: buses, reverb, the multi-sample sampler, drums and harmony helpers.

The sampler plays two libraries (see scripts/fetch_samples.py):
  * the orchestral set in assets/samples/hq — Salamander grand piano and VSCO 2 CE strings, brass, harp,
    mallets and percussion, stereo, two velocity layers, round robins;
  * the General-MIDI set (FluidR3_GM) for celesta, music box, choir, pads, vibes, bells, woodblock, applause.
Every orchestral instrument falls back to a General-MIDI one if the orchestral set is missing.
"""
import os, subprocess, itertools
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES = os.path.join(ROOT, 'assets', 'samples')
HQ_DIR = os.path.join(SAMPLES, 'hq')

def t_(d): return np.arange(int(d * SR)) / SR
def lp(x, f, o=2): return sosfilt(butter(o, min(f, SR / 2 * 0.95), 'low', fs=SR, output='sos'), x, axis=0)
def hp(x, f, o=2): return sosfilt(butter(o, f, 'high', fs=SR, output='sos'), x, axis=0)
def bp(x, a, b, o=2): return sosfilt(butter(o, [a, min(b, SR / 2 * 0.95)], 'band', fs=SR, output='sos'), x, axis=0)
def shelf_hi(x, f, g):  # crude high shelf: add/subtract a high-passed copy
    return x + hp(x, f) * (g - 1)
def midi_hz(m): return 440.0 * 2 ** ((m - 69) / 12)
def st(x):
    """mono -> stereo (n, 2)"""
    return x if x.ndim == 2 else np.stack([x, x], 1)

# ---------------------------------------------------------------- buses
class Bus:
    """Stereo accumulation buffer, shape (n, 2)."""
    def __init__(self, seconds): self.x = np.zeros((int(seconds * SR) + SR * 6, 2))
    @property
    def L(self): return self.x[:, 0]
    @property
    def R(self): return self.x[:, 1]
    def add(self, y, at, gain=1.0, pan=0.0):
        if y is None or len(y) == 0: return
        y = st(y); i = int(round(at * SR))
        if i >= len(self.x): return
        if i < 0: y = y[-i:]; i = 0
        j = min(len(self.x), i + len(y)); y = y[:j - i]
        if y.shape[1] == 2 and pan != 0.0:   # balance for stereo sources, constant-power
            a = (pan + 1) * np.pi / 4; gl, gr = np.cos(a) * 1.414, np.sin(a) * 1.414
            self.x[i:j, 0] += (y[:, 0] * min(1, gl) + y[:, 1] * max(0, gl - 1)) * gain
            self.x[i:j, 1] += (y[:, 1] * min(1, gr) + y[:, 0] * max(0, gr - 1)) * gain
        else:
            self.x[i:j] += y * gain
    def add_st(self, L, R, at, gain=1.0): self.add(np.stack([L, R], 1), at, gain)

# ---------------------------------------------------------------- reverb (synthetic hall, frequency-dependent decay)
_IR = {}
def ir(decay=2.2, seed=0, bright=1.0):
    k = (round(decay, 2), seed, bright)
    if k not in _IR:
        rng = np.random.default_rng(11 + seed); n = int(decay * 1.3 * SR); tt = np.arange(n) / SR
        out = np.zeros(n)
        for (a, b, tscale, g) in ((40, 400, 1.15, 1.0), (400, 2500, 1.0, 0.9), (2500, 12000, 0.55 * bright, 0.55 * bright)):
            nz = bp(rng.standard_normal(n), a, b); out += nz * np.exp(-tt * 6.9 / (decay * tscale)) * g
        pre = int(0.018 * SR); out = np.concatenate([np.zeros(pre), out])
        for d, g in ((0.011, 0.5), (0.019, 0.38), (0.027, 0.3), (0.041, 0.22)):  # early reflections
            out[int((d + 0.002 * seed) * SR)] += g * (1 if seed % 2 == 0 else -1)
        att = int(0.008 * SR); out[pre:pre + att] *= np.linspace(0, 1, att)
        _IR[k] = out / np.sqrt(np.sum(out ** 2))
    return _IR[k]

def reverb(x, mix=0.25, decay=2.2, bright=1.0):
    """x (n,2) -> (n,2); wet is full-band convolution of each side with decorrelated IRs."""
    wl = fftconvolve(x[:, 0], ir(decay, 0, bright))[:len(x)]; wr = fftconvolve(x[:, 1], ir(decay, 1, bright))[:len(x)]
    wet = hp(np.stack([wl * 0.78 + wr * 0.22, wr * 0.78 + wl * 0.22], 1), 120)   # partly correlated: keeps the image ~reference width
    return x * (1 - mix * 0.35) + wet * mix

EQ_EDGES = [30 * (16000 / 30) ** (k / 36) for k in range(37)]
EQ_CENTERS = [float(np.sqrt(a * b)) for a, b in zip(EQ_EDGES[:-1], EQ_EDGES[1:])]
def eq_curve(x, gains_db, centers=EQ_CENTERS):
    """zero-phase graphic EQ: gains (dB) at log-spaced band centres, interpolated on log-frequency"""
    if gains_db is None: return x
    n = len(x); N = 1 << int(np.ceil(np.log2(n + SR)))
    f = np.fft.rfftfreq(N, 1 / SR); lf = np.log(np.maximum(f, 1.0))
    g = np.interp(lf, np.log(centers), gains_db, left=gains_db[0], right=gains_db[-1]); G = 10 ** (g / 20)
    X = np.fft.rfft(x, N, axis=0); y = np.fft.irfft(X * G[:, None], N, axis=0)[:n]
    return y

def compress(x, thr=0.25, ratio=3.0, att=0.006, rel=0.12, makeup=1.0):
    """simple RMS-ish feed-forward compressor on a stereo array (vectorised envelope via filtering)."""
    lvl = np.sqrt(np.maximum(lp(np.max(np.abs(x), 1) ** 2, 1 / (2 * np.pi * att * 3)), 1e-12))
    over = np.maximum(lvl / thr, 1.0); g = over ** (1 / ratio - 1)
    g = lp(g, 1 / (2 * np.pi * rel))
    return x * g[:, None] * makeup

# ---------------------------------------------------------------- sampler
GM_SUSTAINED = {'string_ensemble_1', 'synth_strings_1', 'choir_aahs', 'pad_2_warm', 'pad_1_new_age', 'brass_section', 'french_horn', 'flute', 'applause'}
HQ_SUSTAINED = {'violins', 'violas', 'celli', 'basses', 'violins_trem', 'celli_trem', 'horn', 'trombone'}
FALLBACK = {'piano': 'acoustic_grand_piano', 'violins': 'string_ensemble_1', 'violas': 'string_ensemble_1', 'celli': 'string_ensemble_1',
            'basses': 'contrabass', 'violins_trem': 'string_ensemble_1', 'celli_trem': 'string_ensemble_1', 'violins_pizz': 'pizzicato_strings',
            'celli_pizz': 'pizzicato_strings', 'basses_pizz': 'pizzicato_strings', 'violins_spic': 'pizzicato_strings', 'celli_spic': 'pizzicato_strings',
            'harp': 'orchestral_harp', 'glock': 'glockenspiel', 'horn': 'french_horn', 'trombone': 'brass_section', 'timpani': 'timpani',
            'timpani_roll': 'timpani', 'marimba': 'marimba', 'xylo': 'marimba'}
ANCHOR = {'p': 62, 'f': 100}

class Sampler:
    def __init__(self):
        if not os.path.isdir(SAMPLES): raise SystemExit('instrument samples missing — run: python3 scripts/fetch_samples.py')
        self.cache = {}; self.tcache = {}; self.ranges = {}; self.hq = {}; self.rr = {}
        self.has_hq = os.path.isdir(HQ_DIR)
    # -- loading
    def _decode(self, path, ch):
        k = (path, ch)
        if k not in self.cache:
            r = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', str(ch), '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True)
            x = np.frombuffer(r.stdout, dtype=np.float32)
            self.cache[k] = x.reshape(-1, 2) if ch == 2 else x
        return self.cache[k]
    def is_hq(self, inst): return self.has_hq and os.path.isdir(os.path.join(HQ_DIR, inst))
    def _hq_index(self, inst):
        if inst not in self.hq:
            idx = {}
            for f in os.listdir(os.path.join(HQ_DIR, inst)):
                if f.endswith('.mp3'):
                    m, l, r = f[:-4].split('_'); idx.setdefault(int(m), {}).setdefault(l, []).append(f)
            for m in idx:
                for l in idx[m]: idx[m][l].sort()
            self.hq[inst] = idx
        return self.hq[inst]
    def _gm_range(self, inst):
        if inst not in self.ranges:
            d = os.path.join(SAMPLES, inst)
            if not os.path.isdir(d): raise SystemExit(f'instrument "{inst}" not downloaded — run scripts/fetch_samples.py')
            self.ranges[inst] = sorted(int(f[:-4]) for f in os.listdir(d) if f.endswith('.mp3'))
        return self.ranges[inst]
    def _transpose(self, key, x, semis):
        if semis == 0: return x
        k = (key, round(semis, 3))
        if k not in self.tcache:
            ratio = 2 ** (semis / 12); idx = np.arange(0, len(x) - 1, ratio); src = np.arange(len(x))
            y = np.stack([np.interp(idx, src, x[:, c]) for c in range(2)], 1) if x.ndim == 2 else np.interp(idx, src, x)
            self.tcache[k] = y.astype(np.float32)
        return self.tcache[k]
    def raw(self, inst, m, vel=90):
        """stereo sample for midi note m, velocity layer + round robin chosen; returns (array, layer_gain)."""
        if self.is_hq(inst):
            idx = self._hq_index(inst)
            src = min(idx, key=lambda q: (abs(q - m), q < m))       # prefer pitching down (more natural)
            lay = idx[src]; l = 'p' if (vel < 84 and 'p' in lay) else ('f' if 'f' in lay else 'p')
            files = lay[l]; kk = (inst, src, l); i = self.rr.get(kk, 0); self.rr[kk] = i + 1
            path = os.path.join(HQ_DIR, inst, files[i % len(files)]); x = self._decode(path, 2)
            g = (vel / ANCHOR[l]) ** 1.25
            return self._transpose(path, x, m - src), g
        gm = FALLBACK.get(inst, inst)
        ms = self._gm_range(gm); src = min(ms, key=lambda q: abs(q - m)); path = os.path.join(SAMPLES, gm, f'{src}.mp3')
        if (path, 1, 'n') not in self.cache:
            x = self._decode(path, 1).astype(np.float64)
            nz = np.nonzero(np.abs(x) > 1e-4)[0]; x = x[nz[0]:] if len(nz) else x
            self.cache[(path, 1, 'n')] = (x / (np.max(np.abs(x)) + 1e-9) * 0.5).astype(np.float32)
        x = self.cache[(path, 1, 'n')]
        return st(self._transpose(path + '#n', x, m - src)), (vel / 127) ** 1.4 * 1.6
    def sustained(self, inst): return (inst in HQ_SUSTAINED and self.is_hq(inst)) or FALLBACK.get(inst, inst) in GM_SUSTAINED
    def note(self, inst, m, dur, vel=90, release=None, env=None):
        """stereo note: (n, 2). env: None | 'swell' | 'fade' | (a, b) linear gain ramp over the note."""
        x, g = self.raw(inst, m, vel)
        sus = self.sustained(inst)
        rel = release if release is not None else (0.45 if sus else 0.3)
        need = int((dur + rel) * SR)
        if sus and need > len(x) - int(0.5 * SR):               # loop the steady middle with crossfades
            a = int(min(1.6 * SR, 0.35 * len(x))); b = int(len(x) - min(0.9 * SR, 0.15 * len(x))); xf = int(min(0.35 * SR, (b - a) / 3))
            if xf > 0.04 * SR:
                seg = x[a:b]; cur = x[:b]; fade = np.linspace(0, 1, xf)[:, None]
                while len(cur) < need:
                    tail = cur[-xf:] * (1 - fade) + seg[:xf] * fade; cur = np.concatenate([cur[:-xf], tail, seg[xf:]])
                x = cur
        y = np.array(x[:need], dtype=np.float64)
        on = int(dur * SR)
        if on < len(y):
            r = min(int(rel * SR), len(y) - on); y[on:on + r] *= (np.linspace(1, 0, r) ** 1.6)[:, None]; y[on + r:] = 0
        att = int(0.003 * SR); y[:att] *= np.linspace(0, 1, att)[:, None]
        if env is not None:
            n = len(y)
            if env == 'swell': e = np.linspace(0.08, 1, n) ** 1.8
            elif env == 'fade': e = np.linspace(1, 0.1, n)
            else: e = np.linspace(env[0], env[1], n)
            y *= e[:, None]
        return y * g
    def hit(self, inst, vel=100, dur=None):
        """one-shot (unpitched percussion etc.)"""
        x, g = self.raw(inst, 60, vel); y = np.array(x, dtype=np.float64) * g
        if dur: n = int(dur * SR); y = y[:n]; f = min(len(y) // 3, int(0.08 * SR)); y[-f:] *= np.linspace(1, 0, f)[:, None]
        return y

# ---------------------------------------------------------------- synth drums
rng0 = np.random.default_rng(5)
def kick(v=1.0, soft=True):
    t = t_(0.55); f = 46 + (95 if soft else 140) * np.exp(-t * 30)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * (6.5 if soft else 5)); body = np.tanh(body * 1.4) / np.tanh(1.4)
    click = hp(rng0.standard_normal(len(t)), 2500) * np.exp(-t * 350) * (0.12 if soft else 0.22)
    return (body + click) * v
def clap(v=1.0):
    t = t_(0.35); n = rng0.standard_normal(len(t))
    e = sum(np.exp(-np.maximum(t - d, 0) * 70) * (t >= d) for d in (0, 0.009, 0.019, 0.028)) / 4 + np.exp(-np.maximum(t - 0.028, 0) * 16) * (t >= 0.028) * 0.55
    return bp(n, 900, 5000) * e * v * 0.45
def snap(v=1.0): t = t_(0.12); return bp(rng0.standard_normal(len(t)), 1800, 6000) * np.exp(-t * 55) * v * 0.3
def hat(v=1.0, d=0.045): t = t_(d); return bp(rng0.standard_normal(len(t)), 7000, 14000) * np.exp(-t * 95) * v * 0.09
def boom808(v=1.0, f0=80, f1=34, d=1.9):
    t = t_(d); f = f1 + (f0 - f1) * np.exp(-t * 2.4); x = np.sin(2 * np.pi * np.cumsum(f) / SR)
    x = np.tanh(x * 1.8) / np.tanh(1.8) * np.exp(-t * 1.6) * np.minimum(1, t * 400)
    hit = lp(rng0.standard_normal(len(t)), 700) * np.exp(-t * 30) * 0.3
    return (x + hit) * v
def sub_drop(v=1.0, d=2.6):
    t = t_(d); f = 30 + 70 * np.exp(-t * 1.3); x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 0.9) * np.minimum(1, t * 200)
    return np.tanh(x * 1.5) * v

# ---------------------------------------------------------------- harmony
NOTE = {'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11}
QUAL = {'': [0, 4, 7], 'm': [0, 3, 7], 'maj7': [0, 4, 7, 11], 'm7': [0, 3, 7, 10], '7': [0, 4, 7, 10], 'sus2': [0, 2, 7], 'sus4': [0, 5, 7],
        'add9': [0, 4, 7, 14], 'm9': [0, 3, 7, 10, 14], 'dim': [0, 3, 6], '5': [0, 7]}
MAJOR = [0, 2, 4, 5, 7, 9, 11]
def parse(ch):
    if '/' in ch: ch = ch.split('/')[0]
    r = ch[:2] if len(ch) > 1 and ch[1] in '#b' else ch[:1]; return NOTE[r], QUAL[ch[len(r):]]
def slash_bass(ch):
    return NOTE[ch.split('/')[1]] if '/' in ch else parse(ch)[0]
def pcs(ch): root, iv = parse(ch); return {(root + i) % 12 for i in iv}
def voice(ch, lo, hi): p = pcs(ch); return [m for m in range(lo, hi + 1) if m % 12 in p]
def low_note(pc, lo): return lo + ((pc - lo) % 12)
def bass_of(ch, lo=36): return low_note(slash_bass(ch), lo)
def scale_for(ch, key_pc=0):
    s = {(key_pc + i) % 12 for i in MAJOR}; cp = pcs(ch)
    for c in cp:                       # chromatic chord tones (e.g. G# in E major) replace their natural neighbour
        if c not in s: s.discard((c - 1) % 12); s.add(c)
    return s
def lead(prev, ch, n, lo, hi, top=None):
    """voice-led chord of n notes in [lo, hi] close to the previous voicing"""
    cands = voice(ch, lo, hi); root = parse(ch)[0]
    if len(cands) <= n: return cands
    best, bc = None, 1e9
    for combo in itertools.combinations(cands, n):
        if any(b - a < 3 for a, b in zip(combo, combo[1:])): continue
        pc_ = {c % 12 for c in combo}
        if len(pc_) < min(n, 3) or (n >= 3 and root not in pc_ and len(pcs(ch)) <= 3): continue
        cost = sum(abs(a - b) for a, b in zip(combo, prev)) if prev and len(prev) == n else abs(np.mean(combo) - (lo + hi) / 2)
        if top is not None: cost += abs(combo[-1] - top) * 0.6
        if cost < bc: best, bc = combo, cost
    return list(best or cands[:n])
