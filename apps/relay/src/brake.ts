const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface Limiter {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

const answer = (status: number, code: string, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error, code }), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

export async function braked(req: Request, limiter: Limiter | undefined, periodSeconds: number): Promise<Response | null> {
  const local = LOOPBACK.has(new URL(req.url).hostname);
  const ip = req.headers.get("CF-Connecting-IP");
  const closed = () => (local ? null : answer(503, "brake_unavailable", "Mailboxes cannot be made right now."));
  if (!limiter || !ip) return closed();
  try {
    if ((await limiter.limit({ key: ip })).success) return null;
  } catch (error) {
    console.log("relay: rate limiter failed", error instanceof Error ? error.message : String(error));
    return closed();
  }
  return answer(429, "too_many_requests", "too many requests", { "Retry-After": String(periodSeconds) });
}
