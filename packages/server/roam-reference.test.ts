import { afterEach, describe, expect, test } from "bun:test";

import { ROAM_API_VERSION } from "./integrations";
import {
	handleRoamDoc,
	handleRoamPages,
	handleRoamTest,
} from "./reference-handlers";

let activeServer: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
	activeServer?.stop(true);
	activeServer = null;
});

function startRoamServer(
	fetch: (req: Request) => Response | Promise<Response>,
): number {
	activeServer = Bun.serve({
		port: 0,
		fetch,
	});
	return activeServer.port;
}

describe("Roam reference handlers", () => {
	test("handleRoamTest calls ui.mainWindow.getOpenView", async () => {
		let seenBody: unknown = null;
		let seenAuth: string | null = null;
		const port = startRoamServer(async (req) => {
			seenAuth = req.headers.get("authorization");
			seenBody = await req.json();
			return Response.json({
				apiVersion: ROAM_API_VERSION,
				result: { graphName: "work-notes", view: "page" },
			});
		});

		const res = await handleRoamTest(
			new Request(
				`http://localhost/api/roam/test?graphName=work-notes&graphType=offline&port=${port}`,
				{
					headers: { Authorization: "Bearer secret-token" },
				},
			),
		);

		expect(res.status).toBe(200);
		expect(seenAuth).toBe("Bearer secret-token");
		expect(seenBody).toEqual({
			action: "ui.mainWindow.getOpenView",
			args: [],
			expectedApiVersion: ROAM_API_VERSION,
		});
		expect(await res.json()).toEqual({
			ok: true,
			apiVersion: ROAM_API_VERSION,
			graphName: "work-notes",
		});
	});

	test("handleRoamPages normalizes suggestion objects into stable page rows", async () => {
		let seenBody: unknown = null;
		const port = startRoamServer(async (req) => {
			seenBody = await req.json();
			return Response.json({
				apiVersion: ROAM_API_VERSION,
				result: {
					suggestions: {
						recentlyEditedPages: [
							{
								uid: "page-2",
								title: "Edited Later",
								editedAt: "2026-04-09T19:00:00.000Z",
							},
						],
						recentlyOpenedByUser: [
							{
								uid: "page-1",
								title: "Opened Earlier",
								type: "page",
								openedAt: "2026-04-09T18:00:00.000Z",
							},
							{
								uid: "ignored-block",
								title: "Block",
								type: "block",
								openedAt: "2026-04-09T20:00:00.000Z",
							},
						],
					},
				},
			});
		});

		const res = await handleRoamPages(
			new Request(
				`http://localhost/api/reference/roam/pages?graphName=work-notes&graphType=hosted&port=${port}`,
				{
					headers: { Authorization: "Bearer secret-token" },
				},
			),
		);

		expect(seenBody).toEqual({
			action: "data.ai.search",
			args: [{ query: "", scope: "pages", limit: 100, includePath: false }],
			expectedApiVersion: ROAM_API_VERSION,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			tree: [
				{
					name: "Edited Later",
					path: "page-2",
					type: "file",
				},
				{
					name: "Opened Earlier",
					path: "page-1",
					type: "file",
				},
			],
		});
	});

	test("handleRoamDoc loads a page by uid and strips roam metadata tags", async () => {
		let seenBody: unknown = null;
		const port = startRoamServer(async (req) => {
			seenBody = await req.json();
			return Response.json({
				apiVersion: ROAM_API_VERSION,
				result: {
					markdown: '<roam uid="abc123">## Heading\n\nBody</roam>',
				},
			});
		});

		const res = await handleRoamDoc(
			new Request(
				`http://localhost/api/reference/roam/doc?graphName=work-notes&graphType=offline&port=${port}&uid=abc123`,
				{
					headers: { Authorization: "Bearer secret-token" },
				},
			),
		);

		expect(seenBody).toEqual({
			action: "data.ai.getPage",
			args: [{ uid: "abc123" }],
			expectedApiVersion: ROAM_API_VERSION,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			markdown: "## Heading\n\nBody",
			filepath: "roam:offline:work-notes/abc123",
		});
	});

	test("handleRoamDoc accepts the token as a query parameter for linked-doc fetches", async () => {
		let seenAuth: string | null = null;
		const port = startRoamServer(async (req) => {
			seenAuth = req.headers.get("authorization");
			return Response.json({
				apiVersion: ROAM_API_VERSION,
				result: {
					markdown: "# Page",
				},
			});
		});

		const res = await handleRoamDoc(
			new Request(
				`http://localhost/api/reference/roam/doc?graphName=work-notes&graphType=hosted&port=${port}&token=secret-token&uid=abc123`,
			),
		);

		expect(seenAuth).toBe("Bearer secret-token");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			markdown: "# Page",
			filepath: "roam:hosted:work-notes/abc123",
		});
	});

	test("handleRoamTest maps generic upstream failures to a server error", async () => {
		const port = startRoamServer(() =>
			Response.json({ error: "Boom" }, { status: 500 }),
		);

		const res = await handleRoamTest(
			new Request(
				`http://localhost/api/roam/test?graphName=work-notes&graphType=hosted&port=${port}`,
				{
					headers: { Authorization: "Bearer secret-token" },
				},
			),
		);

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "Boom" });
	});
});
