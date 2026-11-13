import { LOOPBACK } from "./origin";

export const CREATE_LIMIT = 20;
export const CREATE_WINDOW_MS = 60_000;

interface Limiter {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

type Strict = (key: string) => Promise<boolean>;

const answer = (status: number, code: string, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error, code }), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

export function clientKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

export function windowCounter(limit: number, windowMs: number, now: () => number = Date.now): () => boolean {
  let start = 0;
  let count = 0;
  return () => {
    const at = now();
    if (at - start >= windowMs) {
      start = at;
      count = 0;
    }
    if (count >= limit) return false;
    count += 1;
    return true;
  };
}

export async function braked(req: Request, limiter: Limiter | undefined, periodSeconds: number, strict?: Strict): Promise<Response | null> {
  const local = LOOPBACK.has(new URL(req.url).hostname);
  const ip = req.headers.get("CF-Connecting-IP");
  const closed = () => (local ? null : answer(503, "brake_unavailable", "Mailboxes cannot be made right now."));
  if (!limiter || !strict || !ip) return closed();
  const key = clientKey(ip);
  try {
    if ((await limiter.limit({ key })).success && (await strict(key))) return null;
  } catch (error) {
    console.log("relay: rate limiter failed", error instanceof Error ? error.message : String(error));
    return closed();
  }
  return answer(429, "too_many_requests", "too many requests", { "Retry-After": String(periodSeconds) });
}
