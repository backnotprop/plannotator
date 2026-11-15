import { describe, expect, test } from "bun:test";
import { CF_APP_NAME, createCfApi, runCfSetup, runCfTeardown, type CfFetch } from "./cf-access-api";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "fedcba9876543210fedcba9876543210";
const TUNNEL = "11111111-2222-3333-4444-555555555555";

interface Stand {
  calls: string[];
  fetch: CfFetch;
  dnsExisting?: { id: string; type: string; content: string }[];
  appsExisting?: { id: string; name: string; domain: string; aud: string }[];
}

function standIn(options: Partial<Pick<Stand, "dnsExisting" | "appsExisting">> & { failAt?: string; team?: string | null } = {}): Stand {
  const calls: string[] = [];
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { headers: { "Content-Type": "application/json" } });
  const fetch: CfFetch = async (url, init) => {
    const path = url.replace("http://stand-in.test/client/v4", "");
    const key = `${init.method} ${path.split("?")[0]}`;
    calls.push(key);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    if (options.failAt && key.startsWith(options.failAt)) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "denied" }] }), { status: 403 });
    if (key === "GET /user/tokens/verify") return ok({ status: "active" });
    if (key === "GET /accounts") return ok([{ id: ACCOUNT, name: "Mine" }]);
    if (key === "GET /zones") return ok([{ id: ZONE, name: "example.test" }]);
    if (key.endsWith("/access/organizations")) return ok(options.team === null ? {} : { auth_domain: options.team ?? "myteam.cloudflareaccess.com" });
    if (key.endsWith("GET /accounts/" + ACCOUNT + "/access/identity_providers") || key === `GET /accounts/${ACCOUNT}/access/identity_providers`) return ok([]);
    if (key === `POST /accounts/${ACCOUNT}/access/identity_providers`) return ok({ id: "idp-1", type: "onetimepin" });
    if (key === `GET /accounts/${ACCOUNT}/cfd_tunnel`) return ok([]);
    if (key === `POST /accounts/${ACCOUNT}/cfd_tunnel`) return ok({ id: TUNNEL, name: JSON.parse(String(init.body)).name });
    if (key === `GET /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/token`) return ok("tunnel-run-token");
    if (key === `PUT /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`) {
      const ingress = JSON.parse(String(init.body)).config.ingress;
      expect(ingress[0].originRequest.httpHostHeader).toBe(ingress[0].hostname);
      expect(ingress[0].service).toBe("http://127.0.0.1:41234");
      const sibling = `${ingress[0].hostname.split(".")[0]}-s.example.test`;
      expect(ingress[1]).toEqual({ hostname: sibling, service: "http://127.0.0.1:41234", originRequest: { httpHostHeader: sibling } });
      expect(ingress.at(-1)).toEqual({ service: "http_status:404" });
      return ok({});
    }
    if (key === `GET /accounts/${ACCOUNT}/access/apps`) return ok(options.appsExisting ?? []);
    if (key === `POST /accounts/${ACCOUNT}/access/apps`) {
      const body = JSON.parse(String(init.body));
      expect(body.policies).toEqual([{ name: "owner only", decision: "allow", precedence: 1, include: [{ email: { email: "me@example.com" } }] }]);
      expect(body.allowed_idps).toEqual(["idp-1"]);
      expect(body.self_hosted_domains).toEqual([body.domain, `${body.domain.split(".")[0]}-s.example.test`]);
      return ok({ id: "app-1", aud: "aud0123456789abcdef" });
    }
    if (key === `GET /zones/${ZONE}/dns_records`) return ok(options.dnsExisting ?? []);
    if (key === `POST /zones/${ZONE}/dns_records`) {
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ type: "CNAME", content: `${TUNNEL}.cfargotunnel.com`, proxied: true });
      return ok({ id: `dns-${body.name.split(".")[0]}` });
    }
    if (init.method === "DELETE") return ok({});
    throw new Error(`unexpected ${key}`);
  };
  return { calls, fetch };
}

const api = (stand: Stand) => createCfApi("test-token", { base: "http://stand-in.test/client/v4", fetch: stand.fetch });

describe("setup against a stand-in Cloudflare API", () => {
  test("creates login, tunnel, route and Access app, and only then the DNS record", async () => {
    const stand = standIn();
    const result = await runCfSetup(api(stand), { email: "Me@Example.com", port: 41234, hostname: "plannotator.example.test" });
    const writes = stand.calls.filter((c) => !c.startsWith("GET"));
    expect(writes).toEqual([
      `POST /accounts/${ACCOUNT}/access/identity_providers`,
      `POST /accounts/${ACCOUNT}/cfd_tunnel`,
      `PUT /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`,
      `POST /accounts/${ACCOUNT}/access/apps`,
      `POST /zones/${ZONE}/dns_records`,
      `POST /zones/${ZONE}/dns_records`,
    ]);
    expect(stand.calls.at(-1)).toBe(`POST /zones/${ZONE}/dns_records`);
    expect(result).toMatchObject({ host: "plannotator.example.test", team: "myteam.cloudflareaccess.com", aud: "aud0123456789abcdef", tunnelToken: "tunnel-run-token", sessionHost: "plannotator-s.example.test", dnsRecord: "dns-plannotator", sessionDnsRecord: "dns-plannotator-s" });
  });

  test("a failure before DNS leaves no DNS record behind", async () => {
    const stand = standIn({ failAt: `POST /accounts/${ACCOUNT}/access/apps` });
    await expect(runCfSetup(api(stand), { email: "me@example.com", port: 41234 })).rejects.toThrow("denied");
    expect(stand.calls.some((c) => c.includes("dns_records"))).toBe(false);
  });

  test("refuses to take over a hostname that already has a record or another Access app", async () => {
    const taken = standIn({ dnsExisting: [{ id: "x", type: "A", content: "192.0.2.1" }] });
    await expect(runCfSetup(api(taken), { email: "me@example.com", port: 41234, hostname: "www.example.test" })).rejects.toThrow("already has a DNS record");
    expect(taken.calls.some((c) => c.startsWith("POST /zones") || c.startsWith("PUT /zones"))).toBe(false);
    const appTaken = standIn({ appsExisting: [{ id: "a", name: "Their app", domain: "www.example.test", aud: "x" }] });
    await expect(runCfSetup(api(appTaken), { email: "me@example.com", port: 41234, hostname: "www.example.test" })).rejects.toThrow("Their app");
    expect(CF_APP_NAME).toBe("Plannotator");
  });

  test("needs Zero Trust, a typed e-mail and a one-level hostname", async () => {
    await expect(runCfSetup(api(standIn({ team: null })), { email: "me@example.com", port: 41234 })).rejects.toThrow("Zero Trust");
    await expect(runCfSetup(api(standIn()), { email: "", port: 41234 })).rejects.toThrow("--email");
    await expect(runCfSetup(api(standIn()), { email: "me@example.com", port: 41234, hostname: "a.b.example.test" })).rejects.toThrow("one level");
  });
});

describe("teardown against a stand-in Cloudflare API", () => {
  test("deletes DNS, then the Access app, then the tunnel", async () => {
    const stand = standIn();
    await runCfTeardown(api(stand), { account: ACCOUNT, zone: ZONE, tunnel: TUNNEL, app: "app-1", dnsRecord: "dns-1", sessionDnsRecord: "dns-2" });
    expect(stand.calls).toEqual([
      `DELETE /zones/${ZONE}/dns_records/dns-1`,
      `DELETE /zones/${ZONE}/dns_records/dns-2`,
      `DELETE /accounts/${ACCOUNT}/access/apps/app-1`,
      `DELETE /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/connections`,
      `DELETE /accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}`,
    ]);
  });

  test("stops at the first refusal, before the next object goes", async () => {
    const stand = standIn({ failAt: "DELETE /zones" });
    await expect(runCfTeardown(api(stand), { account: ACCOUNT, zone: ZONE, tunnel: TUNNEL, app: "app-1", dnsRecord: "dns-1" })).rejects.toThrow("denied");
    expect(stand.calls).toEqual([`DELETE /zones/${ZONE}/dns_records/dns-1`]);
  });
});
