/**
 * Host-header allowlist (packages/shared/request-host.ts), driven over HTTP
 * against real plan, review and annotate servers. Shared by the Bun suite
 * (request-host.test.ts) and the Pi mirror
 * (apps/pi-extension/server/request-host.test.ts), so both runtimes answer
 * the same scenarios.
 *
 * Requests go through node:http so the Host header is exactly the one under
 * test (fetch sets its own). Every test runs under a temp
 * PLANNOTATOR_DATA_DIR; nothing touches the real ~/.plannotator.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { hostname } from "node:os";
import { machineHostnames } from "../shared/request-host";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";

export interface HostScenarioServer {
  url: string;
  stop: () => void;
}

export type HostScenarioKind = "plan" | "review" | "annotate";

export type StartHostScenarioServer = (
  kind: HostScenarioKind,
  options: { docPath: string; htmlContent: string },
) => Promise<HostScenarioServer>;

const HTML = "<!doctype html><html><body>host-scenario-app</body></html>";
const EVIL = "evil.example";

/** The JSON read each kind's page loads first. */
const FIRST_READ: Record<HostScenarioKind, string> = {
  plan: "/api/plan",
  annotate: "/api/plan",
  review: "/api/diff",
};

/** The decision endpoint each kind takes. */
const DECISION: Record<HostScenarioKind, string> = {
  plan: "/api/approve",
  annotate: "/api/feedback",
  review: "/api/feedback",
};

export function defineRequestHostScenarios(runtime: string, start: StartHostScenarioServer): void {
  const environment = createTestEnvironment(
    [
      "PLANNOTATOR_PORT",
      "PLANNOTATOR_REMOTE",
      "PLANNOTATOR_DATA_DIR",
      "PLANNOTATOR_BROWSER",
      "PLANNOTATOR_AI",
      "PLANNOTATOR_URL_HOST",
      "PLANNOTATOR_ALLOWED_HOSTS",
      "VSCODE_PROXY_URI",
      "SSH_TTY",
      "SSH_CONNECTION",
    ],
    "plannotator-request-host-",
  );

  let docPath = "";

  async function isolate(options: { remote?: boolean; allowedHosts?: string } = {}): Promise<void> {
    environment.reset();
    const dir = environment.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
    process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
    process.env.PLANNOTATOR_AI = "disabled";
    process.env.PLANNOTATOR_REMOTE = options.remote ? "1" : "0";
    if (options.allowedHosts !== undefined) process.env.PLANNOTATOR_ALLOWED_HOSTS = options.allowedHosts;
    if (options.remote) {
      // Remote mode would otherwise bind the fixed 19432.
      const { start: port, servers } = await occupyConsecutivePorts(1);
      await closeServer(servers[0]);
      process.env.PLANNOTATOR_PORT = String(port);
    }
    docPath = join(dir, "notes.md");
    writeFileSync(docPath, "# Notes\n\nsecret body\n");
  }

  afterEach(() => environment.restore());

  const portOf = (server: HostScenarioServer) => new URL(server.url).port;
  const get = (server: HostScenarioServer, path: string, host: string) =>
    rawRequest(`${loopbackBase(server)}${path}`, { headers: { host } });

  for (const kind of ["plan", "review", "annotate"] as const) {
    describe(`${runtime} ${kind} server: Host allowlist`, () => {
      test("loopback Hosts are answered, a foreign name is refused on every route", async () => {
        await isolate();
        const server = await start(kind, { docPath, htmlContent: HTML });
        try {
          const port = portOf(server);
          for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
            const page = await get(server, "/", host);
            expect([host, page.status]).toEqual([host, 200]);
            expect(page.body.toString("utf8")).toContain("host-scenario-app");
            const read = await get(server, FIRST_READ[kind], host);
            expect([host, read.status]).toEqual([host, 200]);
            const externals = await get(server, "/api/external-annotations", host);
            expect([host, externals.status]).toEqual([host, 200]);
          }

          const evil = `${EVIL}:${port}`;
          const refusedReads = ["/", FIRST_READ[kind], "/api/external-annotations", "/api/draft"];
          if (kind !== "review") refusedReads.push(`/api/doc?path=${encodeURIComponent(docPath)}`);
          for (const path of refusedReads) {
            const res = await get(server, path, evil);
            expect([path, res.status]).toEqual([path, 403]);
            const body = res.body.toString("utf8");
            expect(body).toContain("PLANNOTATOR_ALLOWED_HOSTS");
            expect(body).not.toContain("secret body");
            expect(body).not.toContain("host-scenario-app");
          }

          // Writes are refused before they reach a handler: no decision, no config write.
          const decision = await rawRequestWithBody(server, DECISION[kind], evil, { feedback: "x", annotations: [] });
          expect(decision.status).toBe(403);
          const config = await rawRequestWithBody(server, "/api/config", evil, { displayName: "rebound" });
          expect(config.status).toBe(403);

          // A WebSocket upgrade never succeeds: a 403, or (node:http with no
          // upgrade listener attached, i.e. no agent terminal) a closed
          // socket. The guarded-listener case is request-host-guard.test.ts.
          const upgrade = await rawRequest(`${loopbackBase(server)}/api/agent-terminal/pty/x`, {
            headers: { host: evil, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
          }).then((res) => res.status, () => "closed");
          expect([403, "closed"]).toContain(upgrade);

          // The session is still undecided and answers its own page.
          const after = await get(server, FIRST_READ[kind], `localhost:${port}`);
          expect(after.status).toBe(200);
        } finally {
          server.stop();
        }
      });

      test("remote mode also answers IP literals, the urlHost and this machine's name, and still refuses a foreign name", async () => {
        await isolate({ remote: true });
        process.env.PLANNOTATOR_URL_HOST = "review-box.example";
        const server = await start(kind, { docPath, htmlContent: HTML });
        try {
          const port = portOf(server);
          expect((await get(server, "/", `review-box.example:${port}`)).status).toBe(200);
          const [machine] = machineHostnames(hostname());
          if (machine) expect((await get(server, "/", `${machine}:${port}`)).status).toBe(200);
          expect((await get(server, FIRST_READ[kind], `192.168.1.20:${port}`)).status).toBe(200);
          expect((await get(server, "/", `[fd00::5]:${port}`)).status).toBe(200);
          expect((await get(server, "/", `localhost:${port}`)).status).toBe(200);
          if (machine) {
            const short = machine.split(".")[0];
            expect((await get(server, "/", `${short}.local:${port}`)).status).toBe(200);
          }
          expect((await get(server, FIRST_READ[kind], `${EVIL}:${port}`)).status).toBe(403);
        } finally {
          server.stop();
        }
      });

      test("a browser IDE's port proxy (VSCODE_PROXY_URI) is answered on its per-port hostname in local mode", async () => {
        await isolate();
        process.env.VSCODE_PROXY_URI = "https://{{port}}--dev--ws--me.coder.example.com/";
        const server = await start(kind, { docPath, htmlContent: HTML });
        try {
          const port = portOf(server);
          expect((await get(server, FIRST_READ[kind], `${port}--dev--ws--me.coder.example.com`)).status).toBe(200);
          expect((await get(server, FIRST_READ[kind], `x--dev--ws--me.coder.example.com`)).status).toBe(403);
          expect((await get(server, FIRST_READ[kind], `${EVIL}:${port}`)).status).toBe(403);
        } finally {
          server.stop();
        }
      });

      test("PLANNOTATOR_ALLOWED_HOSTS admits a forwarded hostname; * turns the check off", async () => {
        await isolate({ allowedHosts: "preview.example.com" });
        const server = await start(kind, { docPath, htmlContent: HTML });
        try {
          const port = portOf(server);
          expect((await get(server, "/", `preview.example.com:${port}`)).status).toBe(200);
          expect((await get(server, "/", `${EVIL}:${port}`)).status).toBe(403);
        } finally {
          server.stop();
          environment.restore();
        }
        await isolate({ allowedHosts: "*" });
        const open = await start(kind, { docPath, htmlContent: HTML });
        try {
          expect((await get(open, "/", `${EVIL}:${portOf(open)}`)).status).toBe(200);
        } finally {
          open.stop();
        }
      });
    });
  }
}

function rawRequestWithBody(server: HostScenarioServer, path: string, host: string, body: unknown) {
  const text = JSON.stringify(body);
  return new Promise<{ status: number }>((resolve, reject) => {
    // node:http directly: rawRequest sends no body.
    const req = request(
      `${loopbackBase(server)}${path}`,
      { method: "POST", headers: { host, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

/** Connect over loopback whatever URL the session advertises (urlHost). */
function loopbackBase(server: HostScenarioServer): string {
  return `http://127.0.0.1:${new URL(server.url).port}`;
}

/** A GET (or bodiless request) with exactly these headers; fetch would set its own Host. */
function rawRequest(url: string, options: { headers: Record<string, string> }): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
