#!/usr/bin/env python3
"""Soundtrack for blocky What-If episodes: original chapter score + sound effects + ambience, mixed and
mastered from the episode timeline.

What the reference does (measured from its top videos with spectrograms / chroma, see references/04):
  * no voiceover; a produced score on real-sounding instruments, a different cue per chapter
  * ~0.4 s of near-silence before each chapter, landing on a deep boom with a falling pitch
  * crystal sparkle runs on reveals, glock "level up" stings, whooshes on transitions, crowd / wind beds

The score is written by scripts/cues.py and played on recorded instruments (Salamander piano, VSCO 2 CE
strings / brass / harp / mallets / percussion, FluidR3 colours); see scripts/fetch_samples.py.

Usage: python3 scripts/audio.py EPISODE.json OUT.wav [--from S] [--to S] [--stems DIR] [--cue MOOD SECONDS]
"""
import json, sys, os, subprocess, wave
import numpy as np
from scipy.ndimage import minimum_filter1d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audio_lib import SR, Bus, Sampler, t_, lp, hp, bp, st, kick, clap, snap, hat, boom808, sub_drop, compress, reverb, rng0
from cues import compose, CUES, ALIASES

# ---------------------------------------------------------------- sound effects
class SFX:
    """make(name, v) -> (stereo array, pan, offset). offset < 0 means the sound should start earlier than t."""
    def __init__(self, smp): self.s = smp
    def _mix(self, n, parts):
        out = np.zeros((int(n * SR), 2))
        for at, x, g in parts:
            x = st(x); i = int(at * SR); j = min(len(out), i + len(x))
            if i < len(out): out[i:j] += x[:j - i] * g
        return out
    def make(self, name, v=1.0):
        s = self.s; R = np.random.default_rng(abs(hash(name)) % 1000 + 3)
        if name == 'boom':        # chapter hit: 808 with a falling pitch + concert bass drum + low timpani
            parts = [(0, boom808(1.0, 80, 33, 2.2), 0.85), (0, s.hit('bassdrum', 112), 0.9), (0, s.note('timpani', 36, 1.6, 112, 0.9), 0.55)]
            return self._mix(2.6, parts) * v, 0.0, 0.0
        if name == 'impact':
            x, _, _ = self.make('boom', 1.0)
            parts = [(0, x, 1.0), (0, s.hit('crash', 110), 0.35), (0, sub_drop(0.5, 2.4), 1.0)]
            return self._mix(5, parts) * v, 0.0, 0.0
        if name == 'sparkle':     # bell tree stroke + descending celesta / glock run
            parts = [(0, s.hit('bell_tree', 90), 0.55)]
            for i, m in enumerate([108, 105, 103, 100, 98, 96, 93, 91, 88, 86]):
                parts.append((0.05 + i * 0.038, s.note('celesta', m, 0.7, 70 - i * 3, 0.8), 0.7))
                if i % 2 == 0: parts.append((0.05 + i * 0.038, s.note('glock', m - 12, 0.5, 64, 0.6), 0.25))
            return self._mix(3.2, parts) * v, 0.3, 0.0
        if name == 'levelup':     # glockenspiel arpeggio + harp flourish + triangle
            parts = [(i * 0.07, s.note('glock', m, 0.8, 96, 0.8), 0.75) for i, m in enumerate([84, 88, 91, 96])]
            parts += [(i * 0.03, s.note('harp', m, 1.0, 70, 0.8), 0.3) for i, m in enumerate([72, 76, 79, 84, 88, 91])]
            parts.append((0.21, s.hit('triangle', 80), 0.25))
            return self._mix(3.0, parts) * v, 0.25, 0.0
        if name == 'leveldown':   # low piano fall + cello spiccato thud + soft boom
            parts = [(i * 0.13, s.note('piano', m, 1.5, 100, 0.7), 0.8) for i, m in enumerate([64, 60, 57, 52])]
            parts += [(0, s.note('celli_spic', 40, 0.4, 104), 0.5), (0, boom808(0.22, 62, 30, 1.2), 1.0)]
            return self._mix(3.0, parts) * v, -0.1, 0.0
        if name == 'clock':
            parts = [(0, s.note('tubular_bells', 60, 3.0, 112, 1.2), 1.0), (0.02, s.note('tubular_bells', 55, 3.0, 100, 1.2), 0.8), (0, s.hit('bassdrum', 80), 0.35)]
            return self._mix(4.4, parts) * v, 0.0, 0.0
        if name == 'pop':         # bubble / pill: soft pitched blip + woodblock body
            t = t_(0.12); f = 500 + 900 * (1 - np.exp(-t * 45)); blip = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 38) * 0.35
            parts = [(0, blip, 1.0), (0, s.note('woodblock', 72, 0.1, 70, 0.08), 0.35)]
            return self._mix(0.4, parts) * v, 0.15, 0.0
        if name == 'tick':
            t = t_(0.03); return st(np.sin(2 * np.pi * 2600 * t) * np.exp(-t * 220) * 0.35) * v, 0.2, 0.0
        if name == 'cash':        # register ding: two glock notes + sleigh bells shimmer
            parts = [(0, s.note('glock', 96, 0.6, 100), 0.7), (0.07, s.note('glock', 100, 0.9, 104), 0.8), (0, s.hit('sleigh', 90), 0.35)]
            return self._mix(1.8, parts) * v, 0.25, 0.0
        if name == 'notify':
            parts = [(0, s.note('vibraphone', 79, 0.5, 100), 1.0), (0.11, s.note('vibraphone', 86, 0.7, 100), 1.0)]
            return self._mix(1.4, parts) * v, 0.2, 0.0
        if name in ('whoosh', 'swoosh'):
            d = 0.8 if name == 'whoosh' else 0.38; t = t_(d); n = rng0.standard_normal(len(t)); y = np.zeros_like(n)
            f = np.geomspace(300, 3800, len(t)) if name == 'whoosh' else np.geomspace(1400, 6500, len(t))
            for i in range(0, len(n), 512): y[i:i + 512] = bp(n[i:i + 512], f[i] * 0.6, f[i] * 1.5)
            env = np.sin(np.pi * t / d) ** 2; pan = np.linspace(-0.6, 0.6, len(t))
            out = np.stack([y * env * np.cos((pan + 1) * np.pi / 4), y * env * np.sin((pan + 1) * np.pi / 4)], 1) * 1.414
            return out * v * (1.0 if name == 'whoosh' else 0.6), 0.0, 0.0
        if name == 'rewind':
            d = 1.3; t = t_(d); f = 1600 * np.exp(-t * 1.4) + 180
            tape = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) * 0.18 + rng0.standard_normal(len(t)) * 0.1
            w, _, _ = self.make('whoosh'); x = st(lp(tape, 3500) * np.minimum(1, t * 10) * np.exp(-t * 0.9))
            x[:len(w)] += w[:len(x)] * 0.6
            return x * v, 0.0, 0.0
        if name == 'ring':
            out = np.zeros(int(1.8 * SR)); t = t_(0.42)
            for k in range(2): seg = (np.sin(2 * np.pi * 1400 * t) + np.sin(2 * np.pi * 1760 * t)) * 0.12 * np.minimum(1, np.minimum(t, 0.42 - t) * 60); out[int(k * 0.6 * SR):][:len(seg)] += seg
            return st(out) * v, 0.3, 0.0
        if name == 'decline':
            t = t_(0.2); return st(np.sin(2 * np.pi * np.cumsum(700 - 350 * t / 0.2) / SR) * np.exp(-t * 9) * 0.25) * v, 0.3, 0.0
        if name == 'stamp':
            parts = [(0, s.hit('snare', 118), 0.6), (0, s.hit('bassdrum', 96), 0.6), (0, lp(kick(1.0, soft=False), 500), 0.5)]
            return self._mix(1.5, parts) * v, 0.0, 0.0
        if name == 'thud':
            parts = [(0, s.hit('bassdrum', 110), 0.9), (0, boom808(0.6, 55, 30, 0.9), 1.0)]
            return self._mix(2.0, parts) * v, 0.0, 0.0
        if name == 'heartbeat':
            a = lp(s.hit('bassdrum', 90), 160)
            return self._mix(1.2, [(0, a, 0.9), (0.24, a, 0.55)]) * v, 0.0, 0.0
        if name in ('riser', 'swell'):  # cymbal crescendo + string tremolo swell, peaking ~2.2 s after t
            cy = s.hit('cymbal_swell_short', 100); env = np.abs(cy).max(1); pk = int(np.argmax(np.convolve(env, np.ones(2205) / 2205, 'same')))
            lead = 2.2; i0 = max(0, pk - int(lead * SR)); cy = cy[i0:pk + int(0.25 * SR)].copy(); cy[-int(0.25 * SR):] *= np.linspace(1, 0, int(0.25 * SR))[:, None]
            parts = [(0, cy, 0.9), (0, s.note('violins_trem', 69, 2.1, 90, 0.15, env='swell'), 0.4), (0, s.note('violins_trem', 76, 2.1, 90, 0.15, env='swell'), 0.3)]
            return self._mix(2.8, parts) * v, 0.0, 0.0
        if name == 'crash': return s.hit('crash', 104) * 0.5 * v, 0.2, 0.0
        if name == 'gong': return s.hit('gong', 100) * 0.7 * v, 0.0, 0.0
        if name == 'glitch':
            d = 0.35; t = t_(d); n = rng0.standard_normal(len(t)); sq = np.sign(np.sin(2 * np.pi * 90 * t))
            return st((hp(n, 2000) * 0.25 + sq * 0.12) * (rng0.uniform(0, 1, len(n)) > 0.4)) * v, 0.0, 0.0
        if name == 'money':
            parts = [(0, s.hit('sleigh', 70), 0.25)]
            for i in range(12): parts.append((i * 0.08 + R.uniform(0, .03), bp(rng0.standard_normal(int(0.04 * SR)), 2000, 9000) * 0.2, 1.0))
            return self._mix(1.4, parts) * v, 0.0, 0.0
        # ambience loops (returned long; caller tiles)
        if name in ('cheer', 'crowd'):
            d = 8.0; parts = []
            for k in range(6):
                a = s.note('applause', 60 + R.integers(-2, 3), 5.5, 120, 0.5); parts.append((R.uniform(0, 2.5), a, 0.45))
            t = t_(d); roar = bp(rng0.standard_normal(len(t)), 300, 2600) * (0.7 + 0.3 * np.sin(2 * np.pi * 0.43 * t)) * 0.07
            hum = bp(rng0.standard_normal(len(t)), 150, 600) * 0.05
            x = self._mix(d, parts); x += st(roar + hum)
            fade = int(0.4 * SR); x[:fade] *= np.linspace(0, 1, fade)[:, None]; x[-fade:] *= np.linspace(1, 0, fade)[:, None]
            return x * v, 0.0, 0.0
        if name == 'murmur':
            d = 6.0; t = t_(d); n = bp(rng0.standard_normal(len(t)), 220, 1300) * (0.75 + 0.25 * np.sin(2 * np.pi * 0.37 * t)) * 0.12
            return st(n) * v, 0.0, 0.0
        if name == 'wind':
            d = 8.0; t = t_(d); n = rng0.standard_normal(len(t)); y = np.zeros_like(n); f = 380 + 220 * np.sin(2 * np.pi * 0.11 * t)
            for i in range(0, len(n), 2048): y[i:i + 2048] = bp(n[i:i + 2048], f[i] * 0.5, f[i] * 1.6)
            return st(y * 0.35) * v, 0.0, 0.0
        if name == 'rain': d = 6.0; return st(hp(rng0.standard_normal(int(d * SR)), 2500) * 0.06) * v, 0.0, 0.0
        if name == 'cars': d = 4.0; t = t_(d); return st(bp(rng0.standard_normal(len(t)), 60, 400) * np.sin(np.pi * t / d) * 0.3) * v, 0.0, 0.0
        if name == 'room': d = 6.0; return st(lp(rng0.standard_normal(int(d * SR)), 300) * 0.02) * v, 0.0, 0.0
        if name == 'birds':
            d = 8.0; out = np.zeros(int(d * SR))
            for k in range(9):
                t0 = R.uniform(0, d - 0.6); n = int(R.uniform(0.08, 0.18) * SR); tt = np.arange(n) / SR; f = R.uniform(2800, 4200) + 900 * np.sin(2 * np.pi * R.uniform(18, 30) * tt)
                ch = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * tt / tt[-1]) ** 2 * 0.05
                i = int(t0 * SR); out[i:i + n] += ch[:len(out) - i]
            return st(out) * v, 0.0, 0.0
        raise SystemExit(f'unknown sfx "{name}"')

SFX_NAMES = ['boom', 'impact', 'sparkle', 'levelup', 'leveldown', 'clock', 'pop', 'tick', 'cash', 'notify', 'whoosh', 'swoosh', 'rewind', 'ring',
             'decline', 'stamp', 'thud', 'heartbeat', 'riser', 'swell', 'crash', 'gong', 'glitch', 'money', 'cheer', 'crowd', 'murmur', 'wind', 'rain',
             'cars', 'room', 'birds']

# ---------------------------------------------------------------- file loading / writing
def load_file(path, gain=1.0):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32).astype(np.float64).reshape(-1, 2) * gain

def write_wav(path, x):
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())

# ---------------------------------------------------------------- loudness (ITU-R BS.1770-4 / EBU R128)
def _kweight(x, sr=SR):
    """K-weighting: high-shelf pre-filter + RLB high-pass (coefficients derived for any sample rate)."""
    from scipy.signal import lfilter
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / sr); Vh = 10 ** (G / 20); Vb = Vh ** 0.4996667741545416; a0 = 1 + K / Q + K * K
    b1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]; a1 = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    f0, Q = 38.13547087602444, 0.5003270373238773; K = np.tan(np.pi * f0 / sr)
    b2 = [1, -2, 1]; a2 = [1, 2 * (K * K - 1) / (1 + K / Q + K * K), (1 - K / Q + K * K) / (1 + K / Q + K * K)]
    return lfilter(b2, a2, lfilter(b1, a1, x, axis=0), axis=0)

def lufs(x, sr=SR):
    """Integrated loudness in LUFS (gated, 400 ms blocks, 75 % overlap)."""
    y = _kweight(np.asarray(x, dtype=np.float64), sr); ms = np.sum(y ** 2, axis=1) if y.ndim == 2 else y ** 2
    blk, hop = int(0.4 * sr), int(0.1 * sr); n = max(1, (len(ms) - blk) // hop + 1)
    c = np.concatenate([[0.0], np.cumsum(ms)]); z = np.array([(c[i * hop + blk] - c[i * hop]) / blk for i in range(n)])
    L = -0.691 + 10 * np.log10(z + 1e-12); z = z[L > -70]
    if not len(z): return -70.0
    rel = -0.691 + 10 * np.log10(np.mean(z)) - 10; L = -0.691 + 10 * np.log10(z + 1e-12)
    return float(-0.691 + 10 * np.log10(np.mean(z[L > rel])))

def true_peak(x):
    from scipy.signal import resample_poly
    return float(np.max(np.abs(resample_poly(x, 4, 1, axis=0))))

def _limit(x, ceiling):
    pk = np.max(np.abs(x), 1); g = np.minimum(1.0, ceiling / (pk + 1e-9))       # look-ahead peak limiter
    w = int(0.006 * SR); g = minimum_filter1d(g, size=w * 2 + 1); g = np.convolve(g, np.ones(w) / w, 'same')
    g = np.minimum(g, minimum_filter1d(np.minimum(1.0, ceiling / (pk + 1e-9)), 3))
    return x * g[:, None]

# The reference channel's uploads measure about -15.4 LUFS integrated with peaks under -1 dBTP
# (YouTube "content loudness" -14.8 ... -15.8 dB on the popular videos), so master to exactly that.
TARGET_LUFS, TP_CEIL = -15.4, 10 ** (-1.2 / 20)

def master(x, target_lufs=TARGET_LUFS, ceiling=TP_CEIL):
    x = hp(x, 28)
    x = compress(x, thr=0.28, ratio=2.0, att=0.012, rel=0.25)                  # glue
    for _ in range(3):                                                         # gain -> limit -> re-measure
        x = x * 10 ** ((target_lufs - lufs(x)) / 20)
        x = _limit(x, ceiling * 0.97)
        tp = true_peak(x)
        if tp > ceiling: x = x * (ceiling / tp)
        if abs(lufs(x) - target_lufs) < 0.15: break
    return np.clip(x, -0.98, 0.98)

# ---------------------------------------------------------------- timeline mix
def main():
    a = sys.argv[1:]
    if a and a[0] == '--cue':          # audition one cue: --cue MOOD SECONDS OUT.wav
        smp = Sampler(); x = compose(smp, a[1], float(a[2]), seed=int(a[4]) if len(a) > 4 else 0); write_wav(a[3], master(x)); print(a[3]); return
    ep_path, out_path = a[0], a[1]
    fr = float(a[a.index('--from') + 1]) if '--from' in a else 0.0
    to = float(a[a.index('--to') + 1]) if '--to' in a else None
    stems = a[a.index('--stems') + 1] if '--stems' in a else None
    base = os.path.dirname(os.path.abspath(ep_path))
    ep = json.load(open(ep_path)); meta = ep.get('meta', {}); acfg = ep.get('audio', {})
    smp = Sampler(); sfx = SFX(smp)
    scenes = ep['scenes']; starts = np.cumsum([0] + [s['dur'] for s in scenes]); total = float(starts[-1])
    MUS, FX, AMB = Bus(total + 1), Bus(total + 1), Bus(total + 1)
    gap = acfg.get('gap', 0.4); hits = []
    # chapters
    segs, cur = [], None
    for i, s in enumerate(scenes):
        m = s.get('music')
        if m is not None and (cur is None or m != cur['m'] or (s.get('hit') is True and i > 0)):
            if cur: cur['end'] = float(starts[i]); segs.append(cur)
            cur = {'m': m, 'start': float(starts[i]), 'hit': s.get('hit', i > 0), 'key': s.get('musicKey', 0), 'seed': s.get('musicSeed')}
    if cur: cur['end'] = total; segs.append(cur)
    seen = {}
    for k, sg in enumerate(segs):
        st_, en = sg['start'], sg['end']; nxt = k + 1 < len(segs)
        dur = max(0.1, en - st_ - (gap if nxt else 0.0)); m = sg['m']
        if m == 'silence': pass
        elif isinstance(m, dict) and m.get('file'):
            x = load_file(os.path.join(base, m['file']), m.get('gain', 0.6))[:int(dur * SR)].copy(); fo = int(0.3 * SR)
            if len(x) > fo: x[-fo:] *= np.linspace(1, 0, fo)[:, None]
            MUS.add(x, st_, acfg.get('musicGain', 1.0))
        else:
            mood = ALIASES.get(m, m); seed = sg['seed'] if sg['seed'] is not None else seen.get(mood, 0); seen[mood] = seen.get(mood, 0) + 1
            MUS.add(compose(smp, mood, dur, seed=seed, transpose=sg['key']), st_, acfg.get('musicGain', 1.0))
        if sg['hit'] and m != 'silence': x, pan, _ = sfx.make('boom', acfg.get('boomGain', 0.24)); FX.add(x, st_, 1, pan); hits.append(st_)
    # sfx + ambience
    prev = None
    def fire(name, at, gain=0.8):
        x, pan, off = sfx.make(name, gain); FX.add(x, at + off, 1, pan)
        if name in ('boom', 'impact', 'thud'): hits.append(at)
    for i, s in enumerate(scenes):
        t0 = float(starts[i])
        for e in s.get('sfx', []):
            if e.get('file'): FX.add(load_file(os.path.join(base, e['file']), e.get('gain', 0.8)), t0 + e.get('t', 0))
            else: fire(e['name'], t0 + e.get('t', 0), e.get('gain', 0.8))
        for e in s.get('ambience', []):
            x, _, _ = sfx.make(e['name'], e.get('gain', 0.5)); d = e.get('d', s['dur'] - e.get('t', 0)); n = int(d * SR)
            reps = int(np.ceil(n / len(x))) + 1; y = np.concatenate([x] * reps)[:n]
            ramp = np.minimum(1, np.minimum(np.arange(n), n - np.arange(n)) / (0.35 * SR)); AMB.add(y * ramp[:, None], t0 + e.get('t', 0), 1, 0)
        if acfg.get('auto', True):
            stt = (s.get('hud') or {}).get('status'); val = stt if isinstance(stt, str) else (stt or {}).get('value'); tone = None if isinstance(stt, str) else (stt or {}).get('tone')
            if val and prev is not None and val != prev and s.get('transition') != 'rewind': fire('leveldown' if tone == 'bad' else 'levelup', t0 + 0.06, 0.45 if tone == 'bad' else 0.5)
            if val: prev = val
            if s.get('transition') == 'rewind': fire('rewind', t0, 0.75)
            if s.get('transition') == 'flash': fire('impact', t0, 0.4)
            for c in s.get('cards', []):
                ct = t0 + c.get('t', 0)
                kind = {'bubble': 'pop', 'pill': 'pop', 'tag': 'pop', 'chip': 'tick', 'phone_call': 'ring', 'notification': 'notify', 'title': 'boom', 'big_number': 'swoosh',
                        'stat': 'sparkle', 'receipt': 'cash', 'leaderboard': 'sparkle', 'list_stamp': None, 'schedule': 'swoosh', 'clock': 'tick', 'phone_msg': 'notify', 'compare': 'swoosh'}.get(c['type'], 'swoosh')
                if kind: fire(kind, ct, {'pop': 0.45, 'tick': 0.4, 'ring': 0.5, 'notify': 0.55, 'boom': 0.6, 'swoosh': 0.4, 'sparkle': 0.5, 'cash': 0.55}[kind])
                if c['type'] == 'phone_call' and c.get('declineAt') is not None: fire('decline', ct + c['declineAt'], 0.5)
                if c['type'] == 'list_stamp': [fire('stamp', ct + q, 0.7) for q in c.get('stampTimes', [])]
                if c['type'] in ('stat', 'big_number') and c.get('from') is not None:
                    for q in np.arange(0, c.get('countDur', 1.6 if c['type'] == 'stat' else 2), 0.07): fire('tick', ct + q, 0.16)
    # duck the score under booms (sidechain feel), a little under the crowd too
    duck = np.ones(len(MUS.x))
    for h in hits:
        i = int(h * SR); n = int(0.6 * SR); e = 1 - 0.25 * np.exp(-np.arange(n) / (0.18 * SR)); j = min(len(duck), i + n); duck[i:j] = np.minimum(duck[i:j], e[:j - i])
    MUS.x *= duck[:, None]
    # voiceover (optional variant) with ducking
    VO = Bus(total + 1)
    if meta.get('voiceover'):
        VO.add(load_file(os.path.join(base, meta['voiceover'])), meta.get('voiceoverStart', 0.0))
        env = np.convolve(np.abs(VO.L), np.ones(4410) / 4410, 'same'); d2 = 1 - 0.55 * np.clip(env * 12, 0, 1); MUS.x *= d2[:, None]
    sfxg = acfg.get('sfxGain', 1.0)
    mixx = MUS.x + FX.x * sfxg + AMB.x + VO.x
    out = master(mixx[:int(total * SR) + SR // 2])
    i0, i1 = int(fr * SR), int((to if to is not None else total) * SR)
    write_wav(out_path, out[i0:i1])
    if stems:
        os.makedirs(stems, exist_ok=True)
        for nm, bus in (('music', MUS), ('sfx', FX), ('ambience', AMB)): write_wav(os.path.join(stems, nm + '.wav'), bus.x[i0:i1])
    print(json.dumps({'audio': out_path, 'seconds': round((i1 - i0) / SR, 2), 'chapters': [[round(sg['start'], 2), sg['m'] if isinstance(sg['m'], str) else 'file'] for sg in segs]}))

if __name__ == '__main__': main()
