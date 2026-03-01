import { homedir } from "os";
import { join } from "path";
import { createPaste, getPaste, PasteError } from "../core/handler";
import { corsHeaders, getAllowedOrigins } from "../core/cors";
import { FsPasteStore } from "../stores/fs";

const port = parseInt(process.env.PASTE_PORT || "19433", 10);
const dataDir =
  process.env.PASTE_DATA_DIR || join(homedir(), ".plannotator", "pastes");
const ttlDays = parseInt(process.env.PASTE_TTL_DAYS || "7", 10);
const ttlSeconds = ttlDays * 24 * 60 * 60;
const maxSize = parseInt(process.env.PASTE_MAX_SIZE || "524288", 10);
const allowedOrigins = getAllowedOrigins(process.env.PASTE_ALLOWED_ORIGINS);

const store = new FsPasteStore(dataDir);

const ID_PATTERN = /^\/api\/paste\/([A-Za-z0-9]{6,16})$/;

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";
    const cors = corsHeaders(origin, allowedOrigins);

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
        const result = await createPaste(body.data as string, store, {
          maxSize,
          ttlSeconds,
        });
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
});

console.log(`Plannotator paste service running on http://localhost:${port}`);
console.log(`Storage: ${dataDir}`);
console.log(`TTL: ${ttlDays} days`);
