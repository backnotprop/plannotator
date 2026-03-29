/**
 * External Annotations — Pi (node:http) server handler.
 *
 * Thin HTTP adapter over the shared annotation store. Mirrors the Bun
 * handler at packages/server/external-annotations.ts but uses node:http
 * IncomingMessage/ServerResponse + res.write() for SSE.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	createAnnotationStore,
	transformPlanInput,
	transformReviewInput,
	serializeSSEEvent,
	HEARTBEAT_COMMENT,
	HEARTBEAT_INTERVAL_MS,
	type StorableAnnotation,
	type ExternalAnnotationEvent,
} from "../generated/external-annotation.js";
import { json, parseBody } from "./helpers.js";

// ---------------------------------------------------------------------------
// Route prefix
// ---------------------------------------------------------------------------

const BASE = "/api/external-annotations";
const STREAM = `${BASE}/stream`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExternalAnnotationHandler(mode: "plan" | "review") {
	const store = createAnnotationStore<StorableAnnotation>();
	const subscribers = new Set<ServerResponse>();
	const transform = mode === "plan" ? transformPlanInput : transformReviewInput;

	// Wire store mutations → SSE broadcast
	store.onMutation((event: ExternalAnnotationEvent<StorableAnnotation>) => {
		const data = serializeSSEEvent(event);
		for (const res of subscribers) {
			try {
				res.write(data);
			} catch {
				// Response closed — clean up
				subscribers.delete(res);
			}
		}
	});

	return {
		async handle(
			req: IncomingMessage,
			res: ServerResponse,
			url: URL,
		): Promise<boolean> {
			// --- SSE stream ---
			if (url.pathname === STREAM && req.method === "GET") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});

				// Disable idle timeout for SSE connections
				res.setTimeout(0);

				// Send current state as snapshot
				const snapshot: ExternalAnnotationEvent<StorableAnnotation> = {
					type: "snapshot",
					annotations: store.getAll(),
				};
				res.write(serializeSSEEvent(snapshot));

				subscribers.add(res);

				// Heartbeat to keep connection alive
				const heartbeatTimer = setInterval(() => {
					try {
						res.write(HEARTBEAT_COMMENT);
					} catch {
						clearInterval(heartbeatTimer);
						subscribers.delete(res);
					}
				}, HEARTBEAT_INTERVAL_MS);

				// Clean up on disconnect
				res.on("close", () => {
					clearInterval(heartbeatTimer);
					subscribers.delete(res);
				});

				// Don't end the response — SSE stays open
				return true;
			}

			// --- GET snapshot (polling fallback) ---
			if (url.pathname === BASE && req.method === "GET") {
				const since = url.searchParams.get("since");
				if (since !== null) {
					const sinceVersion = parseInt(since, 10);
					if (!isNaN(sinceVersion) && sinceVersion === store.version) {
						res.writeHead(304);
						res.end();
						return true;
					}
				}
				json(res, {
					annotations: store.getAll(),
					version: store.version,
				});
				return true;
			}

			// --- POST (add single or batch) ---
			if (url.pathname === BASE && req.method === "POST") {
				try {
					const body = await parseBody(req);
					const parsed = transform(body);

					if ("error" in parsed) {
						json(res, { error: parsed.error }, 400);
						return true;
					}

					const created = store.add(parsed.annotations);
					json(res, { ids: created.map((a: StorableAnnotation) => a.id) }, 201);
				} catch {
					json(res, { error: "Invalid JSON" }, 400);
				}
				return true;
			}

			// --- PATCH (update fields on a single annotation) ---
			if (url.pathname === BASE && req.method === "PATCH") {
				const id = url.searchParams.get("id");
				if (!id) {
					json(res, { error: "Missing ?id parameter" }, 400);
					return true;
				}
				try {
					const body = await parseBody(req);
					const updated = store.update(id, body as Partial<StorableAnnotation>);
					if (!updated) {
						json(res, { error: "Not found" }, 404);
						return true;
					}
					json(res, { annotation: updated });
				} catch {
					json(res, { error: "Invalid JSON" }, 400);
				}
				return true;
			}

			// --- DELETE (by id, by source, or clear all) ---
			if (url.pathname === BASE && req.method === "DELETE") {
				const id = url.searchParams.get("id");
				const source = url.searchParams.get("source");

				if (id) {
					store.remove(id);
					json(res, { ok: true });
					return true;
				}

				if (source) {
					const count = store.clearBySource(source);
					json(res, { ok: true, removed: count });
					return true;
				}

				const count = store.clearAll();
				json(res, { ok: true, removed: count });
				return true;
			}

			// Not handled — pass through
			return false;
		},
	};
}
