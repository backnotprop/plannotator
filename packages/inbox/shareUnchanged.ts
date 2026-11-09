/**
 * A fresh read of the open thread, with every part that has not changed since the last read kept as the same object
 * (structural sharing, as TanStack Query does for its results). #2948, the long-lived window.
 *
 * Why: the window re-reads the open thread on every record (an agent's message, an answer, a look), and each read is
 * a whole new copy of every message. Copies of earlier reads stayed alive: a message's callbacks that React keeps
 * from an earlier render (useCallback, useMemo, a context value) close over that render's scope, and through it over
 * the thread object of that read. Each message drawn after a new read pinned that read, so a thread kept open while
 * its agent worked held one more full copy per message that came in: on a 245-message thread, 30 arrivals left 17
 * copies (about 0.6 MB each), and the heap grew without end over days. With the parts shared, an earlier read pins
 * only what really changed in it.
 *
 * It also spares React work: an unchanged message is the same object, so what is memoized on it stays.
 *
 * Plain JSON data only (what the Inbox API returns): objects, arrays and primitives. Arrays are matched by index (a
 * thread's messages only grow at the end); anything else that differs is taken from `next` as it is.
 */
export function shareUnchanged<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((value, i) => {
      const kept = i < prev.length ? shareUnchanged(prev[i], value) : value;
      if (kept !== prev[i]) same = false;
      return kept;
    });
    return (same ? prev : out) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    let same = prevKeys.length === nextKeys.length;
    const out: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const had = Object.prototype.hasOwnProperty.call(prev, key);
      const kept = had ? shareUnchanged(prev[key], next[key]) : next[key];
      if (!had || kept !== prev[key]) same = false;
      out[key] = kept;
    }
    return (same ? prev : out) as T;
  }
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
