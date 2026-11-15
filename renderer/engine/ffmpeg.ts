// ffmpeg / ffprobe helpers. Encoder per Prompt 6a: h264_nvenc (preset p5, cq 23) when a 1-frame probe
// works, else libx264 -preset veryfast -crf 20 (CPU pods, SPEC §9.1).
import { spawn } from "node:child_process";

export function run(cmd: string, args: string[], input?: NodeJS.ReadableStream): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		p.stdout!.on("data", (d) => (stdout += d));
		p.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-20000)));
		p.on("error", reject);
		p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
		if (input && p.stdin) input.pipe(p.stdin);
	});
}

export async function must(cmd: string, args: string[]) {
	const r = await run(cmd, args);
	if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(" ")} … failed (${r.code}): ${r.stderr.slice(-1500)}`);
	return r;
}

export type Encoder = { name: "h264_nvenc" | "libx264"; args: string[] };

const NVENC: Encoder = { name: "h264_nvenc", args: ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", "0"] };
const X264: Encoder = { name: "libx264", args: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads", "4"] };
const COMMON = ["-pix_fmt", "yuv420p", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1"];

let cached: Encoder | null = null;
export async function pickEncoder(): Promise<Encoder> {
	if (cached) return cached;
	if (process.env.FORCE_X264 === "1") return (cached = X264);
	const r = await run("ffmpeg", ["-hide_banner", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.04", "-frames:v", "1", ...NVENC.args, "-f", "null", "-"]);
	if (r.code !== 0) console.error(`nvenc probe failed (${r.code}), using libx264:\n${r.stderr.slice(-1500)}`);
	return (cached = r.code === 0 ? NVENC : X264);
}
export const encoderArgs = (e: Encoder) => [...e.args, ...COMMON];

export async function durationOf(file: string): Promise<number> {
	const r = await must("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
	return Number(r.stdout.trim());
}
