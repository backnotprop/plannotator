import {
  PLANNOTATOR_DAEMON_SESSION_VIEWS,
  createDaemonErrorResponse,
  getDaemonCapabilities,
  type DaemonCreateSessionRequest,
  type DaemonEndpoint,
  type DaemonEvent,
  type DaemonSessionBootstrapResponse,
  type DaemonSessionStatus,
  type DaemonSessionSummary,
  type DaemonStatus,
  type DaemonWebSocketClientMessage,
} from "@plannotator/shared/daemon-protocol";
import type { DaemonState } from "./state";
import { DAEMON_AUTH_COOKIE, DAEMON_AUTH_QUERY_PARAM } from "./state";
import { DaemonSessionStore, type DaemonSessionRecord } from "./session-store";
import { DaemonEventHub } from "./event-hub";
import type { SessionEventFamily, SessionRequestContext, SessionSnapshotProvider } from "../session-handler";
import { handleFavicon } from "../shared-handlers";
import { addProject, listProjects, readProjectRegistry, writeProjectRegistry } from "./project-registry";
import { loadConfig, saveConfig, getServerConfig, detectGitUser } from "@plannotator/shared/config";
import { readImprovementHook, getImprovementHookExpectedPath } from "@plannotator/shared/improvement-hooks";
import { composeImproveContext } from "@plannotator/shared/pfm-reminder";
import { readSnapshot } from "./session-store";
import { parseRemoteUrl, parseRemoteHost } from "@plannotator/shared/repo";
import { checkPRAuth, fetchPRList, fetchPRDetailedList } from "../pr";
import type { PRRef, PRListItem, PRDetailedListItem } from "@plannotator/shared/pr-types";

const RESULT_DELETE_GRACE_MS = 2_000;
const DAEMON_AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export type SessionBrowserAction = "opened" | "notified";

export interface DaemonServerOptions {
  state: DaemonState;
  shellHtmlContent: string;
  store?: DaemonSessionStore;
  createSession: (
    request: DaemonCreateSessionRequest,
    context: DaemonFetchContext,
  ) => DaemonSessionRecord | Promise<DaemonSessionRecord>;
  presentSession?: (
    record: DaemonSessionRecord,
    eventHub: DaemonEventHub,
  ) => Promise<SessionBrowserAction>;
  onShutdown?: () => void | Promise<void>;
}

export interface DaemonFetchContext {
  endpoint: DaemonEndpoint;
  store: DaemonSessionStore;
  publishSessionEvent: (
    sessionId: string,
    family: SessionEventFamily,
    event: unknown,
  ) => void;
  registerSessionSnapshotProvider: (
    sessionId: string,
    family: SessionEventFamily,
    provider: SessionSnapshotProvider,
  ) => () => void;
}

export type DaemonFetchHandler = ((
  req: Request,
  requestContext?: SessionRequestContext,
) => Promise<Response | undefined>) & {
  eventHub: DaemonEventHub;
  websocket: DaemonEventHub["websocket"];
};

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

function queryToken(url: URL): string | undefined {
  return url.searchParams.get(DAEMON_AUTH_QUERY_PARAM) ?? undefined;
}

function hasDaemonAuth(req: Request, state: DaemonState, url?: URL, options: { allowQuery?: boolean } = {}): boolean {
  return (
    bearerToken(req) === state.authToken ||
    cookieToken(req) === state.authToken ||
    (options.allowQuery === true && queryToken(url ?? new URL(req.url)) === state.authToken)
  );
}

function isAuthBootstrapPage(req: Request, url: URL): boolean {
  if (!isPageRequest(req)) return false;
  if (url.pathname === "/") return true;
  const session = sessionFromPath(url.pathname);
  return !!session && !session.rest.startsWith("/api");
}

function isAllowedWebSocketOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
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

export function createDaemonFetchHandler(options: DaemonServerOptions): DaemonFetchHandler {
  const store = options.store ?? new DaemonSessionStore();
  const prListCache = new Map<string, { prs: PRListItem[]; platform: string; defaultBranch: string; time: number }>();
  const prDetailedListCache = new Map<string, { prs: PRDetailedListItem[]; platform: string; time: number }>();
  const endpoint: DaemonEndpoint = {
    hostname: options.state.hostname,
    port: options.state.port,
    baseUrl: options.state.baseUrl,
    isRemote: options.state.isRemote,
  };

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

  const parseResponsePayload = async (response: Response): Promise<unknown> => {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const dispatchAction = async (
    message: Extract<DaemonWebSocketClientMessage, { type: "action" }>,
  ): Promise<{ status: number; payload?: unknown }> => {
    const record = store.get(message.sessionId);
    if (!record?.handleRequest) {
      throw new Error(`Session not found: ${message.sessionId}`);
    }
    const method = message.method.toUpperCase();
    const path = message.path.startsWith("/") ? message.path : `/${message.path}`;
    const actionUrl = new URL(path, endpoint.baseUrl);
    if (actionUrl.pathname !== "/api" && !actionUrl.pathname.startsWith("/api/")) {
      throw new Error("Daemon WebSocket actions must target a session /api path.");
    }

    const init: RequestInit = { method };
    if (message.body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(message.body);
    }
    const response = await record.handleRequest(new Request(actionUrl, init), actionUrl);
    return {
      status: response.status,
      payload: await parseResponsePayload(response),
    };
  };

  const eventHub = new DaemonEventHub({
    daemonSnapshot: () => ({
      status: makeStatus(),
      sessions: store.list(),
    }),
    dispatchAction,
  });

  const context: DaemonFetchContext = {
    endpoint,
    store,
    publishSessionEvent: (sessionId, family, event) => {
      eventHub.publishSessionEvent(sessionId, family, event);
    },
    registerSessionSnapshotProvider: (sessionId, family, provider) =>
      eventHub.registerSnapshotProvider(sessionId, family, provider),
  };

  store.onMutation((event) => eventHub.publishDaemonEvent(event));

  const daemonFetch = async function daemonFetch(
    req: Request,
    requestContext?: SessionRequestContext,
  ): Promise<Response | undefined> {
      const url = new URL(req.url);

      if (url.pathname === "/daemon/capabilities" && req.method === "GET") {
        return json(getDaemonCapabilities());
      }

      if (url.pathname === "/favicon.svg" && req.method === "GET") {
        return handleFavicon();
      }

      if (url.pathname !== "/daemon/ws" && isAuthBootstrapPage(req, url) && url.searchParams.has(DAEMON_AUTH_QUERY_PARAM)) {
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

      if (url.pathname === "/daemon/ws" && req.method === "GET") {
        if (!isAllowedWebSocketOrigin(req, url)) {
          return json(createDaemonErrorResponse("unauthorized", "Daemon WebSocket origin is not allowed."), { status: 403 });
        }
        if (!requestContext?.upgradeWebSocket) {
          return json(createDaemonErrorResponse("invalid-request", "WebSocket upgrade is unavailable."), { status: 426 });
        }
        const upgraded = requestContext.upgradeWebSocket({
          daemonAuthenticated: hasDaemonAuth(req, options.state, url, { allowQuery: true }),
        });
        return upgraded;
      }

      if (url.pathname.startsWith("/daemon/") && !hasDaemonAuth(req, options.state, url)) {
        return daemonUnauthorized();
      }

      if (url.pathname === "/daemon/events" && req.method === "GET") {
        return json(createDaemonErrorResponse("invalid-request", "Daemon events moved to /daemon/ws."), { status: 410 });
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
        eventHub.publishDaemonEvent({
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
          const isFrontendInitiated = record.origin === "plannotator-frontend";
          const browserAction = options.presentSession && !isFrontendInitiated
            ? await options.presentSession(record, eventHub).catch((): SessionBrowserAction => "opened")
            : undefined;
          return json({
            ok: true,
            session: store.summary(record, { includeRemoteShare: true }),
            ...(browserAction && { browserAction }),
          }, { status: 201 });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to create session.";
          eventHub.publishDaemonEvent({
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
          if (completed.status !== "awaiting-resubmission" && completed.status !== "idle") {
            const timer = setTimeout(() => void store.delete(id), RESULT_DELETE_GRACE_MS);
            timer.unref?.();
          }
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

      if (url.pathname === "/daemon/fs/list" && req.method === "GET") {
        const rawPath = url.searchParams.get("path") ?? "~";
        try {
          const { readdirSync, statSync, existsSync } = await import("fs");
          const { homedir } = await import("os");
          const { join, dirname, basename, resolve: resolvePath } = await import("path");
          const resolved = rawPath === "~" || rawPath === "~/"
            ? homedir()
            : rawPath.startsWith("~/")
              ? join(homedir(), rawPath.slice(2))
              : resolvePath(rawPath);
          let listDir = resolved;
          let prefix = "";
          const isDir = existsSync(resolved) && statSync(resolved).isDirectory();
          if (!isDir) {
            listDir = dirname(resolved);
            prefix = basename(resolved).toLowerCase();
          }
          const entries = readdirSync(listDir, { withFileTypes: true });
          const dirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith(".") && (!prefix || e.name.toLowerCase().startsWith(prefix)))
            .map((e) => ({ name: e.name, path: join(listDir, e.name) }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return json({ ok: true, path: isDir ? resolved : listDir, dirs });
        } catch {
          return json({ ok: true, path: rawPath, dirs: [] });
        }
      }

      if (url.pathname === "/daemon/projects" && req.method === "GET") {
        return json({ ok: true, projects: listProjects() });
      }

      if (url.pathname === "/daemon/projects" && req.method === "POST") {
        if (!isJsonRequest(req)) {
          return json(createDaemonErrorResponse("invalid-request", "Project requests must use application/json."), { status: 415 });
        }
        let body: { name?: unknown; cwd?: unknown };
        try {
          body = await req.json() as { name?: unknown; cwd?: unknown };
        } catch {
          return json(createDaemonErrorResponse("invalid-request", "Invalid project request JSON."), { status: 400 });
        }
        if (typeof body.cwd !== "string" || body.cwd.length === 0) {
          return json(createDaemonErrorResponse("invalid-request", "Project requires a cwd path."), { status: 400 });
        }
        const name = typeof body.name === "string" && body.name.length > 0 ? body.name : undefined;
        try {
          const entry = addProject(body.cwd, name);
          return json({ ok: true, project: entry }, { status: 201 });
        } catch (err) {
          return json(
            createDaemonErrorResponse("invalid-request", err instanceof Error ? err.message : "Failed to add project."),
            { status: 400 },
          );
        }
      }

      if (url.pathname === "/daemon/projects" && req.method === "DELETE") {
        const cwd = url.searchParams.get("cwd");
        if (!cwd) {
          return json(createDaemonErrorResponse("invalid-request", "Project deletion requires a cwd query parameter."), { status: 400 });
        }
        const clean = url.searchParams.get("clean") === "1";
        const entries = readProjectRegistry();
        const project = entries.find((e) => e.cwd === cwd);
        if (!project) {
          return json(createDaemonErrorResponse("invalid-request", `Project not found: ${cwd}`), { status: 404 });
        }
        const childCwds = entries.filter((e) => e.parentCwd === project.cwd).map((e) => e.cwd);
        const projectCwds = new Set([project.cwd, ...childCwds]);
        const remaining = entries.filter((e) => !projectCwds.has(e.cwd));
        writeProjectRegistry(remaining);

        if (clean) {
          for (const record of store.list()) {
            if (record.project === project.name || projectCwds.has(record.cwd ?? "")) {
              void store.cancel(record.id, "Project removed.");
            }
          }
          const safeName = project.name.replace(/[/\\]/g, "");
          if (safeName && safeName.length > 0 && !/^\.+$/.test(safeName)) {
            try {
              const { join, resolve, sep } = await import("path");
              const { homedir } = await import("os");
              const { rmSync } = await import("fs");
              const historyRoot = resolve(homedir(), ".plannotator", "history");
              const historyDir = resolve(join(historyRoot, safeName));
              if (historyDir.startsWith(historyRoot + sep)) {
                rmSync(historyDir, { recursive: true, force: true });
              }
            } catch {}
          }
        }

        return json({ ok: true });
      }

      if (url.pathname === "/daemon/projects/worktrees" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd");
        if (!cwd) {
          return json(createDaemonErrorResponse("invalid-request", "Worktree listing requires a cwd query parameter."), { status: 400 });
        }
        try {
          const { execSync } = await import("child_process");
          const raw = execSync("git worktree list --porcelain", { cwd, encoding: "utf-8" });
          const worktrees: { path: string; branch: string | null; head: string }[] = [];
          let current: { path?: string; branch?: string | null; head?: string } = {};
          for (const line of raw.split("\n")) {
            if (line.startsWith("worktree ")) {
              if (current.path) worktrees.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? "" });
              current = { path: line.slice(9) };
            } else if (line.startsWith("HEAD ")) {
              current.head = line.slice(5);
            } else if (line.startsWith("branch ")) {
              current.branch = line.slice(7).replace(/^refs\/heads\//, "");
            } else if (line === "detached") {
              current.branch = null;
            }
          }
          if (current.path) worktrees.push({ path: current.path, branch: current.branch ?? null, head: current.head ?? "" });
          const { tmpdir } = await import("os");
          const { statSync, existsSync } = await import("fs");
          const { join, resolve: resolvePath } = await import("path");
          const tmp = tmpdir();
          const filtered = worktrees.filter((wt) => !wt.path.startsWith(tmp) && !wt.path.startsWith("/private" + tmp));

          const withActivity = filtered.map((wt) => {
            let lastActive = 0;
            try {
              const gitDir = execSync("git rev-parse --git-dir", { cwd: wt.path, encoding: "utf-8" }).trim();
              const indexPath = join(resolvePath(wt.path, gitDir), "index");
              if (existsSync(indexPath)) {
                lastActive = statSync(indexPath).mtimeMs;
              }
            } catch {}
            if (!lastActive) {
              try {
                const commitTime = execSync("git log -1 --format=%ct", { cwd: wt.path, encoding: "utf-8" }).trim();
                if (commitTime) lastActive = Number(commitTime) * 1000;
              } catch {}
            }
            if (!lastActive) {
              try {
                lastActive = statSync(wt.path).mtimeMs;
              } catch {}
            }
            return { ...wt, lastActive };
          });

          withActivity.sort((a, b) => b.lastActive - a.lastActive);
          return json({ ok: true, worktrees: withActivity });
        } catch (err) {
          return json({ ok: true, worktrees: [] });
        }
      }

      if ((url.pathname === "/daemon/projects/prs" || url.pathname === "/daemon/projects/prs/detailed") && req.method === "GET") {
        const isDetailed = url.pathname.endsWith("/detailed");
        const cwd = url.searchParams.get("cwd");
        if (!cwd) {
          return json(createDaemonErrorResponse("invalid-request", "PR listing requires a cwd query parameter."), { status: 400 });
        }
        const now = Date.now();
        if (!isDetailed) {
          const cached = prListCache.get(cwd);
          if (cached && now - cached.time < 30_000) {
            return json({ ok: true, prs: cached.prs, platform: cached.platform, defaultBranch: cached.defaultBranch });
          }
        } else {
          const cached = prDetailedListCache.get(cwd);
          if (cached && now - cached.time < 30_000) {
            return json({ ok: true, prs: cached.prs, platform: cached.platform });
          }
        }
        try {
          const { execSync } = await import("child_process");
          let remoteUrl: string;
          try {
            remoteUrl = execSync("git remote get-url origin", { cwd, encoding: "utf-8" }).trim();
          } catch {
            return json({ ok: true, prs: [], platform: null, error: "no-remote" });
          }
          const host = parseRemoteHost(remoteUrl);
          const repoPath = parseRemoteUrl(remoteUrl);
          if (!host || !repoPath) {
            return json({ ok: true, prs: [], platform: null, error: "no-remote" });
          }
          const isGitLab = host.toLowerCase().includes("gitlab");
          const platform = isGitLab ? "gitlab" : "github";
          let ref: PRRef;
          if (isGitLab) {
            ref = { platform: "gitlab", host, projectPath: repoPath, iid: 0 };
          } else {
            const parts = repoPath.split("/");
            const owner = parts.slice(0, -1).join("/");
            const repo = parts[parts.length - 1];
            ref = { platform: "github", host, owner, repo, number: 0 };
          }
          try {
            await checkPRAuth(ref);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isNotFound = message.includes("not found") || message.includes("ENOENT");
            return json({ ok: true, prs: [], platform, error: isNotFound ? "no-cli" : "auth-failed", message });
          }
          if (isDetailed) {
            let prs: PRDetailedListItem[];
            try { prs = await fetchPRDetailedList(ref); } catch { return json({ ok: true, prs: [], platform }); }
            prDetailedListCache.set(cwd, { prs, platform, time: now });
            return json({ ok: true, prs, platform });
          } else {
            let prs: PRListItem[];
            try { prs = await fetchPRList(ref); } catch { return json({ ok: true, prs: [], platform }); }
            let defaultBranch = "main";
            try {
              const symRef = execSync("git symbolic-ref refs/remotes/origin/HEAD", { cwd, encoding: "utf-8" }).trim();
              const branch = symRef.replace(/^refs\/remotes\/origin\//, "");
              if (branch) defaultBranch = branch;
            } catch {}
            prListCache.set(cwd, { prs, platform, defaultBranch, time: now });
            return json({ ok: true, prs, platform, defaultBranch });
          }
        } catch {
          return json({ ok: true, prs: [], platform: null });
        }
      }

      // --- Global settings endpoints (no session context needed) ---

      if (url.pathname === "/daemon/config" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd") ?? undefined;
        const gitUser = detectGitUser(cwd);
        return json({ ok: true, config: getServerConfig(gitUser) });
      }

      if (url.pathname === "/daemon/config" && req.method === "POST") {
        if (!isJsonRequest(req)) {
          return json(createDaemonErrorResponse("invalid-request", "Config requests must use application/json."), { status: 415 });
        }
        try {
          const body = (await req.json()) as Record<string, unknown>;
          const toSave: Record<string, unknown> = {};
          if (body.displayName !== undefined) toSave.displayName = body.displayName;
          if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
          if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
          if (body.conventionalLabels !== undefined) toSave.conventionalLabels = body.conventionalLabels;
          if (body.pfmReminder !== undefined) toSave.pfmReminder = body.pfmReminder;
          if (body.legacyTabMode !== undefined) toSave.legacyTabMode = body.legacyTabMode;
          if (Object.keys(toSave).length > 0) saveConfig(toSave as Parameters<typeof saveConfig>[0]);
          return json({ ok: true });
        } catch {
          return json(createDaemonErrorResponse("invalid-request", "Invalid config request."), { status: 400 });
        }
      }

      if (url.pathname === "/daemon/git/user" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd") ?? undefined;
        const gitUser = detectGitUser(cwd);
        return json({ ok: true, gitUser });
      }

      if (url.pathname === "/daemon/improve-context" && req.method === "GET") {
        const config = loadConfig();
        const hook = readImprovementHook("enterplanmode-improve");
        const composed = composeImproveContext({
          pfmEnabled: config.pfmReminder === true,
          improvementHookContent: hook?.content ?? null,
        });
        return json({ ok: true, context: composed });
      }

      if (url.pathname === "/daemon/hooks/status" && req.method === "GET") {
        const config = loadConfig();
        const hook = readImprovementHook("enterplanmode-improve");
        const pfmEnabled = config.pfmReminder === true;
        const composed = composeImproveContext({
          pfmEnabled,
          improvementHookContent: hook?.content ?? null,
        });
        return json({
          ok: true,
          pfmReminder: { enabled: pfmEnabled },
          improvementHook: {
            present: !!hook,
            filePath: hook?.filePath ?? getImprovementHookExpectedPath("enterplanmode-improve"),
            fileSize: hook?.content?.length ?? null,
            content: hook?.content ?? null,
          },
          composedLength: composed?.length ?? null,
        });
      }

      const browserSession = sessionFromPath(url.pathname);
      if (browserSession) {
        let record = store.get(browserSession.id);
        const sessionApiPath = `/s/${browserSession.id}/api`;
        if (!record) {
          const snapshot = readSnapshot(browserSession.id);
          if (snapshot && isPageRequest(req)) {
            return html(sessionShellHtml(options.shellHtmlContent, browserSession.id));
          }
          if (snapshot && req.method === "GET") {
            if (url.pathname === `${sessionApiPath}/session`) {
              const summary: DaemonSessionSummary = {
                id: snapshot.sessionId,
                mode: snapshot.mode,
                status: snapshot.status as DaemonSessionStatus,
                url: `${endpoint.baseUrl}/s/${snapshot.sessionId}`,
                project: snapshot.meta.project,
                label: snapshot.meta.label,
                ...(snapshot.meta.origin && { origin: snapshot.meta.origin }),
                ...(snapshot.meta.cwd && { cwd: snapshot.meta.cwd }),
                createdAt: snapshot.capturedAt,
                updatedAt: snapshot.capturedAt,
              };
              const bootstrap: DaemonSessionBootstrapResponse = {
                ok: true,
                session: summary,
                apiBase: sessionApiPath,
                capabilities: getDaemonCapabilities(),
                supportedSessionViews: [...PLANNOTATOR_DAEMON_SESSION_VIEWS],
              };
              return json(bootstrap);
            }
            const apiPath = url.pathname.slice(sessionApiPath.length);
            if (apiPath === "/plan" || apiPath === "/diff") {
              return json({ ...snapshot.content as object, _snapshot: true, _status: snapshot.status, _result: snapshot.result });
            }
          }
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
            const snapshot = readSnapshot(browserSession.id);
            if (snapshot && req.method === "GET") {
              const apiPath = url.pathname.slice(sessionApiPath.length);
              if (apiPath === "/plan" || apiPath === "/diff") {
                return json({ ...snapshot.content as object, _snapshot: true, _status: snapshot.status, _result: snapshot.result });
              }
            }
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

  daemonFetch.eventHub = eventHub;
  daemonFetch.websocket = eventHub.websocket;
  return daemonFetch;
}
