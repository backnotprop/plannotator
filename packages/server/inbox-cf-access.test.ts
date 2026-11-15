import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDoorSession } from "@plannotator/shared/inbox/cf-access-door";
import { makeTestKeys, ownerClaims, TEST_AUD, TEST_HOST, TEST_OWNER, TEST_SESSION_HOST, TEST_TEAM, type TestKeys } from "../../tests/helpers/cf-access-keys";
import { startInboxServer, type InboxServer } from "./inbox";

const KEY_A = "aaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "bbbbbbbbbbbbbbbbbbbbbb";
const SECRET_A = "secret-a-0123456789abcdef0123456789";
const SECRET_B = "secret-b-0123456789abcdef0123456789";

let keys: TestKeys;
let dataDir: string;
const servers: InboxServer[] = [];
const sessions: ReturnType<typeof Bun.serve>[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_CF_ACCESS", "PLANNOTATOR_INBOX_TAILSCALE"] as const;

beforeAll(async () => {
  keys = await makeTestKeys();
});
beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-cf-access-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_INBOX_CF_ACCESS;
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const session of sessions.splice(0)) session.stop(true);
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

async function start(): Promise<{ inbox: InboxServer; door: string }> {
  const port = freePort();
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({ inboxCloudflareAccess: { on: true, host: TEST_HOST, sessionHost: TEST_SESSION_HOST, team: TEST_TEAM, aud: TEST_AUD, allow: [TEST_OWNER], port } }),
  );
  const inbox = await startInboxServer({
    dataDir,
    htmlContent: "<!doctype html><title>Inbox</title>",
    cloudflareAccess: { fetchKeys: async () => keys.jwks, tunnel: false, sessionAlive: () => true, log: () => {} },
  });
  servers.push(inbox);
  return { inbox, door: `http://127.0.0.1:${port}` };
}

function fakeSession(key: string, secret: string) {
  const seen: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      seen.push(req.headers);
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response('<html><head><script type="module" src="/assets/app.js"></script></head></html>', { headers: { "Content-Type": "text/html" } });
      return Response.json({ session: key, path });
    },
  });
  sessions.push(server);
  writeDoorSession(dataDir, { key, port: server.port as number, pid: process.pid, secret });
  return { seen };
}

async function owner(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  return { Host: TEST_HOST, "Sec-Fetch-Site": "same-origin", "Cf-Access-Jwt-Assertion": await keys.sign(ownerClaims(Math.floor(Date.now() / 1000))), ...extra };
}

describe("the Inbox through Cloudflare Access", () => {
  test("an owner's request reaches the Inbox as the tailnet owner does, and Settings reports it", async () => {
    const { inbox, door } = await start();
    const response = await fetch(`${door}/api/inbox/settings`, { headers: await owner() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { via: string; cloudflareAccess: { url: string; allowed: string[] } };
    expect(body.via).toBe("tailnet");
    expect(body.cloudflareAccess).toMatchObject({ url: `https://${TEST_HOST}/`, allowed: [TEST_OWNER] });
    const mcp = await fetch(`${door}/mcp`, { method: "POST", headers: { ...(await owner()), "Content-Type": "application/json" }, body: "{}" });
    expect(mcp.status).toBe(403);
    expect(inbox.registry.cloudflare_access?.url).toBe(`https://${TEST_HOST}/`);
  });

  test("without a valid token nothing past the door answers", async () => {
    const { door } = await start();
    const none = await fetch(`${door}/api/inbox/settings`, { headers: { Host: TEST_HOST } });
    expect([none.status, ((await none.json()) as { code: string }).code]).toEqual([403, "access_token_required"]);
    const wrongHost = await fetch(`${door}/api/inbox/settings`, { headers: await owner({ Host: "127.0.0.1" }) });
    expect(wrongHost.status).toBe(403);
    const stranger = await fetch(`${door}/api/inbox/settings`, {
      headers: { Host: TEST_HOST, "Cf-Access-Jwt-Assertion": await keys.sign(ownerClaims(Math.floor(Date.now() / 1000), { email: "stranger@example.com" })) },
    });
    expect(stranger.status).toBe(403);
  });

  test("the window's own port refuses anything Cloudflare's edge added", async () => {
    const { inbox } = await start();
    const local = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/settings`);
    expect(local.status).toBe(200);
    for (const header of ["cf-access-jwt-assertion", "cf-connecting-ip", "cf-ray"]) {
      const tunneled = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/settings`, { headers: { [header]: "x" } });
      expect(tunneled.status).toBe(403);
    }
  });

  test("a session is reached by its prefix with the door's secret and the public Host, and its page gets the base", async () => {
    const { door } = await start();
    const a = fakeSession(KEY_A, SECRET_A);
    const page = await fetch(`${door}/s/${KEY_A}/`, { headers: await owner({ Host: TEST_SESSION_HOST, "Sec-Fetch-Dest": "document", Cookie: "CF_Authorization=abc; theme=dark", "Plannotator-Door": "forged" }) });
    const html = await page.text();
    expect(html).toContain(`src="/s/${KEY_A}/assets/app.js"`);
    expect(html).toContain("data-plannotator-door");
    const api = await fetch(`${door}/s/${KEY_A}/api/diff?x=1`, { headers: await owner({ Host: TEST_SESSION_HOST }) });
    expect(await api.json()).toEqual({ session: KEY_A, path: "/api/diff" });
    const sent = a.seen[0]!;
    expect(sent.get("plannotator-door")).toBe(SECRET_A);
    expect(sent.get("host")).toBe(TEST_SESSION_HOST);
    expect(sent.get("cookie")).toBe("theme=dark");
    expect(sent.get("cf-access-jwt-assertion")).toBeNull();
  });

  test("with two sessions open, an unattributed request never reaches either session", async () => {
    const { door } = await start();
    const a = fakeSession(KEY_A, SECRET_A);
    const b = fakeSession(KEY_B, SECRET_B);
    const lost = await fetch(`${door}/api/diff`, { headers: await owner({ Host: TEST_SESSION_HOST }) });
    expect(lost.status).toBe(410);
    expect(a.seen.length + b.seen.length).toBe(0);
    const viaReferer = await fetch(`${door}/api/diff`, { headers: await owner({ Host: TEST_SESSION_HOST, Referer: `https://${TEST_SESSION_HOST}/s/${KEY_B}/` }) });
    expect(await viaReferer.json()).toEqual({ session: KEY_B, path: "/api/diff" });
    const inboxRoute = await fetch(`${door}/api/inbox/settings`, { headers: await owner({ Host: TEST_SESSION_HOST }) });
    expect(inboxRoute.status).toBe(403);
    const ended = await fetch(`${door}/s/cccccccccccccccccccccc/`, { headers: await owner({ Host: TEST_SESSION_HOST }) });
    expect(ended.status).toBe(410);
  });

  test("the two names never cross: Host decides before any path or Referer", async () => {
    const { door } = await start();
    const a = fakeSession(KEY_A, SECRET_A);
    const sessionOnInboxName = await fetch(`${door}/s/${KEY_A}/api/diff`, { headers: await owner() });
    expect([sessionOnInboxName.status, ((await sessionOnInboxName.json()) as { code: string }).code]).toEqual([403, "wrong_origin"]);
    const inboxOnSessionName = await fetch(`${door}/api/inbox/settings`, { headers: await owner({ Host: TEST_SESSION_HOST, Referer: `https://${TEST_SESSION_HOST}/s/${KEY_A}/` }) });
    expect(await inboxOnSessionName.json()).toEqual({ session: KEY_A, path: "/api/inbox/settings" });
    const inboxOnSessionNameUnattributed = await fetch(`${door}/api/inbox/settings`, { headers: await owner({ Host: TEST_SESSION_HOST }) });
    expect([inboxOnSessionNameUnattributed.status, ((await inboxOnSessionNameUnattributed.json()) as { code: string }).code]).toEqual([403, "wrong_origin"]);
    const fromSessionPage = await fetch(`${door}/api/inbox/threads`, { headers: await owner({ "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors" }) });
    expect(((await fromSessionPage.json()) as { code: string }).code).toBe("cross_site");
    expect(a.seen.length).toBe(1);
  });

  test("a session's compressed asset passes through unchanged", async () => {
    const { door } = await start();
    const body = Bun.gzipSync(new TextEncoder().encode("console.log('session asset');"));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { headers: { "Content-Type": "text/javascript", "Content-Encoding": "gzip" } }) });
    sessions.push(server);
    writeDoorSession(dataDir, { key: KEY_A, port: server.port as number, pid: process.pid, secret: SECRET_A });
    const asset = await fetch(`${door}/s/${KEY_A}/assets/app.js`, { headers: await owner({ Host: TEST_SESSION_HOST, "Accept-Encoding": "gzip" }) });
    expect(await asset.text()).toBe("console.log('session asset');");
  });

  test("a person signed in through Cloudflare cannot change the Cloudflare settings", async () => {
    const { inbox, door } = await start();
    const read = await fetch(`${door}/api/inbox/cloudflare-access`, { headers: await owner() });
    expect([read.status, ((await read.json()) as { code: string }).code]).toEqual([403, "local_only"]);
    for (const action of ["switch", "remove", "setup", "zones"]) {
      const write = await fetch(`${door}/api/inbox/cloudflare-access/${action}`, {
        method: "POST",
        headers: { ...(await owner()), "Content-Type": "application/json", Origin: `https://${TEST_HOST}` },
        body: JSON.stringify({ on: false, token: "x", serverSession: inbox.serverSession }),
      });
      expect([action, write.status]).toEqual([action, 403]);
    }
    const local = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/cloudflare-access`);
    expect(local.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxCloudflareAccess.on).toBe(true);
  });

  test("an owner's write reaches the Inbox through the door with its body intact", async () => {
    const { inbox, door } = await start();
    const post = async (serverSession: string) => {
      const body = JSON.stringify({ serverSession, text_size: 14 });
      return fetch(`${door}/api/inbox/settings`, {
        method: "POST",
        headers: { ...(await owner()), "Content-Type": "application/json", "Content-Length": String(body.length), Origin: `https://${TEST_HOST}` },
        body,
      });
    };
    expect((await post("not-this-inbox")).status).toBe(409);
    const written = await post(inbox.serverSession);
    expect(written.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxTextSize).toBe(14);
  });
});
