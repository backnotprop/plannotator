export interface Throttle {
  allow(key: string): boolean;
}

export interface ThrottleOptions {
  limit: number;
  windowMs: number;
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
