import { afterEach, describe, expect, test } from "bun:test";

import { ROAM_API_VERSION } from "../../../packages/shared/integrations-common.ts";
import { callRoamLocalApi } from "./roam-client.ts";

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
	test("posts to the local Roam API with bearer auth, offline graph query, and expectedApiVersion", async () => {
		let seen: {
			pathname: string;
			search: string;
			auth: string | null;
			body: unknown;
		} | null = null;

		const port = startRoamServer(async (req) => {
			const url = new URL(req.url);
			seen = {
				pathname: url.pathname,
				search: url.search,
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
});
