/**
 * Node mirror of packages/server/external-annotations.imageRegion.test.ts
 * (#2100): POST and PATCH validate `imageRegion` with the same fail-closed
 * parser on the Pi server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createExternalAnnotationHandler } from "./external-annotations.ts";
import { requestUrl } from "./helpers.ts";

const REGION = { v: 1, src: "figures/status-colors.png", sourceLine: 6, box: { x: 1820, y: 380, w: 420, h: 160 }, naturalWidth: 3664, naturalHeight: 1453 };

describe("pi external annotations: imageRegion", () => {
	const handler = createExternalAnnotationHandler("plan");
	let server: Server;
	let base = "";

	beforeAll(async () => {
		server = createServer(async (req, res) => {
			if (!(await handler.handle(req, res, requestUrl(req)))) {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		base = `http://127.0.0.1:${address.port}/api/external-annotations`;
	});

	afterAll(() => {
		server.close();
	});

	const call = async (method: string, url: string, body?: unknown) => {
		const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, body: (await res.json()) as Record<string, any> };
	};

	test("POST stores a valid region and refuses a malformed one; PATCH refuses to clear it", async () => {
		const ok = await call("POST", base, { source: "bot", type: "COMMENT", text: "grey", originalText: REGION.src, imageRegion: { ...REGION, extra: 1 } });
		expect(ok.status).toBe(201);
		const id = ok.body.ids[0] as string;
		const snapshot = (await call("GET", base)).body.annotations as Array<{ id: string; imageRegion?: unknown }>;
		expect(snapshot.find((a) => a.id === id)?.imageRegion).toEqual(REGION);

		const bad = await call("POST", base, { source: "bot", type: "COMMENT", text: "grey", originalText: REGION.src, imageRegion: { ...REGION, box: { ...REGION.box, y: 1400 } } });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toContain("imageRegion");

		expect((await call("PATCH", `${base}?id=${id}`, { imageRegion: null })).status).toBe(400);
		const moved = { ...REGION, box: { x: 1, y: 2, w: 3, h: 4 } };
		const patched = await call("PATCH", `${base}?id=${id}`, { imageRegion: moved });
		expect(patched.status).toBe(200);
		expect(patched.body.annotation.imageRegion).toEqual(moved);
	});
});
