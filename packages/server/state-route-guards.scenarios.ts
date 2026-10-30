/**
 * Cross-origin and stale-tab guards on the plan, annotate and review servers'
 * state-changing routes, driven over HTTP against real servers. Shared by the
 * Bun suite (state-route-guards.test.ts) and the Pi mirror
 * (apps/pi-extension/server/state-route-guards.test.ts), so both runtimes
 * answer the same scenarios.
 *
 * Covered: the guard every server runs before routing (any POST, PUT, PATCH
 * or DELETE from another site is 403 `cross_origin`), and the routes that
 * write files or start processes, which also check `serverSession`:
 * `/api/save-notes` (plan, annotate), `/api/plan/vscode-diff` (plan) and
 * `/api/agents/jobs` (review).
 *
 * Nothing real is launched or written outside temp folders: the only notes
 * target is Obsidian into a temp vault (no Bear or Octarine body is ever
 * sent, so no `open` runs), vscode-diff is never given a version it could
 * open, the job launch names a provider that does not exist, and PATH holds
 * only an empty scratch folder while a request is in flight. Requests go
 * through node:http so Origin, Host and Sec-Fetch-Site are exactly the ones
 * under test. Every test runs under a temp PLANNOTATOR_DATA_DIR.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";

export interface StateRouteScenarioServer {
  url: string;
  stop: () => void;
}

export type StateRouteScenarioKind = "plan" | "review" | "annotate";

export type StartStateRouteScenarioServer = (
  kind: StateRouteScenarioKind,
  options: { root: string; docPath: string; htmlContent: string },
) => Promise<StateRouteScenarioServer>;

const HTML = "<!doctype html><html><body>state-route-scenario-app</body></html>";

/** The JSON read whose payload advertises `serverSession`. */
const FIRST_READ: Record<StateRouteScenarioKind, string> = {
  plan: "/api/plan",
  annotate: "/api/plan",
  review: "/api/diff",
};

interface Answer {
  status: number;
  body: Record<string, unknown> | null;
}

function send(url: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, url),
      { method, headers: { "content-type": "text/plain", ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Headers a page on another site (or the sandboxed annotated-HTML frame) sends. */
const FOREIGN: Array<Record<string, string>> = [
  { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  // Another localhost port: same-site to the browser, never the session's page.
  { origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" },
  // The sandboxed annotated-HTML frame: opaque origin.
  { origin: "null", "sec-fetch-site": "cross-site" },
  { origin: "null", "sec-fetch-site": "same-origin" },
  // A request whose Origin was stripped still carries the browser's verdict.
  { "sec-fetch-site": "cross-site" },
];

/** The VS Code panel's cookie proxy: Origin is the proxy, Host is the server. */
const VSCODE_PROXY = { origin: "http://127.0.0.1:53111", "sec-fetch-site": "same-origin" };

export function defineStateRouteScenarios(runtime: string, start: StartStateRouteScenarioServer): void {
  const environment = createTestEnvironment(
    [
      "PATH",
      "PLANNOTATOR_PORT",
      "PLANNOTATOR_REMOTE",
      "PLANNOTATOR_DATA_DIR",
      "PLANNOTATOR_BROWSER",
      "PLANNOTATOR_AI",
      "PLANNOTATOR_INBOX_CONNECT",
      "PLANNOTATOR_FEEDBACK_HISTORY",
      "PLANNOTATOR_ALLOWED_HOSTS",
      "SSH_TTY",
      "SSH_CONNECTION",
      "NOTION_TOKEN",
    ],
    "plannotator-state-route-guards-",
  );

  let server: StateRouteScenarioServer | null = null;
  let host = "";
  let serverSession = "";
  let emptyPath = "";
  let vault = "";

  afterEach(() => {
    server?.stop();
    server = null;
    environment.restore();
  });

  /**
   * `agentJobs`: the job routes need AI on (they answer 503 when it is off).
   * The server then starts with PATH holding only an empty folder, so it
   * detects no agent CLI and no provider is available to launch.
   */
  async function setUp(kind: StateRouteScenarioKind, options: { agentJobs?: boolean; env?: Record<string, string> } = {}): Promise<void> {
    const originalPath = process.env.PATH ?? "";
    environment.reset();
    const dir = environment.makeTempDir();
    process.env.PATH = originalPath;
    process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
    process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
    if (!options.agentJobs) process.env.PLANNOTATOR_AI = "disabled";
    process.env.PLANNOTATOR_INBOX_CONNECT = "0";
    process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
    process.env.PLANNOTATOR_REMOTE = "0";
    Object.assign(process.env, options.env);

    emptyPath = environment.makeTempDir();
    vault = environment.makeTempDir();
    const root = environment.makeTempDir();
    const docPath = join(root, "notes.md");
    writeFileSync(docPath, "# Notes\n");
    if (options.agentJobs) process.env.PATH = emptyPath;
    try {
      server = await start(kind, { root, docPath, htmlContent: HTML });
    } finally {
      process.env.PATH = originalPath;
    }
    host = new URL(server.url).host;
    const first = (await (await fetch(`${server.url}${FIRST_READ[kind]}`)).json()) as { serverSession?: unknown };
    serverSession = typeof first.serverSession === "string" ? first.serverSession : "";
    expect(serverSession).not.toBe("");
  }

  /** Send with PATH narrowed to an empty folder, so nothing real can launch. */
  async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
    const saved = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      return await send(server!.url, method, path, { host, ...headers }, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
    } finally {
      process.env.PATH = saved;
    }
  }

  const sameOrigin = (): Record<string, string> => ({ origin: `http://${host}`, "sec-fetch-site": "same-origin" });

  function notesWritten(): string[] {
    const folder = join(vault, "plannotator");
    return existsSync(folder) ? readdirSync(folder) : [];
  }

  const saveNotesBody = (extra: Record<string, unknown> = {}) => ({
    obsidian: { vaultPath: vault, folder: "plannotator", plan: "# Saved Plan\n\nBody" },
    ...extra,
  });

  describe(`${runtime}: every state-changing request from another site is refused before routing`, () => {
    const decisions: Array<[StateRouteScenarioKind, string, string]> = [
      ["plan", "POST", "/api/approve"],
      ["plan", "POST", "/api/deny"],
      ["plan", "POST", "/api/draft"],
      ["annotate", "POST", "/api/feedback"],
      ["annotate", "POST", "/api/approve"],
      ["annotate", "POST", "/api/exit"],
      ["review", "POST", "/api/feedback"],
      ["review", "POST", "/api/exit"],
      ["review", "POST", "/api/git-add"],
      ["review", "PUT", "/api/agents/guide-instructions"],
      ["review", "DELETE", "/api/agents/jobs"],
    ];
    for (const kind of ["plan", "annotate", "review"] as const) {
      test(`${kind}: cross-site, same-site, Origin null and a stripped Origin are 403 cross_origin`, async () => {
        await setUp(kind);
        for (const [routeKind, method, path] of decisions) {
          if (routeKind !== kind) continue;
          for (const headers of FOREIGN) {
            const answer = await call(method, path, headers, { feedback: "x", annotations: [], serverSession });
            expect([method, path, JSON.stringify(headers), answer.status, answer.body?.code]).toEqual([
              method,
              path,
              JSON.stringify(headers),
              403,
              "cross_origin",
            ]);
          }
        }
      });
    }

    test("a GET from another site is left to its route (reads are not this guard's business)", async () => {
      await setUp("annotate");
      const answer = await call("GET", "/api/plan", { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
      expect(answer.status).toBe(200);
    });

    test("a non-browser client (no Origin, no fetch metadata) still reaches the route", async () => {
      await setUp("plan");
      const answer = await call("POST", "/api/save-notes", {}, {});
      expect(answer.status).toBe(200);
      expect(answer.body?.ok).toBe(true);
    });
  });

  // A plain-HTTP reverse proxy that rewrites Host (nginx's default proxy_pass):
  // the page's Origin is the proxy's public name, Host is the upstream, and the
  // browser sends no Sec-Fetch-Site over plain HTTP to a non-localhost address.
  describe(`${runtime}: an Origin named in PLANNOTATOR_ALLOWED_HOSTS (a plain-HTTP proxy that rewrites Host)`, () => {
    const proxied = { origin: "http://review.example.com" };
    const routes: Array<[string, unknown, number]> = [
      // [path, body, status once past the guards]
      ["/api/save-notes", {}, 200],
      ["/api/plan/vscode-diff", {}, 400],
    ];

    test("a named hostname (exact or .suffix) passes the guard and the route checks", async () => {
      for (const setting of ["review.example.com", ".example.com", "other.example, review.example.com:8080"]) {
        await setUp("plan");
        process.env.PLANNOTATOR_ALLOWED_HOSTS = setting;
        for (const [path, body, status] of routes) {
          const answer = await call("POST", path, proxied, { ...(body as object), serverSession });
          expect([setting, path, answer.status]).toEqual([setting, path, status]);
        }
        server?.stop();
        server = null;
        environment.restore();
      }
    });

    test("`*` does not widen it, an unnamed Origin is refused, and fetch metadata still wins", async () => {
      await setUp("plan");
      for (const [setting, headers] of [
        ["*", proxied],
        ["other.example", proxied],
        ["review.example.com", { origin: "http://review.example.com.evil.example" }],
        ["review.example.com", { ...proxied, "sec-fetch-site": "cross-site" }],
        ["review.example.com", { origin: "null" }],
      ] as Array<[string, Record<string, string>]>) {
        process.env.PLANNOTATOR_ALLOWED_HOSTS = setting;
        for (const [path] of routes) {
          const answer = await call("POST", path, headers, { serverSession });
          expect([setting, JSON.stringify(headers), path, answer.status, answer.body?.code]).toEqual([
            setting,
            JSON.stringify(headers),
            path,
            403,
            "cross_origin",
          ]);
        }
      }
    });
  });

  for (const kind of ["plan", "annotate"] as const) {
    describe(`${runtime} ${kind} server: POST /api/save-notes`, () => {
      test("another site's page writes nothing", async () => {
        await setUp(kind);
        for (const headers of FOREIGN) {
          const answer = await call("POST", "/api/save-notes", headers, saveNotesBody({ serverSession }));
          expect([JSON.stringify(headers), answer.status]).toEqual([JSON.stringify(headers), 403]);
        }
        expect(notesWritten()).toEqual([]);
      });

      test("a stale tab's serverSession is 409 session_mismatch and writes nothing", async () => {
        await setUp(kind);
        const answer = await call("POST", "/api/save-notes", sameOrigin(), saveNotesBody({ serverSession: "not-this-session" }));
        expect(answer.status).toBe(409);
        expect(answer.body?.code).toBe("session_mismatch");
        expect(notesWritten()).toEqual([]);
      });

      test("the session's own page saves into the vault", async () => {
        await setUp(kind);
        const answer = await call("POST", "/api/save-notes", sameOrigin(), saveNotesBody({ serverSession }));
        expect(answer.status).toBe(200);
        expect((answer.body?.results as { obsidian?: { success?: boolean } })?.obsidian?.success).toBe(true);
        expect(notesWritten().length).toBe(1);
      });

      test("the VS Code cookie proxy shape (Origin = proxy, Sec-Fetch-Site: same-origin) saves", async () => {
        await setUp(kind);
        const answer = await call("POST", "/api/save-notes", VSCODE_PROXY, saveNotesBody({ serverSession }));
        expect(answer.status).toBe(200);
        expect(notesWritten().length).toBe(1);
      });

      test("an Obsidian folder that climbs out of the vault is refused", async () => {
        await setUp(kind);
        const answer = await call("POST", "/api/save-notes", sameOrigin(), {
          obsidian: { vaultPath: vault, folder: "../escaped", plan: "# Saved Plan\n" },
          serverSession,
        });
        expect(answer.status).toBe(200);
        expect((answer.body?.results as { obsidian?: { success?: boolean } })?.obsidian?.success).toBe(false);
        expect(existsSync(join(vault, "..", "escaped"))).toBe(false);
      });
    });
  }

  describe(`${runtime} plan server: POST /api/plan/vscode-diff`, () => {
    test("another site's page is refused; a stale tab is 409; the session's own page reaches validation", async () => {
      await setUp("plan");
      for (const headers of FOREIGN) {
        const answer = await call("POST", "/api/plan/vscode-diff", headers, { serverSession });
        expect([JSON.stringify(headers), answer.status]).toEqual([JSON.stringify(headers), 403]);
      }
      const stale = await call("POST", "/api/plan/vscode-diff", sameOrigin(), { serverSession: "not-this-session" });
      expect(stale.status).toBe(409);
      expect(stale.body?.code).toBe("session_mismatch");
      // No baseVersion: past both guards, refused by validation, nothing opened.
      for (const headers of [sameOrigin(), VSCODE_PROXY]) {
        const own = await call("POST", "/api/plan/vscode-diff", headers, { serverSession });
        expect(own.status).toBe(400);
        expect(own.body?.error).toBe("Missing baseVersion");
      }
    });
  });

  describe(`${runtime} review server: /api/agents/jobs`, () => {
    test("launch and kill from another site are refused", async () => {
      await setUp("review", { agentJobs: true });
      for (const headers of FOREIGN) {
        const launch = await call("POST", "/api/agents/jobs", headers, { provider: "not-a-provider", serverSession });
        expect([JSON.stringify(headers), launch.status]).toEqual([JSON.stringify(headers), 403]);
        const killAll = await call("DELETE", "/api/agents/jobs", headers);
        expect(killAll.status).toBe(403);
        const killOne = await call("DELETE", "/api/agents/jobs/some-id", headers);
        expect(killOne.status).toBe(403);
      }
    });

    test("a stale tab's launch and kill are 409 session_mismatch", async () => {
      await setUp("review", { agentJobs: true });
      const launch = await call("POST", "/api/agents/jobs", sameOrigin(), { provider: "not-a-provider", serverSession: "not-this-session" });
      expect(launch.status).toBe(409);
      expect(launch.body?.code).toBe("session_mismatch");
      const killAll = await call("DELETE", "/api/agents/jobs?serverSession=not-this-session", sameOrigin());
      expect(killAll.status).toBe(409);
      const killOne = await call("DELETE", "/api/agents/jobs/some-id?serverSession=not-this-session", sameOrigin());
      expect(killOne.status).toBe(409);
    });

    test("the session's own page (and the VS Code proxy) reach the route", async () => {
      await setUp("review", { agentJobs: true });
      for (const headers of [sameOrigin(), VSCODE_PROXY]) {
        // Past both guards: the provider does not exist, so nothing launches.
        const launch = await call("POST", "/api/agents/jobs", headers, { provider: "not-a-provider", serverSession });
        expect(launch.status).toBe(400);
        expect(String(launch.body?.error)).toContain("Unknown or unavailable provider");
        const killAll = await call("DELETE", `/api/agents/jobs?serverSession=${serverSession}`, headers);
        expect(killAll.status).toBe(200);
        expect(killAll.body).toEqual({ ok: true, killed: 0 });
      }
      // An older tab sends no session at all: accepted.
      const legacy = await call("DELETE", "/api/agents/jobs", sameOrigin());
      expect(legacy.status).toBe(200);
    });
  });
  // Save to Notion acts with the server's NOTION_TOKEN, so only a session on
  // this computer offers it. Notion itself is never called: fetch is stubbed.
  describe(`${runtime}: Notion is offered only to a local session with NOTION_TOKEN`, () => {
    async function freePort(): Promise<string> {
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      return String(port);
    }

    async function offered(): Promise<unknown> {
      return (await send(server!.url, "GET", "/api/plan", { host })).body?.notion;
    }

    /** Save through the route with Notion stubbed; returns the result and how often Notion was called. */
    async function saveToNotionRoute(): Promise<{ result: unknown; calls: number }> {
      const realFetch = globalThis.fetch;
      let calls = 0;
      // Only Notion's API is stubbed and counted; the server's own requests pass through.
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!target.startsWith("https://api.notion.com/")) return realFetch(input, init);
        calls++;
        return Response.json({ url: "https://www.notion.so/saved" });
      }) as unknown as typeof fetch;
      try {
        const answer = await call("POST", "/api/save-notes", sameOrigin(), {
          notion: { plan: "# Plan\n\nBody", parentPageId: "0123456789abcdef0123456789abcdef" },
          serverSession,
        });
        expect(answer.status).toBe(200);
        return { result: (answer.body?.results as Record<string, unknown> | undefined)?.notion, calls };
      } finally {
        globalThis.fetch = realFetch;
      }
    }

    for (const kind of ["plan", "annotate"] as const) {
      test(`${kind}: offered and saved locally with a token`, async () => {
        await setUp(kind, { env: { NOTION_TOKEN: "secret-token" } });
        expect(await offered()).toBe(true);
        const { result, calls } = await saveToNotionRoute();
        expect(result).toEqual({ success: true, url: "https://www.notion.so/saved" });
        expect(calls).toBe(1);
      });

      test(`${kind}: never offered or saved in remote mode`, async () => {
        await setUp(kind, { env: { NOTION_TOKEN: "secret-token", PLANNOTATOR_REMOTE: "1", PLANNOTATOR_PORT: await freePort() } });
        expect(await offered()).toBeUndefined();
        const { result, calls } = await saveToNotionRoute();
        expect(result).toBeUndefined();
        expect(calls).toBe(0);
      });

      test(`${kind}: never offered without NOTION_TOKEN`, async () => {
        await setUp(kind);
        expect(await offered()).toBeUndefined();
      });
    }
  });
}
