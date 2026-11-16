// SPEC §7 Contract D, control-plane side. Port of scripts/google_oauth.py smoketest.
// Access token cached in KV until 60 s before expiry. invalid_grant -> DriveAuthError (job fails drive_auth).
import type { DriveFileMeta, GoogleTokenResp } from "../../packages/contract/src/index";

const DRIVE = "https://www.googleapis.com/drive/v3";
const KV_KEY = "google_access_token";

export class DriveAuthError extends Error {}

export async function accessToken(env: Env): Promise<string> {
	const cached = await env.OAUTH_KV.get(KV_KEY);
	if (cached) return cached;
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: env.GOOGLE_REFRESH_TOKEN,
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
		}),
	});
	const text = await res.text();
	if (!res.ok) {
		if (text.includes("invalid_grant")) throw new DriveAuthError("invalid_grant: re-run scripts/google_oauth.py auth");
		throw new Error(`google token ${res.status}: ${text.slice(0, 200)}`);
	}
	const t = JSON.parse(text) as GoogleTokenResp;
	await env.OAUTH_KV.put(KV_KEY, t.access_token, { expirationTtl: Math.max(60, t.expires_in - 60) });
	return t.access_token;
}

async function g(env: Env, url: string, init: RequestInit = {}) {
	const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${await accessToken(env)}`, ...init.headers } });
	if (res.status === 401) {
		await env.OAUTH_KV.delete(KV_KEY); // stale token: next call refreshes
	}
	return res;
}

/** Resumable session in DRIVE_FOLDER_ID named "<title>.mp4". Returns only the session URI. */
export async function createSession(env: Env, name: string, size: number): Promise<string> {
	const res = await g(env, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
		method: "POST",
		headers: {
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Length": String(size),
			"X-Upload-Content-Type": "video/mp4",
		},
		body: JSON.stringify({ name, parents: [env.DRIVE_FOLDER_ID] }),
	});
	const loc = res.headers.get("Location");
	if (!res.ok || !loc) throw new Error(`drive session ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return loc;
}

export async function fileMeta(env: Env, fileId: string): Promise<DriveFileMeta> {
	const res = await g(env, `${DRIVE}/files/${encodeURIComponent(fileId)}?fields=size,md5Checksum,webViewLink`);
	if (!res.ok) throw new Error(`drive meta ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return (await res.json()) as DriveFileMeta;
}

export async function shareAnyone(env: Env, fileId: string) {
	const res = await g(env, `${DRIVE}/files/${encodeURIComponent(fileId)}/permissions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ role: "reader", type: "anyone" }),
	});
	if (!res.ok) throw new Error(`drive share ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function deleteFile(env: Env, fileId: string) {
	await g(env, `${DRIVE}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
}

/** GET /input/voiceover: stream the Drive audio file through to the pod. */
export async function streamFile(env: Env, fileId: string): Promise<Response> {
	const res = await g(env, `${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`);
	if (!res.ok) return new Response(`drive ${res.status}`, { status: 502 });
	return new Response(res.body, { headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream" } });
}

/** Upload an input file (voiceover audio) into DRIVE_FOLDER_ID so the app's drive.file token can read it back. */
export async function uploadInput(env: Env, name: string, type: string, body: ArrayBuffer): Promise<string> {
	const res = await g(env, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
		method: "POST",
		headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(body.byteLength), "X-Upload-Content-Type": type },
		body: JSON.stringify({ name, parents: [env.DRIVE_FOLDER_ID] }),
	});
	const loc = res.headers.get("Location");
	if (!res.ok || !loc) throw new Error(`drive session ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const put = await fetch(loc, { method: "PUT", headers: { "Content-Type": type }, body });
	if (!put.ok) throw new Error(`drive upload ${put.status}: ${(await put.text()).slice(0, 200)}`);
	return ((await put.json()) as { id: string }).id;
}
