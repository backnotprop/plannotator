import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForgejoHosts } from "./inbox-forgejo-hosts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:1/api/inbox/forgejo/hosts", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ serverSession: "s", ...body }) });
const PATH = "/api/inbox/forgejo/hosts";

let dir: string;
let before: string | undefined;
beforeEach(() => { before = process.env.PLANNOTATOR_DATA_DIR; dir = mkdtempSync(join(tmpdir(), "fj-hosts-")); process.env.PLANNOTATOR_DATA_DIR = dir; });
afterEach(() => { if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR; else process.env.PLANNOTATOR_DATA_DIR = before; });
const make = (extra: Partial<Parameters<typeof createForgejoHosts>[0]> = {}) => createForgejoHosts({ serverSession: "s", json, readBody, env: {}, ...extra });
const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));

test("a saved host and token land in config.json (0600), and no answer holds the token", async () => {
  const hosts = make();
  const secret = "tok_secret_value_1a2b";
  const res = await hosts.route(post({ op: "save", origin: "git.example.com", token: ` ${secret} ` }), PATH, "local");
  const text = await res!.text();
  expect(text).not.toContain(secret);
  expect(JSON.parse(text).hosts).toEqual([{ origin: "https://git.example.com", hostSource: "saved", token: { source: "saved", last4: "1a2b" } }]);
  expect(config().forgejoTokens).toEqual({ "https://git.example.com": secret });
  expect(config().forgejoHosts).toEqual(["git.example.com"]);
  expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(hosts.state())).not.toContain(secret);
});

test("a host saved without a token keeps the one it had, and Remove drops both", async () => {
  const hosts = make();
  await hosts.route(post({ op: "save", origin: "https://git.example.com", token: "tok_secret_value_1a2b" }), PATH, "local");
  await hosts.route(post({ op: "save", origin: "https://git.example.com" }), PATH, "local");
  expect(config().forgejoTokens["https://git.example.com"]).toBe("tok_secret_value_1a2b");
  const res = await hosts.route(post({ op: "remove", origin: "https://git.example.com" }), PATH, "local");
  expect((await res!.json()).hosts).toEqual([]);
  expect(config().forgejoTokens).toEqual({});
  expect(config().forgejoHosts).toEqual([]);
});

test("what the person wrote by hand in config.json is kept", async () => {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ theme: "dark", forgejoHosts: ["old.example.org"], forgejoTokens: { "https://old.example.org": "tok_handwritten_zzzz" } }));
  const hosts = make();
  await hosts.route(post({ op: "save", origin: "https://git.example.com", token: "tok_secret_value_1a2b" }), PATH, "local");
  const kept = config();
  expect(kept.theme).toBe("dark");
  expect(kept.forgejoTokens["https://old.example.org"]).toBe("tok_handwritten_zzzz");
  expect(kept.forgejoHosts.sort()).toEqual(["git.example.com", "old.example.org"]);
});

test("a token is refused from another device over plain http, and accepted over https", async () => {
  const hosts = make();
  const plain = await hosts.route(post({ op: "save", origin: "https://git.example.com", token: "tok_secret_value_1a2b" }), PATH, "tunnel");
  expect(plain!.status).toBe(403);
  expect(hosts.state().hosts).toEqual([]);
  const secure = await hosts.route(post({ op: "save", origin: "https://git.example.com", token: "tok_secret_value_1a2b" }, { "x-forwarded-proto": "https" }), PATH, "tunnel");
  expect(secure!.status).toBe(200);
});

test("a host set in the environment shows read-only, and the environment's token is named, not shown", () => {
  const hosts = make({ env: { PLANNOTATOR_FORGEJO_URL: "https://git.env.example/", PLANNOTATOR_FORGEJO_TOKEN: "tok_from_env_value" } });
  expect(hosts.state().hosts).toEqual([{ origin: "https://git.env.example", hostSource: "env", token: { source: "env", last4: null } }]);
});

test("Check asks only a host that was added, with its token, and reports accepted, refused or unreachable", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  let status = 200;
  const fake = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (status === 0) throw new Error("down");
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  const hosts = make({ fetch: fake });
  const stranger = hosts.route(post({ op: "check", origin: "https://other.example" }), PATH, "local");
  await expect(stranger).rejects.toThrow("add the host first");
  expect(seen).toEqual([]);
  await hosts.route(post({ op: "save", origin: "https://git.example.com", token: "tok_secret_value_1a2b" }), PATH, "local");
  expect(await (await hosts.route(post({ op: "check", origin: "https://git.example.com" }), PATH, "local"))!.json()).toEqual({ verdict: "accepted" });
  expect(seen[0]).toEqual({ url: "https://git.example.com/api/v1/user", auth: "token tok_secret_value_1a2b" });
  status = 401;
  expect((await (await hosts.route(post({ op: "check", origin: "https://git.example.com" }), PATH, "local"))!.json()).verdict).toBe("refused");
  status = 0;
  expect((await (await hosts.route(post({ op: "check", origin: "https://git.example.com" }), PATH, "local"))!.json()).verdict).toBe("unreachable");
});

test("a bad address or token is refused and nothing is written", async () => {
  const hosts = make();
  await expect(hosts.route(post({ op: "save", origin: "not an address" }), PATH, "local")).rejects.toThrow("origin");
  await expect(hosts.route(post({ op: "save", origin: "https://git.example.com", token: "short" }), PATH, "local")).rejects.toThrow("token");
  expect(hosts.state().hosts).toEqual([]);
});
