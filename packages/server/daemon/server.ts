import {
  createDaemonErrorResponse,
  getDaemonCapabilities,
  type DaemonCreateSessionRequest,
  type DaemonEndpoint,
  type DaemonStatus,
} from "@plannotator/shared/daemon-protocol";
import type { DaemonState } from "./state";
import { DaemonSessionStore, type DaemonSessionRecord } from "./session-store";
import type { SessionRequestContext } from "../session-handler";
import { handleFavicon } from "../shared-handlers";

const RESULT_DELETE_GRACE_MS = 2_000;

export interface DaemonServerOptions {
  state: DaemonState;
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

function injectApiBase(html: string, apiBaseScript: string): string {
  const marker = "</head>";
  const index = html.lastIndexOf(marker);
  if (index === -1) return `${apiBaseScript}${html}`;
  return `${html.slice(0, index)}${apiBaseScript}${html.slice(index)}`;
}

function createApiBaseScript(apiBase: string): string {
  return `<script>
(() => {
  const apiBase = ${JSON.stringify(apiBase)};
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

export function createDaemonFetchHandler(options: DaemonServerOptions) {
  const store = options.store ?? new DaemonSessionStore();
  const endpoint: DaemonEndpoint = {
    hostname: options.state.hostname,
    port: options.state.port,
    baseUrl: options.state.baseUrl,
    isRemote: options.state.isRemote,
  };

  const context: DaemonFetchContext = { endpoint, store };

  return async function daemonFetch(req: Request, requestContext?: SessionRequestContext): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === "/daemon/capabilities" && req.method === "GET") {
        return json(getDaemonCapabilities());
      }

      if (url.pathname === "/favicon.svg" && req.method === "GET") {
        return handleFavicon();
      }

      if (url.pathname === "/daemon/status" && req.method === "GET") {
        const status: DaemonStatus = {
          ok: true,
          protocol: options.state.protocol,
          protocolVersion: options.state.protocolVersion,
          pid: options.state.pid,
          endpoint,
          startedAt: options.state.startedAt,
          activeSessionCount: store.activeCount(),
          sessionCount: store.totalCount(),
        };
        return json(status);
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
          return json(
            createDaemonErrorResponse("internal-error", err instanceof Error ? err.message : "Failed to create session."),
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
        if (!record) {
          return new Response("Session not found", { status: 404 });
        }
        const sessionApiPath = `/s/${browserSession.id}/api`;
        if (url.pathname === sessionApiPath || url.pathname.startsWith(`${sessionApiPath}/`)) {
          if (!record.handleRequest) {
            return new Response("Session has no API handler", { status: 404 });
          }
          const scopedUrl = stripSessionApiPath(url, browserSession.id);
          return record.handleRequest(new Request(scopedUrl.toString(), req), scopedUrl, requestContext);
        }
        if (record.htmlContent) {
          const apiBase = `/s/${record.id}/api`;
          const apiBaseScript = createApiBaseScript(apiBase);
          return new Response(injectApiBase(record.htmlContent, apiBaseScript), {
            headers: { "Content-Type": "text/html" },
          });
        }
      }

      return new Response("Not found", { status: 404 });
    };
}
