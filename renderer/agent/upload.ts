// SPEC §7 pod side: PUT 32 MiB chunks to the session URI (no Authorization header), 308 + Range,
// on a drop query "bytes */size" and resume; on 404/4xx the session is dead: get a new one, restart at 0.
import { open } from "node:fs/promises";
import { CONSTANTS } from "../../packages/contract/src/index.ts";

export interface UploadDeps {
	newSession: () => Promise<string>;
	log: (msg: string) => void;
	dropAfterChunk?: number | null; // Phase 9 fault: simulate a connection drop after chunk N
	onResume?: (offset: number) => void; // called with Drive's 308 Range offset when resuming after a drop
	fetch?: typeof fetch;
	chunk?: number;
}

export async function resumableUpload(path: string, size: number, d: UploadDeps): Promise<string> {
	const f = d.fetch ?? fetch;
	const CHUNK = d.chunk ?? CONSTANTS.DRIVE_CHUNK_BYTES;
	const fh = await open(path, "r");
	try {
		for (let session = 0; session < 3; session++) {
			const uri = await d.newSession();
			let offset = 0;
			let chunkNo = 0;
			let drops = 0;
			while (true) {
				const len = Math.min(CHUNK, size - offset);
				const buf = Buffer.alloc(len);
				await fh.read(buf, 0, len, offset);
				let res: Response | null = null;
				try {
					res = await f(uri, { method: "PUT", body: buf, headers: { "Content-Range": `bytes ${offset}-${offset + len - 1}/${size}` } });
				} catch (e) {
					d.log(`chunk at ${offset} dropped: ${(e as Error).message}`);
				}
				chunkNo++;
				if (res && d.dropAfterChunk === chunkNo) {
					d.log(`fault: simulating a drop after chunk ${chunkNo}`);
					res = null;
				}
				if (!res) {
					if (++drops > 8) throw new Error("too many dropped chunks");
					const q = await f(uri, { method: "PUT", headers: { "Content-Range": `bytes */${size}` } }).catch(() => null);
					if (q && (q.status === 200 || q.status === 201)) return ((await q.json()) as { id: string }).id;
					if (q && q.status === 308) {
						offset = nextOffset(q);
						d.log(`resuming at byte ${offset}`);
						d.onResume?.(offset);
						continue;
					}
					if (q && q.status >= 400 && q.status < 500) break; // dead session
					await new Promise((r) => setTimeout(r, 2000 * drops));
					continue;
				}
				if (res.status === 308) {
					offset = nextOffset(res);
					continue;
				}
				if (res.status === 200 || res.status === 201) return ((await res.json()) as { id: string }).id;
				if (res.status >= 400 && res.status < 500) {
					d.log(`session dead (${res.status}); new session, restart from 0`);
					break;
				}
				// 5xx: query and resume
				const q = await f(uri, { method: "PUT", headers: { "Content-Range": `bytes */${size}` } });
				if (q.status === 308) offset = nextOffset(q);
				else if (q.status === 200 || q.status === 201) return ((await q.json()) as { id: string }).id;
				else break;
			}
		}
		throw new Error("upload failed after 3 sessions");
	} finally {
		await fh.close();
	}
}

/** "Range: bytes=0-b" -> b + 1; no Range header -> nothing stored yet. */
const nextOffset = (r: Response) => {
	const m = /bytes=0-(\d+)/.exec(r.headers.get("Range") ?? "");
	return m ? Number(m[1]) + 1 : 0;
};
