/**
 * `plannotator inbox permission-hook` (launch PR 2): what Claude Code reads
 * from it. Each test guards one way the hook could break a session: plan
 * review taken over, a session the Inbox did not launch held up, an Inbox
 * restart turning into a silent fallback, or a refusal held forever.
 */
import { describe, expect, test } from "bun:test";
import { permissionHookOutput, PERMISSION_HOOK_RETRY_MS } from "./inbox-permission-hook";

const LAUNCH = "lch_01J00000000000000000000000";
const ENV = { PLANNOTATOR_LAUNCH: LAUNCH, PLANNOTATOR_LAUNCH_KEY: "k".repeat(64) };
const BASH = { session_id: "s-1", cwd: "/w", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } };
const REGISTRY = { port: 4321, token: "t".repeat(64) };

/** A scripted Inbox: each call takes the next answer (a status and body, or "down"), and is recorded. */
function inbox(script: ({ status: number; body: unknown } | "down")[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const sleeps: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = script.shift();
    if (!next || next === "down") throw new TypeError("fetch failed: connection refused");
    return Response.json(next.body, { status: next.status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, sleeps, fetch, sleep: async (ms: number) => void sleeps.push(ms) };
}

describe("permission-hook", () => {
  test("ExitPlanMode: no output and no call, so plan review decides as before", async () => {
    const box = inbox([]);
    const out = await permissionHookOutput({ stdin: JSON.stringify({ ...BASH, tool_name: "ExitPlanMode" }), env: ENV, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY });
    expect(out).toBeNull();
    expect(box.calls).toHaveLength(0);
  });

  test("a session the Inbox did not launch (no launch in its env), or stdin that is not an event: no output, no call", async () => {
    const box = inbox([]);
    expect(await permissionHookOutput({ stdin: JSON.stringify(BASH), env: {}, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY })).toBeNull();
    expect(await permissionHookOutput({ stdin: "not json", env: ENV, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY })).toBeNull();
    expect(box.calls).toHaveLength(0);
  });

  test("waits through the Inbox being down, then keeps its question across calls and prints the decision", async () => {
    const decision = { behavior: "allow", updatedInput: { command: "ls" } };
    const box = inbox(["down", { status: 503, body: {} }, { status: 200, body: { status: "waiting", message_id: "msg_1" } }, "down", { status: 200, body: { status: "decided", message_id: "msg_1", decision } }]);
    let registryReads = 0;
    const out = await permissionHookOutput({
      stdin: JSON.stringify(BASH),
      env: ENV,
      dataDir: "/nowhere",
      fetch: box.fetch,
      sleep: box.sleep,
      // No inbox.json at first (not started yet), then the running Inbox's.
      registry: () => (registryReads++ === 0 ? null : REGISTRY),
    });
    expect(JSON.parse(out!)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
    expect(box.sleeps.every((ms) => ms === PERMISSION_HOOK_RETRY_MS)).toBe(true);
    expect(box.sleeps).toHaveLength(4);
    expect(box.calls[0]!.url).toBe(`http://127.0.0.1:4321/api/inbox/launch/${LAUNCH}/permission`);
    expect(box.calls[0]!.headers.authorization).toBe(`Bearer ${REGISTRY.token}`);
    expect(box.calls[0]!.body).toMatchObject({ key: ENV.PLANNOTATOR_LAUNCH_KEY, event: BASH });
    expect(box.calls[0]!.body.message_id).toBeUndefined();
    // One request id for the whole wait; the question's id once the Inbox named it.
    expect(new Set(box.calls.map((c) => c.body.request_id)).size).toBe(1);
    expect(box.calls.at(-1)!.body.message_id).toBe("msg_1");
  });

  test("refused (a wrong key, a deleted launch, launch off) or withdrawn: no output, at once", async () => {
    for (const answer of [
      { status: 403, body: { code: "wrong_key" } },
      { status: 410, body: { code: "launch_gone" } },
      { status: 404, body: { code: "launch_off" } },
      { status: 200, body: { status: "withdrawn", message_id: "msg_1" } },
    ]) {
      const box = inbox([answer]);
      expect(await permissionHookOutput({ stdin: JSON.stringify(BASH), env: ENV, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY })).toBeNull();
      expect(box.calls).toHaveLength(1);
    }
  });
});
