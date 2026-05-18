import {
  PLANNOTATOR_DAEMON_SESSION_VIEWS,
  createDaemonErrorResponse,
  getDaemonCapabilities,
  serializeDaemonEvent,
  type DaemonCreateSessionRequest,
  type DaemonEndpoint,
  type DaemonEvent,
  type DaemonSessionBootstrapResponse,
  type DaemonStatus,
} from "@plannotator/shared/daemon-protocol";
import type { DaemonState } from "./state";
import { DAEMON_AUTH_COOKIE, DAEMON_AUTH_QUERY_PARAM } from "./state";
import { DaemonSessionStore, type DaemonSessionRecord } from "./session-store";
import type { SessionRequestContext } from "../session-handler";
import { handleFavicon } from "../shared-handlers";

const RESULT_DELETE_GRACE_MS = 2_000;
const DAEMON_EVENT_HEARTBEAT_MS = 15_000;
const SSE_HEARTBEAT_COMMENT = ": heartbeat\n\n";
const DAEMON_AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface DaemonServerOptions {
  state: DaemonState;
  shellHtmlContent: string;
  store?: DaemonSessionStore;
  createSession: (
    request: DaemonCreateSessionRequest,
    context: DaemonFetchContext,
  ) => DaemonSessionRecord | Promise<DaemonSessionRecord>;
  onShutdown?: () => void | Promise<void>;
}

export interface DaemonFetchContext {
  endpoint: DaemonEndpoint;
  store: DaemonSessionStore;
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function stripSessionApiPath(url: URL, sessionId: string): URL {
  const next = new URL(url.toString());
  const prefix = `/s/${sessionId}/api`;
  next.pathname = `/api${url.pathname.slice(prefix.length)}`;
  return next;
}

function sessionFromPath(pathname: string): { id: string; rest: string } | null {
  const match = pathname.match(/^\/s\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    id: decodeURIComponent(match[1]),
    rest: match[2] || "/",
  };
}

function isJsonRequest(req: Request): boolean {
  const contentType = req.headers.get("content-type") ?? "";
  return contentType.split(";")[0].trim().toLowerCase() === "application/json";
}

function isPageRequest(req: Request): boolean {
  return req.method === "GET" || req.method === "HEAD";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function cookieToken(req: Request): string | undefined {
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === DAEMON_AUTH_COOKIE) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return undefined;
}

function hasDaemonAuth(req: Request, state: DaemonState): boolean {
  return bearerToken(req) === state.authToken || cookieToken(req) === state.authToken;
}

function daemonAuthCookie(state: DaemonState): string {
  return [
    `${DAEMON_AUTH_COOKIE}=${encodeURIComponent(state.authToken)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${DAEMON_AUTH_COOKIE_MAX_AGE_SECONDS}`,
  ].join("; ");
}

function daemonUnauthorized(): Response {
  return json(
    createDaemonErrorResponse("unauthorized", "Daemon control request is missing or using an invalid auth token."),
    { status: 401 },
  );
}

function injectApiBase(html: string, apiBaseScript: string): string {
  const marker = "</head>";
  const index = html.lastIndexOf(marker);
  if (index === -1) return `${apiBaseScript}${html}`;
  return `${html.slice(0, index)}${apiBaseScript}${html.slice(index)}`;
}

function createApiBaseScript(apiBase: string): string {
  const safeApiBase = JSON.stringify(apiBase).replace(/</g, "\\u003c");
  return `<script>
(() => {
  const apiBase = ${safeApiBase};
  window.__PLANNOTATOR_API_BASE__ = apiBase;

  const isApiPath = (path) => path === "/api" || path.startsWith("/api/");
  const rewrite = (input) => {
    if (typeof input === "string" && isApiPath(input)) {
      return apiBase + input.slice(4);
    }
    if (input instanceof URL && isApiPath(input.pathname)) {
      const next = new URL(input.toString());
      next.pathname = apiBase + input.pathname.slice(4);
      return next;
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      const next = rewrite(new URL(input.url));
      if (next instanceof URL && next.toString() !== input.url) {
        return new Request(next.toString(), input);
      }
    }
    return input;
  };

  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) {
    window.fetch = (input, init) => originalFetch(rewrite(input), init);
  }

  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    window.EventSource = function(url, init) {
      return new OriginalEventSource(rewrite(url), init);
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
    window.EventSource.CONNECTING = OriginalEventSource.CONNECTING;
    window.EventSource.OPEN = OriginalEventSource.OPEN;
    window.EventSource.CLOSED = OriginalEventSource.CLOSED;
  }
})();
</script>`;
}

function html(htmlContent: string): Response {
  return new Response(htmlContent, {
    headers: { "Content-Type": "text/html" },
  });
}

function sessionShellHtml(shellHtmlContent: string, sessionId: string): string {
  const apiBase = `/s/${sessionId}/api`;
  return injectApiBase(shellHtmlContent, createApiBaseScript(apiBase));
}

function daemonEventHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
}

export function createDaemonFetchHandler(options: DaemonServerOptions) {
  const store = options.store ?? new DaemonSessionStore();
  const endpoint: DaemonEndpoint = {
    hostname: options.state.hostname,
    port: options.state.port,
    baseUrl: options.state.baseUrl,
    isRemote: options.state.isRemote,
  };

  const context: DaemonFetchContext = { endpoint, store };
  const encoder = new TextEncoder();
  const subscribers = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    ReturnType<typeof setInterval>
  >();

  const makeStatus = (): DaemonStatus => ({
    ok: true,
    protocol: options.state.protocol,
    protocolVersion: options.state.protocolVersion,
    pid: options.state.pid,
    endpoint,
    startedAt: options.state.startedAt,
    activeSessionCount: store.activeCount(),
    sessionCount: store.totalCount(),
  });

  const sendEvent = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: DaemonEvent,
  ) => {
    controller.enqueue(encoder.encode(serializeDaemonEvent(event)));
  };

  const removeSubscriber = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const timer = subscribers.get(controller);
    if (timer) clearInterval(timer);
    subscribers.delete(controller);
  };

  const broadcast = (event: DaemonEvent) => {
    for (const controller of subscribers.keys()) {
      try {
        sendEvent(controller, event);
      } catch {
        removeSubscriber(controller);
      }
    }
  };

  store.onMutation((event) => broadcast(event));

  return async function daemonFetch(req: Request, requestContext?: SessionRequestContext): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === "/daemon/capabilities" && req.method === "GET") {
        return json(getDaemonCapabilities());
      }

      if (url.pathname === "/favicon.svg" && req.method === "GET") {
        return handleFavicon();
      }

      if (isPageRequest(req) && url.searchParams.has(DAEMON_AUTH_QUERY_PARAM)) {
        const token = url.searchParams.get(DAEMON_AUTH_QUERY_PARAM);
        if (token !== options.state.authToken) return daemonUnauthorized();
        url.searchParams.delete(DAEMON_AUTH_QUERY_PARAM);
        return new Response(null, {
          status: 302,
          headers: {
            Location: url.toString(),
            "Set-Cookie": daemonAuthCookie(options.state),
          },
        });
      }

      if (url.pathname === "/" && isPageRequest(req)) {
        return html(options.shellHtmlContent);
      }

      if (url.pathname.startsWith("/daemon/") && !hasDaemonAuth(req, options.state)) {
        return daemonUnauthorized();
      }

      if (url.pathname === "/daemon/events" && req.method === "GET") {
        requestContext?.disableIdleTimeout?.();
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(SSE_HEARTBEAT_COMMENT));
              } catch {
                removeSubscriber(controller);
              }
            }, DAEMON_EVENT_HEARTBEAT_MS);
            heartbeat.unref?.();
            subscribers.set(controller, heartbeat);

            const at = new Date().toISOString();
            const status = makeStatus();
            sendEvent(controller, {
              type: "snapshot",
              at,
              status,
              sessions: store.list(),
            });
            sendEvent(controller, {
              type: "daemon-status",
              at,
              status,
            });
          },
          cancel() {
            if (streamController) removeSubscriber(streamController);
          },
        });
        return new Response(stream, { headers: daemonEventHeaders() });
      }

      if (url.pathname === "/daemon/events/debug" && req.method === "POST") {
        if (!isJsonRequest(req)) {
          return json(createDaemonErrorResponse("invalid-request", "Daemon debug events must use application/json."), { status: 415 });
        }
        let body: Record<string, unknown>;
        try {
          body = await req.json() as Record<string, unknown>;
        } catch {
          return json(createDaemonErrorResponse("invalid-request", "Invalid daemon debug event JSON."), { status: 400 });
        }
        const message = optionalString(body.message);
        if (!message) {
          return json(createDaemonErrorResponse("invalid-request", "Daemon debug events require a message."), { status: 400 });
        }
        const rawLevel = optionalString(body.level);
        const level = rawLevel === "debug" || rawLevel === "info" || rawLevel === "warn" || rawLevel === "error"
          ? rawLevel
          : "info";
        broadcast({
          type: "debug-log",
          at: optionalString(body.at) ?? new Date().toISOString(),
          source: optionalString(body.source) ?? "external",
          message,
          level,
          sessionId: optionalString(body.sessionId),
          scenarioId: optionalString(body.scenarioId),
          data: body.data,
        });
        return json({ ok: true });
      }

      if (url.pathname === "/daemon/status" && req.method === "GET") {
        return json(makeStatus());
      }

      if (url.pathname === "/daemon/sessions" && req.method === "GET") {
        if (url.searchParams.get("clean") === "1") {
          await store.cleanupExpired();
        }
        return json({ ok: true, sessions: store.list() });
      }

      if (url.pathname === "/daemon/sessions" && req.method === "POST") {
        if (!isJsonRequest(req)) {
          return json(createDaemonErrorResponse("invalid-request", "Daemon session requests must use application/json."), { status: 415 });
        }
        let body: DaemonCreateSessionRequest;
        try {
          body = await req.json() as DaemonCreateSessionRequest;
        } catch {
          return json(createDaemonErrorResponse("invalid-request", "Invalid daemon session request JSON."), { status: 400 });
        }
        try {
          requestContext?.disableIdleTimeout?.();
          const record = await options.createSession(body, context);
          return json({ ok: true, session: store.summary(record, { includeRemoteShare: true }) }, { status: 201 });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to create session.";
          broadcast({
            type: "daemon-error",
            at: new Date().toISOString(),
            code: "internal-error",
            message,
          });
          return json(
            createDaemonErrorResponse("internal-error", message),
            { status: 500 },
          );
        }
      }

      const sessionRoute = url.pathname.match(/^\/daemon\/sessions\/([^/]+)(?:\/([^/]+))?$/);
      if (sessionRoute) {
        const id = decodeURIComponent(sessionRoute[1]);
        const action = sessionRoute[2] ?? "";
        const record = store.get(id);
        if (!record) {
          return json(createDaemonErrorResponse("session-not-found", `Session not found: ${id}`), { status: 404 });
        }

        if (!action && req.method === "GET") {
          return json({ ok: true, session: store.summary(record) });
        }

        if (action === "result" && req.method === "GET") {
          requestContext?.disableIdleTimeout?.();
          const completed = await store.waitForResult(id);
          const response = json({ ok: true, session: store.summary(completed), result: completed.result ?? null });
          const timer = setTimeout(() => void store.delete(id), RESULT_DELETE_GRACE_MS);
          timer.unref?.();
          return response;
        }

        if (action === "cancel" && req.method === "POST") {
          if (!isJsonRequest(req)) {
            return json(createDaemonErrorResponse("invalid-request", "Daemon cancel requests must use application/json."), { status: 415 });
          }
          let body: { reason?: unknown } = {};
          try {
            body = await req.json() as { reason?: unknown };
          } catch {
            return json(createDaemonErrorResponse("invalid-request", "Invalid daemon cancel request JSON."), { status: 400 });
          }
          const cancelled = await store.cancel(id, typeof body.reason === "string" ? body.reason : undefined);
          return json({ ok: true, session: store.summary(cancelled ?? record) });
        }

        if (!action && req.method === "DELETE") {
          await store.delete(id);
          return json({ ok: true });
        }
      }

      if (url.pathname === "/daemon/shutdown" && req.method === "POST") {
        if (!isJsonRequest(req)) {
          return json(createDaemonErrorResponse("invalid-request", "Daemon shutdown requests must use application/json."), { status: 415 });
        }
        const timer = setTimeout(() => {
          void Promise.resolve(options.onShutdown?.()).catch(() => {});
        }, 0);
        timer.unref?.();
        return json({ ok: true, shuttingDown: true });
      }

      const browserSession = sessionFromPath(url.pathname);
      if (browserSession) {
        const record = store.get(browserSession.id);
        const sessionApiPath = `/s/${browserSession.id}/api`;
        if (!record) {
          if (url.pathname === `${sessionApiPath}/session` && req.method === "GET") {
            return json(createDaemonErrorResponse("session-not-found", `Session not found: ${browserSession.id}`), { status: 404 });
          }
          if (url.pathname === sessionApiPath || url.pathname.startsWith(`${sessionApiPath}/`)) {
            return json(createDaemonErrorResponse("session-not-found", `Session not found: ${browserSession.id}`), { status: 404 });
          }
          if (isPageRequest(req)) {
            return html(sessionShellHtml(options.shellHtmlContent, browserSession.id));
          }
          return new Response("Not found", { status: 404 });
        }
        if (url.pathname === `${sessionApiPath}/session` && req.method === "GET") {
          const bootstrap: DaemonSessionBootstrapResponse = {
            ok: true,
            session: store.summary(record, { includeRemoteShare: true }),
            apiBase: sessionApiPath,
            capabilities: getDaemonCapabilities(),
            supportedSessionViews: [...PLANNOTATOR_DAEMON_SESSION_VIEWS],
          };
          return json(bootstrap);
        }
        if (url.pathname === sessionApiPath || url.pathname.startsWith(`${sessionApiPath}/`)) {
          if (!record.handleRequest) {
            return new Response("Session has no API handler", { status: 404 });
          }
          const scopedUrl = stripSessionApiPath(url, browserSession.id);
          return record.handleRequest(new Request(scopedUrl.toString(), req), scopedUrl, requestContext);
        }
        if (isPageRequest(req)) {
          return html(sessionShellHtml(options.shellHtmlContent, record.id));
        }
        return new Response("Not found", { status: 404 });
      }

      return new Response("Not found", { status: 404 });
    };
}
