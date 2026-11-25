// Voiceover (Decision): a Drive audio file streamed via GET /input/voiceover, or text -> Kokoro-82M on the pod
// (weights baked into the image, no network at run time). Cached per job in workDir. Output: 48 kHz mono WAV.
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Voiceover } from "../../packages/contract/src/index.ts";
import { durationOf, must } from "./ffmpeg.ts";

export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_VOICE = process.env.TTS_VOICE ?? "af_heart";

export async function prepareVoice(
	vo: Voiceover,
	dir: string,
	fetchDriveAudio: () => Promise<Response>,
): Promise<{ path: string; seconds: number }> {
	if (vo.none) throw new Error("voiceover {none:true} has no voice track (caption-led style)");
	await mkdir(dir, { recursive: true });
	const out = join(dir, "voice.wav");
	if (!existsSync(out)) {
		if (vo.drive_file_id) {
			const res = await fetchDriveAudio();
			if (!res.ok) throw new Error(`GET /input/voiceover ${res.status}`);
			const raw = join(dir, "voice.src");
			await writeFile(raw, Buffer.from(await res.arrayBuffer()));
			await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-ac", "1", "-ar", "48000", out]);
		} else {
			// Child process: Kokoro/ONNX blocks the event loop for tens of seconds, which starved heartbeats.
			// Text goes via a file: argv has length limits and must() echoes args into error messages.
			const txt = join(dir, "voice.txt");
			await writeFile(txt, vo.text!);
			await must(process.execPath, [fileURLToPath(import.meta.url), txt, out]);
		}
	}
	return { path: out, seconds: await durationOf(out) };
}

/** Kokoro-82M via kokoro-js (ONNX on CPU). Sentence by sentence so long scripts stay under the token limit. */
export async function tts(text: string, out: string) {
	const tf = await import("@huggingface/transformers");
	tf.env.allowRemoteModels = process.env.TTS_ALLOW_DOWNLOAD === "1"; // image build only
	if (process.env.TTS_CACHE) tf.env.cacheDir = process.env.TTS_CACHE;
	const { KokoroTTS } = await import("kokoro-js");
	// KokoroTTS.from_pretrained drops session_options, so load the parts ourselves to cap ONNX threads:
	// onnxruntime defaults to one intra-op thread per host core, which thrashes in a CPU-quota'd container.
	const threads = ttsThreads();
	console.error(`tts: onnx intraOpNumThreads=${threads} interOpNumThreads=1`);
	const load = () => tf.StyleTextToSpeech2Model.from_pretrained(KOKORO_MODEL, { dtype: "q8", device: "cpu", session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } });
	const [m, tok] = await Promise.all([retryLocked(load), tf.AutoTokenizer.from_pretrained(KOKORO_MODEL)]);
	const model = new KokoroTTS(m as never, tok as never);
	const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
	const parts: Float32Array[] = [];
	let rate = 24000;
	const speed = Number(process.env.TTS_SPEED) || 1; // >1 talks faster (doomsday narrator ~1.35)
	const gap = () => new Float32Array(Math.round((rate * 0.18) / speed));
	for (const s of sentences) {
		const a = await model.generate(s, { voice: KOKORO_VOICE as never, speed });
		rate = a.sampling_rate;
		parts.push(a.audio as Float32Array, gap());
	}
	const pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) pcm.set(p, (o += p.length) - p.length);
	const raw = out.replace(/\.wav$/, ".24k.wav");
	await writeFile(raw, wav(pcm, rate));
	await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-ac", "1", "-ar", "48000", out]);
}

/** Windows: a just-downloaded model can be locked for a moment (antivirus scan), and onnxruntime then fails with
 * "system error number 13" (access denied). Retry those, 1+2+4+8 s; anything else throws at once. */
export async function retryLocked<T>(fn: () => Promise<T>, waits = [1000, 2000, 4000, 8000]): Promise<T> {
	for (let i = 0; ; i++)
		try {
			return await fn();
		} catch (e) {
			if (i >= waits.length || !/system error number 13|EACCES|EBUSY|EPERM/.test(String((e as Error)?.message ?? e))) throw e;
			console.error(`tts: model file busy (${(e as Error).message.slice(-60)}), retrying in ${waits[i] / 1000} s`);
			await new Promise((r) => setTimeout(r, waits[i]));
		}
}

/** TTS_THREADS, else min(4, cgroup v2 CPU quota or available cores). */
export function ttsThreads(): number {
	const env = Number(process.env.TTS_THREADS);
	if (env >= 1) return Math.floor(env);
	let cores = availableParallelism();
	try {
		const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
		if (quota !== "max") cores = Math.min(cores, Math.max(1, Math.ceil(Number(quota) / Number(period))));
	} catch {} // no cgroup v2 (macOS, v1 hosts): host cores
	return Math.min(4, cores); // 4 matched 8 for speed at half the CPU (local measurement)
}

function wav(pcm: Float32Array, rate: number): Buffer {
	const b = Buffer.alloc(44 + pcm.length * 2);
	b.write("RIFF", 0);
	b.writeUInt32LE(36 + pcm.length * 2, 4);
	b.write("WAVEfmt ", 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(1, 22);
	b.writeUInt32LE(rate, 24);
	b.writeUInt32LE(rate * 2, 28);
	b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34);
	b.write("data", 36);
	b.writeUInt32LE(pcm.length * 2, 40);
	for (let i = 0; i < pcm.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
	return b;
}

/** Silent track of a given length (bench runs, and tests). */
export async function silence(seconds: number, out: string) {
	await must("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(seconds), out]);
	return { path: out, seconds };
}

// `node voice.ts <text-file> <out.wav>`: TTS in its own process (used by prepareVoice).
if (process.argv[1] === fileURLToPath(import.meta.url)) await tts(await readFile(process.argv[2], "utf8"), process.argv[3]);
