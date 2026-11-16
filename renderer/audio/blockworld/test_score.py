"""No-rental proof for renderer/audio/blockworld/score.py. Needs numpy+scipy, ffmpeg and the samples (assets/samples).

    python3 renderer/audio/blockworld/test_score.py
"""
import copy, hashlib, json, os, sys, tempfile, unittest, wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import score as bs

sys.path.insert(0, os.path.join(bs.KIT_DEFAULT, "scripts"))
import numpy as np
from audio import lufs  # the kit's own BS.1770 meter

EXAMPLE = os.path.join(HERE, "..", "..", "styles", "blockworld", "example-plan.json")


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


def reviewer_plan():
    """Reviewer's baseline: two caption-only scenes (2.25 s + 2.75 s), whimsical score, one sparkle, no voice."""
    ep = {"meta": {"title": "t", "voiceover": None}, "hud": {"counters": []},
          "scenes": [{"id": "a", "dur": 2.25, "music": "whimsical", "hit": True, "captions": [{"t": 0.2, "d": 1.8, "text": "One."}],
                      "sfx": [{"t": 0.5, "name": "sparkle", "gain": 0.8}]},
                     {"id": "b", "dur": 2.75, "captions": [{"t": 0.2, "d": 2.3, "text": "Two."}]}]}
    return {"style": "blockworld", "fps": 30, "resolution": "1920x1080",
            "scenes": [{"n": i + 1, "template": "episode", "duration_s": s["dur"], "props": {"episode": ep}} for i, s in enumerate(ep["scenes"])]}


class Baseline(unittest.TestCase):
    def test_reviewer_case_exact_5s_deterministic(self):
        import time
        d = tempfile.mkdtemp(); a, b = os.path.join(d, "a.wav"), os.path.join(d, "b.wav")
        t0 = time.time(); total = bs.score(reviewer_plan(), a); el = time.time() - t0
        bs.score(reviewer_plan(), b)
        x = read_wav(a)  # asserts stereo, 44.1 kHz, PCM16
        print(f"\n  baseline: {len(x) / 44100:.3f}s in {el:.1f}s, peak {20 * np.log10(np.abs(x).max()):.3f} dBFS", file=sys.stderr)
        self.assertEqual(total, 5.0)
        self.assertEqual(len(x), 5 * 44100)
        with open(a, "rb") as fa, open(b, "rb") as fb:
            self.assertEqual(fa.read(), fb.read())


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
        for ps in plan["scenes"]:
            ps["props"] = {**ps.get("props", {}), "episode": ep}
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
            (lambda p, e: e["scenes"].extend([{"dur": 60}] * 20) or p["scenes"].extend({"duration_s": 60} for _ in range(20)), "max 900"),
            (lambda p, e: p["scenes"][1].update(duration_s=9.9), "duration_s"),
            (lambda p, e: p["scenes"].pop(), "same number"),
            (lambda p, e: e.update(audio={"musicGain": 50}), "musicGain"),
            (lambda p, e: p.update(style="custom"), "style"),
        ]
        for mutate, needle in cases:
            with self.subTest(needle=needle):
                self.hostile(mutate, needle)

    def test_file_inputs_refused_before_anything_runs(self):
        """Each file-backed kind fails validation; only the kit-name lookup ran, never audio.py or ffmpeg."""
        def m(scene, **kw): return lambda e: e["scenes"][scene].update(**kw)
        cases = {
            "score path": m(0, music={"file": "score.mp3"}), "score abs": m(0, music="/tmp/score.mp3"),
            "score url": m(0, music="https://x.test/s.mp3"),
            "sfx path": lambda e: e["scenes"][0]["sfx"].append({"file": "../x.wav"}),
            "sfx url": lambda e: e["scenes"][0]["sfx"].append({"name": "https://x.test/a.wav"}),
            "ambience path": lambda e: e["scenes"][1].update(ambience=[{"name": "wind", "file": "w.wav"}]),
            "voice path": lambda e: e["meta"].update(voiceover="vo.mp3"),
            "voice url": lambda e: e["meta"].update(voiceover="https://x.test/vo.mp3"),
        }
        real = bs.subprocess.run
        for label, mutate in cases.items():
            with self.subTest(label):
                plan = reviewer_plan(); ep = copy.deepcopy(plan["scenes"][0]["props"]["episode"]); mutate(ep)
                for ps in plan["scenes"]: ps["props"]["episode"] = ep
                calls = []
                bs.subprocess.run = lambda argv, *a, **k: (calls.append(argv), real(argv, *a, **k))[1]
                try:
                    with self.assertRaises(bs.Bad):
                        bs.score(plan, os.path.join(self.d, "never.wav"))
                finally:
                    bs.subprocess.run = real
                self.assertEqual(len(calls), 1)            # load_kit_names only
                self.assertEqual(calls[0][1], "-c")
                self.assertFalse(any("audio.py" in str(x) or "ffmpeg" in str(x) for c in calls for x in c))
                self.assertFalse(os.path.exists(os.path.join(self.d, "never.wav")))

    def test_later_scene_with_different_episode_rejected(self):
        plan = scored_plan()
        ep2 = copy.deepcopy(plan["scenes"][0]["props"]["episode"]); ep2["scenes"][2]["music"] = "threat"
        plan["scenes"][3]["props"]["episode"] = ep2
        with self.assertRaises(bs.Bad) as cm:
            bs.sanitize(plan, self.sfx, self.moods)
        self.assertIn("scene 4", str(cm.exception))

    def test_timing_change_requires_rescore(self):
        plan = reviewer_plan(); h0 = bs.episode_hash(plan)
        ep = copy.deepcopy(plan["scenes"][0]["props"]["episode"]); ep["scenes"][1]["dur"] = 3.75
        for ps, s in zip(plan["scenes"], ep["scenes"]): ps["props"]["episode"] = ep; ps["duration_s"] = s["dur"]
        self.assertNotEqual(bs.episode_hash(plan), h0)          # stale score is detectable
        out = os.path.join(self.d, "rescore.wav")
        self.assertEqual(bs.score(plan, out), 6.0)
        self.assertEqual(len(read_wav(out)), 6 * 44100)        # re-score tracks the new timing

    def test_relative_kit_path_cli(self):
        import subprocess
        root = os.path.abspath(os.path.join(HERE, "..", "..", "..")); plan = os.path.join(self.d, "p.json"); out = os.path.join(self.d, "rel.wav")
        with open(plan, "w") as f: json.dump(reviewer_plan(), f)
        r = subprocess.run([sys.executable, "renderer/audio/blockworld/score.py", plan, out, "--kit", "renderer/audio/blockworld"],
                           cwd=root, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["seconds"], 5.0)

    def test_explicit_voice_keeps_episode_length(self):
        import subprocess
        v = os.path.join(self.d, "v.wav")  # 8 s tone: longer than the 5 s episode, must not retime it
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=8", "-ar", "48000", v], check=True)
        out = os.path.join(self.d, "voiced.wav")
        self.assertEqual(bs.score(reviewer_plan(), out, voice=v), 5.0)
        self.assertEqual(len(read_wav(out)), 5 * 44100)

    def test_clean_episode_has_only_audio_fields(self):
        ep, _ = bs.sanitize(scored_plan(), self.sfx, self.moods)
        self.assertEqual(ep["meta"], {})
        self.assertNotIn("file", json.dumps(ep))
        self.assertLessEqual(set().union(*[s.keys() for s in ep["scenes"]]),
                             {"dur", "music", "hit", "musicKey", "musicSeed", "transition", "sfx", "ambience", "cards", "hud"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
