import { describe, test, expect } from "bun:test";
import { SessionManager } from "./session-manager.ts";
import { buildSystemPrompt, buildForkPreamble } from "./context.ts";
import {
  ProviderRegistry,
  registerProviderFactory,
  createProvider,
} from "./provider.ts";
import { createAIEndpoints } from "./endpoints.ts";
import type {
  AIProvider,
  AISession,
  AIMessage,
  AIContext,
} from "./types.ts";
import {
  buildWindowsCommandScriptSpawnCommand,
  killWindowsProcessTree,
  resolveCommandFromWhichOutput,
  resolveWindowsCommandShim,
  shouldSpawnViaShell,
} from "./providers/command-path.ts";

// ---------------------------------------------------------------------------
// Helpers — mock provider/session for testing
// ---------------------------------------------------------------------------

function mockSession(
  id: string,
  parentSessionId: string | null = null
): AISession {
  let active = false;
  return {
    get id() {
      return id;
    },
    parentSessionId,
    get isActive() {
      return active;
    },
    async *query(prompt: string): AsyncIterable<AIMessage> {
      active = true;
      yield { type: "text_delta", delta: `Echo: ${prompt}` };
      yield {
        type: "result",
        sessionId: id,
        success: true,
        result: `Echo: ${prompt}`,
      };
      active = false;
    },
    abort() {
      active = false;
    },
  };
}

let sessionCounter = 0;

function mockProvider(name = "mock"): AIProvider {
  return {
    name,
    capabilities: { fork: true, resume: true, streaming: true, tools: false },
    async createSession(opts) {
      return mockSession(`session-${++sessionCounter}`, null);
    },
    async forkSession(opts) {
      const parent = opts.context.parent;
      return mockSession(
        `forked-${++sessionCounter}`,
        parent?.sessionId ?? null
      );
    },
    async resumeSession(sessionId) {
      return mockSession(sessionId, null);
    },
    dispose() {},
  };
}

// ---------------------------------------------------------------------------
// Command path helpers
// ---------------------------------------------------------------------------

describe("command path helpers", () => {
  test("resolveWindowsCommandShim prefers a sibling .cmd for npm shims", () => {
    const raw = String.raw`C:\Users\Andrew\AppData\Roaming\npm\pi`;
    const resolved = resolveWindowsCommandShim(
      raw,
      "win32",
      (path) => path === `${raw}.cmd`,
    );

    expect(resolved).toBe(`${raw}.cmd`);
  });

  test("resolveCommandFromWhichOutput skips extensionless Windows shims", () => {
    const raw = String.raw`C:\Users\Andrew\AppData\Roaming\npm\pi`;
    const resolved = resolveCommandFromWhichOutput(
      `${raw}\r\n${raw}.cmd\r\n`,
      "win32",
      () => false,
    );

    expect(resolved).toBe(`${raw}.cmd`);
  });

  test("resolveCommandFromWhichOutput preserves the first non-Windows result", () => {
    expect(
      resolveCommandFromWhichOutput("/usr/local/bin/pi\n/usr/bin/pi\n", "darwin"),
    ).toBe("/usr/local/bin/pi");
  });

  test("shouldSpawnViaShell only flags Windows command scripts", () => {
    expect(
      shouldSpawnViaShell(
        String.raw`C:\Users\Andrew\AppData\Roaming\npm\pi.cmd`,
        "win32",
      ),
    ).toBe(true);
    expect(shouldSpawnViaShell(String.raw`C:\tools\pi.exe`, "win32")).toBe(false);
    expect(shouldSpawnViaShell("/usr/local/bin/pi.cmd", "darwin")).toBe(false);
  });

  test("buildWindowsCommandScriptSpawnCommand wraps command scripts for Bun.spawn", () => {
    const command = buildWindowsCommandScriptSpawnCommand(
      String.raw`C:\Users\Andrew Ramos\AppData\Roaming\npm\pi.cmd`,
      ["--mode", "rpc"],
      "win32",
      String.raw`C:\Windows\System32\cmd.exe`,
    );

    expect(command).toEqual([
      String.raw`C:\Windows\System32\cmd.exe`,
      "/d",
      "/s",
      "/c",
      String.raw`"C:\Users\Andrew Ramos\AppData\Roaming\npm\pi.cmd" --mode rpc`,
    ]);
  });

  test("buildWindowsCommandScriptSpawnCommand ignores native executables", () => {
    expect(
      buildWindowsCommandScriptSpawnCommand(
        String.raw`C:\tools\pi.exe`,
        ["--mode", "rpc"],
        "win32",
      ),
    ).toBeNull();
  });

  test("killWindowsProcessTree invokes taskkill with tree flags on Windows", () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { stdio: "ignore"; windowsHide: boolean };
    }> = [];
    const killed = killWindowsProcessTree(1234, "win32", (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    });

    expect(killed).toBe(true);
    expect(calls).toEqual([
      {
        command: "taskkill",
        args: ["/pid", "1234", "/t", "/f"],
        options: { stdio: "ignore", windowsHide: true },
      },
    ]);
  });

  test("killWindowsProcessTree skips non-Windows platforms", () => {
    let called = false;
    const killed = killWindowsProcessTree(1234, "darwin", () => {
      called = true;
      return { status: 0 };
    });

    expect(killed).toBe(false);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  test("tracks sessions and lists them newest-first", () => {
    const sm = new SessionManager();
    const s1 = mockSession("s1");
    const s2 = mockSession("s2");

    const e1 = sm.track(s1, "plan-review", "First");
    const e2 = sm.track(s2, "code-review", "Second");
    e1.lastActiveAt = 1000;
    e2.lastActiveAt = 2000;

    expect(sm.size).toBe(2);
    const list = sm.list();
    expect(list[0].session.id).toBe("s2");
    expect(list[1].session.id).toBe("s1");
  });

  test("get returns entry by ID", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "plan-review");
    expect(sm.get("s1")?.session.id).toBe("s1");
    expect(sm.get("nonexistent")).toBeUndefined();
  });

  test("touch updates lastActiveAt", async () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "plan-review");
    const before = sm.get("s1")!.lastActiveAt;

    await new Promise((r) => setTimeout(r, 10));
    sm.touch("s1");

    expect(sm.get("s1")!.lastActiveAt).toBeGreaterThan(before);
  });

  test("remove removes entry", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "plan-review");
    sm.remove("s1");
    expect(sm.size).toBe(0);
  });

  test("forksOf filters by parent", () => {
    const sm = new SessionManager();
    sm.track(mockSession("s1"), "plan-review");
    sm.track(mockSession("fork1", "parent-123"), "plan-review");
    sm.track(mockSession("fork2", "parent-123"), "plan-review");
    sm.track(mockSession("fork3", "other-parent"), "code-review");

    const forks = sm.forksOf("parent-123");
    expect(forks.length).toBe(2);
    expect(forks.map((f) => f.session.id).sort()).toEqual(["fork1", "fork2"]);
  });

  test("evicts oldest idle session when maxSessions reached", () => {
    const sm = new SessionManager({ maxSessions: 2 });
    sm.track(mockSession("s1"), "plan-review");
    sm.track(mockSession("s2"), "plan-review");
    sm.track(mockSession("s3"), "plan-review");

    expect(sm.size).toBe(2);
    expect(sm.get("s1")).toBeUndefined();
    expect(sm.get("s2")).toBeDefined();
    expect(sm.get("s3")).toBeDefined();
  });

  test("disposeAll aborts active sessions and clears", () => {
    const sm = new SessionManager();
    const s1 = mockSession("s1");
    sm.track(s1, "plan-review");
    sm.disposeAll();
    expect(sm.size).toBe(0);
  });

  test("remapId moves entry to new key and keeps alias", () => {
    const sm = new SessionManager();
    sm.track(mockSession("placeholder-1"), "plan-review");

    sm.remapId("placeholder-1", "real-sdk-id");

    // Both old and new IDs resolve to the same entry
    expect(sm.get("real-sdk-id")).toBeDefined();
    expect(sm.get("placeholder-1")).toBeDefined();
    expect(sm.get("placeholder-1")).toBe(sm.get("real-sdk-id"));
  });

  test("track wires onIdResolved callback with alias", () => {
    const sm = new SessionManager();
    const session = mockSession("temp-id");
    sm.track(session, "plan-review");

    expect(session.onIdResolved).toBeDefined();
    session.onIdResolved!("temp-id", "real-id");

    // Both IDs work
    expect(sm.get("real-id")).toBeDefined();
    expect(sm.get("temp-id")).toBeDefined();
    expect(sm.get("temp-id")).toBe(sm.get("real-id"));
  });

  test("remove cleans up aliases", () => {
    const sm = new SessionManager();
    sm.track(mockSession("temp"), "plan-review");
    sm.remapId("temp", "real");

    sm.remove("real");
    expect(sm.get("real")).toBeUndefined();
    expect(sm.get("temp")).toBeUndefined();
    expect(sm.size).toBe(0);
  });

  test("remove via alias also works", () => {
    const sm = new SessionManager();
    sm.track(mockSession("temp"), "plan-review");
    sm.remapId("temp", "real");

    sm.remove("temp"); // remove via alias
    expect(sm.get("real")).toBeUndefined();
    expect(sm.get("temp")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

describe("Context builders", () => {
  test("buildSystemPrompt for plan-review", () => {
    const ctx: AIContext = {
      mode: "plan-review",
      plan: {
        plan: "# My Plan\n\nStep 1: do things",
        previousPlan: "# Old Plan",
        version: 3,
        totalVersions: 4,
        project: "plannotator",
      },
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("Plannotator");
    expect(prompt).toContain("# My Plan");
    expect(prompt).toContain("Step 1: do things");
    expect(prompt).toContain("Plan version: 3 of 4");
    expect(prompt).toContain("Project: plannotator");
    expect(prompt).toContain("# Old Plan");
  });

  test("buildSystemPrompt for code-review is role-only (diff rides on user messages)", () => {
    const ctx: AIContext = {
      mode: "code-review",
      review: { patch: "diff --git a/foo.ts b/foo.ts\n+hello", diffType: "branch", base: "main" },
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("Plannotator");
    expect(prompt).toContain("code changes");
    // The diff and how-to-inspect-it are delivered on the user's messages now
    // (the review server's shared machine builds them), not in the system prompt.
    expect(prompt).not.toContain("diff --git");
    expect(prompt).not.toContain("git diff");
    expect(prompt).not.toContain("```diff");
  });

  test("buildSystemPrompt for annotate", () => {
    const ctx: AIContext = {
      mode: "annotate",
      annotate: {
        content: "# Doc\nSome content",
        filePath: "/tmp/test.md",
        sourceInfo: "https://example.com/doc.html",
        sourceConverted: true,
        renderAs: "html",
      },
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("Plannotator");
    expect(prompt).toContain("/tmp/test.md");
    expect(prompt).toContain("https://example.com/doc.html");
    expect(prompt).toContain("Render mode: html");
    expect(prompt).toContain("converted before annotation");
  });

  test("buildForkPreamble includes context and instructions", () => {
    const ctx: AIContext = {
      mode: "plan-review",
      plan: {
        plan: "# Plan\nDetails here",
        annotations: "- Remove section 3",
      },
      parent: { sessionId: "parent-123", cwd: "/project" },
    };
    const preamble = buildForkPreamble(ctx);
    expect(preamble).toContain("reviewing your work in Plannotator");
    expect(preamble).toContain("# Plan");
    expect(preamble).toContain("Remove section 3");
  });

  test("buildForkPreamble for code-review with selected code", () => {
    const ctx: AIContext = {
      mode: "code-review",
      review: {
        patch: "+new line",
        filePath: "src/auth.ts",
        selectedCode: "function verify()",
        lineRange: { start: 10, end: 15, side: "new" },
      },
      parent: { sessionId: "p", cwd: "/proj" },
    };
    const preamble = buildForkPreamble(ctx);
    expect(preamble).toContain("src/auth.ts");
    expect(preamble).toContain("function verify()");
    expect(preamble).toContain("Lines 10-15");
  });

  test("truncates very long plans", () => {
    const longPlan = "x".repeat(100_000);
    const ctx: AIContext = {
      mode: "plan-review",
      plan: { plan: longPlan },
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("[truncated for context window]");
    expect(prompt.length).toBeLessThan(longPlan.length);
  });

  test("every mode instructs the agent to answer directly (no unprompted review)", () => {
    const modes: AIContext[] = [
      { mode: "plan-review", plan: { plan: "# Plan" } },
      { mode: "code-review", review: { patch: "+x" } },
      { mode: "annotate", annotate: { content: "# Doc", filePath: "/x.md" } },
    ];
    for (const ctx of modes) {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).toContain("Respond to the user's message directly");
      expect(prompt).toContain("do NOT review");
    }
  });

  test("code-review system prompt never carries the diff or a git command, for any diffType", () => {
    // The "changes under review" context moved to the user's messages (built by
    // the shared agent-review machine), so the system prompt must stay role-only
    // regardless of diff type — no pasted patch, no git command.
    const variants: AIContext[] = [
      { mode: "code-review", review: { patch: "diff --git a/foo.ts\n+marker", diffType: "branch", base: "develop" } },
      { mode: "code-review", review: { patch: "+marker", diffType: "merge-base", base: "main" } },
      { mode: "code-review", review: { patch: "diff --git a/foo.ts\n+marker", diffType: "jj-current" } },
      { mode: "code-review", review: { patch: "diff --git a/foo.ts\n+marker" } },
    ];
    for (const ctx of variants) {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).not.toContain("marker");
      expect(prompt).not.toContain("```diff");
      expect(prompt).not.toContain("git diff");
    }
  });

  test("code-review system prompt tells the agent the changeset arrives in user messages", () => {
    const prompt = buildSystemPrompt({ mode: "code-review", review: { patch: "+x" } });
    expect(prompt).toMatch(/messages/i);
    expect(prompt).toMatch(/inspect/i);
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

describe("ProviderRegistry", () => {
  test("register, get, list, dispose", () => {
    const reg = new ProviderRegistry();
    const p = mockProvider("test-provider");
    reg.register(p);

    expect(reg.get("test-provider")).toBe(p);
    expect(reg.getDefault()?.provider).toBe(p);
    expect(reg.getDefault()?.id).toBe("test-provider");
    expect(reg.list()).toEqual(["test-provider"]);

    reg.dispose("test-provider");
    expect(reg.get("test-provider")).toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  test("register with custom instance ID", () => {
    const reg = new ProviderRegistry();
    const p = mockProvider("claude-agent-sdk");
    const id = reg.register(p, "claude-fast");

    expect(id).toBe("claude-fast");
    expect(reg.get("claude-fast")).toBe(p);
    expect(reg.get("claude-agent-sdk")).toBeUndefined();
  });

  test("multiple instances of same provider type", () => {
    const reg = new ProviderRegistry();
    const p1 = mockProvider("claude-agent-sdk");
    const p2 = mockProvider("claude-agent-sdk");

    reg.register(p1, "claude-review");
    reg.register(p2, "claude-plan");

    expect(reg.size).toBe(2);
    expect(reg.get("claude-review")).toBe(p1);
    expect(reg.get("claude-plan")).toBe(p2);

    const byType = reg.getByType("claude-agent-sdk");
    expect(byType.length).toBe(2);
  });

  test("mixed provider types", () => {
    const reg = new ProviderRegistry();
    reg.register(mockProvider("claude-agent-sdk"), "claude-1");
    reg.register(mockProvider("opencode-sdk"), "oc-1");

    expect(reg.size).toBe(2);
    expect(reg.getByType("claude-agent-sdk").length).toBe(1);
    expect(reg.getByType("opencode-sdk").length).toBe(1);
  });

  test("disposeAll clears everything", () => {
    const reg = new ProviderRegistry();
    reg.register(mockProvider("a"));
    reg.register(mockProvider("b"));
    reg.disposeAll();
    expect(reg.size).toBe(0);
  });

  test("createProvider via factory (does not auto-register)", async () => {
    registerProviderFactory("test-factory", async (config) => {
      return mockProvider(config.type);
    });

    const provider = await createProvider({ type: "test-factory" });
    expect(provider.name).toBe("test-factory");

    // Should NOT be auto-registered in any registry
    const reg = new ProviderRegistry();
    expect(reg.get("test-factory")).toBeUndefined();
  });

  test("createProvider throws for unknown type", async () => {
    await expect(createProvider({ type: "unknown-xyz" })).rejects.toThrow(
      "No AI provider factory"
    );
  });
});

// ---------------------------------------------------------------------------
// AI endpoints
// ---------------------------------------------------------------------------

describe("AI endpoints", () => {
  function setup() {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const endpoints = createAIEndpoints({ registry: reg, sessionManager: sm });
    return { reg, sm, endpoints };
  }

  test("capabilities returns available: false when no provider", async () => {
    const { endpoints } = setup();

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    expect(data.available).toBe(false);
    expect(data.defaultProvider).toBeNull();
  });

  test("capabilities returns provider info when registered", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    expect(data.available).toBe(true);
    expect(data.defaultProvider).toBe("mock");
    expect(data.providers.length).toBe(1);
    expect(data.providers[0].id).toBe("mock");
    expect(data.providers[0].name).toBe("mock");
    expect(data.providers[0].capabilities.fork).toBe(true);
  });

  test("capabilities waits for pending provider discovery", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const provider = mockProvider("pi-sdk") as AIProvider & {
      models?: Array<{ id: string; label: string; default?: boolean }>;
    };
    reg.register(provider);
    const endpoints = createAIEndpoints({
      registry: reg,
      sessionManager: sm,
      beforeCapabilities: async () => {
        provider.models = [{ id: "pi/model", label: "Pi Model", default: true }];
      },
    });

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    expect(data.providers[0].models).toEqual([
      { id: "pi/model", label: "Pi Model", default: true },
    ]);
  });

  test("capabilities lists multiple providers", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("claude-agent-sdk"), "claude-1");
    reg.register(mockProvider("opencode-sdk"), "oc-1");

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    expect(data.providers.length).toBe(2);
    const ids = data.providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("claude-1");
    expect(ids).toContain("oc-1");
  });

  test("capabilities returns instance ID not type name for defaultProvider", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("claude-agent-sdk"), "claude-fast");

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();
    // Should return the instance ID "claude-fast", not the type name "claude-agent-sdk"
    expect(data.defaultProvider).toBe("claude-fast");
  });

  test("session creation and query flow", async () => {
    const { reg, sm, endpoints } = setup();
    reg.register(mockProvider("mock"));

    // Create session
    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
        }),
      })
    );
    const createData = (await createRes.json()) as { sessionId: string };
    expect(createData.sessionId).toBeDefined();
    expect(sm.size).toBe(1);

    // Query
    const queryRes = await endpoints["/api/ai/query"](
      new Request("http://localhost/api/ai/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: createData.sessionId,
          prompt: "What is this plan about?",
        }),
      })
    );
    expect(queryRes.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await queryRes.text();
    expect(text).toContain("Echo: What is this plan about?");
    expect(text).toContain("[DONE]");
  });

  test("session creation with specific provider ID", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("claude-agent-sdk"), "claude-fast");
    reg.register(mockProvider("opencode-sdk"), "oc-default");

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          providerId: "claude-fast",
        }),
      })
    );
    expect(createRes.status).toBe(200);
  });

  test("session creation clamps client-supplied cost controls", async () => {
    const { reg, endpoints } = setup();
    let seenOptions: { maxTurns?: number; maxBudgetUsd?: number } | null = null;
    reg.register({
      ...mockProvider("mock"),
      async createSession(opts) {
        seenOptions = opts;
        return mockSession(`session-${++sessionCounter}`, null);
      },
    });

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          maxTurns: 9999,
          maxBudgetUsd: 9999,
        }),
      })
    );

    expect(createRes.status).toBe(200);
    expect(seenOptions?.maxTurns).toBe(99);
    expect(seenOptions?.maxBudgetUsd).toBe(5);
  });

  test("session creation fails for unknown provider ID", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
          providerId: "nonexistent",
        }),
      })
    );
    expect(createRes.status).toBe(503);
    const data = await createRes.json();
    expect(data.error).toContain("nonexistent");
  });

  test("query with context update prepends to prompt", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
        }),
      })
    );
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const queryRes = await endpoints["/api/ai/query"](
      new Request("http://localhost/api/ai/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          prompt: "What changed?",
          contextUpdate: "New annotation: section 3 flagged",
        }),
      })
    );
    const text = await queryRes.text();
    expect(text).toContain("Context update");
    expect(text).toContain("section 3 flagged");
    expect(text).toContain("What changed?");
  });

  test("query sets label from first prompt", async () => {
    const { reg, sm, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
        }),
      })
    );
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    // First query should set the label
    await endpoints["/api/ai/query"](
      new Request("http://localhost/api/ai/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          prompt: "Why did we choose this approach?",
        }),
      })
    );

    const entry = sm.get(sessionId);
    expect(entry?.label).toBe("Why did we choose this approach?");
  });

  test("abort endpoint", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    const createRes = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# Test" } },
        }),
      })
    );
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    const abortRes = await endpoints["/api/ai/abort"](
      new Request("http://localhost/api/ai/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
    );
    const abortData = (await abortRes.json()) as { ok: boolean };
    expect(abortData.ok).toBe(true);
  });

  test("sessions list endpoint", async () => {
    const { reg, endpoints } = setup();
    reg.register(mockProvider("mock"));

    await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "plan-review", plan: { plan: "# A" } },
        }),
      })
    );
    await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "code-review", review: { patch: "+x" } },
        }),
      })
    );

    const listRes = await endpoints["/api/ai/sessions"](
      new Request("http://localhost/api/ai/sessions")
    );
    const sessions = (await listRes.json()) as Array<{ mode: string }>;
    expect(sessions.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Claude Agent SDK — Bedrock/Vertex model resolution
// ---------------------------------------------------------------------------

import { resolveSDKModel } from "./providers/claude-agent-sdk.ts";

describe("resolveSDKModel", () => {
  const SONNET_ARN =
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6";
  const OPUS_ARN =
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-4-8[1m]";
  const HAIKU_ARN =
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0";

  const bedrockEnv = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_MODEL: OPUS_ARN,
    ANTHROPIC_DEFAULT_SONNET_MODEL: SONNET_ARN,
    ANTHROPIC_DEFAULT_OPUS_MODEL: OPUS_ARN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: HAIKU_ARN,
  };

  test("off Bedrock/Vertex: returns the requested alias unchanged", () => {
    expect(resolveSDKModel("claude-sonnet-4-6", {})).toBe("claude-sonnet-4-6");
  });

  test("maps a bare sonnet alias to the configured Sonnet ARN on Bedrock", () => {
    expect(resolveSDKModel("claude-sonnet-4-6", bedrockEnv)).toBe(SONNET_ARN);
  });

  test("maps bare opus / haiku aliases to their ARNs", () => {
    expect(resolveSDKModel("claude-opus-4-8", bedrockEnv)).toBe(OPUS_ARN);
    expect(resolveSDKModel("claude-haiku-4-5", bedrockEnv)).toBe(HAIKU_ARN);
  });

  test("maps the [1m] context variant by family", () => {
    expect(resolveSDKModel("claude-sonnet-4-6[1m]", bedrockEnv)).toBe(SONNET_ARN);
  });

  test("passes through an identifier that is already an ARN", () => {
    expect(resolveSDKModel(SONNET_ARN, bedrockEnv)).toBe(SONNET_ARN);
  });

  test("passes through a bare inference-profile id", () => {
    const profile = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    expect(resolveSDKModel(profile, bedrockEnv)).toBe(profile);
  });

  test("falls back to ANTHROPIC_MODEL when no family default is set", () => {
    expect(
      resolveSDKModel("claude-sonnet-4-6", {
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_MODEL: OPUS_ARN,
      }),
    ).toBe(OPUS_ARN);
  });

  test("returns undefined so the SDK inherits env when nothing else resolves", () => {
    expect(
      resolveSDKModel("claude-sonnet-4-6", { CLAUDE_CODE_USE_BEDROCK: "1" }),
    ).toBeUndefined();
  });

  test("also applies on Vertex", () => {
    expect(
      resolveSDKModel("claude-opus-4-8", {
        CLAUDE_CODE_USE_VERTEX: "true",
        ANTHROPIC_DEFAULT_OPUS_MODEL: OPUS_ARN,
      }),
    ).toBe(OPUS_ARN);
  });
});

// ---------------------------------------------------------------------------
// Codex app-server provider — JSON-RPC classification + event mapping
// ---------------------------------------------------------------------------

import {
  classifyRpcMessage,
  mapApprovalRequest,
  mapCodexAppServerEvent,
} from "./providers/codex-app-server.ts";

describe("classifyRpcMessage", () => {
  test("a message with id + result is a response", () => {
    expect(classifyRpcMessage({ id: 7, result: { ok: true } })).toEqual({
      kind: "response",
      id: 7,
    });
  });

  test("a message with id + method is a server request (not a response)", () => {
    // id-space collision guard: even though id 7 could match a pending client
    // request, the presence of `method` means this is an inbound request.
    expect(
      classifyRpcMessage({
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: { command: "ls" },
      }),
    ).toEqual({
      kind: "request",
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "ls" },
    });
  });

  test("a message with method and no id is a notification", () => {
    expect(
      classifyRpcMessage({ method: "item/agentMessage/delta", params: { delta: "hi" } }),
    ).toEqual({
      kind: "notification",
      method: "item/agentMessage/delta",
      params: { delta: "hi" },
    });
  });

  test("a message with neither id nor method is unknown", () => {
    expect(classifyRpcMessage({ foo: 1 })).toEqual({ kind: "unknown" });
  });
});

describe("mapCodexAppServerEvent", () => {
  test("agentMessage delta maps to text_delta", () => {
    expect(
      mapCodexAppServerEvent(
        { method: "item/agentMessage/delta", params: { delta: "Hello" } },
        "thr-1",
      ),
    ).toEqual([{ type: "text_delta", delta: "Hello" }]);
  });

  test("empty agentMessage delta is ignored", () => {
    expect(
      mapCodexAppServerEvent(
        { method: "item/agentMessage/delta", params: { delta: "" } },
        "thr-1",
      ),
    ).toEqual([]);
  });

  test("commandExecution item/started maps to tool_use", () => {
    expect(
      mapCodexAppServerEvent(
        {
          method: "item/started",
          params: { item: { id: "cmd-1", type: "commandExecution", command: "ls -la" } },
        },
        "thr-1",
      ),
    ).toEqual([{
      type: "tool_use",
      toolName: "Bash",
      toolInput: { command: "ls -la" },
      toolUseId: "cmd-1",
    }]);
  });

  test("commandExecution item/completed maps to tool_result with exit code", () => {
    const result = mapCodexAppServerEvent(
      {
        method: "item/completed",
        params: {
          item: { id: "cmd-1", type: "commandExecution", aggregatedOutput: "file.txt\n", exitCode: 0 },
        },
      },
      "thr-1",
    );
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("tool_result");
    if (result[0].type === "tool_result") {
      expect(result[0].result).toContain("file.txt");
      expect(result[0].result).toContain("[exit code: 0]");
    }
  });

  test("turn/completed (success) maps to result with sessionId", () => {
    expect(
      mapCodexAppServerEvent(
        { method: "turn/completed", params: { turn: { status: "completed" } } },
        "thr-1",
      ),
    ).toEqual([{ type: "result", sessionId: "thr-1", success: true }]);
  });

  test("turn/completed (failed) maps to error", () => {
    expect(
      mapCodexAppServerEvent(
        {
          method: "turn/completed",
          params: { turn: { status: "failed", error: { message: "boom" } } },
        },
        "thr-1",
      ),
    ).toEqual([{ type: "error", error: "boom", code: "turn_failed" }]);
  });

  test("error notification reads the nested error.message (not generic Unknown error)", () => {
    // Codex's ErrorNotification carries the text under `error` (a TurnError).
    expect(
      mapCodexAppServerEvent(
        { method: "error", params: { error: { message: "usage limit reached" }, willRetry: false } },
        "thr-1",
      ),
    ).toEqual([{ type: "error", error: "usage limit reached", code: "codex_error" }]);
  });

  test("error notification falls back to Unknown error when no message present", () => {
    expect(
      mapCodexAppServerEvent({ method: "error", params: {} }, "thr-1"),
    ).toEqual([{ type: "error", error: "Unknown error", code: "codex_error" }]);
  });

  test("transient error (willRetry) is not surfaced — Codex retries and the turn continues", () => {
    expect(
      mapCodexAppServerEvent(
        { method: "error", params: { error: { message: "blip" }, willRetry: true } },
        "thr-1",
      ),
    ).toEqual([]);
  });

  test("process_exited maps to a provider error", () => {
    const result = mapCodexAppServerEvent({ method: "process_exited", params: {} }, "thr-1");
    expect(result[0].type).toBe("error");
    if (result[0].type === "error") expect(result[0].code).toBe("provider_error");
  });

  test("informational notifications are ignored", () => {
    expect(mapCodexAppServerEvent({ method: "turn/started", params: {} }, "thr-1")).toEqual([]);
    expect(mapCodexAppServerEvent({ method: "thread/started", params: {} }, "thr-1")).toEqual([]);
  });

  test("unknown notification passes through", () => {
    const result = mapCodexAppServerEvent({ method: "some/future/event", params: {} }, "thr-1");
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("unknown");
  });
});

describe("mapApprovalRequest", () => {
  test("command execution approval maps to a Bash permission_request", () => {
    const msg = mapApprovalRequest(
      "item/commandExecution/requestApproval",
      { command: "rm -rf build", cwd: "/repo", itemId: "item-1", reason: "needs write" },
      "42",
    );
    expect(msg.type).toBe("permission_request");
    expect(msg.requestId).toBe("42");
    expect(msg.toolName).toBe("Bash");
    expect(msg.toolInput).toEqual({ command: "rm -rf build", cwd: "/repo" });
    expect(msg.toolUseId).toBe("item-1");
    expect(msg.description).toBe("needs write");
  });

  test("file change approval maps to a FileChange permission_request", () => {
    const msg = mapApprovalRequest(
      "item/fileChange/requestApproval",
      { itemId: "item-2", reason: "edit src/foo.ts" },
      "43",
    );
    expect(msg.toolName).toBe("FileChange");
    expect(msg.title).toBe("edit src/foo.ts");
    expect(msg.requestId).toBe("43");
  });

  test("unknown approval method falls back to a generic permission_request", () => {
    const msg = mapApprovalRequest("item/something/requestApproval", { foo: 1 }, "44");
    expect(msg.type).toBe("permission_request");
    expect(msg.toolName).toBe("item/something/requestApproval");
    expect(msg.toolInput).toEqual({ foo: 1 });
  });
});

// ---------------------------------------------------------------------------
// Multi-provider capabilities
// ---------------------------------------------------------------------------

describe("Multi-provider endpoints", () => {
  test("capabilities lists both providers with correct capabilities", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const endpoints = createAIEndpoints({ registry: reg, sessionManager: sm });

    // Claude-like: full capabilities
    const claude = mockProvider("claude-agent-sdk");
    reg.register(claude, "claude");

    // Codex-like: no fork
    const codex: AIProvider = {
      ...mockProvider("codex-sdk"),
      capabilities: { fork: false, resume: true, streaming: true, tools: true },
    };
    reg.register(codex, "codex");

    const res = await endpoints["/api/ai/capabilities"](
      new Request("http://localhost/api/ai/capabilities")
    );
    const data = await res.json();

    expect(data.available).toBe(true);
    expect(data.providers.length).toBe(2);
    const ids = data.providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    // Default is first registered
    expect(data.defaultProvider).toBe("claude");
  });

  test("session creation with specific provider ID routes correctly", async () => {
    const reg = new ProviderRegistry();
    const sm = new SessionManager();
    const endpoints = createAIEndpoints({ registry: reg, sessionManager: sm });

    reg.register(mockProvider("claude-agent-sdk"), "claude");
    reg.register(mockProvider("codex-sdk"), "codex");

    // Create session with codex provider
    const res = await endpoints["/api/ai/session"](
      new Request("http://localhost/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: { mode: "code-review", review: { patch: "+x" } },
          providerId: "codex",
        }),
      })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessionId: string };
    expect(data.sessionId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildEffectivePrompt
// ---------------------------------------------------------------------------

import { buildEffectivePrompt } from "./context.ts";

describe("buildEffectivePrompt", () => {
  test("prepends preamble on first query", () => {
    const result = buildEffectivePrompt("What is this?", "System context here", false);
    expect(result).toBe("System context here\n\n---\n\nUser question: What is this?");
  });

  test("returns bare prompt on subsequent queries", () => {
    const result = buildEffectivePrompt("What is this?", "System context here", true);
    expect(result).toBe("What is this?");
  });

  test("returns bare prompt when preamble is null", () => {
    const result = buildEffectivePrompt("What is this?", null, false);
    expect(result).toBe("What is this?");
  });
});

// ---------------------------------------------------------------------------
// mapPiEvent
// ---------------------------------------------------------------------------

import { mapPiEvent } from "./providers/pi-sdk.ts";

describe("mapPiEvent", () => {
  const SESSION_ID = "pi-session-123";

  test("text_delta from message_update", () => {
    const result = mapPiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello", contentIndex: 0, partial: {} },
    }, SESSION_ID);
    expect(result).toEqual([{ type: "text_delta", delta: "Hello" }]);
  });

  test("toolcall_end from message_update", () => {
    const result = mapPiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "tc_1", name: "read", arguments: { path: "/foo" } },
        partial: {},
      },
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "tool_use",
      toolName: "read",
      toolInput: { path: "/foo" },
      toolUseId: "tc_1",
    }]);
  });

  test("tool_execution_end maps to tool_result", () => {
    const result = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "tc_1",
      toolName: "read",
      result: "file contents",
      isError: false,
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "tool_result",
      toolUseId: "tc_1",
      result: "file contents",
    }]);
  });

  test("tool_execution_end with error maps to tool_result with [Error] prefix", () => {
    const result = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "tc_1",
      toolName: "read",
      result: "not found",
      isError: true,
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "tool_result",
      toolUseId: "tc_1",
      result: "[Error] not found",
    }]);
  });

  test("agent_end maps to result", () => {
    const result = mapPiEvent({
      type: "agent_end",
      messages: [],
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "result",
      sessionId: SESSION_ID,
      success: true,
    }]);
  });

  test("process_exited maps to error", () => {
    const result = mapPiEvent({ type: "process_exited" }, SESSION_ID);
    expect(result).toEqual([{
      type: "error",
      error: "Pi process exited unexpectedly.",
      code: "pi_process_exit",
    }]);
  });

  test("ignored events return empty", () => {
    expect(mapPiEvent({ type: "agent_start" }, SESSION_ID)).toEqual([]);
    expect(mapPiEvent({ type: "turn_start" }, SESSION_ID)).toEqual([]);
    expect(mapPiEvent({ type: "turn_end", message: {}, toolResults: [] }, SESSION_ID)).toEqual([]);
    expect(mapPiEvent({ type: "message_start", message: {} }, SESSION_ID)).toEqual([]);
    expect(mapPiEvent({ type: "message_end", message: {} }, SESSION_ID)).toEqual([]);
    expect(mapPiEvent({ type: "tool_execution_start", toolCallId: "x", toolName: "y", args: {} }, SESSION_ID)).toEqual([]);
  });

  test("message_update with thinking events returns empty", () => {
    const result = mapPiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm", contentIndex: 0, partial: {} },
    }, SESSION_ID);
    expect(result).toEqual([]);
  });

  test("message_update with done returns empty", () => {
    const result = mapPiEvent({
      type: "message_update",
      assistantMessageEvent: { type: "done", reason: "stop", message: {} },
    }, SESSION_ID);
    expect(result).toEqual([]);
  });

  test("tool_execution_end with object result stringifies it", () => {
    const result = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "tc_2",
      toolName: "ls",
      result: { files: ["a.ts", "b.ts"] },
      isError: false,
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "tool_result",
      toolUseId: "tc_2",
      result: JSON.stringify({ files: ["a.ts", "b.ts"] }),
    }]);
  });
});

// ---------------------------------------------------------------------------
// OpenCode event mapping
// ---------------------------------------------------------------------------

import { mapOpenCodeEvent } from "./providers/opencode-sdk.ts";

describe("mapOpenCodeEvent", () => {
  const SESSION_ID = "oc_session_1";

  test("message.part.delta with text field maps to text_delta", () => {
    const result = mapOpenCodeEvent("message.part.delta", {
      sessionID: SESSION_ID,
      messageID: "msg_1",
      partID: "part_1",
      field: "text",
      delta: "Hello ",
    }, SESSION_ID);
    expect(result).toEqual([{ type: "text_delta", delta: "Hello " }]);
  });

  test("message.part.delta with non-text field returns empty", () => {
    const result = mapOpenCodeEvent("message.part.delta", {
      field: "reasoning",
      delta: "thinking...",
    }, SESSION_ID);
    expect(result).toEqual([]);
  });

  test("message.part.updated with running tool maps to tool_use", () => {
    const result = mapOpenCodeEvent("message.part.updated", {
      part: {
        id: "part_1",
        type: "tool",
        tool: "read",
        callID: "call_1",
        state: {
          status: "running",
          input: { path: "/foo.ts" },
          time: { start: 1000 },
        },
      },
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "tool_use",
      toolName: "read",
      toolInput: { path: "/foo.ts" },
      toolUseId: "call_1",
    }]);
  });

  test("message.part.updated with completed tool maps to tool_result", () => {
    const result = mapOpenCodeEvent("message.part.updated", {
      part: {
        id: "part_1",
        type: "tool",
        tool: "read",
        callID: "call_1",
        state: {
          status: "completed",
          output: "file contents here",
          time: { start: 1000, end: 1100 },
        },
      },
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "tool_result",
      toolUseId: "call_1",
      result: "file contents here",
    }]);
  });

  test("message.part.updated with error tool maps to tool_result with [Error] prefix", () => {
    const result = mapOpenCodeEvent("message.part.updated", {
      part: {
        id: "part_1",
        type: "tool",
        tool: "read",
        callID: "call_1",
        state: {
          status: "error",
          error: "file not found",
          time: { start: 1000, end: 1100 },
        },
      },
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "tool_result",
      toolUseId: "call_1",
      result: "[Error] file not found",
    }]);
  });

  test("permission.updated maps to permission_request", () => {
    const result = mapOpenCodeEvent("permission.updated", {
      id: "perm_1",
      type: "write_file",
      title: "Write to /src/foo.ts",
      callID: "call_2",
      sessionID: SESSION_ID,
      metadata: { path: "/src/foo.ts" },
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "permission_request",
      requestId: "perm_1",
      toolName: "write_file",
      toolInput: { path: "/src/foo.ts" },
      title: "Write to /src/foo.ts",
      toolUseId: "call_2",
    }]);
  });

  test("session.status idle maps to result", () => {
    const result = mapOpenCodeEvent("session.status", {
      sessionID: SESSION_ID,
      status: { type: "idle" },
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "result",
      sessionId: SESSION_ID,
      success: true,
    }]);
  });

  test("session.status busy returns empty", () => {
    const result = mapOpenCodeEvent("session.status", {
      sessionID: SESSION_ID,
      status: { type: "busy" },
    }, SESSION_ID);
    expect(result).toEqual([]);
  });

  test("message.updated with error maps to error", () => {
    const result = mapOpenCodeEvent("message.updated", {
      info: {
        id: "msg_1",
        sessionID: SESSION_ID,
        role: "assistant",
        error: {
          name: "ProviderAuthError",
          data: { message: "Invalid API key", providerID: "anthropic" },
        },
      },
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "error",
      error: "Invalid API key",
      code: "opencode_message_error",
    }]);
  });

  test("session.error maps to error", () => {
    const result = mapOpenCodeEvent("session.error", {
      sessionID: SESSION_ID,
      error: { message: "Something went wrong" },
    }, SESSION_ID);
    expect(result).toEqual([{
      type: "error",
      error: "Something went wrong",
      code: "opencode_session_error",
    }]);
  });

  test("ignored events return empty", () => {
    expect(mapOpenCodeEvent("session.created", { sessionID: SESSION_ID }, SESSION_ID)).toEqual([]);
    expect(mapOpenCodeEvent("session.updated", { sessionID: SESSION_ID }, SESSION_ID)).toEqual([]);
    expect(mapOpenCodeEvent("server.connected", {}, SESSION_ID)).toEqual([]);
    expect(mapOpenCodeEvent("file.edited", { file: "foo.ts" }, SESSION_ID)).toEqual([]);
  });
});
