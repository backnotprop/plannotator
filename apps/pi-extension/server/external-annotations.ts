import type { IncomingMessage, ServerResponse } from "node:http";
import {
	createAnnotationStore,
	transformPlanInput,
	transformReviewInput,
	serializeSSEEvent,
	HEARTBEAT_COMMENT,
	HEARTBEAT_INTERVAL_MS,
	validateReplyTarget,
	validateAnnotationPatch,
	type StorableAnnotation,
	type ExternalAnnotationEvent,
} from "../generated/external-annotation.ts";
import { json, parseBody } from "./helpers.ts";

const BASE = "/api/external-annotations";
const STREAM = `${BASE}/stream`;

export function createExternalAnnotationHandler(mode: "plan" | "review") {
	const store = createAnnotationStore<StorableAnnotation>();
	const subscribers = new Set<ServerResponse>();
	const transform = mode === "plan" ? transformPlanInput : transformReviewInput;

	const broadcast = (event: ExternalAnnotationEvent<StorableAnnotation>) => {
		const data = serializeSSEEvent(event);
		for (const res of subscribers) {
			try {
				res.write(data);
			} catch {
				subscribers.delete(res);
			}
		}
	};

	store.onMutation(broadcast);

	return {
		broadcast,

		endStreams() {
			for (const res of subscribers) {
				try {
					res.end();
				} catch {
				}
			}
			subscribers.clear();
		},

		addAnnotations(body: unknown): { ids: string[] } | { error: string } {
			const parsed = transform(body);
			if ("error" in parsed) return { error: parsed.error };
			const created = store.add(parsed.annotations);
			return { ids: created.map((a: { id: string }) => a.id) };
		},

		async handle(
			req: IncomingMessage,
			res: ServerResponse,
			url: URL,
		): Promise<boolean> {
			if (url.pathname === STREAM && req.method === "GET") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				});

				res.setTimeout(0);

				const snapshot: ExternalAnnotationEvent<StorableAnnotation> = {
					type: "snapshot",
					annotations: store.getAll(),
				};
				res.write(serializeSSEEvent(snapshot));

				subscribers.add(res);

				const heartbeatTimer = setInterval(() => {
					try {
						res.write(HEARTBEAT_COMMENT);
					} catch {
						clearInterval(heartbeatTimer);
						subscribers.delete(res);
					}
				}, HEARTBEAT_INTERVAL_MS);

				res.on("close", () => {
					clearInterval(heartbeatTimer);
					subscribers.delete(res);
				});

				return true;
			}

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

			if (url.pathname === BASE && req.method === "PATCH") {
				const id = url.searchParams.get("id");
				if (!id) {
					json(res, { error: "Missing ?id parameter" }, 400);
					return true;
				}
				let body: unknown;
				try {
					body = await parseBody(req);
				} catch {
					json(res, { error: "Invalid JSON" }, 400);
					return true;
				}
				const patch = validateAnnotationPatch(mode, body);
				if ("error" in patch) {
					json(res, { error: patch.error }, 400);
					return true;
				}
				if ("inReplyTo" in patch.fields) {
					const problem = validateReplyTarget(store.getAll(), id, patch.fields.inReplyTo);
					if (problem) {
						json(res, { error: problem }, 400);
						return true;
					}
				}
				const updated = store.update(id, patch.fields as Partial<StorableAnnotation>);
				if (!updated) {
					json(res, { error: "Not found" }, 404);
					return true;
				}
				json(res, { annotation: updated });
				return true;
			}

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

			return false;
		},
	};
}
