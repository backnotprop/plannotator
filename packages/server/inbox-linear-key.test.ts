import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinearKey, LINEAR_KEY_FILE } from "./inbox-linear-key";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:1/api/inbox/linear/key", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ serverSession: "s", ...(body as object) }) });

test("a pasted key wins over LINEAR_API_KEY, Remove falls back to it, and no answer holds the key", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "linear-key-"));
  let forgot = 0;
  const key = createLinearKey({ dataDir, serverSession: "s", json, readBody, env: { LINEAR_API_KEY: "lin_api_from_env_0000" }, changed: () => forgot++ });
  expect(key.state()).toEqual({ source: "env", last4: null });
  expect(key.apiKey()).toBe("lin_api_from_env_0000");

  const pasted = "lin_api_pasted_secret_9xyz";
  const saved = await key.route(post({ key: `  ${pasted} ` }), "/api/inbox/linear/key", "local");
  const savedText = await saved!.text();
  expect(JSON.parse(savedText)).toEqual({ key: { source: "saved", last4: "9xyz" } });
  expect(savedText).not.toContain(pasted);
  expect(key.apiKey()).toBe(pasted);
  const file = join(dataDir, LINEAR_KEY_FILE);
  expect(readFileSync(file, "utf8").trim()).toBe(pasted);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(key.state())).not.toContain(pasted);
  expect(forgot).toBe(1);

  const removed = await key.route(post({ key: null }), "/api/inbox/linear/key", "local");
  expect(await removed!.json()).toEqual({ key: { source: "env", last4: null } });
  expect(existsSync(file)).toBe(false);
  expect(key.apiKey()).toBe("lin_api_from_env_0000");
  expect(forgot).toBe(2);

  const none = createLinearKey({ dataDir, serverSession: "s", json, readBody, env: {} });
  expect(none.state()).toEqual({ source: null, last4: null });
  expect(none.apiKey()).toBeNull();
});

test("refused: plain http from the tailnet, a stale page, a value that is not a key, any other method or path", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "linear-key-"));
  const key = createLinearKey({ dataDir, serverSession: "s", json, readBody, env: {} });
  const plain = await key.route(post({ key: "lin_api_over_http_1234" }), "/api/inbox/linear/key", "tailnet");
  expect(plain!.status).toBe(403);
  const tls = await key.route(post({ key: "lin_api_over_tls_1234" }, { "x-forwarded-proto": "https" }), "/api/inbox/linear/key", "tailnet");
  expect(tls!.status).toBe(200);
  const stale = await key.route(
    new Request("http://127.0.0.1:1/api/inbox/linear/key", { method: "POST", body: JSON.stringify({ serverSession: "old", key: "lin_api_stale_page_1234" }) }),
    "/api/inbox/linear/key",
    "local",
  );
  expect(stale!.status).toBe(409);
  await expect(key.route(post({ key: "short" }), "/api/inbox/linear/key", "local")).rejects.toThrow("Linear API key");
  expect(key.apiKey()).toBe("lin_api_over_tls_1234");
  expect((await key.route(new Request("http://127.0.0.1:1/api/inbox/linear/key"), "/api/inbox/linear/key", "local"))!.status).toBe(405);
  expect(await key.route(post({ key: null }), "/api/inbox/other", "local")).toBeNull();
});
