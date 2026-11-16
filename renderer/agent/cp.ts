// Control-plane client: SPEC §5 Agent API with Bearer JOB_TOKEN.
import type {
	Cmd, DoneIn, ErrorIn, ErrorOut, HeartbeatIn, HelloIn, HelloOut, SpecOut, UploadSessionIn, UploadSessionOut,
} from "../../packages/contract/src/index.ts";

export class Gone extends Error {} // job terminal or token rejected: stop and self-destruct
export class Held extends Error {} // control plane answered but deliberately held us (X-VF-Hold): reachable, retry

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
		if (res.status === 401 || res.status === 410) throw new Gone(`${path}: ${res.status} ${await res.text()}`);
		return res;
	}
	async post<T>(path: string, body: unknown): Promise<T> {
		const res = await this.req(path, { method: "POST", body: JSON.stringify(body) });
		if (!res.ok) {
			const msg = `${path}: ${res.status} ${(await res.text()).slice(0, 300)}`;
			throw res.headers.get("X-VF-Hold") ? new Held(msg) : new Error(msg);
		}
		return (await res.json()) as T;
	}

	hello = (b: HelloIn) => this.post<HelloOut>("/hello", b);
	heartbeat = (b: HeartbeatIn) => this.post<{ cmd: Cmd | `fault:${string}` }>("/heartbeat", b);
	error = (b: ErrorIn) => this.post<ErrorOut>("/error", b);
	uploadSession = (b: UploadSessionIn) => this.post<UploadSessionOut>("/upload-session", b);
	done = (b: DoneIn) => this.post<unknown>("/done", b);
	bench = (render_s: number) => this.post<unknown>("/bench", { render_s });
	voiceover = () => this.req("/input/voiceover", {}, 600_000);

	/** Long-poll until a plan arrives. */
	async spec(): Promise<SpecOut> {
		for (;;) {
			const res = await this.req("/spec");
			if (res.status === 200) return (await res.json()) as SpecOut;
			if (res.status !== 204) await new Promise((r) => setTimeout(r, 3000));
		}
	}

	async previews(frames: Map<string, Buffer>) {
		const form = new FormData();
		for (const [name, jpeg] of frames) form.append(name, new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), `${name}.jpg`);
		const res = await this.req("/previews", { method: "POST", body: form });
		if (res.status !== 201) throw new Error(`/previews: ${res.status} ${(await res.text()).slice(0, 300)}`);
	}
}
