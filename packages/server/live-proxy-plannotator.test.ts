/**
 * Annotate's live app mode never proxies a Plannotator server (Bun side; the
 * Pi mirror is apps/pi-extension/server/live-proxy-plannotator.test.ts).
 *
 * The live proxy mirrors its upstream's origin and passes the browser's own
 * Sec-Fetch-Site through, so a proxied Plannotator page would get same-origin
 * writes on that server. Pinned here, against real servers on loopback:
 *  - every Bun Plannotator server marks its responses with the Plannotator
 *    server header;
 *  - the probe refuses a target by port (the data dir's registries) before
 *    any request, and by that header; --app says so, and without it the
 *    session falls back to static conversion with a notice;
 *  - the proxy refuses the editor's own port at start, and any marked
 *    upstream response, so a write through it never reaches a scratch Inbox.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAnnotateTarget } from "../../apps/hook/server/annotate-resolution";
import { buildForceAppFailureMessage, buildLivePlannotatorFallbackNotice, probeLiveAppTarget } from "@plannotator/shared/live-probe";
import {
  LIVE_PROXY_PLANNOTATOR_UPSTREAM_MESSAGE,
  assertLiveTargetNotEditor,
  isPlannotatorLiveTarget,
} from "@plannotator/shared/live-proxy-core";
import { listPlannotatorServerPorts } from "@plannotator/shared/plannotator-ports";
import {
  LIVE_PROXIED_REFUSED_CODE,
  PLANNOTATOR_LIVE_PROXY_HEADER,
  PLANNOTATOR_SERVER_HEADER,
} from "@plannotator/shared/plannotator-server-marker";
import { startAnnotateServer } from "./annotate";
import { startPlannotatorServer } from "./index";
import { startInboxServer, type InboxServer } from "./inbox";
import { startLiveAppProxy, type LiveAppProxy } from "./live-proxy";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI", "PLANNOTATOR_INBOX_CONNECT"] as const;
const saved: Record<string, string | undefined> = {};
let root: string;
let dataDir: string;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-live-plannotator-")));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_INBOX_CONNECT = "0";
  delete process.env.PLANNOTATOR_PORT;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

async function scratchInbox(): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false });
  cleanups.push(() => server.stop());
  return server;
}

function proxyTo(targetUrl: string): LiveAppProxy {
  const proxy = startLiveAppProxy({
    targetUrl,
    editorOrigins: ["http://localhost:1", "http://127.0.0.1:1"],
    bridgeJs: "/* bridge */",
  });
  cleanups.push(() => proxy.stop());
  return proxy;
}

/** A write as the proxied page's browser sends it: same-origin with the proxy. */
function proxiedPost(proxy: LiveAppProxy, path: string, body: unknown): Promise<Response> {
  const origin = `http://localhost:${proxy.port}`;
  return fetch(`http://127.0.0.1:${proxy.port}${path}`, {
    method: "POST",
    headers: {
      Host: `localhost:${proxy.port}`,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("every Bun Plannotator server sends the Plannotator server header", () => {
  test("plan, review, annotate and the Inbox", async () => {
    const plan = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML });
    cleanups.push(() => plan.stop());
    const review = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML });
    cleanups.push(() => review.stop());
    const annotate = await startAnnotateServer({ markdown: "# T", filePath: join(root, "t.md"), htmlContent: MINIMAL_HTML });
    cleanups.push(() => annotate.stop());
    const inbox = await scratchInbox();

    for (const url of [plan.url, review.url, annotate.url, `http://127.0.0.1:${inbox.port}`]) {
      const page = await fetch(`${url}/`);
      expect(page.headers.get(PLANNOTATOR_SERVER_HEADER)).not.toBeNull();
      // Refusals and unknown routes carry it too.
      const missing = await fetch(`${url}/api/no-such-route`);
      expect(missing.headers.get(PLANNOTATOR_SERVER_HEADER)).not.toBeNull();
      // A request the live proxy forwarded is refused before any route.
      const proxied = await fetch(`${url}/`, { headers: { [PLANNOTATOR_LIVE_PROXY_HEADER]: "1" } });
      expect(proxied.status).toBe(403);
      expect(proxied.headers.get("x-plannotator-error")).toBe(LIVE_PROXIED_REFUSED_CODE);
    }
  });
});

describe("the live probe refuses a Plannotator server", () => {
  test("by a port the data dir's registries name, before any request", async () => {
    const inbox = await scratchInbox();
    const ports = listPlannotatorServerPorts(dataDir);
    expect(ports).toContain(inbox.port);

    const target = `http://localhost:${inbox.port}/`;
    let requests = 0;
    const counting = (async () => {
      requests += 1;
      return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
    }) as unknown as typeof fetch;
    const probe = await probeLiveAppTarget(target, new URL(target), counting, { plannotatorPorts: ports });
    expect(probe).toMatchObject({ liveEligible: false, plannotator: true });
    expect(requests).toBe(0);
  });

  test("by the Plannotator server header when no registry names it", async () => {
    const inbox = await scratchInbox();
    const target = `http://127.0.0.1:${inbox.port}/`;
    const probe = await probeLiveAppTarget(target, new URL(target));
    expect(probe).toMatchObject({ liveEligible: false, plannotator: true, probeError: null });
  });

  test("the sessions registry counts only live processes", () => {
    const sessions = join(dataDir, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, port: 41001 }));
    writeFileSync(join(sessions, "999999999.json"), JSON.stringify({ pid: 999_999_999, port: 41002 }));
    writeFileSync(join(sessions, "garbage.json"), "{not json");
    const ports = listPlannotatorServerPorts(dataDir);
    expect(ports).toContain(41001);
    expect(ports).not.toContain(41002);
  });

  test("a plain dev app is still live", async () => {
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("<html><body>app</body></html>", { headers: { "Content-Type": "text/html" } }),
    });
    cleanups.push(() => app.stop(true));
    const target = `http://127.0.0.1:${app.port}/`;
    const probe = await probeLiveAppTarget(target, new URL(target), fetch, { plannotatorPorts: listPlannotatorServerPorts(dataDir) });
    expect(probe).toMatchObject({ liveEligible: true, plannotator: false });
  });

  test("--app fails with the Plannotator message; without it, static conversion with a notice", async () => {
    const inbox = await scratchInbox();
    const target = `http://localhost:${inbox.port}/`;
    const options = { rawFilePath: target, projectRoot: root, noJina: true, renderMarkdown: false };

    const forced = await resolveAnnotateTarget({ ...options, forceApp: true, log: () => {} });
    expect(forced.ok).toBe(false);
    if (!forced.ok) {
      expect(forced.message).toBe(
        buildForceAppFailureMessage(target, { liveEligible: false, probeError: null, probeRedirectedTo: null, plannotator: true }),
      );
      expect(forced.message).toContain("Plannotator server");
    }

    const lines: string[] = [];
    const fallback = await resolveAnnotateTarget({ ...options, log: (line) => lines.push(line) });
    expect(fallback.ok && fallback.liveApp).toBeFalsy();
    expect(lines).toContain(buildLivePlannotatorFallbackNotice(target));
  });
});

describe("the live proxy refuses a Plannotator server", () => {
  test("the editor's own port, at start", () => {
    expect(isPlannotatorLiveTarget("http://localhost:4100/x", [4100])).toBe(true);
    expect(isPlannotatorLiveTarget("http://example.com:4100/", [4100])).toBe(false);
    expect(() => assertLiveTargetNotEditor("http://127.0.0.1:4100/", ["http://localhost:4100"])).toThrow(/own address/);
    expect(() =>
      startLiveAppProxy({ targetUrl: "http://localhost:4100/", editorOrigins: ["http://localhost:4100", "http://127.0.0.1:4100"], bridgeJs: "" }),
    ).toThrow(/never proxies a Plannotator server/);
  });

  test("a proxied same-origin write never reaches a scratch Inbox", async () => {
    const inbox = await scratchInbox();
    const configPath = join(dataDir, "config.json");
    const before = (() => {
      try {
        return readFileSync(configPath, "utf8");
      } catch {
        return null;
      }
    })();

    const proxy = proxyTo(`http://127.0.0.1:${inbox.port}/`);
    const page = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { Host: `localhost:${proxy.port}`, Accept: "text/html" } });
    expect(page.status).toBe(502);
    expect(await page.text()).toBe(LIVE_PROXY_PLANNOTATOR_UPSTREAM_MESSAGE);

    const write = await proxiedPost(proxy, "/api/inbox/settings", { serverSession: inbox.serverSession, text_size: 12 });
    expect(write.status).toBe(502);
    expect(await write.text()).toBe(LIVE_PROXY_PLANNOTATOR_UPSTREAM_MESSAGE);
    const after = (() => {
      try {
        return readFileSync(configPath, "utf8");
      } catch {
        return null;
      }
    })();
    expect(after).toBe(before);
    expect(after ?? "").not.toContain("inboxTextSize");
  });

  test("a proxied same-origin write never reaches another annotate server", async () => {
    const annotate = await startAnnotateServer({ markdown: "# T", filePath: join(root, "t.md"), htmlContent: MINIMAL_HTML });
    cleanups.push(() => annotate.stop());
    const proxy = proxyTo(`${annotate.url}/`);
    const write = await proxiedPost(proxy, "/api/config", { agentTool: true });
    expect(write.status).toBe(502);
    expect(JSON.stringify(await (await fetch(`${annotate.url}/api/plan`)).json())).not.toContain('"agentTool":true');
  });
});

/** A raw WebSocket handshake to `port`; resolves with the response head. */
function rawUpgrade(port: number, extra: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = [
        "GET / HTTP/1.1",
        `Host: localhost:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        ...Object.entries(extra).map(([name, value]) => `${name}: ${value}`),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let head = "";
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(head);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(head));
  });
}

describe("WebSocket upgrades through the live proxy", () => {
  test("the proxy tags the upstream handshake once", async () => {
    let tag: string | null | undefined;
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        tag = req.headers.get(PLANNOTATOR_LIVE_PROXY_HEADER);
        if (srv.upgrade(req)) return;
        return new Response("no", { status: 400 });
      },
      websocket: { message() {} },
    });
    cleanups.push(() => app.stop(true));
    const proxy = proxyTo(`http://127.0.0.1:${app.port}/`);
    const ws = new WebSocket(`ws://localhost:${proxy.port}/`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("upgrade failed"));
    });
    // The proxy connects upstream once the client's socket is open.
    for (let i = 0; i < 100 && tag === undefined; i++) await Bun.sleep(20);
    ws.close();
    expect(tag).toBe("1");
  });

  test("an upgrade through the proxy to an Inbox is refused", async () => {
    const inbox = await scratchInbox();
    // The Inbox refuses a tagged handshake before any route.
    const direct = await rawUpgrade(inbox.port, { [PLANNOTATOR_LIVE_PROXY_HEADER]: "1" });
    expect(direct).toStartWith("HTTP/1.1 403");
    expect(direct.toLowerCase()).toContain(`x-plannotator-error: ${LIVE_PROXIED_REFUSED_CODE}`);

    // Through the proxy, the client's socket is closed and never carries a message.
    const proxy = proxyTo(`http://127.0.0.1:${inbox.port}/`);
    const ws = new WebSocket(`ws://localhost:${proxy.port}/`);
    let messages = 0;
    ws.onmessage = () => {
      messages += 1;
    };
    const closed = await new Promise<boolean>((resolve) => {
      ws.onclose = () => resolve(true);
      setTimeout(() => resolve(false), 5000);
    });
    expect(closed).toBe(true);
    expect(messages).toBe(0);
  });
});
