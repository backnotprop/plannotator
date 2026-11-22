/**
 * The network key (#956) against real plan, review and annotate servers, in a
 * remote session SSH alone turned on (`PLANNOTATOR_REMOTE` unset,
 * `SSH_CONNECTION` set). Shared by the Bun suite (network-key.test.ts) and the
 * Pi mirror (apps/pi-extension/server/network-key.test.ts), so both runtimes
 * answer the same scenarios.
 *
 * Every server is bound to 127.0.0.1 (the runtime's loopback bind seam:
 * remote mode would otherwise listen on every interface), and a test plays
 * "another computer" by naming the peer every request is judged as coming
 * from, through the runtime's own copy of `setThisMachineForTests`. Every
 * request goes over loopback with node:http, so headers are exactly the ones
 * under test. Remote mode would bind the fixed 19432: each server gets a free
 * port through PLANNOTATOR_PORT. Every test runs under a temp
 * PLANNOTATOR_DATA_DIR; nothing is decided, written or launched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";

export interface NetworkKeyScenarioServer {
  url: string;
  stop: () => void | Promise<void>;
}

export type NetworkKeyScenarioKind = "plan" | "review" | "annotate";

export type StartNetworkKeyScenarioServer = (
  kind: NetworkKeyScenarioKind,
  options: { root: string; docPath: string; htmlContent: string },
) => Promise<NetworkKeyScenarioServer>;

/** The runtime's own copy of the rule's test seams (Pi vendors packages/shared). */
export interface NetworkKeySeams {
  setThisMachineForTests(rule: { addresses?: readonly string[]; loopback?: boolean; peer?: string } | null): void;
  /** The runtime's own `setLoopbackBindForTests`: bind 127.0.0.1 even in remote mode. */
  setLoopbackBindForTests(on: boolean): void;
  resetNetworkKeysForTests(): void;
  networkKeyCookieName(key: string): string;
}

const HTML = "<!doctype html><html><body>network-key-scenario-app</body></html>";

const FIRST_READ: Record<NetworkKeyScenarioKind, string> = {
  plan: "/api/plan",
  annotate: "/api/plan",
  review: "/api/diff",
};

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * A request written byte for byte, for request targets node:http's client
 * would tidy up (it collapses a leading `//`).
 */
function sendRaw(port: number, target: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = [`GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close"];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const split = raw.indexOf("\r\n\r\n");
      const head = (split === -1 ? raw : raw.slice(0, split)).split("\r\n");
      const answerHeaders: Record<string, string> = {};
      for (const line of head.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) answerHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status: Number(head[0]?.split(" ")[1] ?? 0), headers: answerHeaders, text: split === -1 ? "" : raw.slice(split + 4) });
    });
  });
}

/** A WebSocket upgrade's status line (the socket is closed right after). */
function upgradeStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        host: `127.0.0.1:${port}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

const PAGE = { accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "document" };

/**
 * `upgrades`: whether the runtime answers a refused upgrade over the wire.
 * Bun's node:http emulation (which runs the Pi suite) does not relay bytes
 * written to an upgrade socket, so Pi's upgrade half is covered by
 * apps/pi-extension/server/network-key-guard.test.ts instead.
 */
export function defineNetworkKeyScenarios(
  runtime: string,
  start: StartNetworkKeyScenarioServer,
  seams: NetworkKeySeams,
  options: { upgrades: boolean } = { upgrades: true },
): void {
  const environment = createTestEnvironment(
    [
      "PLANNOTATOR_PORT",
      "PLANNOTATOR_REMOTE",
      "PLANNOTATOR_DATA_DIR",
      "PLANNOTATOR_BROWSER",
      "PLANNOTATOR_AI",
      "PLANNOTATOR_INBOX_CONNECT",
      "PLANNOTATOR_FEEDBACK_HISTORY",
      "PLANNOTATOR_URL_HOST",
      "PLANNOTATOR_PUBLIC_URL",
      "PLANNOTATOR_ALLOWED_HOSTS",
      "SSH_TTY",
      "SSH_CONNECTION",
    ],
    "plannotator-network-key-",
  );

  const servers: NetworkKeyScenarioServer[] = [];
  let dataDir = "";
  let root = "";
  let docPath = "";

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
    seams.setThisMachineForTests(null);
    seams.setLoopbackBindForTests(false);
    seams.resetNetworkKeysForTests();
    environment.restore();
  });

  async function isolate(mode: "ssh" | "remote" | "local" = "ssh"): Promise<void> {
    environment.reset();
    seams.resetNetworkKeysForTests();
    seams.setLoopbackBindForTests(true);
    const dir = environment.makeTempDir();
    dataDir = join(dir, "data");
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
    process.env.PLANNOTATOR_AI = "disabled";
    process.env.PLANNOTATOR_INBOX_CONNECT = "0";
    process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
    if (mode === "ssh") process.env.SSH_CONNECTION = "10.0.0.2 51000 10.0.0.1 22";
    else process.env.PLANNOTATOR_REMOTE = mode === "remote" ? "1" : "0";
    if (mode !== "local") {
      const { start: port, servers: held } = await occupyConsecutivePorts(1);
      await closeServer(held[0]);
      process.env.PLANNOTATOR_PORT = String(port);
    }
    root = environment.makeTempDir();
    docPath = join(root, "notes.md");
    writeFileSync(docPath, "# Notes\n");
  }

  async function open(kind: NetworkKeyScenarioKind): Promise<{ server: NetworkKeyScenarioServer; port: number }> {
    const server = await start(kind, { root, docPath, htmlContent: HTML });
    servers.push(server);
    const port = process.env.PLANNOTATOR_PORT ? Number(process.env.PLANNOTATOR_PORT) : Number(new URL(server.url).port);
    return { server, port };
  }

  /** From here on, requests come from another computer (a TEST-NET address that is none of this machine's). */
  const fromAnotherComputer = () => seams.setThisMachineForTests({ addresses: ["10.0.0.1"], peer: "203.0.113.7" });
  const key = () => readFileSync(join(dataDir, "network-key"), "utf8").trim();
  const cookieOf = () => `${seams.networkKeyCookieName(key())}=${key()}`;

  for (const kind of ["plan", "review", "annotate"] as const) {
    describe(`${runtime} ${kind} server over SSH: the network key`, () => {
      test("this machine (every tunnel, the VS Code panel, agents) needs no key", async () => {
        await isolate();
        const { server, port } = await open(kind);
        // A localhost URL never carries the key: nothing changes in what is printed or relayed.
        expect(server.url).not.toContain("key=");
        const page = await send(port, "GET", "/", PAGE);
        expect(page.status).toBe(200);
        expect(page.text).toContain("network-key-scenario-app");
        expect((await send(port, "GET", FIRST_READ[kind])).status).toBe(200);
        // An agent relaying the bare URL, from this machine.
        expect((await send(port, "GET", "/?client=x", PAGE)).status).toBe(200);
      });

      test("another computer without the key is refused before any route: the page, the API, a decision, an upgrade", async () => {
        await isolate();
        const { port } = await open(kind);
        fromAnotherComputer();
        const page = await send(port, "GET", "/", PAGE);
        expect(page.status).toBe(401);
        expect(String(page.headers["content-type"])).toContain("text/html");
        expect(page.text).not.toContain("network-key-scenario-app");
        expect(page.text).not.toContain(key());
        const api = await send(port, "GET", FIRST_READ[kind]);
        expect(api.status).toBe(401);
        expect(JSON.parse(api.text)).toMatchObject({ ok: false, code: "network_key_required" });
        expect(api.text).not.toContain(key());
        const decision = kind === "plan" ? "/api/approve" : "/api/feedback";
        const decided = await send(port, "POST", decision, { "content-type": "application/json" }, JSON.stringify({ permissionMode: "bypassPermissions", feedback: "x" }));
        expect(decided.status).toBe(401);
        if (options.upgrades) expect(await upgradeStatus(port, "/api/agent-terminal/ws")).toBe(401);
        // A wrong key is the same as none.
        expect((await send(port, "GET", `${FIRST_READ[kind]}?key=${"A".repeat(43)}`)).status).toBe(401);
      });

      test("the keyed link sets the cookie and lands on the clean address; reloads and second tabs ride the cookie", async () => {
        await isolate();
        const { port } = await open(kind);
        fromAnotherComputer();
        const landing = await send(port, "GET", `/?key=${key()}`, PAGE);
        expect(landing.status).toBe(303);
        expect(landing.headers.location).toBe("/");
        const setCookie = String(landing.headers["set-cookie"]);
        expect(setCookie).toContain(cookieOf());
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Lax");
        expect(setCookie).toContain("Path=/");
        expect(setCookie).toMatch(/Max-Age=\d{7,}/);
        // The redirect target, a reload, a second tab: the cookie alone.
        const page = await send(port, "GET", "/", { ...PAGE, cookie: cookieOf() });
        expect(page.status).toBe(200);
        expect(page.text).toContain("network-key-scenario-app");
        expect((await send(port, "GET", FIRST_READ[kind], { cookie: cookieOf() })).status).toBe(200);
        // An upgrade with the cookie gets past the key (what the route answers is its own business).
        if (options.upgrades) expect(await upgradeStatus(port, "/api/agent-terminal/ws", { cookie: cookieOf() })).not.toBe(401);
        // The annotated-HTML frame's token paths answer as before (their sandbox sends no SameSite cookie).
        expect((await send(port, "GET", "/api/html-assets/0000000000000000/x.css")).status).not.toBe(401);
      });

      test("a second session later on the same port takes the same cookie (the replaced-review reload)", async () => {
        await isolate();
        const first = await open(kind);
        const cookie = cookieOf();
        await first.server.stop();
        servers.splice(servers.indexOf(first.server), 1);
        seams.resetNetworkKeysForTests();
        const second = await open(kind);
        expect(second.port).toBe(first.port);
        fromAnotherComputer();
        expect((await send(second.port, "GET", "/", { ...PAGE, cookie })).status).toBe(200);
        expect((await send(second.port, "GET", FIRST_READ[kind], { cookie })).status).toBe(200);
      });

      test("a URL another computer opens directly (urlHost) carries the key", async () => {
        await isolate();
        process.env.PLANNOTATOR_URL_HOST = "devbox.example";
        const { server, port } = await open(kind);
        expect(server.url).toBe(`http://devbox.example:${port}/?key=${key()}`);
      });

      test("a key or cookie with a non-ASCII character of the key's length is refused, and the server keeps answering", async () => {
        await isolate();
        const { port } = await open(kind);
        fromAnotherComputer();
        // 43 characters, 44 bytes: comparing it must not throw.
        const sameLength = `${"A".repeat(42)}é`;
        expect((await send(port, "GET", `/?key=${encodeURIComponent(sameLength)}`, PAGE)).status).toBe(401);
        expect((await send(port, "GET", `${FIRST_READ[kind]}?key=${encodeURIComponent(sameLength)}`)).status).toBe(401);
        // A cookie carrying a raw latin1 byte (what a header may hold on the wire).
        const rawByte = `${seams.networkKeyCookieName(key())}=${"A".repeat(42)}\xe9`;
        const refused = await send(port, "GET", FIRST_READ[kind], { cookie: rawByte });
        expect(refused.status).toBe(401);
        expect(refused.text).not.toContain(" at ");
        expect((await send(port, "GET", "/", { ...PAGE, cookie: rawByte })).status).toBe(401);
        // Still up, still the same rule.
        expect((await send(port, "GET", FIRST_READ[kind], { cookie: cookieOf() })).status).toBe(200);
      });

      test("a request target that reads as protocol-relative never reaches the app without the key", async () => {
        await isolate();
        const { port } = await open(kind);
        fromAnotherComputer();
        for (const target of ["//x/api/html-assets/t", "//x/api/html-assets/0000000000000000/x.css"]) {
          const answer = await sendRaw(port, target, PAGE);
          expect(answer.status).not.toBe(0);
          expect(answer.text).not.toContain("network-key-scenario-app");
        }
      });

      test("the keyed link's redirect always stays on this address", async () => {
        await isolate();
        const { port } = await open(kind);
        fromAnotherComputer();
        for (const target of [`/.//evil.example/?key=${key()}`, `//evil.example/?key=${key()}`, `/%2F/evil.example/?key=${key()}`]) {
          const landing = await sendRaw(port, target, PAGE);
          expect(landing.status).toBe(303);
          const location = String(landing.headers.location);
          expect(location.startsWith("/")).toBe(true);
          expect(location[1] === "/" || location[1] === "\\").toBe(false);
          expect(location).not.toContain("key=");
        }
      });

      test("PLANNOTATOR_REMOTE=1 and local mode are unchanged: no key is asked for or advertised", async () => {
        for (const mode of ["remote", "local"] as const) {
          await isolate(mode);
          process.env.PLANNOTATOR_URL_HOST = mode === "remote" ? "devbox.example" : "";
          if (mode === "local") delete process.env.PLANNOTATOR_URL_HOST;
          const { server, port } = await open(kind);
          expect(server.url).not.toContain("key=");
          fromAnotherComputer();
          expect((await send(port, "GET", "/", PAGE)).status).toBe(200);
          expect((await send(port, "GET", FIRST_READ[kind])).status).toBe(200);
          for (const s of servers.splice(0)) await s.stop();
          seams.setThisMachineForTests(null);
          seams.setLoopbackBindForTests(false);
          environment.restore();
        }
      });
    });
  }
}
