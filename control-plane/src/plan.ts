// scene_plan validation (CONTRACT Extension 6). Returns precise errors Claude can fix and resubmit.
import type { ScenePlan } from "../../packages/contract/src/index";
import { TRANSITIONS, templatesFor } from "../../packages/contract/src/styles";
import { CONSTANTS } from "./config";

export const PACKAGE_ID = /^pk_[0-9a-f]{24}$/;

export const PLAN_MAX_BYTES = 1_500_000;

export function validatePlan(p: unknown, jobStyle: string): string[] {
	const errs: string[] = [];
	const plan = p as Partial<ScenePlan>;
	if (!plan || typeof plan !== "object") return ["scene_plan must be an object {style, fps, resolution, scenes}"];
	// jobs.plan_json is one D1 row (2,000,000-byte row limit): keep a margin for the other columns.
	const bytes = new TextEncoder().encode(JSON.stringify(p)).length;
	if (bytes > PLAN_MAX_BYTES) errs.push(`scene_plan is ${(bytes / 1e6).toFixed(2)} MB serialized; the limit is 1.5 MB including inline data: images. Resize/recompress images (about 1280 px, JPEG q75) or use fewer, then resubmit`);
	if (plan.style !== jobStyle) errs.push(`style must be "${jobStyle}" (the job's style), got ${JSON.stringify(plan.style)}`);
	if (typeof plan.fps !== "number" || !Number.isInteger(plan.fps) || plan.fps < 12 || plan.fps > 60) errs.push("fps must be an integer 12..60, e.g. 30");
	const m = typeof plan.resolution === "string" ? /^(\d{3,4})x(\d{3,4})$/.exec(plan.resolution) : null;
	if (!m || +m[1] > 3840 || +m[2] > 3840 || +m[1] % 2 || +m[2] % 2) errs.push('resolution must be "<even width>x<even height>" up to 3840, e.g. "1920x1080"');
	if (!Array.isArray(plan.scenes) || !plan.scenes.length) return [...errs, "scenes must be a non-empty array"];
	const custom = jobStyle === "custom";
	if (custom) {
		if (typeof plan.package !== "string" || !PACKAGE_ID.test(plan.package)) errs.push('package must be a package_id from upload_package ("pk_" + 24 hex) for style custom');
	} else if (plan.package !== undefined) errs.push(`package is only allowed with style "custom", not ${jobStyle}`);
	const templates = templatesFor(jobStyle);
	let total = 0;
	plan.scenes.forEach((s, i) => {
		const at = `scenes[${i}]`;
		if (s?.n !== i + 1) errs.push(`${at}.n must be ${i + 1} (1-based, contiguous)`);
		if (custom ? !(typeof s?.template === "string" && /^[a-z0-9-]{1,40}$/.test(s.template)) : !templates.includes(s?.template)) errs.push(custom ? `${at}.template must match [a-z0-9-]{1,40} (a <template>.html in the package)` : `${at}.template "${s?.template}" is not in style ${jobStyle}: ${templates.join(", ")}`);
		if (!s?.props || typeof s.props !== "object" || Array.isArray(s.props)) errs.push(`${at}.props must be an object`);
		if (typeof s?.duration_s !== "number" || !(s.duration_s > 0)) errs.push(`${at}.duration_s must be a number > 0`);
		else total += s.duration_s;
		if (typeof s?.narration !== "string") errs.push(`${at}.narration must be a string`);
		if (!(TRANSITIONS as readonly string[]).includes(s?.transition)) errs.push(`${at}.transition must be one of ${TRANSITIONS.join(", ")}`);
	});
	if (total > CONSTANTS.MAX_VIDEO_MIN * 60 + 0.1) errs.push(`total duration ${total.toFixed(1)} s exceeds the ${CONSTANTS.MAX_VIDEO_MIN} min maximum`);
	return errs;
}

/** RFC 7386 JSON merge patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
	const out: Record<string, unknown> = target && typeof target === "object" && !Array.isArray(target) ? { ...(target as object) } : {};
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete out[k];
		else out[k] = mergePatch(out[k], v);
	}
	return out;
}
