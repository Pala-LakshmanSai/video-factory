"""No-rental proof for scripts/blockworld_score.py. Needs numpy+scipy, ffmpeg and the kit checkout.

    python3 scripts/test_blockworld_score.py
"""
import copy, hashlib, json, os, sys, tempfile, unittest, wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import blockworld_score as bs

sys.path.insert(0, os.path.join(bs.KIT_DEFAULT, "scripts"))
import numpy as np
from audio import lufs  # the kit's own BS.1770 meter

EXAMPLE = os.path.join(HERE, "..", "renderer", "styles", "blockworld", "example-plan.json")


def scored_plan():
    """The shipped example plan with a caption-led score: two chapters, a boom, an SFX and an ambience bed."""
    plan = json.load(open(EXAMPLE))
    ep = plan["scenes"][0]["props"]["episode"]
    s = ep["scenes"]
    s[0].update(music="bright", hit=True)
    s[1]["sfx"] = [{"t": 1.5, "name": "thud", "gain": 0.9}]
    s[2].update(music="tense", hit=True)
    s[3]["ambience"] = [{"name": "wind", "gain": 0.4}]
    for ps in plan["scenes"]:
        ps["props"]["episode"] = ep
    return plan


def read_wav(p):
    with wave.open(p) as w:
        assert (w.getnchannels(), w.getframerate(), w.getsampwidth()) == (2, 44100, 2)
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").reshape(-1, 2) / 32768.0


class Score(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sfx, cls.moods = bs.load_kit_names(bs.KIT_DEFAULT)
        cls.d = tempfile.mkdtemp()
        cls.a, cls.b = os.path.join(cls.d, "a.wav"), os.path.join(cls.d, "b.wav")
        cls.total = bs.score(scored_plan(), cls.a)
        bs.score(scored_plan(), cls.b)

    def test_length_equals_episode(self):
        x = read_wav(self.a)
        self.assertAlmostEqual(self.total, 16.8)
        self.assertEqual(len(x), int(self.total * 44100))  # rescale in timing.ts is then the identity

    def test_loudness_and_peak(self):
        x = read_wav(self.a)
        L = lufs(x)
        print(f"\n  score: {len(x) / 44100:.3f}s  {L:.2f} LUFS  peak {20 * np.log10(np.abs(x).max()):.2f} dBFS", file=sys.stderr)
        self.assertLess(abs(L - (-15.4)), 0.5)
        self.assertLess(np.abs(x).max(), 10 ** (-1.0 / 20))

    def test_deterministic(self):
        h = [hashlib.sha256(open(p, "rb").read()).hexdigest() for p in (self.a, self.b)]
        self.assertEqual(h[0], h[1])

    def hostile(self, mutate, needle):
        plan = scored_plan()
        ep = copy.deepcopy(plan["scenes"][0]["props"]["episode"])
        mutate(plan, ep)
        plan["scenes"][0]["props"]["episode"] = ep
        with self.assertRaises(bs.Bad) as cm:
            bs.sanitize(plan, self.sfx, self.moods)
        self.assertIn(needle, str(cm.exception))

    def test_rejects_hostile_inputs(self):
        cases = [
            (lambda p, e: e["scenes"][0].update(music={"file": "../../etc/passwd"}), "music"),
            (lambda p, e: e["scenes"][0].update(music="/abs/score.mp3"), "music"),
            (lambda p, e: e["scenes"][1]["sfx"].append({"file": "/etc/passwd"}), "file"),
            (lambda p, e: e["scenes"][1]["sfx"].append({"name": "../samples/x"}), "bundled"),
            (lambda p, e: e["scenes"][1]["sfx"].append({"name": "boom; rm -rf /"}), "bundled"),
            (lambda p, e: e["scenes"][3]["ambience"].append({"name": "wind", "file": "x.wav"}), "file"),
            (lambda p, e: e["meta"].update(voiceover="../vo.mp3"), "voiceover"),
            (lambda p, e: e["scenes"][0].update(dur=1e9), "dur"),
            (lambda p, e: e["scenes"][0].update(dur=float("nan")), "dur"),
            (lambda p, e: e["scenes"][0].update(dur="4"), "dur"),
            (lambda p, e: e["scenes"][1]["sfx"][0].update(t=99), "sfx.t"),
            (lambda p, e: e["scenes"][1]["sfx"][0].update(gain=1e6), "gain"),
            (lambda p, e: e["scenes"][1].update(sfx=[{"name": "tick"}] * 33), "at most"),
            (lambda p, e: e["scenes"].extend([{"dur": 60}] * 20) or p["scenes"].extend([{"duration_s": 60}] * 20), "max 900"),
            (lambda p, e: p["scenes"][1].update(duration_s=9.9), "duration_s"),
            (lambda p, e: p["scenes"].pop(), "same number"),
            (lambda p, e: e.update(audio={"musicGain": 50}), "musicGain"),
            (lambda p, e: p.update(style="custom"), "style"),
        ]
        for mutate, needle in cases:
            with self.subTest(needle=needle):
                self.hostile(mutate, needle)

    def test_clean_episode_has_only_audio_fields(self):
        ep, _ = bs.sanitize(scored_plan(), self.sfx, self.moods)
        self.assertEqual(ep["meta"], {})
        self.assertNotIn("file", json.dumps(ep))
        self.assertLessEqual(set().union(*[s.keys() for s in ep["scenes"]]),
                             {"dur", "music", "hit", "musicKey", "musicSeed", "transition", "sfx", "ambience", "cards", "hud"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
