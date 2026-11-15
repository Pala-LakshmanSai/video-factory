// Style library index shared by the control plane (scene_plan validation) and the renderer.
// Each style's templates live in renderer/styles/<style>/<template>.html; its doc in docs/styles/<style>.md.
// The renderer golden test fails if this list and the template files drift apart.
export const TEMPLATES = ["title", "kinetic-text", "b-roll-caption", "list", "quote", "end-card"] as const;
export const TRANSITIONS = ["cut", "fade", "slide"] as const;

export const STYLE_TEMPLATES: Record<string, readonly string[]> = {
  explainer: TEMPLATES,
  "bold-shorts": TEMPLATES,
  documentary: TEMPLATES,
};
