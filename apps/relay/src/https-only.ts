import { LOOPBACK } from "./origin";

export function plainHttp(req: Request): Response | null {
  const url = new URL(req.url);
  if (url.protocol === "https:" || LOOPBACK.has(url.hostname)) return null;
  return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
}
