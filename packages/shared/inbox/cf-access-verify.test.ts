import { beforeAll, describe, expect, test } from "bun:test";
import { makeTestKeys, ownerClaims, TEST_AUD, TEST_HOST, TEST_OWNER, TEST_SESSION_HOST, TEST_TEAM, type TestKeys } from "../../../tests/helpers/cf-access-keys";
import { parseCfAccessSettings, resolveCfAccess, type CfAccessSettings } from "./cf-access";
import { CF_ACCESS_KEYS_REFETCH_MS, CF_ACCESS_KEYS_TTL_MS, createCfAccessVerifier } from "./cf-access-verify";

const settings = parseCfAccessSettings({ team: TEST_TEAM, aud: TEST_AUD, allow: [TEST_OWNER], host: TEST_HOST, sessionHost: TEST_SESSION_HOST, port: 41234 }) as CfAccessSettings;
const NOW = 1_800_000_000_000;
const nowS = NOW / 1000;

let keys: TestKeys;
let other: TestKeys;
beforeAll(async () => {
  keys = await makeTestKeys();
  other = await makeTestKeys("test-kid-1");
});

function verifier(options: { now?: () => number; fetchKeys?: (url: string) => Promise<unknown> } = {}) {
  const fetched: string[] = [];
  const v = createCfAccessVerifier(settings, {
    now: options.now ?? (() => NOW),
    fetchKeys:
      options.fetchKeys ??
      (async (url) => {
        fetched.push(url);
        return keys.jwks;
      }),
  });
  return { v, fetched };
}

function headers(token: string | null, extra: Record<string, string> = {}): Headers {
  return new Headers({ host: TEST_HOST, ...(token ? { "cf-access-jwt-assertion": token } : {}), ...extra });
}

describe("the Access check chain", () => {
  test("an owner's token through the public host passes", async () => {
    const { v, fetched } = verifier();
    const result = await v.check("GET", "/", headers(await keys.sign(ownerClaims(nowS, { email: "Owner@Example.com" }))));
    expect(result).toEqual({ ok: true, email: TEST_OWNER, world: "inbox" });
    expect(fetched).toEqual([`https://${TEST_TEAM}/cdn-cgi/access/certs`]);
  });

  const cases: [string, () => Promise<{ token: string | null; extra?: Record<string, string>; host?: string }>, number, string][] = [
    ["another Host", async () => ({ token: await keys.sign(ownerClaims(nowS)), host: "evil.example.test" }), 403, "forbidden_host"],
    ["no token", async () => ({ token: null }), 403, "access_token_required"],
    ["an oversized token", async () => ({ token: "a".repeat(17 * 1024) }), 403, "access_token_invalid"],
    ["alg none", async () => ({ token: (await keys.sign(ownerClaims(nowS), { alg: "none" })) }), 403, "access_token_invalid"],
    ["HS256", async () => ({ token: (await keys.sign(ownerClaims(nowS), { alg: "HS256" })) }), 403, "access_token_invalid"],
    ["a crit header", async () => ({ token: (await keys.sign(ownerClaims(nowS), { crit: ["exp"] })) }), 403, "access_token_invalid"],
    ["an unknown kid", async () => ({ token: (await keys.sign(ownerClaims(nowS), { kid: "nope" })) }), 403, "access_token_invalid"],
    ["another key's signature under a known kid", async () => ({ token: await other.sign(ownerClaims(nowS)) }), 403, "access_token_invalid"],
    ["a tampered payload", async () => {
      const [h, , s] = (await keys.sign(ownerClaims(nowS))).split(".");
      const p = Buffer.from(JSON.stringify(ownerClaims(nowS, { email: "x@example.com" }))).toString("base64url");
      return { token: `${h}.${p}.${s}` };
    }, 403, "access_token_invalid"],
    ["another issuer", async () => ({ token: await keys.sign(ownerClaims(nowS, { iss: "https://other.cloudflareaccess.com" })) }), 403, "access_token_invalid"],
    ["another audience", async () => ({ token: await keys.sign(ownerClaims(nowS, { aud: ["0000000000000000"] })) }), 403, "access_token_invalid"],
    ["expired past the skew", async () => ({ token: await keys.sign(ownerClaims(nowS, { exp: nowS - 61 })) }), 403, "access_token_invalid"],
    ["no exp", async () => ({ token: await keys.sign(ownerClaims(nowS, { exp: undefined })) }), 403, "access_token_invalid"],
    ["nbf in the future", async () => ({ token: await keys.sign(ownerClaims(nowS, { nbf: nowS + 120 })) }), 403, "access_token_invalid"],
    ["iat in the future", async () => ({ token: await keys.sign(ownerClaims(nowS, { iat: nowS + 120 })) }), 403, "access_token_invalid"],
    ["a service token", async () => ({ token: await keys.sign(ownerClaims(nowS, { email: undefined, common_name: "svc.access" })) }), 403, "access_identity_refused"],
    ["a service token that names the owner", async () => ({ token: await keys.sign(ownerClaims(nowS, { common_name: "svc.access" })) }), 403, "access_identity_refused"],
    ["no e-mail", async () => ({ token: await keys.sign(ownerClaims(nowS, { email: "  " })) }), 403, "access_identity_refused"],
    ["an e-mail not on the allowlist", async () => ({ token: await keys.sign(ownerClaims(nowS, { email: "guest@example.com" })) }), 403, "access_identity_refused"],
    ["a cross-site fetch", async () => ({ token: await keys.sign(ownerClaims(nowS)), extra: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" } }), 403, "cross_site"],
  ];
  for (const [name, make, status, code] of cases) {
    test(`refuses ${name}`, async () => {
      const { v } = verifier();
      const { token, extra, host } = await make();
      const h = headers(token, extra);
      if (host) h.set("host", host);
      const result = await v.check("POST", "/api/inbox/threads", h);
      expect(result.ok).toBe(false);
      if (!result.ok) expect([result.status, result.code]).toEqual([status, code]);
    });
  }

  test("last week's one-name setup: the Inbox's name passes, no other name does", async () => {
    const v = createCfAccessVerifier({ ...settings, sessionHost: null }, { now: () => NOW, fetchKeys: async () => keys.jwks });
    const token = await keys.sign(ownerClaims(nowS, { common_name: null }));
    expect((await v.check("GET", "/", headers(token))).ok).toBe(true);
    const sibling = await v.check("GET", "/s/abcdefghijklmnopqrstuv/", headers(token, { host: TEST_SESSION_HOST }));
    expect(sibling.ok === false && sibling.code).toBe("forbidden_host");
  });

  test("Host decides the world; the two names are other sites to each other", async () => {
    const { v } = verifier();
    const token = await keys.sign(ownerClaims(nowS));
    const sessions = headers(token, { host: TEST_SESSION_HOST });
    const inSessions = await v.check("GET", "/s/abcdefghijklmnopqrstuv/api/diff", sessions);
    expect(inSessions.ok && inSessions.world).toBe("sessions");
    const fromSessionPage = headers(token, { "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" });
    expect((await v.check("GET", "/api/inbox/threads", fromSessionPage)).ok).toBe(false);
    const fromInboxPage = headers(token, { host: TEST_SESSION_HOST, "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" });
    expect((await v.check("GET", "/s/abcdefghijklmnopqrstuv/api/diff", fromInboxPage)).ok).toBe(false);
    const linkIn = headers(token, { host: TEST_SESSION_HOST, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" });
    expect((await v.check("GET", "/s/abcdefghijklmnopqrstuv/", linkIn)).ok).toBe(true);
    expect((await v.check("GET", "/s/abcdefghijklmnopqrstuv/api/diff", linkIn)).ok).toBe(false);
  });
});

describe("the team's keys", () => {
  test("no keys refuses with 503 and retries no more than every few seconds", async () => {
    let clock = NOW;
    let calls = 0;
    const { v } = verifier({ now: () => clock, fetchKeys: async () => (calls++, Promise.reject(new Error("down"))) });
    const token = await keys.sign(ownerClaims(nowS));
    const first = await v.check("GET", "/", headers(token));
    expect(first.ok === false && [first.status, first.code]).toEqual([503, "access_keys_unavailable"]);
    await v.check("GET", "/", headers(token));
    expect(calls).toBe(1);
    clock += 5_000;
    await v.check("GET", "/", headers(token));
    expect(calls).toBe(2);
  });

  test("an unknown kid refetches at most once a minute, and keys expire after an hour", async () => {
    let clock = NOW;
    let calls = 0;
    const { v } = verifier({ now: () => clock, fetchKeys: async () => (calls++, keys.jwks) });
    const unknown = await keys.sign(ownerClaims(nowS), { kid: "rotated" });
    await v.check("GET", "/", headers(unknown));
    await v.check("GET", "/", headers(unknown));
    await v.check("GET", "/", headers(unknown));
    expect(calls).toBe(1);
    clock += CF_ACCESS_KEYS_REFETCH_MS;
    await v.check("GET", "/", headers(unknown));
    expect(calls).toBe(2);
    clock += CF_ACCESS_KEYS_TTL_MS;
    const good = await keys.sign(ownerClaims(clock / 1000));
    expect((await v.check("GET", "/", headers(good))).ok).toBe(true);
    expect(calls).toBe(3);
  });

  test("a weak or non-RSA key is never used", async () => {
    const weak = { keys: [{ ...keys.jwks.keys[0], n: Buffer.alloc(128, 1).toString("base64url") }] };
    const { v } = verifier({ fetchKeys: async () => weak });
    const result = await v.check("GET", "/", headers(await keys.sign(ownerClaims(nowS))));
    expect(result.ok === false && result.code).toBe("access_keys_unavailable");
  });
});

describe("settings", () => {
  test("nothing opens without a complete, valid setup", () => {
    const full = { on: true, team: TEST_TEAM, aud: TEST_AUD, allow: [TEST_OWNER], host: TEST_HOST, sessionHost: TEST_SESSION_HOST, port: 41234 };
    expect(resolveCfAccess({}, {}).on).toBe(false);
    expect(resolveCfAccess({ inboxCloudflareAccess: { ...full, on: false } }, {}).on).toBe(false);
    expect(resolveCfAccess({ inboxCloudflareAccess: full }, { PLANNOTATOR_INBOX_CF_ACCESS: "0" }).on).toBe(false);
    expect(resolveCfAccess({ inboxCloudflareAccess: { ...full, on: false } }, { PLANNOTATOR_INBOX_CF_ACCESS: "1" }).on).toBe(false);
    expect(resolveCfAccess({ inboxCloudflareAccess: full }, {}).settings?.host).toBe(TEST_HOST);
    for (const broken of [{ allow: [] }, { allow: ["not-an-email"] }, { aud: "" }, { team: "evil.example.com" }, { host: "127.0.0.1" }, { host: "localhost" }, { port: 80 }, { sessionHost: TEST_HOST }]) {
      const resolved = resolveCfAccess({ inboxCloudflareAccess: { ...full, ...broken } }, {});
      expect(resolved.on && resolved.settings === null && typeof resolved.error).toBe("string");
    }
    expect(resolveCfAccess({ inboxCloudflareAccess: full }, {}, (p) => p === 41234).error).toContain("41234");
    expect(resolveCfAccess({ inboxCloudflareAccess: { ...full, sessionHost: undefined } }, {}).settings).toMatchObject({ host: TEST_HOST, sessionHost: null });
  });
});
