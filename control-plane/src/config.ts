// SPEC §9, §11 + CONTRACT Decisions. Defaults live here; the `config` table overrides them
// (the weekly benchmark writes `gpu_rank`, see bench.ts).
import { CONSTANTS } from "../../packages/contract/src/index";

export { CONSTANTS };

/** §9.2, nearest to India first. A trailing "*" matches any catalog id with that prefix. */
export const REGION_TIERS: string[][] = [
	["AP-IN-1"],
	["EU-RO-1"],
	["EU-CZ-1", "EU-SE-1", "EU-NL-1", "EU-FR-1", "EUR-NO-1", "EUR-IS-1", "EUR-IS-2", "EUR-IS-3"],
	["AP-JP-1"],
	["OC-AU-1"],
	["US-*", "CA-MTL-*"],
];

/** §9.3, exact gpuTypeIds in rank order (groups flattened in the order written). */
export const GPU_RANK: string[] = [
	"NVIDIA GeForce RTX 4090",
	"NVIDIA GeForce RTX 5090",
	"NVIDIA RTX PRO 4500 Blackwell",
	"NVIDIA L40S",
	"NVIDIA RTX 6000 Ada Generation",
	"NVIDIA L40",
	"NVIDIA L4",
	"NVIDIA RTX 4000 Ada Generation",
	"NVIDIA RTX A4500",
	"NVIDIA RTX A5000",
	"NVIDIA GeForce RTX 3090",
	"NVIDIA GeForce RTX 3090 Ti",
	"NVIDIA A40",
	"NVIDIA RTX A6000",
	"NVIDIA RTX 5000 Ada Generation",
	"NVIDIA GeForce RTX 4080",
	"NVIDIA GeForce RTX 4080 SUPER",
	"NVIDIA GeForce RTX 5080",
	"NVIDIA RTX 2000 Ada Generation",
	"NVIDIA RTX A4000",
];

/** §9.3 exclusions (substring match on the normalised id). Defence in depth: GPU_RANK never lists them. */
export const EXCLUDED_GPUS = ["a100", "h100", "h200", "b200", "b300", "a30", "mi300x"];

export const COMPUTE_TIERS = ["GPU/SECURE", "GPU/COMMUNITY", "CPU"] as const;
export const CPU_FLAVORS = ["cpu5c", "cpu3c"] as const;

/** Decisions. */
export const STYLES = ["explainer", "bold-shorts", "documentary"];
export const MAX_PODS_AT_ONCE = CONSTANTS.MAX_PODS_AT_ONCE;
export const MAX_COST_PER_JOB_USD = CONSTANTS.MAX_COST_PER_JOB_USD;
export const MAX_REPLACEMENTS = 2;
export const MAX_REUPLOADS = 2;
export const DEV_DUMMY_IMAGE = "nvidia/cuda:12.4.1-base-ubuntu22.04";

/** RunPod enum values sometimes carry odd spacing ("NVIDIA  RTX A4500"): compare normalised. */
export const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export async function getConfig<T>(db: D1Database, key: string, fallback: T): Promise<T> {
	const row = await db.prepare("SELECT value_json FROM config WHERE key = ?").bind(key).first<{ value_json: string }>();
	return row ? (JSON.parse(row.value_json) as T) : fallback;
}

export async function setConfig(db: D1Database, key: string, value: unknown) {
	await db
		.prepare("INSERT INTO config (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
		.bind(key, JSON.stringify(value))
		.run();
}
