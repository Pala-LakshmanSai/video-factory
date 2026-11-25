// Synced file bytes in Backblaze B2 (S3-compatible API), so a team member needs only an access key, never GitHub.
// The Worker never carries the bytes: it hands out short-lived signed links and clients move files directly to/from
// B2. Object key "blobs/<sha256>"; the index stores asset "b2:<sha256>". Clients verify every download's sha256.
// Config: vars B2_BUCKET, B2_ENDPOINT (e.g. s3.us-west-004.backblazeb2.com); secrets B2_KEY_ID, B2_APP_KEY.
import { AwsClient } from "aws4fetch";

export const B2_ASSET = /^b2:([0-9a-f]{64})$/;
const SHA = /^[0-9a-f]{64}$/;
const LINK_S = 3600; // signed links last an hour: enough for a 1.9 GB upload on a slow line
const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });

type B2Env = { B2_KEY_ID?: string; B2_APP_KEY?: string; B2_BUCKET?: string; B2_ENDPOINT?: string };
export type Store = { client: AwsClient; base: string };

export function b2(e: unknown): Store | null {
	const v = e as B2Env;
	if (!v.B2_KEY_ID || !v.B2_APP_KEY || !v.B2_BUCKET || !v.B2_ENDPOINT) return null;
	const region = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(v.B2_ENDPOINT)?.[1] ?? "us-west-004";
	return { client: new AwsClient({ accessKeyId: v.B2_KEY_ID, secretAccessKey: v.B2_APP_KEY, service: "s3", region }), base: `https://${v.B2_ENDPOINT}/${v.B2_BUCKET}` };
}

async function link(s: Store, method: "GET" | "PUT", sha: string) {
	const r = await s.client.sign(`${s.base}/blobs/${sha}?X-Amz-Expires=${LINK_S}`, { method, aws: { signQuery: true } });
	return r.url;
}

/** GET /sync/blob/<sha> → 302 to a signed download link; POST /sync/blob/<sha>/upload → {exists} or {url} to PUT. */
export async function blobRoute(req: Request, s: Store | null, parts: string[]): Promise<Response> {
	if (!s) return bad("file storage (Backblaze B2) is not configured on this server", 503);
	const [sha, action] = parts;
	if (!SHA.test(sha ?? "")) return bad("bad sha");
	if (!action && req.method === "GET") return new Response(null, { status: 302, headers: { Location: await link(s, "GET", sha), "Cache-Control": "no-store" } });
	if (action === "upload" && req.method === "POST") {
		const head = await s.client.fetch(`${s.base}/blobs/${sha}`, { method: "HEAD" });
		if (head.status === 200) return Response.json({ exists: true, asset: `b2:${sha}`, size: Number(head.headers.get("Content-Length") ?? 0) });
		if (head.status !== 404) return bad(`storage check failed (${head.status})`, 502);
		return Response.json({ exists: false, asset: `b2:${sha}`, url: await link(s, "PUT", sha) });
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
