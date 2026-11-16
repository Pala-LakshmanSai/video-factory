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
  status: "ready" | "pending";
  label: string;
  summary: string; // one line for list_styles
  templates: readonly string[];
  audio: "voiceover"; // the engine muxes exactly one track: TTS or the job's Drive audio (pre-mixed score/SFX go there)
  blocked?: string; // why a pending style can't be ready yet
}

export const STYLE_REGISTRY: Record<string, StyleEntry> = {
  explainer: { version: "1", status: "ready", label: "Explainer", summary: "Clean narrated explainer: titles, kinetic text, lists, quotes.", templates: TEMPLATES, audio: "voiceover" },
  "bold-shorts": { version: "1", status: "ready", label: "Bold Shorts", summary: "Loud high-contrast short-form, big type, fast cuts.", templates: TEMPLATES, audio: "voiceover" },
  documentary: { version: "1", status: "ready", label: "Documentary", summary: "Calm serif documentary look with captions over b-roll.", templates: TEMPLATES, audio: "voiceover" },
};

/** Ready styles only: what acquire, submit/revise and the template loader accept. */
export const STYLE_TEMPLATES: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(STYLE_REGISTRY).filter(([, s]) => s.status === "ready").map(([id, s]) => [id, s.templates]),
);
export const READY_STYLES = Object.keys(STYLE_TEMPLATES);
