// A per-IP throttle kept in the Worker isolate's memory only. The IP is the
// key of an in-memory map that forgets it after the window; it is never
// written to the database or the logs. Each isolate counts on its own, so
// this is a soft limit; the Cloudflare rate-limit binding (wrangler.toml) is
// the shared one.

export interface Throttle {
  /** Counts one request for `key`; false once `key` is over the limit in the window. */
  allow(key: string): boolean;
}

export interface ThrottleOptions {
  limit: number;
  windowMs: number;
  /** Keys held at most; the oldest is forgotten first. Bounds the isolate's memory. */
  maxKeys?: number;
  now?: () => number;
}

export function createThrottle(options: ThrottleOptions): Throttle {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  const hits = new Map<string, { start: number; count: number }>();

  return {
    allow(key: string): boolean {
      const at = now();
      const seen = hits.get(key);
      if (!seen || at - seen.start >= windowMs) {
        hits.delete(key);
        if (hits.size >= maxKeys) {
          const oldest = hits.keys().next().value;
          if (oldest !== undefined) hits.delete(oldest);
        }
        hits.set(key, { start: at, count: 1 });
        return limit >= 1;
      }
      seen.count += 1;
      return seen.count <= limit;
    },
  };
}
