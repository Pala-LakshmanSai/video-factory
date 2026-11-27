// Synced file bytes in S3-compatible object storage, so a team member needs only an access key, never GitHub.
// The Worker never carries the bytes: it hands out short-lived signed links and clients move files directly to/from
// storage. Object key "blobs/<sha256>"; the index stores asset "b2:<sha256>" (the prefix dates from Backblaze; it just
// means "content-addressed object"). Clients verify every download's sha256.
// Config, first match wins:
//   Cloudflare R2 (another Cloudflare account; free egress, no daily cap): secrets R2_ENDPOINT (the bucket's S3 API
//     link, https://<account>.r2.cloudflarestorage.com/<bucket>), R2_KEY_ID, R2_SECRET.
//   Backblaze B2 (old; free plan caps downloads at 1 GB/day): vars B2_BUCKET, B2_ENDPOINT; secrets B2_KEY_ID, B2_APP_KEY.
import { AwsClient } from "aws4fetch";

export const B2_ASSET = /^b2:([0-9a-f]{64})$/;
const SHA = /^[0-9a-f]{64}$/;
const LINK_S = 3600; // signed links last an hour: enough for a 1.9 GB upload on a slow line
const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });

type B2Env = { B2_KEY_ID?: string; B2_APP_KEY?: string; B2_BUCKET?: string; B2_ENDPOINT?: string; R2_ENDPOINT?: string; R2_KEY_ID?: string; R2_SECRET?: string };
export type Store = { client: AwsClient; base: string };

export function b2(e: unknown): Store | null {
	const v = e as B2Env;
	if (v.R2_ENDPOINT && v.R2_KEY_ID && v.R2_SECRET) {
		const base = (/^https?:\/\//.test(v.R2_ENDPOINT.trim()) ? v.R2_ENDPOINT.trim() : `https://${v.R2_ENDPOINT.trim()}`).replace(/\/+$/, "");
		return { client: new AwsClient({ accessKeyId: v.R2_KEY_ID.trim(), secretAccessKey: v.R2_SECRET.trim(), service: "s3", region: "auto" }), base };
	}
	if (!v.B2_KEY_ID || !v.B2_APP_KEY || !v.B2_BUCKET || !v.B2_ENDPOINT) return null;
	const region = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(v.B2_ENDPOINT)?.[1] ?? "us-west-004";
	return { client: new AwsClient({ accessKeyId: v.B2_KEY_ID, secretAccessKey: v.B2_APP_KEY, service: "s3", region }), base: `https://${v.B2_ENDPOINT}/${v.B2_BUCKET}` };
}

// "blobs": synced skill/kit files (garbage-collected against the index). "footage": footage-job bundles
// (`vf footage`, style "footage"); gc never looks there.
export type Prefix = "blobs" | "footage";

async function link(s: Store, method: "GET" | "PUT", sha: string, prefix: Prefix = "blobs") {
	const r = await s.client.sign(`${s.base}/${prefix}/${sha}?X-Amz-Expires=${LINK_S}`, { method, aws: { signQuery: true } });
	return r.url;
}

/** Signed download links for footage objects (style "footage" pods). */
export const footageLink = (s: Store, sha: string) => link(s, "GET", sha, "footage");

/** Does footage/<sha> exist? (submit_job checks a footage plan's manifest before a pod is rented for it.) */
export async function footageExists(s: Store, sha: string) {
	return (await s.client.fetch(`${s.base}/footage/${sha}`, { method: "HEAD" })).status === 200;
}

/** The footage object's bytes as text (the bundle manifest), or null if absent. */
export async function footageText(s: Store, sha: string) {
	const r = await s.client.fetch(`${s.base}/footage/${sha}`);
	return r.status === 200 ? r.text() : null;
}

/** GET /sync/blob/<sha> → 302 to a signed download link; POST /sync/blob/<sha>/upload → {exists} or {url} to PUT.
 *  Same under /sync/footage/ with prefix "footage". */
export async function blobRoute(req: Request, s: Store | null, parts: string[], prefix: Prefix = "blobs"): Promise<Response> {
	if (!s) return bad("file storage is not configured on this server", 503);
	const [sha, action] = parts;
	if (!SHA.test(sha ?? "")) return bad("bad sha");
	if (!action && req.method === "GET") return new Response(null, { status: 302, headers: { Location: await link(s, "GET", sha, prefix), "Cache-Control": "no-store" } });
	if (action === "upload" && req.method === "POST") {
		const head = await s.client.fetch(`${s.base}/${prefix}/${sha}`, { method: "HEAD" });
		if (head.status === 200) return Response.json({ exists: true, asset: `b2:${sha}`, size: Number(head.headers.get("Content-Length") ?? 0) });
		if (head.status !== 404) return bad(`storage check failed (${head.status})`, 502);
		return Response.json({ exists: false, asset: `b2:${sha}`, url: await link(s, "PUT", sha, prefix) });
	}
	return bad("not found", 404);
}

/** Delete stored files nothing in the index points at, older than `days`. */
export async function blobGc(db: D1Database, s: Store, days: number, dry: boolean) {
	const used = new Set((await db.prepare("SELECT DISTINCT asset FROM sync_files WHERE asset LIKE 'b2:%'").all<{ asset: string }>()).results.map((r) => r.asset.slice(3)));
	const cutoff = Date.now() - days * 86400_000;
	const gone: string[] = [];
	let kept = 0;
	let token = "";
	do {
		const r = await s.client.fetch(`${s.base}?list-type=2&prefix=blobs/${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`);
		if (r.status !== 200) throw new Error(`list failed (${r.status})`);
		const xml = await r.text();
		for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
			const sha = /<Key>blobs\/([0-9a-f]{64})<\/Key>/.exec(m[1])?.[1];
			const at = Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1] ?? "");
			if (!sha) continue;
			if (used.has(sha) || !(at < cutoff)) kept++;
			else gone.push(sha);
		}
		token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") : "";
	} while (token);
	if (!dry) for (const sha of gone) await s.client.fetch(`${s.base}/blobs/${sha}`, { method: "DELETE" });
	return { deleted: gone.length, kept, dry };
}
