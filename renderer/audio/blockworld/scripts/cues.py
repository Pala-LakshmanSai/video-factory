"""Chapter cues — the original score.

Each cue is written like a library track: a chord progression (one chord per bar), parts with voice
leading, a generated melody in period form (A A' A A'' — the motif returns so it sounds composed), an
intro bar, and a build after the first phrase. Played on the orchestral sample set (real strings, piano,
harp, mallets, brass, percussion) with a few General-MIDI colours (celesta, music box, choir) and
synthesised pop drums / 808s. Measured targets per cue are in references/04-sound-system.md.
"""
import hashlib
import numpy as np
import json, os
from audio_lib import (SR, Bus, reverb, compress, eq_curve, hp, lp, st, kick, clap, snap, hat, boom808, sub_drop,
                       parse, pcs, voice, bass_of, low_note, scale_for, lead)

CUES = {
    # name: bpm, progression (chord per bar), target loudness (stereo RMS), hall reverb (mix, decay)
    'normal_life': dict(bpm=95,  prog=['Fmaj7', 'C', 'G', 'Am7'],            level=0.095, hall=(0.24, 1.9)),
    'whimsical':   dict(bpm=104, prog=['C', 'G', 'Am', 'F', 'C', 'F', 'G', 'C'], level=0.10, hall=(0.2, 1.6)),
    'cold_open':   dict(bpm=100, prog=['Am', 'F', 'C', 'G'],                 level=0.12, hall=(0.3, 2.6)),
    'triumph':     dict(bpm=100, prog=['C', 'G', 'Am', 'F'],                 level=0.12, hall=(0.3, 2.6)),
    'threat':      dict(bpm=120, prog=['Am', 'Am', 'F', 'E'],                level=0.105, hall=(0.34, 2.8)),
    'tension':     dict(bpm=112, prog=['Am', 'Am', 'F', 'E'],                level=0.105, hall=(0.28, 2.2)),
    'chaos':       dict(bpm=132, prog=['Am', 'F', 'Dm', 'E'],                level=0.125, hall=(0.26, 2.2)),
    'dark':        dict(bpm=104, prog=['Am', 'F', 'C', 'E'],                 level=0.075, hall=(0.4, 3.0)),
    'melancholy':  dict(bpm=80,  prog=['F', 'C', 'G', 'Am'],                 level=0.08, hall=(0.36, 2.6)),
    'heartwarm':   dict(bpm=88,  prog=['C', 'Am', 'F', 'G'],                 level=0.09, hall=(0.34, 2.4)),
    'wonder':      dict(bpm=80,  prog=['Fmaj7', 'G', 'Am7', 'C'],            level=0.085, hall=(0.42, 3.2)),
}
ALIASES = {'bright': 'whimsical', 'curious': 'normal_life', 'tense': 'tension', 'ominous': 'threat', 'cosmic': 'wonder',
           'epic': 'cold_open', 'warm': 'heartwarm', 'sad': 'melancholy', 'mystery': 'wonder', 'happy': 'whimsical'}

# melody rhythms: (position in beats inside a 2-bar cell, length in beats)
RHY = {
    'normal_life': ([(0, 1), (1, .5), (1.5, 1), (2.5, .5), (3, 1), (4, 1.5), (5.5, .5), (6, 2)],
                    [(0, .5), (.5, .5), (1, 1), (2, 1), (3, 1), (4, .5), (4.5, .5), (5, 1), (6, 2)]),
    'whimsical':   ([(0, .5), (.5, .5), (1, .5), (2, .5), (2.5, .5), (3, 1), (4, .5), (4.5, .5), (5, .5), (6, 1), (7, .5)],
                    [(0, 1), (1, .5), (1.5, .5), (2, 1), (3.5, .5), (4, .5), (4.5, .5), (5, 1), (6, 2)]),
    'cold_open':   ([(0, 1.5), (1.5, .5), (2, 2), (4, 1), (5, 1), (6, 2)],
                    [(0, 1), (1, 1), (2, 1), (3, 1), (4, 3), (7, 1)]),
    'melancholy':  ([(0, 1), (1, 1), (2, 2), (4, 1.5), (5.5, .5), (6, 2)],
                    [(0, 1.5), (1.5, .5), (2, 1), (3, 1), (4, 4)]),
    'heartwarm':   ([(0, .5), (.5, .5), (1, 1.5), (2.5, .5), (3, 1), (4, 1), (5, 1), (6, 2)],
                    [(0, 1), (1, 1), (2, 1.5), (3.5, .5), (4, 2), (6, 2)]),
    'dark':        ([(0, 1), (1.5, .5), (2, 1), (3.5, .5), (4, 1.5), (6, 1)],
                    [(0, .5), (1, .5), (2, 1.5), (4, .5), (5, .5), (6, 2)]),
    'wonder':      ([(0, 2), (2, 1), (3, 1), (4, 3), (7, 1)],
                    [(0, 1), (1, 1), (2, 2), (4, 1), (5, 1), (6, 2)]),
}
RHY['triumph'] = RHY['cold_open']

# per-cue tonal balance (dB per band, 36 log bands 30 Hz–16 kHz) matched to the reference's chapters;
# written by scripts/calibrate_eq.py — the arrangement provides the notes, this provides the finish
_EQP = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cue_eq.json')
CUE_EQ = json.load(open(_EQP)) if os.path.exists(_EQP) else {}


class Cue:
    def __init__(self, smp, mood, dur, seed=0, transpose=0):
        cfg = CUES[mood]; self.mood = mood; self.cfg = cfg; self.smp = smp; self.dur = dur; self.tr = transpose
        self.beat = 60 / cfg['bpm']; self.bar = self.beat * 4; self.prog = cfg['prog']
        self.nb = int(np.ceil(dur / self.bar)) + 1
        self.rng = np.random.default_rng(int(hashlib.md5(f'{mood}|{seed}'.encode()).hexdigest()[:8], 16))
        self.bus = {k: Bus(dur + 2) for k in ('dry', 'room', 'hall')}
        self.vl = {}
    # -- timing
    def chord(self, b): return self.prog[b % len(self.prog)]
    def at(self, b, beat): return b * self.bar + beat * self.beat
    def alive(self, b, beat=0): return self.at(b, beat) < self.dur + 0.05
    # -- playing
    def play(self, inst, m, b, beat, beats, vel, g=1.0, pan=0.0, bus='hall', rel=None, env=None, hum=0.006):
        t = self.at(b, beat) + (self.rng.uniform(-hum, hum) if hum else 0)
        if t > self.dur + 0.05: return
        v = int(np.clip(vel + self.rng.integers(-5, 6), 20, 127))
        self.bus[bus].add(self.smp.note(inst, m + self.tr, beats * self.beat, v, rel, env), max(0, t), g, pan)
    def hit(self, inst, b, beat, vel, g=1.0, pan=0.0, bus='room', dur=None):
        t = self.at(b, beat)
        if t > self.dur + 0.05: return
        self.bus[bus].add(self.smp.hit(inst, int(np.clip(vel + self.rng.integers(-5, 6), 20, 127)), dur), t + self.rng.uniform(-0.004, 0.004), g, pan)
    def synth(self, x, b, beat, g=1.0, pan=0.0, bus='dry'):
        t = self.at(b, beat)
        if t <= self.dur + 0.05: self.bus[bus].add(x, t, g, pan)
    def pad(self, part, inst, b, n, lo, hi, vel, g, bus='hall', beats=4, spread=0.6, env=None, top=None):
        v = lead(self.vl.get(part), self.chord(b), n, lo, hi, top); self.vl[part] = v
        for i, m in enumerate(v): self.play(inst, m, b, 0, beats, vel, g, spread * ((i / max(1, n - 1)) * 2 - 1), bus, env=env)
        return v
    # -- melody (period form)
    def melody(self, lo, hi, start=0):
        A, B = RHY.get(self.mood, RHY['normal_life']); rng = self.rng; out = []
        def gen(rhy, b0, shape, prev, cadence=False):
            notes = []
            for k, (p, d) in enumerate(rhy):
                b = b0 + int(p // 4); beat = p % 4; ch = self.chord(b)
                strong = beat % 2 == 0 or d >= 1.5
                cands = voice(ch, lo, hi) if strong else [m for m in range(lo, hi + 1) if m % 12 in scale_for(ch)]
                ph = p / 8; target = lo + (hi - lo) * shape(ph)
                last = cadence and k == len(rhy) - 1
                if last: cands = [m for m in voice(ch, lo, hi) if m % 12 in (parse(ch)[0], (parse(ch)[0] + parse(ch)[1][1]) % 12)] or cands
                def cost(c):
                    j = abs(c - prev)
                    ct = (c % 12) in pcs(ch)
                    return abs(c - target) * 0.45 + j * 0.8 + (4 if j > 7 else 0) + (0 if ct else (1.6 if j <= 2 else 4.0)) + (2.5 if (len(notes) > 1 and c == notes[-1][3] == notes[-2][3]) else 0) + rng.uniform(0, 1.2)
                m = min(cands, key=cost); notes.append((b, beat, d, m)); prev = m
            return notes, prev
        arch = lambda ph: 0.35 + 0.4 * np.sin(np.pi * ph)
        fall = lambda ph: 0.6 - 0.35 * ph
        high = lambda ph: 0.5 + 0.35 * np.sin(np.pi * ph)
        prev = (lo + hi) // 2; b = start; sec = 0
        while self.alive(b):
            if sec % 2 == 0:   # period A: A A' A A''
                a1, p1 = gen(A, b, arch, prev); a2, p2 = gen(A, b + 2, fall, p1)
                same = all(self.chord(b + i) == self.chord(b + 4 + i) for i in range(2))
                a3 = [(x[0] + 4, x[1], x[2], x[3]) for x in a1] if same else gen(A, b + 4, arch, p2)[0]
                a4, prev = gen(A, b + 6, fall, a3[-1][3], cadence=True)
                cell = a1 + a2 + a3 + a4
            else:              # period B: B B' A A''
                b1, p1 = gen(B, b, high, prev); b2, p2 = gen(B, b + 2, arch, p1)
                a1, p3 = gen(A, b + 4, arch, p2); a4, prev = gen(A, b + 6, fall, p3, cadence=True)
                cell = b1 + b2 + a1 + a4
            out += cell; b += 8; sec += 1
        return [n for n in out if self.alive(n[0], n[1])]
    # -- mix
    def render(self):
        mix, dec = self.cfg['hall']
        x = self.bus['dry'].x + reverb(self.bus['room'].x, 0.16, 1.1) + reverb(self.bus['hall'].x, mix, dec)
        n = int(self.dur * SR); tail = int(0.38 * SR); x = hp(x[:n + tail + int(0.05 * SR)], 32)[:n + tail]
        if not getattr(self, 'raw_eq', False): x = eq_curve(x, CUE_EQ.get(self.mood))
        x = compress(x, thr=0.22, ratio=2.2, att=0.01, rel=0.18)
        rms = np.sqrt(np.mean(x[:n] ** 2)) + 1e-9
        # ending: fade over the last 0.3 s, then let a short tail die away into the chapter gap (the
        # reference dips to near-silence, not digital zero)
        fi = int(0.02 * SR); fo = int(min(0.3, self.dur / 3) * SR); env = np.ones(len(x))
        env[:fi] = np.linspace(0, 1, fi); env[n - fo:n] = np.linspace(1, 0.22, fo); env[n:] = 0.22 * np.exp(-np.arange(len(x) - n) / (0.09 * SR))
        x *= env[:, None]
        M = (x[:, 0] + x[:, 1]) / 2; S = (x[:, 0] - x[:, 1]) / 2 * 0.62          # image width ≈ reference (side/mid ≈ 0.3)
        x = np.stack([M + S, M - S], 1)
        return x * (self.cfg['level'] / rms)


# ---------------------------------------------------------------- the cues
def normal_life(c):
    mel = c.melody(72, 86, start=1)
    for b in range(c.nb):
        if not c.alive(b): break
        ch = c.chord(b); r = bass_of(ch, 36); full = b >= 1
        fifth = min(voice(ch, r + 5, r + 9) or [r + 7])
        c.play('piano', r, b, 0, 1.5, 74, 0.85, -0.15, 'room'); c.play('piano', r + 12, b, 1.5, 1, 58, 0.6, -0.15, 'room')
        c.play('piano', fifth, b, 2.5, 1.5, 60, 0.65, -0.15, 'room')
        for pos, d, v in ((0, 1.4, 58), (1.5, 0.9, 52), (3, 0.9, 54)):
            for i, m in enumerate(lead(c.vl.get('rh'), ch, 3, 55, 71)): c.play('piano', m, b, pos, d, v, 0.55, 0.15, 'room')
        c.vl['rh'] = lead(c.vl.get('rh'), ch, 3, 55, 71)
        if full:
            c.play('basses_pizz', bass_of(ch, 28), b, 0, 1, 92, 0.85, 0, 'room'); c.play('basses_pizz', bass_of(ch, 28) + (7 if b % 2 else 12), b, 2, 1, 80, 0.7, 0, 'room')
            c.synth(kick(0.4), b, 0); c.synth(kick(0.28), b, 2.5)
            for q in (1, 3): c.synth(clap(0.2), b, q, 1, -0.05); c.synth(snap(0.2), b, q, 1, 0.1)
            if b >= 4: [c.hit('tamb_shake', b, i * 0.5, 50 if i % 2 else 38, 0.11, 0.35, 'room', 0.25) for i in range(8)]
        if b >= 4: c.pad('vpad', 'violins', b, 2, 64, 79, 54, 0.22, 'hall', 4, 0.5)
        if b % 4 == 3 and b >= 3:
            for i, m in enumerate(voice(ch, 84, 96)[:3]): c.play('glock', m, b, 3 + i * 0.25, 0.5, 70, 0.28, 0.45, 'hall')
    for (b, beat, d, m) in mel:
        c.play('piano', m, b, beat, d, 78, 1.0, 0.15, 'room')
        if b >= 5: c.play('glock', m + 12, b, beat, min(d, 1.0), 62, 0.2, 0.35, 'hall')

def whimsical(c):
    mel = c.melody(76, 91, start=1)
    for b in range(c.nb):
        if not c.alive(b): break
        ch = c.chord(b); r = bass_of(ch, 36); ct = voice(ch, r, r + 16); full = b >= 1
        hi = voice(ch, 48, 64); bot = bass_of(ch, 31)
        walk = [hi[0], hi[1 % len(hi)], hi[2 % len(hi)], hi[1 % len(hi)], hi[0] + 12 if hi[0] + 12 <= 67 else hi[0], hi[2 % len(hi)], hi[1 % len(hi)], hi[2 % len(hi)]]
        c.play('basses_pizz', bot, b, 0, 1, 92, 0.55, 0, 'room'); c.play('basses_pizz', bot + 7 if bot + 7 < 44 else bot - 5, b, 2, 1, 84, 0.45, 0, 'room')
        if full:
            for i, m in enumerate(walk): c.play('celli_pizz', m, b, i * 0.5, 0.5, 96 if i % 2 == 0 else 80, 0.6, -0.15, 'room')
            for i, m in enumerate([0, 2, 1, 2]): c.play('marimba', hi[m % len(hi)] + 12, b, 0.5 + i, 0.5, 74, 0.28, -0.35, 'room')
        for q in (1, 3):
            for m in lead(c.vl.get('pz'), ch, 3, 60, 74): c.play('violins_pizz', m, b, q, 0.5, 86, 0.42, 0.3, 'room')
            c.vl['pz'] = lead(c.vl.get('pz'), ch, 3, 60, 74)
        if full:
            c.synth(kick(0.28), b, 0); c.synth(kick(0.2), b, 2)
            for q in (1, 3): c.synth(clap(0.3), b, q, 1, -0.05); c.hit('snare', b, q, 50, 0.1, 0.05, 'room', 0.4)
            if b % 4 == 0: c.hit('triangle', b, 0, 70, 0.22, 0.5, 'hall', 2.0)
        if b >= 8: c.pad('wpad', 'violins', b, 2, 67, 81, 52, 0.16, 'hall', 4, 0.5)
    for (b, beat, d, m) in mel:
        c.play('glock', m, b, beat, min(d, 1.0), 86, 0.72, 0.25, 'hall'); c.play('violins_pizz', m - 12, b, beat, 0.5, 84, 0.32, -0.1, 'room')
        if b >= 8: c.play('xylo', m - 12, b, beat, min(d, 0.5), 80, 0.3, -0.25, 'room')
        if b < 8 and d >= 1: c.play('celesta', m - 12, b, beat, d, 62, 0.22, -0.2, 'hall')

def epic(c, major=False):
    mel = c.melody(55, 70, start=1)
    for b in range(c.nb):
        if not c.alive(b): break
        ch = c.chord(b); r = bass_of(ch, 28); full = b >= 1
        c.play('basses', r, b, 0, 4, 104, 0.85, 0, 'hall'); c.play('celli', r + 12, b, 0, 4, 100, 0.6, -0.2, 'hall')
        c.pad('str', 'violas', b, 2, 55, 67, 96, 0.45, 'hall', 4, 0.4); c.pad('vln', 'violins', b, 3, 64, 81, 96, 0.4, 'hall', 4, 0.6)
        c.pad('ch', 'choir_aahs', b, 2, 62, 74, 84, 0.2, 'hall', 4, 0.5)
        if full:
            top = voice(ch, 64, 81); pat = [0, 1, 2, 1, 0, 1, 2, 3]
            for i, k in enumerate(pat): c.play('violins_spic', top[k % len(top)], b, i * 0.5, 0.5, 104 if i % 2 == 0 else 86, 0.42, 0.35, 'hall')
            for i in range(8): c.play('celli_spic', r + 12 + (12 if i % 4 == 2 else 0), b, i * 0.5, 0.5, 104 if i % 2 == 0 else 84, 0.45, -0.3, 'hall')
            for i in range(8): c.play('harp', voice(ch, 60, 88)[(i * 2) % len(voice(ch, 60, 88))], b, i * 0.5, 1, 70, 0.18, 0.5, 'hall')
            c.hit('snare', b, 1, 100, 0.24, 0.05, 'room', 1.0); c.hit('snare', b, 3, 104, 0.26, 0.05, 'room', 1.0)
            if major: c.synth(clap(0.4), b, 1, 1, -0.05); c.synth(clap(0.4), b, 3, 1, -0.05)
        tp = low_note(parse(ch)[0], 41)
        c.play('timpani', tp, b, 0, 2, 112, 0.85, -0.1, 'hall'); c.play('timpani', tp, b, 2.5, 1.5, 92, 0.5, -0.1, 'hall')
        c.hit('bassdrum', b, 0, 110, 0.55, 0, 'hall'); c.synth(boom808(0.42, 72, 34, 1.4), b, 0)
        if b % 4 == 0: c.hit('crash', b, 0, 100 if b else 110, 0.32, 0.3, 'hall')
        if b % 4 == 3: c.play('timpani_roll', tp, b, 0, 4, 100, 0.5, -0.1, 'hall', env='swell')
    for (b, beat, d, m) in mel:
        c.play('horn', m, b, beat, d, 104, 0.75, -0.1, 'hall', rel=0.35)
        if d >= 1: c.play('trombone', m - 12, b, beat, d, 92, 0.32, 0.1, 'hall', rel=0.3)
        if b >= 5: c.play('glock', m + 24, b, beat, min(d, 1), 70, 0.2, 0.45, 'hall')
def cold_open(c): epic(c, False)
def triumph(c): epic(c, True)

def threat(c):
    nb = c.nb
    for b in range(nb):
        if not c.alive(b): break
        ch = c.chord(b); r = bass_of(ch, 28); k = b / max(1, nb - 1)
        if b % 2 == 0 or ch != c.chord(b - 1):
            n = 2 if (b + 1 < nb and c.chord(b + 1) == ch) else 1
            c.play('basses', r, b, 0, 4 * n, 104, 0.9, 0, 'hall', env=(0.7, 1.0)); c.play('celli', r + 12, b, 0, 4 * n, 98, 0.55, -0.25, 'hall')
            c.play('celli', min(voice(ch, r + 17, r + 21) or [r + 19]), b, 0, 4 * n, 92, 0.45, 0.25, 'hall')
            c.play('piano', r, b, 0, 3, 104, 0.6, -0.1, 'room'); c.play('piano', r + 12, b, 0, 3, 96, 0.5, -0.1, 'room')
            c.synth(sub_drop(0.45), b, 0); c.hit('bassdrum', b, 0, 104, 0.5, 0, 'hall')
            c.pad('tr', 'violins_trem', b, 2, 76, 88, 66, 0.22, 'hall', 4 * n, 0.5, env='swell')
        top = r + 24; pat = [0, 0, 0, 3 if 'm' in ch else 4, 0, 0, 7, 0, 0, 0, 0, 3 if 'm' in ch else 4, 0, 7, 12, 7]
        for i, iv in enumerate(pat): c.play('celli_spic', top + iv - 12, b, i * 0.25, 0.25, int(78 + 26 * k + (10 if i % 4 == 0 else 0)), 0.42, -0.2 if i % 2 else 0.2, 'hall')
        for i in range(8): c.synth(hat(0.35 if i % 2 == 0 else 0.18), b, i * 0.5, 1, 0.3)
        if b % 2 == 1: c.play('timpani_roll', low_note(parse(c.chord(b + 1))[0], 41), b, 0, 4, 96, 0.45, -0.1, 'hall', env='swell')
        if b % 4 == 2: c.play('horn', min(voice(ch, 50, 57)), b, 0, 8 if c.chord(b + 1) == ch else 4, 92, 0.45, -0.15, 'hall', env='swell')

def tension(c, chaos=False):
    for b in range(c.nb):
        if not c.alive(b): break
        ch = c.chord(b); r = bass_of(ch, 28); top = voice(ch, 64, 77)
        for i, k_ in enumerate([0, 1, 2, 1, 0, 1, 2, 1]): c.play('violins_spic', top[k_ % len(top)], b, i * 0.5, 0.5, 100 if i % 2 == 0 else 82, 0.42, 0.3, 'hall')
        for i in range(8): c.play('celli_spic', r + 12 + (12 if i % 2 else 0), b, i * 0.5, 0.5, 100 if i % 2 == 0 else 84, 0.45, -0.3, 'hall')
        c.play('basses_pizz', r, b, 0, 1, 100, 0.7, 0, 'room'); c.play('basses_pizz', r, b, 2, 1, 92, 0.6, 0, 'room')
        tp = low_note(parse(ch)[0], 41); c.play('timpani', tp, b, 0, 2, 108, 0.75, -0.1, 'hall')
        if b % 2 == 0: c.pad('hn', 'horn', b, 2, 50, 64, 90, 0.42, 'hall', 8 if c.chord(b + 1) == ch else 4, 0.4, env='swell')
        if b % 4 >= 2: c.pad('tr', 'violins_trem', b, 2, 76, 88, 64, 0.2, 'hall', 4, 0.5)
        for i in range(16): c.synth(hat(0.3 if i % 4 == 0 else 0.15), b, i * 0.25, 1, 0.3)
        if chaos:
            c.hit('bassdrum', b, 0, 112, 0.5, 0, 'hall'); c.hit('bassdrum', b, 2, 104, 0.4, 0, 'hall'); c.synth(kick(0.85, soft=False), b, 0); c.synth(kick(0.7, soft=False), b, 2)
            c.hit('snare', b, 1, 112, 0.4, 0.05, 'room'); c.hit('snare', b, 3, 116, 0.42, 0.05, 'room'); c.synth(clap(0.45), b, 1); c.synth(clap(0.45), b, 3)
            for q in (0, 1.5): [c.play('trombone', m, b, q, 0.6, 108, 0.38, 0.1, 'hall', rel=0.2) for m in lead(c.vl.get('tb'), ch, 2, 46, 60)]
            c.vl['tb'] = lead(c.vl.get('tb'), ch, 2, 46, 60)
            if b % 2 == 0: c.hit('crash', b, 0, 104, 0.3, 0.3, 'hall')
            if b % 4 == 3: [c.play('timpani', tp, b, i * 0.5, 0.5, 90 + i * 4, 0.5, -0.1, 'hall') for i in range(8)]
def chaos(c): tension(c, True)

def dark(c):
    mel = c.melody(76, 91, start=1)
    for b in range(c.nb):
        if not c.alive(b): break
        ch = c.chord(b); r = bass_of(ch, 28)
        c.play('basses', r, b, 0, 4, 60, 0.75, 0, 'hall'); c.play('celli', min(voice(ch, r + 17, r + 21) or [r + 19]), b, 0, 4, 58, 0.42, -0.2, 'hall')
        c.pad('tr', 'violins_trem', b, 2, 69, 81, 46, 0.12, 'hall', 4, 0.5)
        c.pad('pd', 'pad_2_warm', b, 2, 55, 67, 64, 0.18, 'hall', 4, 0.5)
        if b % 2 == 0: c.play('piano', r + 12, b, 0, 4, 62, 0.45, -0.1, 'hall')
    for (b, beat, d, m) in mel:
        inst = 'celesta' if (b // 4) % 2 == 0 else 'music_box'
        c.play(inst, m, b, beat, max(d, 1), 74, 0.6, 0.3 if beat % 1 else -0.2, 'hall')
        if b >= 8 and d >= 1: c.play('harp', m - 12, b, beat, d, 58, 0.2, -0.3, 'hall')

def melancholy(c):
    mel = c.melody(67, 82, start=1)
    for b in range(c.nb):
        if not c.alive(b): break
        ch = c.chord(b); r = bass_of(ch, 33); arp = voice(ch, r, r + 19)[:5]
        seq = arp + arp[-2:0:-1]
        for i in range(8): c.play('piano', seq[i % len(seq)], b, i * 0.5, 1.6, 58 if i else 66, 0.7, -0.15, 'hall')
        if b >= 2: c.play('celli', min(voice(ch, 50, 62), key=lambda m: abs(m - 55)), b, 0, 4, 60, 0.38, -0.25, 'hall')
        if b >= 4: c.pad('vp', 'violins', b, 2, 67, 79, 50, 0.18, 'hall', 4, 0.5)
        if b >= 1: c.play('basses', bass_of(ch, 28), b, 0, 4, 56, 0.45, 0, 'hall')
    for (b, beat, d, m) in mel:
        c.play('piano', m, b, beat, d, 70, 0.85, 0.15, 'hall')
        if b >= 8: c.play('celesta', m + 12, b, beat, d, 58, 0.18, 0.4, 'hall')

def heartwarm(c):
    mel = c.melody(67, 84, start=2)
    for b in range(c.nb):
        if not c.alive(b): break
        ch = c.chord(b); r = bass_of(ch, 36); arp = voice(ch, 48, 72)
        seq = [arp[0], arp[2 % len(arp)], arp[4 % len(arp)], arp[3 % len(arp)], arp[5 % len(arp)], arp[4 % len(arp)], arp[2 % len(arp)], arp[3 % len(arp)]]
        c.play('piano', r, b, 0, 4, 68, 0.75, -0.15, 'hall')
        for i, m in enumerate(seq): c.play('piano', m, b, i * 0.5, 1.2, 56, 0.6, 0.1, 'hall')
        c.pad('lo', 'celli', b, 2, 43, 57, 62, 0.32, 'hall', 4, 0.4); c.play('basses', bass_of(ch, 28), b, 0, 4, 60, 0.45, 0, 'hall')
        if b >= 2: c.pad('va', 'violas', b, 2, 55, 67, 58, 0.25, 'hall', 4, 0.5)
        if b % 4 == 0:
            for i, m in enumerate(voice(ch, 60, 91)): c.play('harp', m, b, i * 0.08, 2, 64, 0.26, 0.4, 'hall')
        if b % 2 == 1: c.play('glock', voice(ch, 84, 96)[0], b, 3, 1, 62, 0.22, 0.5, 'hall')
        if b >= 4: c.synth(kick(0.26), b, 0); [c.hit('tamb_shake', b, i * 0.5, 46 if i % 2 else 36, 0.07, 0.35, 'room', 0.25) for i in range(8)]
    for (b, beat, d, m) in mel:
        c.play('violins', m, b, beat, d, 76, 0.42, 0.15, 'hall', rel=0.4)
        if b < 6: c.play('piano', m, b, beat, d, 62, 0.45, 0.15, 'hall')

def wonder(c):
    mel = c.melody(79, 93, start=1)
    for b in range(c.nb):
        if not c.alive(b): break
        ch = c.chord(b); r = bass_of(ch, 28)
        c.pad('tr', 'violins_trem', b, 3, 64, 81, 60, 0.26, 'hall', 4, 0.6, env=(0.6, 1.0))
        c.play('basses', r, b, 0, 4, 58, 0.45, 0, 'hall'); c.play('celli', min(voice(ch, r + 17, r + 21) or [r + 19]), b, 0, 4, 56, 0.32, -0.2, 'hall')
        arp = voice(ch, 60, 88)
        for i in range(16): c.play('harp', arp[(i * 2 + (i // 4)) % len(arp)], b, i * 0.25, 1, 64, 0.3, float(np.sin(i)) * 0.5, 'hall')
        c.pad('ch', 'choir_aahs', b, 2, 60, 72, 70, 0.2, 'hall', 4, 0.5)
        if b % 2 == 0: c.play('glock', voice(ch, 86, 98)[0], b, 2.5, 1, 58, 0.2, 0.5, 'hall')
        if b % 4 == 0: c.hit('triangle', b, 0, 62, 0.18, 0.5, 'hall', 3.0)
    for (b, beat, d, m) in mel: c.play('celesta', m, b, beat, d, 72, 0.5, 0.25, 'hall')

WRITERS = dict(normal_life=normal_life, whimsical=whimsical, cold_open=cold_open, triumph=triumph, threat=threat, tension=tension,
               chaos=chaos, dark=dark, melancholy=melancholy, heartwarm=heartwarm, wonder=wonder)

def compose(smp, mood, dur, seed=0, transpose=0, raw_eq=False):
    """stereo (n, 2) cue: dur seconds plus a ~0.38 s decaying tail"""
    mood = ALIASES.get(mood, mood)
    if mood not in CUES: raise SystemExit(f'unknown music mood "{mood}" — use one of {sorted(set(CUES) | set(ALIASES))} or silence')
    c = Cue(smp, mood, dur, seed, transpose); c.raw_eq = raw_eq; WRITERS[mood](c); return c.render()
