import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_IMAGE_CSP } from "../generated/local-image.ts";
import { handleImageRequest } from "./handlers.ts";
import { requestUrl } from "./helpers.ts";

// The Pi mirror of packages/server/local-image-route.test.ts: every /api/image
// answer keeps an SVG opened directly sandboxed.
function expectProtected(res: Response): void {
	expect(res.headers.get("content-security-policy")).toBe(LOCAL_IMAGE_CSP);
	expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
}

describe("/api/image response headers (Pi)", () => {
	let dir: string;
	let server: Server;
	let origin: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "plannotator-pi-local-image-"));
		writeFileSync(join(dir, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
		writeFileSync(join(dir, "pic.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		server = createServer((req, res) => handleImageRequest(res, requestUrl(req)));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(dir, { recursive: true, force: true });
	});

	const get = (path: string, base?: string) => {
		const url = new URL("/api/image", origin);
		url.searchParams.set("path", path);
		if (base) url.searchParams.set("base", base);
		return fetch(url);
	};

	test("an SVG is served sandboxed with its image type", async () => {
		const res = await get(join(dir, "pic.svg"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/svg+xml");
		expectProtected(res);
		expect(await res.text()).toContain("<svg");
	});

	test("a PNG is served with the same headers and its bytes unchanged", async () => {
		const res = await get(join(dir, "pic.png"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expectProtected(res);
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	});

	test("a path resolved against base carries the headers", async () => {
		const res = await get("pic.svg", dir);
		expect(res.status).toBe(200);
		expectProtected(res);
	});

	test("refusals carry the headers too", async () => {
		const missingParam = await fetch(new URL("/api/image", origin));
		expect(missingParam.status).toBe(400);
		expectProtected(missingParam);
		const notImage = await get(join(dir, "notes.html"));
		expect(notImage.status).toBe(403);
		expectProtected(notImage);
		const missing = await get(join(dir, "missing.svg"));
		expect(missing.status).toBe(404);
		expectProtected(missing);
	});
});
