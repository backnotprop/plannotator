/**
 * POST /api/open-in guards, driven over HTTP against real annotate and review
 * servers. Shared by the Bun suite (open-in-guards.test.ts) and the Pi mirror
 * (apps/pi-extension/server/open-in-guards.test.ts), so both runtimes answer
 * the same scenarios.
 *
 * No real app ever launches. While a request is in flight PATH holds ONLY a
 * scratch folder of launcher stubs (`open`, `xdg-open`, `code`) that record
 * their arguments and exit 0; a launcher that is not a stub cannot be found.
 * Requests go through node:http so Origin, Host and Sec-Fetch-Site are exactly
 * the ones under test. Every test runs under a temp PLANNOTATOR_DATA_DIR.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";

export interface OpenInScenarioServer {
  url: string;
  stop: () => void;
}

export type OpenInScenarioKind = "review" | "annotate";

export type StartOpenInScenarioServer = (
  kind: OpenInScenarioKind,
  options: { root: string; docPath: string; htmlContent: string },
) => Promise<OpenInScenarioServer>;

const HTML = "<!doctype html><html><body>open-in-scenario-app</body></html>";
const LAUNCHERS = ["open", "xdg-open", "code"] as const;

/** The JSON read whose payload advertises `serverSession`. */
const FIRST_READ: Record<OpenInScenarioKind, string> = {
  annotate: "/api/plan",
  review: "/api/diff",
};

interface Answer {
  status: number;
  body: Record<string, unknown> | null;
}

function post(url: string, headers: Record<string, string>, body: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL("/api/open-in", url),
      { method: "POST", headers: { "content-type": "text/plain", ...headers } },
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

export function defineOpenInScenarios(runtime: string, start: StartOpenInScenarioServer): void {
  const environment = createTestEnvironment(
    [
      "PATH",
      "PLANNOTATOR_PORT",
      "PLANNOTATOR_REMOTE",
      "PLANNOTATOR_DATA_DIR",
      "PLANNOTATOR_BROWSER",
      "PLANNOTATOR_AI",
      "PLANNOTATOR_INBOX_CONNECT",
      "SSH_TTY",
      "SSH_CONNECTION",
    ],
    "plannotator-open-in-guards-",
  );

  afterEach(() => environment.restore());

  for (const kind of ["annotate", "review"] as const) {
    describe(`${runtime} ${kind} server: POST /api/open-in`, () => {
      let stubDir = "";
      let launchLog = "";
      let docPath = "";
      let server: OpenInScenarioServer | null = null;
      let host = "";
      let serverSession = "";

      async function setUp(): Promise<void> {
        const originalPath = process.env.PATH ?? "";
        environment.reset();
        const dir = environment.makeTempDir();
        process.env.PATH = originalPath;
        process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
        process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
        process.env.PLANNOTATOR_AI = "disabled";
        process.env.PLANNOTATOR_INBOX_CONNECT = "0";
        process.env.PLANNOTATOR_REMOTE = "0";

        stubDir = environment.makeTempDir();
        launchLog = join(stubDir, "launches.log");
        for (const name of LAUNCHERS) {
          const stub = join(stubDir, name);
          // Builtins only: PATH holds nothing but this folder while it runs.
          writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> "${launchLog}"\nexit 0\n`);
          chmodSync(stub, 0o755);
        }

        const root = environment.makeTempDir();
        docPath = join(root, "notes.md");
        writeFileSync(docPath, "# Notes\n");
        server = await start(kind, { root, docPath, htmlContent: HTML });
        host = new URL(server.url).host;
        const first = (await (await fetch(`${server.url}${FIRST_READ[kind]}`)).json()) as { serverSession?: unknown };
        serverSession = typeof first.serverSession === "string" ? first.serverSession : "";
        expect(serverSession).not.toBe("");
      }

      function launches(): string[] {
        return existsSync(launchLog) ? readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean) : [];
      }

      /** Send with PATH narrowed to the stubs, so nothing real can launch. */
      async function send(headers: Record<string, string>, body: unknown): Promise<Answer> {
        const saved = process.env.PATH;
        process.env.PATH = stubDir;
        try {
          return await post(server!.url, { host, ...headers }, typeof body === "string" ? body : JSON.stringify(body));
        } finally {
          process.env.PATH = saved;
        }
      }

      afterEach(() => {
        server?.stop();
        server = null;
      });

      test("another site's page is refused before anything launches: cross-site, same-site, Origin null", async () => {
        await setUp();
        const foreign: Array<Record<string, string>> = [
          { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
          { origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" },
          // The sandboxed annotated-HTML frame: opaque origin.
          { origin: "null", "sec-fetch-site": "cross-site" },
          { origin: "null", "sec-fetch-site": "same-origin" },
        ];
        for (const headers of foreign) {
          const answer = await send(headers, { filePath: docPath, appId: "reveal", serverSession });
          expect([headers.origin, answer.status]).toEqual([headers.origin, 403]);
        }
        expect(launches()).toEqual([]);
      });

      test("a stale tab's serverSession is 409 session_mismatch and launches nothing", async () => {
        await setUp();
        const answer = await send({ origin: `http://${host}` }, { filePath: docPath, appId: "reveal", serverSession: "not-this-session" });
        expect(answer.status).toBe(409);
        expect(answer.body?.code).toBe("session_mismatch");
        expect(launches()).toEqual([]);
      });

      test("a missing or unknown appId is 400 and never falls back to the OS default handler", async () => {
        await setUp();
        for (const appId of [undefined, "", "default", "not-an-app", 42]) {
          const answer = await send({ origin: `http://${host}` }, { filePath: docPath, appId, serverSession });
          expect([String(appId), answer.status]).toEqual([String(appId), 400]);
          expect(answer.body?.ok).toBe(false);
        }
        expect(launches()).toEqual([]);
      });

      test("same-origin with a catalog app launches it (through the stub)", async () => {
        await setUp();
        const answer = await send({ origin: `http://${host}`, "sec-fetch-site": "same-origin" }, { filePath: docPath, appId: "reveal", serverSession });
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({ ok: true });
        const lines = launches();
        expect(lines.length).toBe(1);
        // Reveal, never a plain `open <file>` (mac: `open -R`, linux: the folder).
        // (The path may come back as its realpath, e.g. /private/var on macOS.)
        if (process.platform === "darwin") {
          expect(lines[0].startsWith("open -R ")).toBe(true);
          expect(lines[0].endsWith("/notes.md")).toBe(true);
        } else {
          expect(lines[0].startsWith("xdg-open ")).toBe(true);
          expect(lines[0].endsWith("/notes.md")).toBe(false);
        }
      });

      test("a request without Origin or serverSession (a non-browser client, an older tab) still works", async () => {
        await setUp();
        const answer = await send({}, { filePath: docPath, appId: "reveal" });
        expect(answer.status).toBe(200);
        expect(launches().length).toBe(1);
      });

      test("the VS Code cookie proxy shape (Origin = proxy, Host = server, Sec-Fetch-Site: same-origin) passes", async () => {
        await setUp();
        const answer = await send(
          { origin: "http://127.0.0.1:53111", "sec-fetch-site": "same-origin" },
          { filePath: docPath, appId: "reveal", serverSession },
        );
        expect(answer.status).toBe(200);
        expect(launches().length).toBe(1);
      });

      test("a path outside the session's roots is still 403", async () => {
        await setUp();
        const answer = await send({ origin: `http://${host}` }, { filePath: "/etc/hosts", appId: "reveal", serverSession });
        expect(answer.status).toBe(403);
        expect(launches()).toEqual([]);
      });
    });
  }
}
