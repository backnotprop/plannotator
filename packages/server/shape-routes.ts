/** Shape's routes on Bun: the Response, file bytes, event feed and code-nav. Route core is packages/shared/shape/routes.ts; the Pi mirror is apps/pi-extension/server/serverShape.ts. */
import { createShapeStore, type ShapeStore } from "@plannotator/shared/shape/store";
import { createShapeWatch, handleShapeRoute, SHAPE_EVENTS_PATH, shapeEventFrame, type ShapeRouteDeps } from "@plannotator/shared/shape/routes";
import { readRepoFile, repoFileErrorBody, REPO_FILE_ERROR_STATUS } from "@plannotator/shared/repo-file";
import { codeNavHoverAnswer } from "./code-nav";
import { decodeBunText } from "./git";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

export const bunShapeCode: NonNullable<ShapeRouteDeps["code"]> = {
  async file(root, path) {
    const read = await readRepoFile(root, path, { decode: decodeBunText });
    return read.ok ? { status: 200, body: { content: read.content } } : { status: REPO_FILE_ERROR_STATUS[read.reason], body: repoFileErrorBody(read) };
  },
  hover: (root, body) => codeNavHoverAnswer(body, root),
};

export function createBunShapeRoutes(options: { dataDir: string; heartbeatMs?: number; watchMs?: number; sessionOf?: ShapeRouteDeps["sessionOf"] }) {
  const store: ShapeStore = createShapeStore({ dataDir: options.dataDir });
  const watch = createShapeWatch(store, { intervalMs: options.watchMs });
  const deps: ShapeRouteDeps = { store, sessionOf: options.sessionOf, changed: () => watch.poke(), code: bunShapeCode };

  function events(req: Request): Response {
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (text: string) => {
          try {
            controller.enqueue(enc.encode(text));
          } catch {
            stop();
          }
        };
        send("retry: 2000\nevent: hello\ndata: {}\n\n");
        const unsubscribe = watch.subscribe((ids) => send(shapeEventFrame(ids)));
        const beat = setInterval(() => send(": ping\n\n"), options.heartbeatMs ?? 25_000);
        stop = () => {
          clearInterval(beat);
          unsubscribe();
        };
        req.signal.addEventListener("abort", () => {
          stop();
          try {
            controller.close();
          } catch {
            // closed
          }
        });
      },
      cancel() {
        stop();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", Connection: "keep-alive", ...NO_STORE } });
  }

  return {
    store,
    watch,
    async route(req: Request, url: URL): Promise<Response | null> {
      if (url.pathname === SHAPE_EVENTS_PATH) {
        if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers: NO_STORE });
        return events(req);
      }
      const answer = await handleShapeRoute({ method: req.method, pathname: url.pathname, params: url.searchParams, json: () => req.json() }, deps);
      if (!answer) return null;
      if ("file" in answer) {
        return new Response(Bun.file(answer.file.path), {
          headers: { "Content-Type": answer.file.contentType, "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "sandbox", ...NO_STORE },
        });
      }
      return Response.json(answer.body, { status: answer.status, headers: NO_STORE });
    },
  };
}
