/**
 * External Annotations — Bun server handler.
 *
 * Thin HTTP adapter over the shared annotation store. Handles routing,
 * request parsing, and daemon event publication.
 *
 * The Pi extension has a mirror handler using node:http primitives at
 * apps/pi-extension/server/external-annotations.ts.
 */

import {
  createAnnotationStore,
  transformPlanInput,
  transformReviewInput,
  type AnnotationStore,
  type StorableAnnotation,
  type ExternalAnnotationEvent,
} from "@plannotator/shared/external-annotation";
import type { SessionSnapshotProvider } from "./session-handler";

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
  /** Remove all annotations from the store. */
  clearAll: () => void;
  dispose: () => void;
}

export interface ExternalAnnotationHandlerOptions {
  publishEvent?: (event: ExternalAnnotationEvent<StorableAnnotation>) => void;
  registerSnapshotProvider?: (provider: SessionSnapshotProvider) => (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// Route prefix
// ---------------------------------------------------------------------------

const BASE = "/api/external-annotations";
const STREAM = `${BASE}/stream`;
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExternalAnnotationHandler(
  mode: "plan" | "review",
  options: ExternalAnnotationHandlerOptions = {},
): ExternalAnnotationHandler {
  const store: AnnotationStore<StorableAnnotation> = createAnnotationStore();
  const transform = mode === "plan" ? transformPlanInput : transformReviewInput;
  let disposed = false;
  const unregisterSnapshotProvider = options.registerSnapshotProvider?.(() => ({
    type: "snapshot",
    annotations: store.getAll(),
    version: store.version,
  } satisfies ExternalAnnotationEvent<StorableAnnotation>));
  const isDaemonBacked = typeof unregisterSnapshotProvider === "function";
  const streamCleanups = new Set<() => void>();

  // Wire store mutations upward to the daemon hub. The handler owns only its
  // store; connection routing and filtering live in the daemon layer.
  store.onMutation((event: ExternalAnnotationEvent<StorableAnnotation>) => {
    if (disposed) return;
    options.publishEvent?.(event);
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
      handlerOptions?: { disableIdleTimeout?: () => void },
    ): Promise<Response | null> {
      // --- Legacy persistent stream route ---
      if (url.pathname === STREAM && req.method === "GET") {
        if (isDaemonBacked) {
          return Response.json({ error: "External annotation events moved to the daemon WebSocket hub." }, { status: 410 });
        }
        handlerOptions?.disableIdleTimeout?.();
        const encoder = new TextEncoder();
        let cleanup: (() => void) | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            const enqueue = (chunk: string) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                cleanup?.();
              }
            };
            const send = (event: ExternalAnnotationEvent<StorableAnnotation>) => {
              enqueue(`data: ${JSON.stringify(event)}\n\n`);
            };
            const unsubscribe = store.onMutation(send);
            cleanup = () => {
              if (closed) return;
              closed = true;
              if (heartbeat) clearInterval(heartbeat);
              unsubscribe();
              streamCleanups.delete(cleanup!);
              try {
                controller.close();
              } catch {
                // Stream may already be closed by the runtime.
              }
            };
            streamCleanups.add(cleanup);
            req.signal.addEventListener("abort", cleanup, { once: true });
            heartbeat = setInterval(() => enqueue(": heartbeat\n\n"), SSE_HEARTBEAT_INTERVAL_MS);
            heartbeat.unref?.();
            send({
              type: "snapshot",
              annotations: store.getAll(),
              version: store.version,
            });
          },
          cancel() {
            cleanup?.();
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

      // --- GET snapshot (reconnect resync) ---
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

    clearAll(): void {
      store.clearAll();
    },

    dispose(): void {
      disposed = true;
      for (const cleanup of Array.from(streamCleanups)) cleanup();
      unregisterSnapshotProvider?.();
    },
  };
}
