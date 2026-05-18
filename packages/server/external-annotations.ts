/**
 * External Annotations — Bun server handler.
 *
 * Thin HTTP adapter over the shared annotation store. Handles routing,
 * request parsing, and SSE broadcasting using Bun's Request/Response +
 * ReadableStream APIs.
 *
 * The Pi extension has a mirror handler using node:http primitives at
 * apps/pi-extension/server/external-annotations.ts.
 */

import {
  createAnnotationStore,
  transformPlanInput,
  transformReviewInput,
  serializeSSEEvent,
  HEARTBEAT_COMMENT,
  HEARTBEAT_INTERVAL_MS,
  type AnnotationStore,
  type StorableAnnotation,
  type ExternalAnnotationEvent,
} from "@plannotator/shared/external-annotation";

export type { ExternalAnnotationEvent } from "@plannotator/shared/external-annotation";

// ---------------------------------------------------------------------------
// Handler interface (matches existing EditorAnnotationHandler pattern)
// ---------------------------------------------------------------------------

export interface ExternalAnnotationHandler {
  handle: (
    req: Request,
    url: URL,
    options?: { disableIdleTimeout?: () => void },
  ) => Promise<Response | null>;
  /** Push annotations directly into the store (bypasses HTTP, reuses same validation). */
  addAnnotations: (body: unknown) => { ids: string[] } | { error: string };
  dispose: () => void;
}

// ---------------------------------------------------------------------------
// Route prefix
// ---------------------------------------------------------------------------

const BASE = "/api/external-annotations";
const STREAM = `${BASE}/stream`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExternalAnnotationHandler(
  mode: "plan" | "review",
): ExternalAnnotationHandler {
  const store: AnnotationStore<StorableAnnotation> = createAnnotationStore();
  const subscribers = new Map<ReadableStreamDefaultController, { heartbeatTimer: ReturnType<typeof setInterval> | null }>();
  const encoder = new TextEncoder();
  const transform = mode === "plan" ? transformPlanInput : transformReviewInput;
  let disposed = false;

  const removeSubscriber = (controller: ReadableStreamDefaultController) => {
    const subscription = subscribers.get(controller);
    if (subscription?.heartbeatTimer) clearInterval(subscription.heartbeatTimer);
    subscribers.delete(controller);
  };

  // Wire store mutations → SSE broadcast
  store.onMutation((event: ExternalAnnotationEvent<StorableAnnotation>) => {
    if (disposed) return;
    const data = encoder.encode(serializeSSEEvent(event));
    for (const controller of subscribers.keys()) {
      try {
        controller.enqueue(data);
      } catch {
        // Controller closed — clean up on next iteration
        removeSubscriber(controller);
      }
    }
  });

  return {
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
      // --- SSE stream ---
      if (url.pathname === STREAM && req.method === "GET") {
        options?.disableIdleTimeout?.();

        let ctrl: ReadableStreamDefaultController;

        const stream = new ReadableStream({
          start(controller) {
            ctrl = controller;
            const subscription = { heartbeatTimer: null as ReturnType<typeof setInterval> | null };
            subscribers.set(controller, subscription);

            // Send current state as snapshot
            const snapshot: ExternalAnnotationEvent<StorableAnnotation> = {
              type: "snapshot",
              annotations: store.getAll(),
            };
            controller.enqueue(encoder.encode(serializeSSEEvent(snapshot)));

            // Heartbeat to keep connection alive
            subscription.heartbeatTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(HEARTBEAT_COMMENT));
              } catch {
                // Stream closed
                removeSubscriber(controller);
              }
            }, HEARTBEAT_INTERVAL_MS);
          },
          cancel() {
            removeSubscriber(ctrl);
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

      // --- GET snapshot (polling fallback) ---
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

      // --- POST (add single or batch) ---
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

      // --- PATCH (update fields on a single annotation) ---
      if (url.pathname === BASE && req.method === "PATCH") {
        const id = url.searchParams.get("id");
        if (!id) {
          return Response.json({ error: "Missing ?id parameter" }, { status: 400 });
        }
        try {
          const body = await req.json();
          const updated = store.update(id, body as Partial<StorableAnnotation>);
          if (!updated) {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          return Response.json({ annotation: updated });
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
      }

      // --- DELETE (by id, by source, or clear all) ---
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

      // Not handled — pass through
      return null;
    },

    dispose(): void {
      disposed = true;
      for (const controller of Array.from(subscribers.keys())) {
        removeSubscriber(controller);
        try {
          controller.close();
        } catch {
          // Stream may already be closed by the client.
        }
      }
    },
  };
}
