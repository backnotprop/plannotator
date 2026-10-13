import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3Credentials, T3OAuthProvider, loginT3 } from "./auth";
import { T3Delivery } from "./delivery";
import { T3Client, T3Thread, type T3Rpc } from "./t3-client";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function credentials(url = new URL("http://127.0.0.1:3773/mcp")): T3Credentials {
  const root = mkdtempSync(join(tmpdir(), "plannotator-t3-auth-")); roots.push(root);
  return new T3Credentials(root, url);
}

describe("T3 OAuth and durable sends", () => {
  test("registration requests authorization-code-only public credentials", () => {
    const provider = new T3OAuthProvider(credentials(), new URL("http://127.0.0.1:1234/callback"), () => {});
    expect(provider.clientMetadata.grant_types).toEqual(["authorization_code"]);
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
    expect(provider.expectedState).not.toBe(new T3OAuthProvider(credentials(), provider.redirectUrl, () => {}).expectedState);
  });
  test("uncertain sends retry the same request once in T3's grant namespace", async () => {
    const store = credentials(); store.save({ endpoint: store.endpoint.href, epoch: "grant-a", tokens: { access_token: "test", token_type: "Bearer" } });
    const receipts = new Map<string, unknown>();
    let networkLost = true;
    let inserted = 0;
    const rpc: T3Rpc = { async call(_name, args) {
      const key = String(args.clientRequestId);
      if (!receipts.has(key)) { inserted++; receipts.set(key, { threadId: args.threadId, messageId: "message", runId: "run", status: "queued", delivery: "queued" }); }
      if (networkLost) { networkLost = false; throw new Error("Lost response after T3 accepted the message"); }
      expect(args.mode).toBe("queue");
      return receipts.get(key);
    } };
    const thread = new T3Thread(rpc, "thread-a");
    await expect(new T3Delivery(thread, store).send("Human reply", "reply-1")).rejects.toThrow("Lost response");
    const receipt = await new T3Delivery(thread, store).send("Human reply", "reply-1");
    expect(receipt.messageId).toBe("message");
    expect(inserted).toBe(1);
    expect((statSync(store.path).mode & 0o777)).toBe(0o600);
    expect((statSync(store.directory).mode & 0o777)).toBe(0o700);
    await expect(new T3Delivery(thread, store).send("Changed reply", "reply-1")).rejects.toThrow("changed its scope or content");
  });
  test("a new OAuth grant refuses to replay an uncertain old delivery", async () => {
    const store = credentials(); store.save({ endpoint: store.endpoint.href, epoch: "old", tokens: { access_token: "test", token_type: "Bearer" } });
    let sends = 0;
    const thread = new T3Thread({ async call() { sends++; throw new Error("Lost response"); } }, "thread-a");
    await expect(new T3Delivery(thread, store).send("Decision", "decision-1")).rejects.toThrow();
    store.save({ endpoint: store.endpoint.href, epoch: "new", tokens: { access_token: "new-test", token_type: "Bearer" } });
    await expect(new T3Delivery(thread, store).send("Decision", "decision-1")).rejects.toThrow("uncertain after T3 reauthorization");
    expect(sends).toBe(1);
  });
  test("after a new login a running worker's delivery object sends new decisions without a restart", async () => {
    // What regresses: every send refused with "Restart this thread's companion" after re-login.
    const store = credentials(); store.save({ endpoint: store.endpoint.href, epoch: "old", tokens: { access_token: "a", token_type: "Bearer" } });
    const thread = new T3Thread({ async call(_name, args) { return { threadId: args.threadId, messageId: "m", runId: "r", status: "queued", delivery: "queued" }; } }, "thread-a");
    const delivery = new T3Delivery(thread, store);
    store.save({ endpoint: store.endpoint.href, epoch: "new", tokens: { access_token: "b", token_type: "Bearer" } });
    expect((await delivery.send("Decision", "decision-2")).messageId).toBe("m");
  });
  test("the worker's MCP client reads the token per request and reopens a session the server dropped after a new login", async () => {
    let accepted = "token-a";
    const sessions = new Map<string, string>();
    const seen: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: request.method === "DELETE" ? 200 : 405 });
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (token !== accepted) return new Response("Unauthorized", { status: 401 });
      const rpc = await request.json() as { id?: number; method: string };
      const session = request.headers.get("mcp-session-id");
      if (rpc.method === "initialize") {
        const id = crypto.randomUUID(); sessions.set(id, token);
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "t3", version: "test" } } }, { headers: { "mcp-session-id": id } });
      }
      // A session belongs to the grant that opened it.
      if (!session || sessions.get(session) !== token) return new Response("Session not found", { status: 404 });
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      seen.push(token);
      const output = { ok: true };
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output } });
    } });
    try {
      const store = credentials(new URL(`http://127.0.0.1:${server.port}/mcp`));
      store.save({ endpoint: store.endpoint.href, epoch: "a", tokens: { access_token: "token-a", token_type: "Bearer" } });
      const client = await T3Client.connect(store.endpoint, store.token);
      expect(await client.call("t3_thread_read", {})).toEqual({ ok: true });
      // `plannotator t3 login` again: the old grant stops working.
      accepted = "token-b";
      store.save({ endpoint: store.endpoint.href, epoch: "b", tokens: { access_token: "token-b", token_type: "Bearer" } });
      expect(await client.call("t3_thread_read", {})).toEqual({ ok: true });
      expect(seen).toEqual(["token-a", "token-b"]);
      await client.close();
    } finally { server.stop(true); }
  });
  test("OAuth callback refuses a wrong state and finishes the PKCE exchange", async () => {
    let tokenExchanges = 0;
    let callbackUrl: URL | undefined;
    let confirmation: Promise<Response> | undefined;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const origin = `http://127.0.0.1:${server.port}`;
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
      if (url.pathname === "/register") return Response.json({ ...(await request.json() as Record<string, unknown>), client_id: "client-a" }, { status: 201 });
      if (url.pathname === "/token") {
        const form = await request.formData();
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code_verifier")).toBeString();
        tokenExchanges++;
        expect((await fetch(callbackUrl!)).status).toBe(403);
        return Response.json({ access_token: "test-access", token_type: "Bearer", expires_in: 3600 });
      }
      return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
    } });
    try {
      const store = credentials(new URL(`http://127.0.0.1:${server.port}/mcp`));
      await loginT3(store, async (authorization) => {
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", "wrong"); callback.searchParams.set("code", "test-code");
        expect((await fetch(callback)).status).toBe(403);
        expect(tokenExchanges).toBe(0);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        callbackUrl = callback;
        confirmation = fetch(callback);
      }, 10_000);
      const response = await confirmation!;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Plannotator connected to T3");
      expect(tokenExchanges).toBe(1);
      expect(store.token()).toBe("test-access");
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
    } finally { server.stop(true); }
  });
});
