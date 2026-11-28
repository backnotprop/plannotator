/**
 * Decoding an id taken from a request path. `decodeURIComponent` throws a
 * URIError on a malformed escape (a path ending in `%`, or `%E0%A4%A`), so a
 * route that decodes a segment unguarded turns a hand-typed URL into a 500 on
 * Bun and, on the Pi server (node:http, no top-level catch), into an unhandled
 * rejection. Both review servers and the Inbox decode through this and answer
 * 400 on `null`.
 */

/** The 400 body text both review servers send for a path whose escapes are malformed. */
export const MALFORMED_PATH_ERROR = "malformed URL encoding";

/** The segment decoded, or `null` when its percent-escapes are malformed. */
export function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
