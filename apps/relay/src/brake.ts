const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface Limiter {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

/** The hard count for one client address: the CreateBrake object named by it (src/create-brake.ts). */
type Counter = (key: string) => { take: () => Promise<{ allowed: boolean; retryAfter: number }> };

export function clientKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

const answer = (status: number, code: string, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error, code }), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

/**
 * The brake on mailbox creation: the rate limiting binding first (cheap, but
 * approximate and per machine), then the client address's CreateBrake count
 * (one count wherever the request lands). Over either: 429 with Retry-After.
 * Off loopback, a missing binding, object or client address, or a failure in
 * either, closes creation (503) rather than leaving it unbraked.
 */
export async function braked(req: Request, limiter: Limiter | undefined, counter: Counter | undefined, periodSeconds: number): Promise<Response | null> {
  const local = LOOPBACK.has(new URL(req.url).hostname);
  const ip = req.headers.get("CF-Connecting-IP");
  const closed = () => (local ? null : answer(503, "brake_unavailable", "Mailboxes cannot be made right now."));
  if (!limiter || !counter || !ip) return closed();
  const key = clientKey(ip);
  let retryAfter = periodSeconds;
  try {
    if ((await limiter.limit({ key })).success) {
      const taken = await counter(key).take();
      if (taken.allowed) return null;
      retryAfter = taken.retryAfter;
    }
  } catch (error) {
    console.log("relay: creation brake failed", error instanceof Error ? error.message : String(error));
    return closed();
  }
  return answer(429, "too_many_requests", "too many requests", { "Retry-After": String(retryAfter) });
}
