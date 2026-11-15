# GPU benchmark (SPEC §9.3)

`plan-60s.json` is the standard 60 s test video (explainer style, 1080p30, 12 scenes, silent audio).
The control plane's weekly cron (`control-plane/src/bench.ts`, Sunday 03:00 UTC) rents one pod per
available ranked GPU under $2/hr with env `BENCH=1`; the agent renders this plan without uploading and
reports `render_s`. Score = `cost_per_hr * (boot_s + render_s) / 3600` = $ per standard video; the rank
is re-ordered by score and posted to Telegram. A run aborts before it could spend more than $2.

Run it locally on CPU (no GPU needed): `cd renderer && node --test test/render.test.ts`.
