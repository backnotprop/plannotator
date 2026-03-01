import { createPaste, getPaste, PasteError } from "../core/handler";
import { corsHeaders, getAllowedOrigins } from "../core/cors";
import { KvPasteStore } from "../stores/kv";

interface Env {
  PASTE_KV: KVNamespace;
  ALLOWED_ORIGINS?: string;
}

const ID_PATTERN = /^\/api\/paste\/([A-Za-z0-9]{6,16})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";
    const allowed = getAllowedOrigins(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin, allowed);
    const store = new KvPasteStore(env.PASTE_KV);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/api/paste" && request.method === "POST") {
      let body: { data?: unknown };
      try {
        body = (await request.json()) as { data?: unknown };
      } catch {
        return Response.json(
          { error: "Invalid JSON body" },
          { status: 400, headers: cors }
        );
      }
      try {
        const result = await createPaste(body.data as string, store);
        return Response.json(result, { status: 201, headers: cors });
      } catch (e) {
        if (e instanceof PasteError) {
          return Response.json(
            { error: e.message },
            { status: e.status, headers: cors }
          );
        }
        return Response.json(
          { error: "Failed to store paste" },
          { status: 500, headers: cors }
        );
      }
    }

    const match = url.pathname.match(ID_PATTERN);
    if (match && request.method === "GET") {
      const data = await getPaste(match[1], store);
      if (!data) {
        return Response.json(
          { error: "Paste not found or expired" },
          { status: 404, headers: cors }
        );
      }
      return Response.json(
        { data },
        {
          headers: {
            ...cors,
            "Cache-Control": "public, max-age=3600",
          },
        }
      );
    }

    return Response.json(
      { error: "Not found. Valid paths: POST /api/paste, GET /api/paste/:id" },
      { status: 404, headers: cors }
    );
  },
};
