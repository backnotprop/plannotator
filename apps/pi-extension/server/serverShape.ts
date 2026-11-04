/**
 * Shape's routes on node:http, for Pi (the Bun mirror is
 * packages/server/shape-routes.ts; the route core is
 * packages/shared/shape/routes.ts, vendored to generated/shape/). Same paths,
 * same answers, same event feed: `GET /api/shapes/events` sends
 * `event: shapes` `{ ids }` when a board changes, including when an agent's
 * `plannotator shape read --notes` picks up a waiting change.
 *
 * Mount it like the other Pi routes: after the Host allowlist and the
 * cross-origin write guard (request-origin-guard.ts). A cross-site read is
 * refused here too, because a board names files and folders.
 */
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { crossOriginRefusalBody, isSameOriginOrNoOrigin } from "../generated/request-origin.ts";
import { readRepoFile, repoFileErrorBody, REPO_FILE_ERROR_STATUS } from "../generated/repo-file.ts";
import { resolveCodeNavHover, validateCodeNavRequest, type CodeNavRequest } from "../generated/code-nav.ts";
import { createShapeStore, type ShapeStore } from "../generated/shape/store.ts";
import { createShapeWatch, handleShapeRoute, SHAPE_EVENTS_PATH, shapeEventFrame, type ShapeRouteDeps } from "../generated/shape/routes.ts";
import { piCodeNavRuntime } from "./code-nav-runtime.ts";
import { readBody } from "./helpers.ts";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

const piShapeCode: NonNullable<ShapeRouteDeps["code"]> = {
	async file(root, path) {
		const read = await readRepoFile(root, path);
		return read.ok ? { status: 200, body: { content: read.content } } : { status: REPO_FILE_ERROR_STATUS[read.reason], body: repoFileErrorBody(read) };
	},
	async hover(root, body) {
		const error = validateCodeNavRequest(body);
		if (error) return { status: 400, body: { error } };
		try {
			return { status: 200, body: await resolveCodeNavHover(piCodeNavRuntime, body as CodeNavRequest, root, []) };
		} catch (err) {
			return { status: 500, body: { error: err instanceof Error ? err.message : "Code navigation failed" } };
		}
	},
};

/**
 * NOT MOUNTED, and must not be until it has what the Bun Inbox has around it: Pi has no Shape switch (the Inbox's
 * Settings → Capabilities → Shape, config `inboxShape`: off answers 404), no owner check (a tailnet guest is
 * refused there) and no `serverSession` check on writes (409 for a page of a restarted server). Whoever mounts
 * this adds all three first.
 */
export function createPiShapeRoutes(options: { dataDir: string; heartbeatMs?: number; watchMs?: number; sessionOf?: ShapeRouteDeps["sessionOf"] }) {
	const store: ShapeStore = createShapeStore({ dataDir: options.dataDir });
	const watch = createShapeWatch(store, { intervalMs: options.watchMs });
	const deps: ShapeRouteDeps = { store, sessionOf: options.sessionOf, changed: () => watch.poke(), code: piShapeCode };

	const sendJson = (res: ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json", ...NO_STORE });
		res.end(JSON.stringify(body));
	};

	function events(req: IncomingMessage, res: ServerResponse) {
		res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", ...NO_STORE });
		res.write("retry: 2000\nevent: hello\ndata: {}\n\n");
		const unsubscribe = watch.subscribe((ids) => res.write(shapeEventFrame(ids)));
		const beat = setInterval(() => res.write(": ping\n\n"), options.heartbeatMs ?? 25_000);
		const stop = () => {
			clearInterval(beat);
			unsubscribe();
		};
		req.on("close", stop);
		res.on("close", stop);
	}

	return {
		store,
		watch,
		/** Answers a Shape path and returns true; false when the path is not Shape's. */
		async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
			if (url.pathname !== "/api/shapes" && !url.pathname.startsWith("/api/shapes/")) return false;
			const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
			if (!isSameOriginOrNoOrigin(origin, req.headers.host ?? "", req.headers["sec-fetch-site"])) {
				sendJson(res, 403, crossOriginRefusalBody());
				return true;
			}
			if (url.pathname === SHAPE_EVENTS_PATH) {
				if (req.method !== "GET") sendJson(res, 405, { error: "method not allowed" });
				else events(req, res);
				return true;
			}
			let text: string | null = null;
			const answer = await handleShapeRoute(
				{
					method: req.method ?? "GET",
					pathname: url.pathname,
					params: url.searchParams,
					json: async () => JSON.parse((text ??= await readBody(req))),
				},
				deps,
			);
			if (!answer) {
				sendJson(res, 404, { error: "Not found", code: "not_found" });
				return true;
			}
			if ("file" in answer) {
				// Opened before the head is written: a file gone between the check and the read is a 404, and an error
				// mid-read ends the response instead of an unhandled 'error' event taking the process down.
				const file = createReadStream(answer.file.path);
				file.on("error", () => {
					if (!res.headersSent) sendJson(res, 404, { error: "Not found", code: "not_found" });
					else res.destroy();
				});
				file.once("open", () => {
					res.writeHead(200, { "Content-Type": answer.file.contentType, "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "sandbox", ...NO_STORE });
					file.pipe(res);
				});
				return true;
			}
			sendJson(res, answer.status, answer.body);
			return true;
		},
	};
}
