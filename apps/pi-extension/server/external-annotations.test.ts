/**
 * External annotations (Pi/Node): PATCH ingest of `inReplyTo`.
 *
 * Node mirror of the PATCH describe in packages/server/external-annotations.test.ts:
 * PATCH merges arbitrary fields, so it was the one way to create an inReplyTo
 * self-reference or cycle; the invalid state is refused at ingest on both
 * runtimes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createExternalAnnotationHandler } from "./external-annotations.ts";
import { requestUrl } from "./helpers.ts";

describe("pi external annotations: PATCH inReplyTo", () => {
	const handler = createExternalAnnotationHandler("plan");
	let server: Server;
	let base = "";

	beforeAll(async () => {
		server = createServer(async (req, res) => {
			const handled = await handler.handle(req, res, requestUrl(req));
			if (!handled) {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		base = `http://127.0.0.1:${address.port}`;
	});

	afterAll(() => {
		server.close();
	});

	const patch = async (id: string, body: unknown) => {
		const res = await fetch(`${base}/api/external-annotations?id=${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: res.status, body: (await res.json()) as { error?: string; annotation?: { inReplyTo?: string } } };
	};

	test("POST accepts a validated diagramAnchor and refuses a malformed one (Node mirror of the Bun case)", async () => {
		const post = async (body: unknown) => {
			const res = await fetch(`${base}/api/external-annotations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return { status: res.status, body: (await res.json()) as { ids?: string[]; error?: string } };
		};
		const anchor = { v: 1, family: "flowchart", kind: "node", id: "D", label: "Approve?", sourceLine: [7, 7] };
		const ok = await post({ source: "review-bot", type: "COMMENT", text: "rename", originalText: "Approve?", diagramAnchor: anchor });
		expect(ok.status).toBe(201);
		const snapshot = (await (await fetch(`${base}/api/external-annotations`)).json()) as {
			annotations: Array<{ id: string; diagramAnchor?: unknown }>;
		};
		expect(snapshot.annotations.find((a) => a.id === ok.body.ids?.[0])?.diagramAnchor).toEqual(anchor);

		const bad = await post({ source: "review-bot", type: "COMMENT", text: "rename", originalText: "Approve?", diagramAnchor: { kind: "node" } });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toContain("diagramAnchor");
	});

	test("refuses an inReplyTo that is self, missing, or would close a cycle; accepts a valid reply", async () => {
		const added = handler.addAnnotations({
			annotations: [
				{ source: "tool", text: "first" },
				{ source: "tool", text: "second" },
			],
		});
		if ("error" in added) throw new Error(added.error);
		const [first, second] = added.ids;

		expect((await patch(first, { inReplyTo: first })).status).toBe(400);
		expect((await patch(first, { inReplyTo: "nope" })).status).toBe(400);
		expect((await patch(first, { inReplyTo: 7 })).status).toBe(400);

		const ok = await patch(second, { inReplyTo: first });
		expect(ok.status).toBe(200);
		expect(ok.body.annotation?.inReplyTo).toBe(first);

		const cycle = await patch(first, { inReplyTo: second });
		expect(cycle.status).toBe(400);
		expect(cycle.body.error).toContain("cycle");

		expect((await patch(second, { inReplyTo: null })).status).toBe(200);
		expect((await patch(second, { text: "still fine" })).status).toBe(200);
	});
});

/**
 * Node mirror of the PATCH body-validation describe in
 * packages/server/external-annotations.test.ts (#1560 follow-up): PATCH used
 * to merge its body verbatim, so `{"diagramAnchor": null}` was answered 200
 * and then blanked the page when the renderer read `.family` off it.
 */
describe("pi external annotations: PATCH body validation", () => {
	const handler = createExternalAnnotationHandler("plan");
	const reviewHandler = createExternalAnnotationHandler("review");
	let server: Server;
	let base = "";

	beforeAll(async () => {
		server = createServer(async (req, res) => {
			const url = requestUrl(req);
			const forReview = url.searchParams.get("mode") === "review";
			const target = forReview ? reviewHandler : handler;
			const handled = await target.handle(req, res, url);
			if (!handled) {
				res.writeHead(404);
				res.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		base = `http://127.0.0.1:${address.port}`;
	});

	afterAll(() => {
		server.close();
	});

	const seed = (target: typeof handler, body: unknown) => {
		const added = target.addAnnotations(body);
		if ("error" in added) throw new Error(added.error);
		return added.ids[0]!;
	};

	const patch = async (id: string, body: unknown, mode?: "review") => {
		const qs = mode ? `&mode=${mode}` : "";
		const res = await fetch(`${base}/api/external-annotations?id=${encodeURIComponent(id)}${qs}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return {
			status: res.status,
			body: (await res.json()) as { error?: string; annotation?: Record<string, unknown> },
		};
	};

	const VALID_ANCHOR = { v: 1, family: "flowchart", kind: "node", id: "D", label: "Approve?", sourceLine: [7, 7] };

	test("refuses every malformed diagramAnchor and leaves the stored one intact", async () => {
		const id = seed(handler, {
			source: "linter",
			type: "COMMENT",
			text: "external finding",
			originalText: "Approve?",
			diagramAnchor: VALID_ANCHOR,
		});

		const nulled = await patch(id, { diagramAnchor: null });
		expect(nulled.status).toBe(400);
		expect(nulled.body.error).toContain("diagramAnchor");

		for (const bad of [
			"nope",
			7,
			{},
			[],
			{ ...VALID_ANCHOR, v: 2 },
			{ ...VALID_ANCHOR, family: "not-a-family" },
		]) {
			expect((await patch(id, { diagramAnchor: bad })).status).toBe(400);
		}

		const snapshot = (await (await fetch(`${base}/api/external-annotations`)).json()) as {
			annotations: Array<{ id: string; diagramAnchor?: unknown }>;
		};
		expect(snapshot.annotations.find((a) => a.id === id)?.diagramAnchor).toEqual(VALID_ANCHOR);
	});

	test("normalizes an accepted anchor and validates the other fields", async () => {
		const id = seed(handler, { source: "linter", text: "note" });

		const ok = await patch(id, { diagramAnchor: { ...VALID_ANCHOR, label: "x".repeat(600), stowaway: "dropped" } });
		expect(ok.status).toBe(200);
		const stored = ok.body.annotation?.diagramAnchor as Record<string, unknown>;
		expect((stored.label as string).length).toBe(400);
		expect(stored).not.toHaveProperty("stowaway");

		expect((await patch(id, { diagramAnchor: { ...VALID_ANCHOR, sourceLine: [-3, -3] } })).status).toBe(200);
		expect((await patch(id, { htmlAnchor: { tagName: "div" } })).status).toBe(400);
		expect((await patch(id, { htmlAnchor: { selector: "#a", tagName: "div" } })).status).toBe(200);
		expect((await patch(id, { elementContext: { id: "no-tag" } })).status).toBe(400);
		expect((await patch(id, { images: [{ name: "a" }] })).status).toBe(400);
		expect((await patch(id, { type: "NOT_A_TYPE" })).status).toBe(400);
		expect((await patch(id, { text: 7 })).status).toBe(400);
		expect((await patch(id, [{ text: "x" }])).status).toBe(400);

		const dropped = await patch(id, { text: "edited", notAField: { deep: true } });
		expect(dropped.status).toBe(200);
		expect(dropped.body.annotation?.text).toBe("edited");
		expect(dropped.body.annotation).not.toHaveProperty("notAField");
	});

	test("review mode keeps its own field set", async () => {
		const id = seed(reviewHandler, { source: "linter", filePath: "a.ts", lineStart: 1, lineEnd: 1, text: "note" });
		expect((await patch(id, { severity: "catastrophic" }, "review")).status).toBe(400);
		expect((await patch(id, { severity: "nit" }, "review")).status).toBe(200);
		expect((await patch(id, { decorations: ["explode"] }, "review")).status).toBe(400);
		expect((await patch(id, { lineStart: "3" }, "review")).status).toBe(400);
	});
});
