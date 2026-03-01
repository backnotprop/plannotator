import { handleRequest } from "../core/handler";
import { corsHeaders, getAllowedOrigins } from "../core/cors";
import { KvPasteStore } from "../stores/kv";

interface Env {
  PASTE_KV: KVNamespace;
  ALLOWED_ORIGINS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const allowed = getAllowedOrigins(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin, allowed);
    const store = new KvPasteStore(env.PASTE_KV);
    return handleRequest(request, store, cors);
  },
};
