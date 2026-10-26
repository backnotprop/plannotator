/**
 * The Bun servers' half of "annotate's live app proxy never fronts a
 * Plannotator server" (packages/shared/plannotator-server-marker.ts):
 *  - every response carries the Plannotator server header, so the probe and
 *    the proxy can tell a Plannotator server from a dev app;
 *  - a request the live proxy forwarded (it carries the live proxy header) is
 *    refused before any route, so a write through the proxy never runs here.
 *
 * Usage: `Bun.serve(withPlannotatorServerHeader({ ...options }))`. The
 * options keep their contextual types (the helper returns what it is given)
 * and their methods keep `this`. A WebSocket upgrade (the handler returns
 * nothing) is left alone.
 */

import {
  LIVE_PROXIED_REFUSED_CODE,
  LIVE_PROXIED_REFUSED_MESSAGE,
  PLANNOTATOR_SERVER_HEADER,
  PLANNOTATOR_SERVER_HEADER_VALUE,
  isLiveProxiedRequest,
} from "@plannotator/shared/plannotator-server-marker";

export { PLANNOTATOR_SERVER_HEADER } from "@plannotator/shared/plannotator-server-marker";

/** Set the header on a response, copying it when its headers are immutable. */
export function markPlannotatorResponse<T>(response: T): T {
  if (!(response instanceof Response)) return response;
  try {
    response.headers.set(PLANNOTATOR_SERVER_HEADER, PLANNOTATOR_SERVER_HEADER_VALUE);
    return response;
  } catch {
    // A fetch() Response has immutable headers: answer with a copy.
    const copy = new Response(response.body, response);
    copy.headers.set(PLANNOTATOR_SERVER_HEADER, PLANNOTATOR_SERVER_HEADER_VALUE);
    return copy as T;
  }
}

/** The 403 a request forwarded by the live app proxy gets. */
export function liveProxiedRefusal(): Response {
  return new Response(LIVE_PROXIED_REFUSED_MESSAGE, {
    status: 403,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Plannotator-Error": LIVE_PROXIED_REFUSED_CODE,
      [PLANNOTATOR_SERVER_HEADER]: PLANNOTATOR_SERVER_HEADER_VALUE,
    },
  });
}

type Handler = (this: unknown, ...args: unknown[]) => unknown;

function wrapFetch(handler: Handler): Handler {
  return function (this: unknown, ...args: unknown[]) {
    const req = args[0];
    if (req instanceof Request && isLiveProxiedRequest(req.headers)) return liveProxiedRefusal();
    const result = handler.apply(this, args);
    if (result instanceof Promise) return result.then(markPlannotatorResponse);
    return markPlannotatorResponse(result);
  };
}

function wrapError(handler: Handler): Handler {
  return function (this: unknown, ...args: unknown[]) {
    const result = handler.apply(this, args);
    if (result instanceof Promise) return result.then(markPlannotatorResponse);
    return markPlannotatorResponse(result);
  };
}

/** Wrap `fetch` and `error` of Bun.serve options (see the header). */
export function withPlannotatorServerHeader<T extends object>(options: T): T {
  const record = options as Record<string, unknown>;
  if (typeof record.fetch === "function") record.fetch = wrapFetch(record.fetch as Handler);
  if (typeof record.error === "function") record.error = wrapError(record.error as Handler);
  return options;
}
