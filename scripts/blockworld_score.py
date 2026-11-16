#!/usr/bin/env python3
"""Pre-rental score for a `blockworld` plan: the kit's own procedural score + SFX, on the episode timeline.

    python3 scripts/blockworld_score.py PLAN.json OUT.wav [--kit "style-kits/3d minecraft"]

Reads the plan, takes the episode from scene 1, keeps ONLY the audio fields the kit's audio.py reads, checks
them against fixed whitelists and bounds, writes that clean episode to a temp dir and runs the kit's
scripts/audio.py on it (argument list, no shell, PYTHONHASHSEED=0 so its SFX seeds are stable). Output is a
44.1 kHz stereo WAV exactly sum(scene.dur) long, mastered to -15.4 LUFS. Upload it as the job's Drive audio:
the engine's one-track contract holds and the scene rescale is the identity (audio length == episode length).

No file inputs are ever passed through: music/sfx `file` entries and `meta.voiceover` are rejected, so the
only audio sources are the kit's bundled instrument samples and its synthesized effects.
Needs python3 with numpy + scipy, ffmpeg, and the kit checkout (style-kits/ is gitignored; samples ~69 MB).
"""
import json, math, os, subprocess, sys, tempfile

KIT_DEFAULT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "style-kits", "3d minecraft")

# Mirrors audio.py SFX_NAMES and cues.py CUES/ALIASES (checked against the kit at run time in load_kit_names).
MAX_TOTAL_S, MAX_SCENES, MAX_SCENE_S, MAX_EVENTS = 900.0, 400, 60.0, 32
CARD_TYPES = {"bubble", "pill", "tag", "chip", "phone_call", "notification", "title", "big_number", "stat", "receipt",
              "leaderboard", "list_stamp", "schedule", "clock", "phone_msg", "compare", "bars", "arrow_label", "image_text"}
TRANSITIONS = {None, "cut", "dip", "rewind", "flash", "fade_in"}


class Bad(ValueError):
    pass


def num(v, lo, hi, what):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise Bad(f"{what}: expected a number in [{lo}, {hi}], got {v!r}")
    return float(v)


def name(v, allowed, what):
    if not isinstance(v, str) or v not in allowed:
        raise Bad(f"{what}: {v!r} is not one of the kit's bundled names")
    return v


def sanitize(plan, sfx_names, moods):
    """Plan -> minimal episode dict for audio.py. Raises Bad on anything outside the whitelist."""
    if not isinstance(plan, dict) or plan.get("style") != "blockworld":
        raise Bad("plan.style must be blockworld")
    pscenes = plan.get("scenes")
    if not isinstance(pscenes, list) or not pscenes:
        raise Bad("plan.scenes missing")
    ep = (pscenes[0].get("props") or {}).get("episode") if isinstance(pscenes[0], dict) else None
    if not isinstance(ep, dict):
        raise Bad("scene 1 props.episode missing")
    meta = ep.get("meta") or {}
    if not isinstance(meta, dict) or meta.get("voiceover") not in (None, False, ""):
        raise Bad("meta.voiceover: caption-led episodes have no narrator; file inputs are not accepted")
    scenes = ep.get("scenes")
    if not isinstance(scenes, list) or not 0 < len(scenes) <= MAX_SCENES:
        raise Bad(f"episode.scenes: 1..{MAX_SCENES} scenes required")
    if len(pscenes) != len(scenes):
        raise Bad("plan and episode must have the same number of scenes")
    acfg_in = ep.get("audio") or {}
    if not isinstance(acfg_in, dict):
        raise Bad("episode.audio must be an object")
    acfg = {}
    for k, lo, hi in (("gap", 0, 2), ("musicGain", 0, 2), ("sfxGain", 0, 2), ("boomGain", 0, 2)):
        if k in acfg_in:
            acfg[k] = num(acfg_in[k], lo, hi, f"audio.{k}")
    if "auto" in acfg_in:
        acfg["auto"] = bool(acfg_in["auto"])
    out, total = [], 0.0
    for i, (s, ps) in enumerate(zip(scenes, pscenes)):
        w = f"scene {i + 1}"
        if not isinstance(s, dict):
            raise Bad(f"{w}: not an object")
        dur = num(s.get("dur"), 0.1, MAX_SCENE_S, f"{w}.dur")
        if not isinstance(ps, dict) or not math.isclose(num(ps.get("duration_s"), 0.1, MAX_SCENE_S, f"{w}.duration_s"), dur, abs_tol=1e-6):
            raise Bad(f"{w}: plan duration_s must equal episode dur (the score is cut to the episode timeline)")
        total += dur
        c = {"dur": dur}
        m = s.get("music")
        if m is not None:
            c["music"] = m if m == "silence" else name(m, moods, f"{w}.music")
        if "hit" in s:
            c["hit"] = bool(s["hit"])
        if "musicKey" in s:
            c["musicKey"] = int(num(s["musicKey"], -12, 12, f"{w}.musicKey"))
        if "musicSeed" in s:
            c["musicSeed"] = int(num(s["musicSeed"], 0, 10_000, f"{w}.musicSeed"))
        if s.get("transition") not in TRANSITIONS:
            raise Bad(f"{w}.transition: {s.get('transition')!r}")
        if s.get("transition"):
            c["transition"] = s["transition"]
        for key in ("sfx", "ambience", "cards"):
            v = s.get(key, [])
            if not isinstance(v, list) or len(v) > MAX_EVENTS:
                raise Bad(f"{w}.{key}: list of at most {MAX_EVENTS}")
        c["sfx"] = [{"name": name(e.get("name"), sfx_names, f"{w}.sfx.name"), "t": num(e.get("t", 0), 0, dur, f"{w}.sfx.t"),
                     "gain": num(e.get("gain", 0.8), 0, 2, f"{w}.sfx.gain")} for e in map(_obj, s.get("sfx", []))]
        c["ambience"] = [{"name": name(e.get("name"), sfx_names, f"{w}.ambience.name"), "t": (t := num(e.get("t", 0), 0, dur, f"{w}.ambience.t")),
                          "d": num(e.get("d", max(0.1, dur - t)), 0.1, max(0.1, dur - t), f"{w}.ambience.d"),
                          "gain": num(e.get("gain", 0.5), 0, 2, f"{w}.ambience.gain")} for e in map(_obj, s.get("ambience", []))]
        cards = []
        for e in map(_obj, s.get("cards", [])):
            cd = {"type": name(e.get("type"), CARD_TYPES, f"{w}.cards.type"), "t": num(e.get("t", 0), 0, dur, f"{w}.cards.t")}
            if e.get("declineAt") is not None:
                cd["declineAt"] = num(e["declineAt"], 0, MAX_SCENE_S, f"{w}.cards.declineAt")
            st = e.get("stampTimes", [])
            if not isinstance(st, list) or len(st) > MAX_EVENTS:
                raise Bad(f"{w}.cards.stampTimes: list of at most {MAX_EVENTS}")
            if st:
                cd["stampTimes"] = [num(q, 0, MAX_SCENE_S, f"{w}.cards.stampTimes") for q in st]
            if e.get("from") is not None:
                cd["from"] = 0
            if e.get("countDur") is not None:
                cd["countDur"] = num(e["countDur"], 0, 10, f"{w}.cards.countDur")
            cards.append(cd)
        c["cards"] = cards
        stt = (s.get("hud") or {}).get("status") if isinstance(s.get("hud"), dict) else None
        if isinstance(stt, str):
            c["hud"] = {"status": stt[:80]}
        elif isinstance(stt, dict) and isinstance(stt.get("value"), str):
            c["hud"] = {"status": {"value": stt["value"][:80], "tone": stt.get("tone") if stt.get("tone") in ("neutral", "good", "bad") else None}}
        out.append(c)
    if total > MAX_TOTAL_S:
        raise Bad(f"episode is {total:.1f}s; max {MAX_TOTAL_S:.0f}s")
    return {"meta": {}, "audio": acfg, "scenes": out}, total


def _obj(e):
    if not isinstance(e, dict) or "file" in e:
        raise Bad("audio events must be objects naming a bundled sound; `file` inputs are not accepted")
    return e


def load_kit_names(kit):
    """Ask the kit itself for its SFX and mood names (so the whitelist can never drift from what it can play)."""
    code = ("import json,sys;sys.path.insert(0,sys.argv[1]);import audio,cues;"
            "print(json.dumps([audio.SFX_NAMES, sorted(set(cues.CUES)|set(cues.ALIASES))]))")
    r = subprocess.run([sys.executable, "-c", code, os.path.join(kit, "scripts")], capture_output=True, text=True, check=True)
    sfx, moods = json.loads(r.stdout)
    return set(sfx), set(moods)


def score(plan, out_wav, kit=KIT_DEFAULT):
    sfx, moods = load_kit_names(kit)
    ep, total = sanitize(plan, sfx, moods)
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "episode.json")
        with open(p, "w") as f:
            json.dump(ep, f)
        env = {**os.environ, "PYTHONHASHSEED": "0"}
        subprocess.run([sys.executable, os.path.join(kit, "scripts", "audio.py"), p, os.path.abspath(out_wav)],
                       cwd=d, env=env, check=True, capture_output=True, timeout=1800)
    return total


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) not in (2, 4) or (len(a) == 4 and a[2] != "--kit"):
        sys.exit(__doc__)
    try:
        with open(a[0]) as f:
            secs = score(json.load(f), a[1], a[3] if len(a) == 4 else KIT_DEFAULT)
    except Bad as e:
        sys.exit(f"rejected: {e}")
    print(json.dumps({"audio": a[1], "seconds": round(secs, 3)}))
