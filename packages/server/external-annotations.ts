import {
  createAnnotationStore,
  transformPlanInput,
  transformReviewInput,
  serializeSSEEvent,
  HEARTBEAT_COMMENT,
  HEARTBEAT_INTERVAL_MS,
  validateReplyTarget,
  validateAnnotationPatch,
  type AnnotationStore,
  type StorableAnnotation,
  type ExternalAnnotationEvent,
} from "@plannotator/shared/external-annotation";

export type { ExternalAnnotationEvent } from "@plannotator/shared/external-annotation";

export interface ExternalAnnotationHandler {
  handle: (
    req: Request,
    url: URL,
    options?: { disableIdleTimeout?: () => void },
  ) => Promise<Response | null>;
  addAnnotations: (body: unknown) => { ids: string[] } | { error: string };
  broadcast: (event: ExternalAnnotationEvent<StorableAnnotation>) => void;
}

const BASE = "/api/external-annotations";
const STREAM = `${BASE}/stream`;

export function createExternalAnnotationHandler(
  mode: "plan" | "review",
): ExternalAnnotationHandler {
  const store: AnnotationStore<StorableAnnotation> = createAnnotationStore();
  const subscribers = new Set<ReadableStreamDefaultController>();
  const encoder = new TextEncoder();
  const transform = mode === "plan" ? transformPlanInput : transformReviewInput;

  const broadcast = (event: ExternalAnnotationEvent<StorableAnnotation>) => {
    const data = encoder.encode(serializeSSEEvent(event));
    for (const controller of subscribers) {
      try {
        controller.enqueue(data);
      } catch {
        // Controller closed — clean up on next iteration
        subscribers.delete(controller);
      }
    }
  };

  store.onMutation(broadcast);

  return {
    broadcast,

    addAnnotations(body: unknown): { ids: string[] } | { error: string } {
      const parsed = transform(body);
      if ("error" in parsed) return { error: parsed.error };
      const created = store.add(parsed.annotations);
      return { ids: created.map((a) => a.id) };
    },

    async handle(
      req: Request,
      url: URL,
      options?: { disableIdleTimeout?: () => void },
    ): Promise<Response | null> {
      if (url.pathname === STREAM && req.method === "GET") {
        options?.disableIdleTimeout?.();

        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        let ctrl: ReadableStreamDefaultController;

        const stream = new ReadableStream({
          start(controller) {
            ctrl = controller;

            const snapshot: ExternalAnnotationEvent<StorableAnnotation> = {
              type: "snapshot",
              annotations: store.getAll(),
            };
            controller.enqueue(encoder.encode(serializeSSEEvent(snapshot)));

            subscribers.add(controller);

            heartbeatTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(HEARTBEAT_COMMENT));
              } catch {
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                subscribers.delete(controller);
              }
            }, HEARTBEAT_INTERVAL_MS);
          },
          cancel() {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            subscribers.delete(ctrl);
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === BASE && req.method === "GET") {
        const since = url.searchParams.get("since");
        if (since !== null) {
          const sinceVersion = parseInt(since, 10);
          if (!isNaN(sinceVersion) && sinceVersion === store.version) {
            return new Response(null, { status: 304 });
          }
        }
        return Response.json({
          annotations: store.getAll(),
          version: store.version,
        });
      }

      if (url.pathname === BASE && req.method === "POST") {
        try {
          const body = await req.json();
          const parsed = transform(body);

          if ("error" in parsed) {
            return Response.json({ error: parsed.error }, { status: 400 });
          }

          const created = store.add(parsed.annotations);
          return Response.json(
            { ids: created.map((a) => a.id) },
            { status: 201 },
          );
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
      }

      if (url.pathname === BASE && req.method === "PATCH") {
        const id = url.searchParams.get("id");
        if (!id) {
          return Response.json({ error: "Missing ?id parameter" }, { status: 400 });
        }
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
        const patch = validateAnnotationPatch(mode, body);
        if ("error" in patch) {
          return Response.json({ error: patch.error }, { status: 400 });
        }
        // A reply must point at an existing, different annotation and must not close a cycle.
        if ("inReplyTo" in patch.fields) {
          const problem = validateReplyTarget(store.getAll(), id, patch.fields.inReplyTo);
          if (problem) return Response.json({ error: problem }, { status: 400 });
        }
        const updated = store.update(id, patch.fields as Partial<StorableAnnotation>);
        if (!updated) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json({ annotation: updated });
      }

      if (url.pathname === BASE && req.method === "DELETE") {
        const id = url.searchParams.get("id");
        const source = url.searchParams.get("source");

        if (id) {
          store.remove(id);
          return Response.json({ ok: true });
        }

        if (source) {
          const count = store.clearBySource(source);
          return Response.json({ ok: true, removed: count });
        }

        const count = store.clearAll();
        return Response.json({ ok: true, removed: count });
      }

      return null;
    },
  };
}
