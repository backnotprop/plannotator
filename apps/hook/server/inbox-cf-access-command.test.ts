import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCfApi, type CfFetch } from "@plannotator/shared/inbox/cf-access-api";
import { tunnelTokenPath } from "@plannotator/server/cf-tunnel";
import { runCfAccessCommand, type CfAccessCommandDeps } from "./inbox-cf-access-command";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "fedcba9876543210fedcba9876543210";
const TUNNEL = "11111111-2222-3333-4444-555555555555";
const TEAM = "myteam.cloudflareaccess.com";

let root: string;
let dataDir: string;
let saved: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-cf-cmd-")));
  dataDir = join(root, "data");
  mkdirSync(dataDir);
  saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

function fakeCloudflared(): string {
  const path = join(root, "cloudflared");
  writeFileSync(path, '#!/bin/sh\necho "INF Registered tunnel connection connIndex=0" >&2\nexec sleep 30\n');
  chmodSync(path, 0o755);
  return path;
}

function standIn(existing?: { host: string; sessionHost: string }) {
  const calls: string[] = [];
  const ok = (result: unknown) => Response.json({ success: true, result });
  const fetch: CfFetch = async (url, init) => {
    const key = `${init.method} ${url.replace("http://stand-in.test", "").split("?")[0]}`;
    calls.push(key);
    if (key === "GET /user/tokens/verify") return ok({ status: "active" });
    if (key === "GET /accounts") return ok([{ id: ACCOUNT }]);
    if (key === "GET /zones") return ok([{ id: ZONE, name: "example.test" }]);
    if (key.endsWith("/access/organizations")) return ok({ auth_domain: TEAM });
    if (key.endsWith("/access/identity_providers") && init.method === "GET") return ok([{ id: "idp", type: "onetimepin" }]);
    if (key.endsWith("/cfd_tunnel") && init.method === "GET") return ok(existing ? [{ id: TUNNEL, name: `plannotator-${existing.host.split(".")[0]}` }] : []);
    if (key.endsWith("/cfd_tunnel")) return ok({ id: TUNNEL, name: "plannotator-x" });
    if (key.endsWith("/token")) return ok("run-token-from-stand-in");
    if (key.endsWith("/access/apps") && init.method === "GET") {
      return ok(existing ? [{ id: "app-1", name: "Plannotator", domain: existing.host, destinations: [existing.host, existing.sessionHost].map((uri) => ({ type: "public", uri })) }] : []);
    }
    if (key.endsWith("/access/apps") || key.endsWith("/access/apps/app-1")) return ok({ id: "app-1", aud: "aud0123456789abcdef" });
    if (key.endsWith("/dns_records") && init.method === "GET") {
      const name = new URL(url).searchParams.get("name") ?? "";
      const owned = existing && [existing.host, existing.sessionHost].includes(name);
      return ok(owned ? [{ id: `dns-${name.split(".")[0]}`, type: "CNAME", content: `${TUNNEL}.cfargotunnel.com` }] : []);
    }
    if (key.endsWith("/dns_records") || (init.method === "PUT" && key.includes("/dns_records/"))) return ok({ id: `dns-${JSON.parse(String(init.body)).name.split(".")[0]}` });
    return ok({});
  };
  return { calls, api: (token: string) => createCfApi(token, { base: "http://stand-in.test", fetch }) };
}

const loginRedirect = async () => new Response(null, { status: 302, headers: { Location: `https://${TEAM}/cdn-cgi/access/login/x` } });

function deps(extra: Partial<CfAccessCommandDeps>): { deps: CfAccessCommandDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      dataDir,
      json: false,
      ensureRunning: () => Promise.reject(new Error("no Inbox in this test")),
      env: { CLOUDFLARE_API_TOKEN: "test-token" },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      checkTimeoutMs: 2_000,
      ...extra,
    },
  };
}

/** A port free now, as the OS says. A random one from 40000-60000 sits in Linux's ephemeral range, where any open connection can hold it ("port … is in use"). */
function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port as number;
  server.stop(true);
  return port;
}

const config = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxCloudflareAccess;

describe("plannotator inbox cloudflare-access setup", () => {
  test("turns on only after the outside checks, keeps only the tunnel token (0600), never the API token", async () => {
    const stand = standIn();
    const port = freePort();
    const run = deps({ api: stand.api, binary: fakeCloudflared(), edgeFetch: loginRedirect, pickPort: () => port });
    expect(await runCfAccessCommand(["setup", "--email", "Me@Example.com", "--hostname", "plannotator.example.test"], run.deps)).toBe(0);
    expect(config()).toMatchObject({ on: true, host: "plannotator.example.test", team: TEAM, aud: "aud0123456789abcdef", allow: ["me@example.com"], port, sessionHost: "plannotator-s.example.test", dnsRecord: "dns-plannotator", sessionDnsRecord: "dns-plannotator-s" });
    expect(readFileSync(tunnelTokenPath(dataDir), "utf8")).toBe("run-token-from-stand-in");
    expect(statSync(tunnelTokenPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).not.toContain("test-token");
    expect(run.out).toEqual(["https://plannotator.example.test/"]);
  });

  test("checks, saves and reuses a custom sessions hostname", async () => {
    const edgeHosts = new Set<string>();
    const run = deps({
      api: standIn().api,
      binary: fakeCloudflared(),
      pickPort: freePort,
      edgeFetch: async (url) => {
        edgeHosts.add(new URL(url).hostname);
        return loginRedirect();
      },
    });
    const args = ["setup", "--email", "me@example.com", "--hostname", "inbox.example.test"];
    expect(await runCfAccessCommand([...args, "--session-hostname", "reviews.example.test"], run.deps)).toBe(0);
    expect(config()).toMatchObject({ on: true, sessionHost: "reviews.example.test", sessionDnsRecord: "dns-reviews" });
    expect(edgeHosts).toEqual(new Set(["inbox.example.test", "reviews.example.test"]));

    const existing = standIn({ host: "inbox.example.test", sessionHost: "reviews.example.test" });
    edgeHosts.clear();
    expect(await runCfAccessCommand(["setup", "--email", "me@example.com", "--hostname", " Inbox.Example.Test. "], { ...run.deps, api: existing.api })).toBe(0);
    expect(config()).toMatchObject({ on: true, sessionHost: "reviews.example.test", app: "app-1", sessionDnsRecord: "dns-reviews" });
    expect(edgeHosts).toEqual(new Set(["inbox.example.test", "reviews.example.test"]));
    expect(existing.calls.filter((call) => !call.startsWith("GET "))).toEqual([
      `PUT /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`,
      `PUT /accounts/${ACCOUNT}/access/apps/app-1`,
      `PUT /zones/${ZONE}/dns_records/dns-inbox`,
      `PUT /zones/${ZONE}/dns_records/dns-reviews`,
    ]);

    const conflict = standIn();
    expect(await runCfAccessCommand([...args, "--session-hostname", "changed.example.test"], { ...run.deps, api: conflict.api })).toBe(2);
    expect(conflict.calls).toEqual([]);
    expect(config()).toMatchObject({ on: true, sessionHost: "reviews.example.test" });
  });

  test("stays off when anything without a login gets through", async () => {
    const port = freePort();
    const leaky = async () => {
      await fetch(`http://127.0.0.1:${port}/`);
      return loginRedirect();
    };
    const passing = async () => new Response("hello", { status: 200 });
    for (const edgeFetch of [leaky, passing]) {
      const stand = standIn();
      const run = deps({ api: stand.api, binary: fakeCloudflared(), edgeFetch, pickPort: () => port });
      expect(await runCfAccessCommand(["setup", "--email", "me@example.com"], run.deps)).toBe(1);
      expect(config()).toBeUndefined();
      expect(existsSync(tunnelTokenPath(dataDir))).toBe(false);
      expect(stand.calls.filter((c) => c.startsWith("DELETE")).length).toBe(5);
      expect(run.err.join("\n")).toContain("Nothing was left behind");
      expect(run.err.join("\n")).toContain(edgeFetch === leaky ? "reached this computer" : "was let through");
    }
  });

  test("a failed outside check says what was seen and what to check", async () => {
    const port = freePort();
    const refused = deps({ api: standIn().api, binary: fakeCloudflared(), edgeFetch: async () => new Response("no", { status: 403 }), pickPort: () => port });
    expect(await runCfAccessCommand(["setup", "--email", "me@example.com"], refused.deps)).toBe(1);
    const said = refused.err.join("\n");
    expect(said).toContain("got HTTP 403 instead of a redirect to your Cloudflare Access login page");
    expect(said).toContain("Zero Trust, Access, Applications");
    const silent = join(root, "cloudflared-silent");
    writeFileSync(silent, '#!/bin/sh\necho "2026-11-15T00:00:00Z ERR Failed to dial a quic connection error=\\"timeout\\"" >&2\nexec sleep 30\n');
    chmodSync(silent, 0o755);
    const stuck = deps({ api: standIn().api, binary: silent, edgeFetch: async () => new Response(null, { status: 302 }), pickPort: () => port, connectTimeoutMs: 1_500 });
    expect(await runCfAccessCommand(["setup", "--email", "me@example.com"], stuck.deps)).toBe(1);
    const stuckSaid = stuck.err.join("\n");
    expect(stuckSaid).toContain("did not report a connection to Cloudflare within 2 s");
    expect(stuckSaid).toContain("Failed to dial a quic connection");
    expect(stuckSaid).toContain("outbound UDP 7844");
  }, 20_000);

  test("needs a typed e-mail and cloudflared before it touches Cloudflare", async () => {
    const stand = standIn();
    const noEmail = deps({ api: stand.api, binary: fakeCloudflared() });
    expect(await runCfAccessCommand(["setup"], noEmail.deps)).toBe(2);
    expect(await runCfAccessCommand(["setup", "--email", "me@example.com", "--session-hostname"], noEmail.deps)).toBe(2);
    expect(noEmail.err.join("\n")).toContain("--session-hostname needs a hostname");
    const noBinary = deps({ api: stand.api, binary: null });
    expect(await runCfAccessCommand(["setup", "--email", "me@example.com"], noBinary.deps)).toBe(1);
    expect(noBinary.err.join("\n")).toContain("cloudflared is not installed");
    expect(stand.calls).toEqual([]);
    expect(existsSync(join(dataDir, "config.json"))).toBe(false);
  });
});

describe("plannotator inbox cloudflare-access teardown", () => {
  test("turns off, deletes DNS, app and tunnel in order, then forgets everything here", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxCloudflareAccess: { on: true, host: "plannotator.example.test", account: ACCOUNT, zone: ZONE, tunnel: TUNNEL, app: "app-1", dnsRecord: "dns-1", sessionDnsRecord: "dns-2" } }));
    mkdirSync(join(dataDir, "cloudflare-access"), { recursive: true });
    writeFileSync(tunnelTokenPath(dataDir), "x", { mode: 0o600 });
    const stand = standIn();
    const run = deps({ api: stand.api });
    expect(await runCfAccessCommand(["teardown"], run.deps)).toBe(0);
    expect(stand.calls).toEqual([
      `DELETE /zones/${ZONE}/dns_records/dns-1`,
      `DELETE /zones/${ZONE}/dns_records/dns-2`,
      `DELETE /accounts/${ACCOUNT}/access/apps/app-1`,
      `DELETE /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/connections`,
      `DELETE /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}`,
    ]);
    expect(existsSync(tunnelTokenPath(dataDir))).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxCloudflareAccess).toBeUndefined();
  });
});
