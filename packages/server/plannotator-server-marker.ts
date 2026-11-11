/**
 * Bun half of the live-proxy guard: every response carries the Plannotator server header, and requests the live proxy forwarded are refused before any route.
 * Usage: `Bun.serve(withPlannotatorServerHeader({ ...options }))`.
 */

import {
  LIVE_PROXIED_REFUSED_CODE,
  LIVE_PROXIED_REFUSED_MESSAGE,
  PLANNOTATOR_SERVER_HEADER,
  PLANNOTATOR_SERVER_HEADER_VALUE,
  isLiveProxiedRequest,
} from "@plannotator/shared/plannotator-server-marker";

export { PLANNOTATOR_SERVER_HEADER } from "@plannotator/shared/plannotator-server-marker";

export function markPlannotatorResponse<T>(response: T): T {
  if (!(response instanceof Response)) return response;
  try {
    response.headers.set(PLANNOTATOR_SERVER_HEADER, PLANNOTATOR_SERVER_HEADER_VALUE);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(PLANNOTATOR_SERVER_HEADER, PLANNOTATOR_SERVER_HEADER_VALUE);
    return copy as T;
  }
}

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

export function withPlannotatorServerHeader<T extends object>(options: T): T {
  const record = options as Record<string, unknown>;
  if (typeof record.fetch === "function") record.fetch = wrapFetch(record.fetch as Handler);
  if (typeof record.error === "function") record.error = wrapError(record.error as Handler);
  return options;
}
