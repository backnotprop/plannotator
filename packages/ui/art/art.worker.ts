// The art worker's entry: wires the engine to the worker scope. Loaded only
// when a person has chosen a background (or opened its settings row), so it
// never rides the boot path.

import { ArtEngine } from "./engine";
import type { FromArtWorker, ToArtWorker } from "./protocol";

interface ArtWorkerScope {
	addEventListener(type: "message", listener: (event: MessageEvent<ToArtWorker>) => void): void;
	postMessage(msg: FromArtWorker, transfer?: Transferable[]): void;
	readonly fonts?: { add(face: FontFace): void };
}

const scope = self as unknown as ArtWorkerScope;

/**
 * A data URL's bytes, decoded here rather than fetched: a page whose CSP has
 * `connect-src 'self'` (the Plannotator Inbox) blocks a worker's fetch of a
 * `data:` URL, and the worker inherits the page's policy.
 */
function dataBytes(url: string): { type: string; bytes: Uint8Array<ArrayBuffer> } | null {
	const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
	if (match === null) return null;
	const type = match[1] ?? "";
	const body = match[3] ?? "";
	if (match[2] === undefined) {
		const text = new TextEncoder().encode(decodeURIComponent(body));
		const bytes = new Uint8Array(new ArrayBuffer(text.length));
		bytes.set(text);
		return { type, bytes };
	}
	const raw = atob(body);
	const bytes = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return { type, bytes };
}

const engine = new ArtEngine({
	now: () => performance.now(),
	clock: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
	clearTimeout: (id) => clearTimeout(id),
	post: (msg, transfer) => scope.postMessage(msg, transfer ?? []),
	loadImage: async (url) => {
		const data = dataBytes(url);
		const blob = data !== null ? new Blob([data.bytes], { type: data.type }) : await (await fetch(url)).blob();
		return createImageBitmap(blob);
	},
	loadFont: async (family, url) => {
		const data = dataBytes(url);
		const face = new FontFace(family, data !== null ? data.bytes.buffer : `url(${JSON.stringify(url)})`);
		await face.load();
		scope.fonts?.add(face);
	},
});

scope.addEventListener("message", (event) => engine.handle(event.data));
