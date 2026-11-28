import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCfApi, type CfFetch } from "@plannotator/shared/inbox/cf-access-api";
import { startInboxServer, type InboxServer } from "./inbox";
import { tunnelTokenPath } from "./cf-tunnel";

const TOKEN = "SENTINEL-cf-api-token-7f3a9c";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "fedcba9876543210fedcba9876543210";
const TUNNEL = "11111111-2222-3333-4444-555555555555";
const TEAM = "myteam.cloudflareaccess.com";

let root: string;
let dataDir: string;
const servers: InboxServer[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_CF_ACCESS"] as const;
const logged: string[] = [];

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-cf-routes-")));
  dataDir = join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_INBOX_CF_ACCESS;
  logged.length = 0;
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

function standIn(options: { failAt?: string } = {}) {
  const calls: string[] = [];
  const ok = (result: unknown) => Response.json({ success: true, result });
  const fetch: CfFetch = async (url, init) => {
    const key = `${init.method} ${url.replace("http://stand-in.test", "").split("?")[0]}`;
    calls.push(key);
    if (options.failAt && key.startsWith(options.failAt)) return Response.json({ success: false, errors: [{ code: 10000, message: "denied by stand-in" }] }, { status: 403 });
    if (key === "GET /user/tokens/verify") return ok({ status: "active" });
    if (key === "GET /accounts") return ok([{ id: ACCOUNT }]);
    if (key === "GET /zones") return ok([{ id: ZONE, name: "example.test", account: { id: ACCOUNT } }]);
    if (key.endsWith("/access/organizations")) return ok({ auth_domain: TEAM });
    if (key.endsWith("/access/identity_providers") && init.method === "GET") return ok([{ id: "idp", type: "onetimepin" }]);
    if (key.endsWith("/cfd_tunnel") && init.method === "GET") return ok([]);
    if (key.endsWith("/cfd_tunnel")) return ok({ id: TUNNEL, name: "plannotator-x" });
    if (key.endsWith("/token")) return ok("run-token-from-stand-in");
    if (key.endsWith("/access/apps") && init.method === "GET") return ok([]);
    if (key.endsWith("/access/apps")) return ok({ id: "app-1", aud: "aud0123456789abcdef" });
    if (key.endsWith("/dns_records") && init.method === "GET") return ok([]);
    if (key.endsWith("/dns_records")) return ok({ id: `dns-${JSON.parse(String(init.body)).name.split(".")[0]}` });
    return ok({});
  };
  return { calls, api: (token: string) => createCfApi(token, { base: "http://stand-in.test", fetch }) };
}

function fakeCloudflared(): string {
  const path = join(root, "cloudflared");
  writeFileSync(path, '#!/bin/sh\necho "INF Registered tunnel connection connIndex=0" >&2\nexec sleep 30\n');
  chmodSync(path, 0o755);
  return path;
}

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

async function start(stand: ReturnType<typeof standIn>) {
  const port = freePort();
  const inbox = await startInboxServer({
    dataDir,
    htmlContent: "<!doctype html><title>Inbox</title>",
    cloudflareAccess: { tunnel: false, log: (line) => logged.push(line), fetchKeys: async () => ({ keys: [] }) },
    cloudflareAccessRoutes: {
      api: stand.api,
      binary: fakeCloudflared(),
      edgeFetch: async () => new Response(null, { status: 302, headers: { Location: `https://${TEAM}/cdn-cgi/access/login/x` } }),
      checkTimeoutMs: 2_000,
      pickPort: () => port,
    },
  });
  servers.push(inbox);
  const answers: string[] = [];
  const call = async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/cloudflare-access${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify({ ...body, serverSession: inbox.serverSession }) } : {}),
    });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: JSON.parse(text) as Record<string, any> };
  };
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const { body } = await call("");
      if (!body.job?.running) return body;
      await Bun.sleep(25);
    }
    throw new Error("setup never finished");
  };
  return { inbox, call, settle, answers };
}

function everyFile(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? everyFile(path) : [path];
  });
}

function expectNoToken(answers: string[]) {
  expect(answers.filter((text) => text.includes(TOKEN))).toEqual([]);
  expect(logged.filter((line) => line.includes(TOKEN))).toEqual([]);
  expect(everyFile(dataDir).filter((file) => readFileSync(file, "latin1").includes(TOKEN))).toEqual([]);
}

describe("Settings → Cloudflare", () => {
  test("the form's path: domains, then setup step by step, then on; the token is echoed nowhere", async () => {
    const stand = standIn();
    const { call, settle, answers, inbox } = await start(stand);
    expect((await call("")).body).toMatchObject({ configured: false, cloudflared: { found: true } });
    const zones = await call("/zones", { token: TOKEN });
    expect(zones.body.zones).toEqual([{ name: "example.test", account: ACCOUNT }]);
    const hostname = `${zones.body.label}.example.test`;
    const started = await call("/setup", { token: TOKEN, email: "Me@Example.com", zone: "example.test", account: ACCOUNT, hostname });
    expect(started.status).toBe(202);
    const done = await settle();
    expect(done.job.failed).toBeNull();
    expect(done.job.steps.map((s: { state: string }) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(done).toMatchObject({ configured: true, on: true, host: hostname, allowed: ["me@example.com"], url: `https://${hostname}/` });
    expect(stand.calls.filter((c) => c.startsWith("POST /zones")).length).toBe(2);
    const off = await call("/switch", { on: false });
    expect(off.body).toMatchObject({ on: false, url: null });
    expect(inbox.registry.cloudflare_access).toBeUndefined();
    expectNoToken(answers);
  });

  test("a failed step names itself and leaves nothing behind", async () => {
    const stand = standIn({ failAt: `POST /zones/${ZONE}/dns_records` });
    const { call, settle, answers } = await start(stand);
    await call("/setup", { token: TOKEN, email: "me@example.com", zone: "example.test", account: ACCOUNT, hostname: "plannotator-abc123.example.test" });
    const failed = await settle();
    expect(failed.job.failed).toMatchObject({ step: "address", leftover: [] });
    expect(failed.job.failed.message).toContain("denied by stand-in");
    expect(stand.calls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE /accounts/${ACCOUNT}/access/apps/app-1`, `DELETE /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/connections`, `DELETE /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}`]);
    expect(failed.configured).toBe(false);
    expect(existsSync(tunnelTokenPath(dataDir))).toBe(false);
    const config = existsSync(join(dataDir, "config.json")) ? JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) : {};
    expect(config.inboxCloudflareAccess).toBeUndefined();
    expectNoToken(answers);
  });

  test("Remove needs the token again, and tears it all down", async () => {
    const stand = standIn();
    const { call, settle, answers } = await start(stand);
    await call("/setup", { token: TOKEN, email: "me@example.com", zone: "example.test", account: ACCOUNT, hostname: "plannotator-abc123.example.test" });
    await settle();
    expect((await call("/remove", {})).body.code).toBe("token_required");
    const removed = await call("/remove", { token: TOKEN });
    expect(removed.body).toMatchObject({ configured: false, on: false });
    expect(stand.calls.filter((c) => c.startsWith("DELETE")).length).toBe(5);
    expectNoToken(answers);
  });
});
