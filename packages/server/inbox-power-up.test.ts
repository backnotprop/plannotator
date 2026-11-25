/**
 * Power Up's route in the Inbox (inbox-power-up.ts), called as the server calls it: the window's ask is answered from
 * this computer's key with the provider's fetch (a stand-in here, never a real provider), and the key is changed only
 * by a request that looks like the window's. Every test uses its own temp data dir.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powerUpRoute } from "./inbox-power-up";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ORIGIN = "http://127.0.0.1:4100";
const SESSION = "session-for-the-test";

function dataDirWithKey(): { dataDir: string; keyFile: string } {
  const root = mkdtempSync(join(tmpdir(), "plannotator-inbox-power-up-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "secrets"), { recursive: true });
  const keyFile = join(dataDir, "secrets", "sem-diff-opinion.json");
  writeFileSync(keyFile, JSON.stringify({ provider: "custom", url: "http://127.0.0.1:9/systemone", auth: "bearer", apiKey: "fake-key-not-real" }));
  return { dataDir, keyFile };
}

/** A stand-in provider: every unsure call is "moved"; records what it was sent. */
function fakeProvider() {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "null")) });
    return Response.json({ answers: { q: { probabilities: { moved: 0.95, new: 0.05 } } } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const question = (helper = "applyDiscount") => ({
  candidates: [{ kind: "extract", helper, caller: "checkout", file: "src/cart.ts", code: { helper: `function ${helper}(t) { return t * 0.9; }`, caller: "function checkout(t) { return t * 0.9; }", callerNew: `function checkout(t) { return ${helper}(t); }` } }],
});

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }): Request {
  return new Request(`${ORIGIN}${path}`, { method, headers: { Host: "127.0.0.1:4100", "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("the window's ask goes to this computer's provider with its key, and the answer comes back", async () => {
  const { dataDir } = dataDirWithKey();
  const provider = fakeProvider();
  const answer = await powerUpRoute(request("/api/sem-diff/opinion", "POST", question()), "/api/sem-diff/opinion", { dataDir, serverSession: SESSION, fromDoor: false, fetch: provider.fetchImpl });
  expect(answer.status).toBe(200);
  const reply = (await answer.json()) as { ok: boolean; answers?: { accept: boolean }[] };
  expect([reply.ok, reply.answers?.map((a) => a.accept)]).toEqual([true, [true]]);
  expect(provider.calls.map((call) => [call.url, call.auth])).toEqual([["http://127.0.0.1:9/systemone", "Bearer fake-key-not-real"]]);
});

test("another site's page, and a linked computer's or a phone's door, ask nothing and read nothing", async () => {
  const { dataDir } = dataDirWithKey();
  const provider = fakeProvider();
  const context = { dataDir, serverSession: SESSION, fromDoor: false, fetch: provider.fetchImpl };
  const cross = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
  expect((await powerUpRoute(request("/api/sem-diff/opinion", "POST", question("crossSite"), cross), "/api/sem-diff/opinion", context)).status).toBe(403);
  expect((await powerUpRoute(request("/api/sem-diff/opinion/settings", "GET", undefined, cross), "/api/sem-diff/opinion/settings", context)).status).toBe(403);
  expect((await powerUpRoute(request("/api/sem-diff/opinion", "POST", question("door")), "/api/sem-diff/opinion", { ...context, fromDoor: true })).status).toBe(404);
  expect(provider.calls).toHaveLength(0);
});

test("the key is removed only by the window's own request: its Origin and this run's serverSession", async () => {
  const { dataDir, keyFile } = dataDirWithKey();
  const context = { dataDir, serverSession: SESSION, fromDoor: false };
  const path = "/api/sem-diff/opinion/settings";
  // A program's bare call (no Origin), and a page that does not hold this run's session.
  expect((await powerUpRoute(request(path, "DELETE", undefined, {}), path, context)).status).toBe(403);
  expect((await powerUpRoute(request(path, "DELETE", { serverSession: "another-run" }), path, context)).status).toBe(403);
  expect(existsSync(keyFile)).toBe(true);
  const removed = await powerUpRoute(request(path, "DELETE", { serverSession: SESSION }), path, context);
  expect(removed.status).toBe(200);
  expect(existsSync(keyFile)).toBe(false);
  const read = (await (await powerUpRoute(request(path, "GET"), path, context)).json()) as { configured: boolean };
  expect(read.configured).toBe(false);
});

test("a new key is saved only by the window's own request, and the settings read never carries the key", async () => {
  const { dataDir, keyFile } = dataDirWithKey();
  const provider = fakeProvider();
  const context = { dataDir, serverSession: SESSION, fromDoor: false, fetch: provider.fetchImpl };
  const path = "/api/sem-diff/opinion/settings";
  const newKey = { provider: "custom", url: "http://127.0.0.1:9/other", auth: "bearer", apiKey: "fake-replacement-key" };
  const saved = () => readFileSync(keyFile, "utf8");
  const before = saved();
  // A program's bare call (no Origin), a page without this run's session, and one with another run's.
  expect((await powerUpRoute(request(path, "POST", newKey, {}), path, context)).status).toBe(403);
  expect((await powerUpRoute(request(path, "POST", newKey), path, context)).status).toBe(403);
  expect((await powerUpRoute(request(path, "POST", { ...newKey, serverSession: "another-run" }), path, context)).status).toBe(403);
  expect(saved()).toBe(before);
  expect(provider.calls).toHaveLength(0);
  const read = await (await powerUpRoute(request(path, "GET"), path, context)).text();
  expect(JSON.parse(read)).toMatchObject({ configured: true, provider: "custom" });
  expect(JSON.parse(read)).not.toHaveProperty("apiKey");
  expect(read).not.toContain("fake-key-not-real");
  // The key check's stand-in answer (the provider's probe).
  const probe = (async () => Response.json({ result: { answers: { q: { noul: 0.97 } } } })) as unknown as typeof fetch;
  const accepted = await powerUpRoute(request(path, "POST", { ...newKey, serverSession: SESSION }), path, { ...context, fetch: probe });
  expect(((await accepted.json()) as { ok: boolean }).ok).toBe(true);
  expect(saved()).toContain("fake-replacement-key");
  // The window's session is the Inbox's: it never reaches the key file.
  expect(saved()).not.toContain(SESSION);
  expect(await (await powerUpRoute(request(path, "GET"), path, context)).text()).not.toContain("fake-replacement-key");
});

test("through the Cloudflare door: the person's window asks and reads, but the key is changed only here or over the tailnet", async () => {
  const { dataDir, keyFile } = dataDirWithKey();
  const provider = fakeProvider();
  const context = { dataDir, serverSession: SESSION, fromDoor: false, fromCloudflare: true, fetch: provider.fetchImpl };
  const path = "/api/sem-diff/opinion/settings";
  const asked = await powerUpRoute(request("/api/sem-diff/opinion", "POST", question()), "/api/sem-diff/opinion", context);
  expect(((await asked.json()) as { ok: boolean }).ok).toBe(true);
  expect(provider.calls).toHaveLength(1);
  expect(((await (await powerUpRoute(request(path, "GET"), path, context)).json()) as { configured: boolean }).configured).toBe(true);
  const write = await powerUpRoute(request(path, "DELETE", { serverSession: SESSION }), path, context);
  expect([write.status, ((await write.json()) as { code: string }).code]).toEqual([403, "local_only"]);
  expect((await powerUpRoute(request(path, "POST", { provider: "custom", url: "http://127.0.0.1:9/x", auth: "bearer", apiKey: "fake-other", serverSession: SESSION }), path, context)).status).toBe(403);
  expect(existsSync(keyFile)).toBe(true);
  expect(readFileSync(keyFile, "utf8")).toContain("fake-key-not-real");
});
