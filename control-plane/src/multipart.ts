// Streaming multipart/form-data reader: yields one file part at a time so a long video's ~800 preview
// frames (~40 MB) never sit in Worker memory at once (formData() buffers it all and the Worker hits its 128 MB limit).

const enc = new TextEncoder();
const dec = new TextDecoder();

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
	const first = needle[0];
	outer: for (let i = hay.indexOf(first, from); i !== -1 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
		for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

function concat(a: Uint8Array, b: Uint8Array) {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

export function boundaryOf(contentType: string | null | undefined): string | null {
	const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
	return m ? (m[1] ?? m[2]).trim() : null;
}

/** Yields {name, bytes} for every part (fields too; callers filter). Throws on a part over maxPartBytes. */
export async function* parts(body: ReadableStream<Uint8Array>, boundary: string, maxPartBytes: number) {
	const delim = enc.encode(`\r\n--${boundary}`);
	const reader = body.getReader();
	// Prefix CRLF so the first "--boundary" matches the same delimiter as every later one.
	let buf = enc.encode("\r\n");
	let started = false;
	let done = false;
	for (;;) {
		const at = indexOf(buf, delim);
		if (at === -1) {
			if (done) return;
			if (buf.length > maxPartBytes + 64 * 1024) throw new Error(`multipart part over ${maxPartBytes} bytes`);
			const r = await reader.read();
			if (r.done) done = true;
			else buf = concat(buf, r.value);
			continue;
		}
		if (started) {
			const part = buf.subarray(0, at);
			const h = indexOf(part, enc.encode("\r\n\r\n"));
			if (h !== -1) {
				const name = /name="([^"]*)"/.exec(dec.decode(part.subarray(0, h)))?.[1] ?? "";
				const bytes = part.slice(h + 4);
				if (bytes.length > maxPartBytes) throw new Error(`${name} is ${bytes.length} bytes; max ${maxPartBytes}`);
				yield { name, bytes };
			}
		}
		started = true;
		buf = buf.slice(at + delim.length);
		// After a delimiter: "--" ends the body, otherwise CRLF then the next part's headers.
		while (buf.length < 2 && !done) {
			const r = await reader.read();
			if (r.done) done = true;
			else buf = concat(buf, r.value);
		}
		if (buf[0] === 45 && buf[1] === 45) return;
		buf = buf.slice(2);
	}
}
