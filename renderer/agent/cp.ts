// Control-plane client: SPEC §5 Agent API with Bearer JOB_TOKEN.
import type {
	Cmd, DoneIn, ErrorIn, ErrorOut, HeartbeatIn, HelloIn, HelloOut, SpecOut, UploadSessionIn, UploadSessionOut,
} from "../../packages/contract/src/index.ts";

export class Gone extends Error {} // job terminal or token rejected: stop and self-destruct
export class Held extends Error {} // control plane answered but deliberately held us (X-VF-Hold): reachable, retry

export const PREVIEW_CHUNK = 60;

export class ControlPlane {
	base: string;
	token: string;
	constructor(base: string, jobId: string, token: string) {
		this.base = `${base.replace(/\/$/, "")}/agent/${encodeURIComponent(jobId)}`;
		this.token = token;
	}

	async req(path: string, init: RequestInit = {}, timeoutMs = 70_000): Promise<Response> {
		const res = await fetch(this.base + path, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
			headers: { Authorization: `Bearer ${this.token}`, ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...init.headers },
		});
		if (res.status === 401 || res.status === 410) throw new Gone(`${path}: ${res.status} ${await res.text().catch(() => "")}`);
		return res;
	}
	async post<T>(path: string, body: unknown): Promise<T> {
		const res = await this.req(path, { method: "POST", body: JSON.stringify(body) });
		if (!res.ok) {
			const msg = `${path}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`;
			throw res.headers.get("X-VF-Hold") ? new Held(msg) : new Error(msg);
		}
		return (await res.json()) as T;
	}

	hello = (b: HelloIn) => this.post<HelloOut>("/hello", b);
	heartbeat = (b: HeartbeatIn) => this.post<{ cmd: Cmd | `fault:${string}` }>("/heartbeat", b);
	error = (b: ErrorIn) => this.post<ErrorOut>("/error", b);
	uploadSession = (b: UploadSessionIn) => this.post<UploadSessionOut>("/upload-session", b);
	/**
	 * /done verifies on Drive and retires the pod server-side, which can outlast the default timeout. It is
	 * idempotent there, so a network error, timeout or 5xx is retried instead of surfacing as a render failure
	 * (which would re-render). A 410 after a retry means our earlier /done (or a failure path) finished the job;
	 * 409 (another file holds the claim) is not a render failure either.
	 * ponytail: retries until the pod TTL self-destructs it; add a cap if a stuck control plane must fail sooner.
	 */
	async done(b: DoneIn, pauseMs = 10_000): Promise<void> {
		for (let i = 0; ; i++) {
			if (i) await new Promise((r) => setTimeout(r, pauseMs));
			let res: Response;
			try {
				res = await this.req("/done", { method: "POST", body: JSON.stringify(b) }, 300_000);
			} catch (e) {
				if (e instanceof Gone && i > 0) return;
				if (e instanceof Gone) throw e;
				console.log(`/done attempt ${i + 1} failed, retrying:`, (e as Error).message);
				continue;
			}
			if (res.ok) return;
			// Status decides; the body is diagnostics only and may itself fail to read.
			const msg = `/done: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`;
			// 409: another file holds the verify claim; not a render failure. The control plane drives what's next.
			if (res.status === 409) return void console.log(msg);
			if (res.status < 500) throw new Error(msg);
			console.log(`${msg}; retrying`);
		}
	}
	bench = (render_s: number) => this.post<unknown>("/bench", { render_s });
	voiceover = () => this.req("/input/voiceover", {}, 600_000);
	pkg = () => this.req("/input/package", {}, 600_000); // style "custom": .tar.gz of the job's style package

	/** Long-poll until a plan arrives. */
	async spec(): Promise<SpecOut> {
		for (;;) {
			const res = await this.req("/spec");
			if (res.status === 200) return (await res.json()) as SpecOut;
			if (res.status !== 204) await new Promise((r) => setTimeout(r, 3000));
		}
	}

	/** Posted in chunks of PREVIEW_CHUNK frames: one request with a long video's ~800 frames exceeds Worker limits.
	 *  The control plane marks the round ready once every scene has its 3 frames, whichever request brings the last. */
	async previews(frames: Map<string, Buffer>) {
		const all = [...frames];
		for (let i = 0; i < all.length; i += PREVIEW_CHUNK) {
			const form = new FormData();
			for (const [name, jpeg] of all.slice(i, i + PREVIEW_CHUNK)) form.append(name, new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), `${name}.jpg`);
			const res = await this.req("/previews", { method: "POST", body: form });
			if (res.status !== 201) throw new Error(`/previews: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
		}
	}
}
