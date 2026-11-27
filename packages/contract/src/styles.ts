// Style registry shared by the control plane (acquire/submit/revise validation, list_styles) and the renderer.
// Each style's templates live in renderer/styles/<style>/<template>.html; its doc in docs/styles/<style>.md.
// Only "ready" styles are accepted anywhere: a style becomes ready after its offline preview + final fixture
// passes through the real engine (renderer/test). Each job stores the renderer image digest it was accepted with
// (jobs.renderer_image) and every pod for that job uses it, so a later image/style change never alters an accepted job.
// `version` labels the look; a visible change to a ready style bumps it (old images stay on Docker Hub for pinned jobs).
export const TEMPLATES = ["title", "kinetic-text", "b-roll-caption", "list", "quote", "end-card"] as const;
export const TRANSITIONS = ["cut", "fade", "slide"] as const;

export interface StyleEntry {
  version: string;
  status: "ready" | "pending" | "retired"; // retired: hidden from new jobs, still valid for jobs that pinned it
  label: string;
  summary: string; // one line for list_styles
  templates: readonly string[];
  // The engine muxes exactly one track. "voiceover": TTS or the job's Drive audio. "episode-score": the pod makes
  // the episode's own score (no narrator unless a voiceover is explicitly given; it is mixed under, never retimed).
  // "bundle": the job's footage bundle carries its own sound (voiceover {none: true} at acquire).
  audio: "voiceover" | "episode-score" | "bundle";
  blocked?: string; // why a pending style can't be ready yet
}

export const STYLE_REGISTRY: Record<string, StyleEntry> = {
  explainer: { version: "1", status: "ready", label: "Explainer", summary: "Clean narrated explainer: titles, kinetic text, lists, quotes.", templates: TEMPLATES, audio: "voiceover" },
  "bold-shorts": { version: "1", status: "ready", label: "Bold Shorts", summary: "Loud high-contrast short-form, big type, fast cuts.", templates: TEMPLATES, audio: "voiceover" },
  documentary: { version: "1", status: "ready", label: "Documentary", summary: "Calm serif documentary look with captions over b-roll.", templates: TEMPLATES, audio: "voiceover" },
  stickman: { version: "1", status: "ready", label: "Stickman Explainer", summary: "Flat stick-figure explainer: hoodie hero, letterbox, gold numbers, label pills, fast cuts.", templates: ["hero", "title", "number", "stages", "photo"], audio: "voiceover" },
  flatglow: { version: "1", status: "ready", label: "Flatglow", summary: "Kurzgesagt-like flat glowing science animation: worlds, labelled objects, neon kinetic type, diagrams.", templates: ["title", "scene", "kinetic", "diagram", "list", "end-card"], audio: "voiceover" },
  pov: { version: "1", status: "ready", label: "POV Escalation", summary: "First-person low-poly 3D journey with a stat HUD and italic captions.", templates: ["journey", "title", "end-card"], audio: "voiceover" },
  blockworld: { version: "1", status: "ready", label: "Blockworld", summary: "Blocky low-poly 3D 'What if you kept getting ___' episodes with HUD counters and serif captions.", templates: ["episode"], audio: "episode-score" },
  discovery: { version: "1", status: "ready", label: "Discovery Documentary", summary: "Calm real-media documentary: graded photos with slow moves, gold-pin maps, then/now reveals, serif title/chapter/quote cards.", templates: ["title", "chapter", "photo", "map", "compare", "quote", "end"], audio: "voiceover" },
  // Special: no registry templates; the job's code ships as a package (control-plane upload_package, scene_plan.package).
  custom: { version: "1", status: "ready", label: "Custom kit package", summary: "Per-video code built from a style kit; requires scene_plan.package from upload_package.", templates: [], audio: "voiceover" },
  // Special: the skill styles (doomsday, gta, aviation, paper-style). The pod runs the skill's own render command over a
  // footage bundle (`scripts/vf.mjs footage`): one scene, template "bundle", props {bundle, skill}. No templates in renderer/styles.
  footage: { version: "1", status: "ready", label: "Footage / skill styles", summary: "Doomsday, GTA, aviation, paper-style: the skill's own render over an uploaded footage bundle (make it with `vf footage`).", templates: ["bundle"], audio: "bundle" },
};

/** Styles whose code does not live in renderer/styles/ (it comes with the job). */
export const JOB_CODE_STYLES = ["custom", "footage"];

/** Ready styles the renderer ships in renderer/styles/ (not "custom"/"footage", whose code comes with the job). */
export const STYLE_TEMPLATES: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(STYLE_REGISTRY).filter(([id, s]) => s.status === "ready" && !JOB_CODE_STYLES.includes(id)).map(([id, s]) => [id, s.templates]),
);
/** What acquire and submit/revise accept: every ready style, including "custom". */
export const READY_STYLES = Object.keys(STYLE_REGISTRY).filter((id) => STYLE_REGISTRY[id].status === "ready");

/** Templates of any registered style, including retired ones: accepted jobs keep validating against their style. */
export const templatesFor = (style: string): readonly string[] => STYLE_REGISTRY[style]?.templates ?? [];
