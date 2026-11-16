import { describe, expect, it } from "vitest";
import { boundaryOf, parts } from "../src/multipart";

/** Re-chunk a stream into tiny pieces so delimiters straddle chunk edges. */
function rechunk(bytes: Uint8Array, size: number) {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(c) {
			if (i >= bytes.length) return c.close();
			c.enqueue(bytes.slice(i, i + size));
			i += size;
		},
	});
}

describe("streaming multipart", () => {
	it("yields every file part byte-exact, across odd chunk sizes", async () => {
		const files = Array.from({ length: 30 }, (_, k) => Uint8Array.from({ length: 1000 + k * 37 }, (_, j) => (j * 31 + k) % 256));
		const form = new FormData();
		files.forEach((f, k) => form.append(`scene-${k + 1}-${k % 3}`, new Blob([f], { type: "image/jpeg" }), `f${k}.jpg`));
		form.append("note", "text field");
		const req = new Request("http://x", { method: "POST", body: form });
		const boundary = boundaryOf(req.headers.get("Content-Type"))!;
		const raw = new Uint8Array(await req.arrayBuffer());
		for (const size of [7, 333, 65536]) {
			const got: { name: string; bytes: Uint8Array }[] = [];
			for await (const p of parts(rechunk(raw, size), boundary, 500 * 1024)) got.push(p);
			expect(got.map((p) => p.name)).toEqual([...files.map((_, k) => `scene-${k + 1}-${k % 3}`), "note"]);
			got.slice(0, 30).forEach((p, k) => expect(p.bytes).toEqual(files[k]));
		}
	});

	it("rejects an oversized part", async () => {
		const form = new FormData();
		form.append("scene-1-0", new Blob([new Uint8Array(2000)]), "a.jpg");
		const req = new Request("http://x", { method: "POST", body: form });
		const gen = parts(req.body!, boundaryOf(req.headers.get("Content-Type"))!, 1000);
		await expect((async () => { for await (const _ of gen); })()).rejects.toThrow(/max 1000/);
	});
});
