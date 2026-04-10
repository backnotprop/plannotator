import { afterEach, describe, expect, test } from "bun:test";

import { ROAM_API_VERSION, formatRoamDailyNotePage, saveToRoam } from "./integrations";
import {
	callRoamLocalApi,
	RoamAuthError,
	RoamConnectionError,
	RoamTimeoutError,
	RoamVersionMismatchError,
} from "./roam-client";

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

describe("callRoamLocalApi", () => {
	test("posts to the local Roam API with auth, offline query, and expectedApiVersion", async () => {
		let seen: {
			pathname: string;
			search: string;
			auth: string | null;
			body: unknown;
		} | null = null;

		const port = startRoamServer(async (req) => {
			seen = {
				pathname: new URL(req.url).pathname,
				search: new URL(req.url).search,
				auth: req.headers.get("authorization"),
				body: await req.json(),
			};
			return Response.json({
				apiVersion: ROAM_API_VERSION,
				result: { ok: true },
			});
		});

		const result = await callRoamLocalApi(
			{
				graphName: "my-graph",
				graphType: "offline",
				token: "secret-token",
				port,
			},
			"data.ai.search",
			[{ query: "" }],
		);

		expect(result).toEqual({ ok: true });
		expect(seen).toEqual({
			pathname: "/api/my-graph",
			search: "?type=offline",
			auth: "Bearer secret-token",
			body: {
				action: "data.ai.search",
				args: [{ query: "" }],
				expectedApiVersion: ROAM_API_VERSION,
			},
		});
	});

	test("raises a typed auth error for 401 responses", async () => {
		const port = startRoamServer(() =>
			Response.json({ error: "Unauthorized" }, { status: 401 }),
		);

		await expect(
			callRoamLocalApi(
				{
					graphName: "my-graph",
					graphType: "hosted",
					token: "bad-token",
					port,
				},
				"ui.mainWindow.getOpenView",
				{},
			),
		).rejects.toBeInstanceOf(RoamAuthError);
	});

	test("raises a typed timeout error when the local API hangs", async () => {
		const port = startRoamServer(async () => {
			await Bun.sleep(50);
			return Response.json({ apiVersion: ROAM_API_VERSION, result: { ok: true } });
		});

		await expect(
			callRoamLocalApi(
				{
					graphName: "my-graph",
					graphType: "hosted",
					token: "secret-token",
					port,
				},
				"ui.mainWindow.getOpenView",
				{},
				{ timeoutMs: 5 },
			),
		).rejects.toBeInstanceOf(RoamTimeoutError);
	});

	test("raises a typed version mismatch error when the API version is incompatible", async () => {
		const port = startRoamServer(() =>
			Response.json({
				apiVersion: "2.0.0",
				result: { ok: true },
			}),
		);

		await expect(
			callRoamLocalApi(
				{
					graphName: "my-graph",
					graphType: "hosted",
					token: "secret-token",
					port,
				},
				"ui.mainWindow.getOpenView",
				{},
			),
		).rejects.toBeInstanceOf(RoamVersionMismatchError);
	});

	test("raises a typed connection error when the local API is unavailable", async () => {
		const unusedServer = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});
		const port = unusedServer.port;
		unusedServer.stop(true);

		await expect(
			callRoamLocalApi(
				{
					graphName: "missing-graph",
					graphType: "hosted",
					token: "secret-token",
					port,
				},
				"ui.mainWindow.getOpenView",
				{},
				{ timeoutMs: 25 },
			),
		).rejects.toBeInstanceOf(RoamConnectionError);
	});
});

describe("saveToRoam", () => {
	const planWithFrontmatter = [
		"---",
		"created: 2026-04-09T14:30:00.000Z",
		"source: plannotator",
		"tags: [plannotator, auth]",
		"owner: alice",
		"---",
		"",
		"# Implementation Plan: Auth Flow",
		"",
		"## Context",
		"Ship it",
	].join("\n");

	const planMarkdownBlock = [
		"```markdown",
		planWithFrontmatter,
		"```",
	].join("\n");

	test("sends attribute blocks, the Plannotator marker, a fenced markdown block, and returns a roam path", async () => {
		let seenBody: unknown = null;
		const port = startRoamServer(async (req) => {
			seenBody = await req.json();
			return Response.json({
				apiVersion: ROAM_API_VERSION,
				result: { uid: "page-uid-123" },
			});
		});

		const result = await saveToRoam({
			graphName: "work-notes",
			graphType: "offline",
			token: "secret-token",
			port,
			titleFormat: "{title}",
			plan: planWithFrontmatter,
		});

		expect(result).toEqual({
			success: true,
			path: "roam:offline:work-notes/page-uid-123",
		});
		expect(seenBody).toEqual({
			action: "data.page.fromMarkdown",
			args: [
				{
					page: { title: "Auth Flow" },
					"markdown-string": [
						"[[Plannotator Plans]]",
						"",
						"created:: [[April 9th, 2026]]",
						"source:: plannotator",
						"tags:: [[plannotator]], [[auth]]",
						"owner:: alice",
						"",
						planMarkdownBlock,
					].join("\n"),
				},
			],
			expectedApiVersion: ROAM_API_VERSION,
		});
	});

	test("saves to today's daily note under a nested plans block when configured", async () => {
		const seenBodies: unknown[] = [];
		const port = startRoamServer(async (req) => {
			seenBodies.push(await req.json());
			return Response.json({
				apiVersion: ROAM_API_VERSION,
				result: { uids: seenBodies.length === 1 ? ["plan-block-uid"] : ["content-block-uid"] },
			});
		});

		const result = await saveToRoam({
			graphName: "work-notes",
			graphType: "hosted",
			token: "secret-token",
			port,
			titleFormat: "{title}",
			saveLocation: "daily-note",
			dailyNoteParent: "[[Plannotator Plans]]",
			plan: planWithFrontmatter,
		});

		expect(result).toEqual({
			success: true,
			path: "roam:hosted:work-notes/plan-block-uid",
		});
		expect(seenBodies).toEqual([
			{
				action: "data.block.fromMarkdown",
				args: [
					{
						location: {
							order: "last",
							"page-title": { "daily-note-page": formatRoamDailyNotePage(new Date()) },
							"nest-under-str": "[[Plannotator Plans]]",
						},
						"markdown-string": "Auth Flow",
					},
				],
				expectedApiVersion: ROAM_API_VERSION,
			},
			{
				action: "data.block.fromMarkdown",
				args: [
					{
						location: {
							order: "last",
							"parent-uid": "plan-block-uid",
						},
						"markdown-string": [
							"created:: [[April 9th, 2026]]",
							"source:: plannotator",
							"tags:: [[plannotator]], [[auth]]",
							"owner:: alice",
							"",
							planMarkdownBlock,
						].join("\n"),
					},
				],
				expectedApiVersion: ROAM_API_VERSION,
			},
		]);
	});

	test("uses a longer fence when the plan contains triple backtick code fences", async () => {
		let seenBody: unknown = null;
		const port = startRoamServer(async (req) => {
			seenBody = await req.json();
			return Response.json({
				apiVersion: ROAM_API_VERSION,
				result: { uid: "page-uid-123" },
			});
		});
		const plan = [
			"# Implementation Plan: Auth Flow",
			"",
			"```ts",
			"console.log('hello');",
			"```",
		].join("\n");

		await saveToRoam({
			graphName: "work-notes",
			graphType: "offline",
			token: "secret-token",
			port,
			titleFormat: "{title}",
			plan,
		});

		expect(seenBody).toEqual({
			action: "data.page.fromMarkdown",
			args: [
				{
					page: { title: "Auth Flow" },
					"markdown-string": [
						"[[Plannotator Plans]]",
						"",
						"````markdown",
						plan,
						"````",
					].join("\n"),
				},
			],
			expectedApiVersion: ROAM_API_VERSION,
		});
	});
});
