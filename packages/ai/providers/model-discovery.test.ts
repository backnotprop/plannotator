import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLAUDE_FALLBACK_MODELS } from "@plannotator/core/model-catalog";
import { ClaudeAgentSDKProvider } from "./claude-agent-sdk.ts";
import { CodexAppServerProvider, codexCatalogFromModelList } from "./codex-app-server.ts";
import { createDeferredModelDiscovery } from "../endpoints.ts";

describe("codexCatalogFromModelList", () => {
  // Shape of codex-cli 0.154 `model/list` entries (trimmed to the read fields).
  const list = [
    {
      id: "gpt-6-astra",
      displayName: "GPT-6-Astra",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
      additionalSpeedTiers: ["fast"],
    },
    {
      id: "gpt-slow",
      displayName: "GPT Slow",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      additionalSpeedTiers: [],
    },
    { id: "gpt-hidden", displayName: "Hidden", hidden: true },
  ];

  test("maps default, efforts and fast-tier support; drops hidden models", () => {
    const catalog = codexCatalogFromModelList(list);
    expect(catalog.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-slow"]);
    expect(catalog[0]).toMatchObject({ label: "GPT-6-Astra", default: true, defaultReasoningEffort: "medium", fastMode: true });
    expect(catalog[0].reasoningEfforts?.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(catalog[1].default).toBeUndefined();
    expect(catalog[1].fastMode).toBeUndefined();
  });

  test("fast mode is also read from serviceTiers (the replacement for additionalSpeedTiers)", () => {
    // Codex's ModelPreset::supports_fast_mode: a service tier whose id is the
    // fast tier's request value ("priority") or its "fast" alias.
    const tier = (id: string) => ({ id, name: id, description: "" });
    const catalog = codexCatalogFromModelList([
      { id: "a", serviceTiers: [tier("priority")] },
      { id: "b", serviceTiers: [tier("fast")] },
      { id: "c", serviceTiers: [tier("flex")], additionalSpeedTiers: [] },
    ]);
    expect(catalog.map((m) => m.fastMode ?? false)).toEqual([true, true, false]);
  });
});

describe("tool version capture during discovery", () => {
  // Fake CLIs: each reports a version but cannot list models, so the version
  // must survive a failed discovery (it is what explains a fallback list).
  const fakeCli = (name: string, body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-fake-cli-"));
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  test.skipIf(process.platform === "win32")("claude: `--version` is read even when discovery fails", async () => {
    const cli = fakeCli("claude", '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.999 (Claude Code)"; exit 0; fi\nexit 1\n');
    try {
      const provider = new ClaudeAgentSDKProvider({ type: "claude-agent-sdk", claudeExecutablePath: cli.path });
      expect(provider.toolVersion).toBeUndefined();
      await expect(provider.fetchModels()).rejects.toThrow();
      expect(provider.modelsSource).toBe("fallback");
      expect(provider.toolVersion).toBe("2.1.999");
    } finally {
      cli.cleanup();
    }
  }, 15_000);

  test.skipIf(process.platform === "win32")("codex: the initialize userAgent carries the version even when model/list fails", async () => {
    const cli = fakeCli(
      "codex",
      `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    const reply = msg.method === "initialize"
      ? { id: msg.id, result: { userAgent: "plannotator/0.150.0 (Linux; x86_64)" } }
      : { id: msg.id, error: { code: -1, message: "not signed in" } };
    process.stdout.write(JSON.stringify(reply) + "\\n");
  }
});
`,
    );
    try {
      const provider = new CodexAppServerProvider({ type: "codex-sdk", codexExecutablePath: cli.path });
      await expect(provider.fetchModels()).rejects.toThrow();
      expect(provider.modelsSource).toBe("fallback");
      expect(provider.toolVersion).toBe("0.150.0");
    } finally {
      cli.cleanup();
    }
  }, 15_000);

  test.skipIf(process.platform === "win32")("codex: the version is not published while model/list is still pending", async () => {
    // Publishing it early would pair the version with the still-fallback list,
    // and the picker would claim "Using the built-in list" for a discovery
    // that is about to succeed.
    const cli = fakeCli(
      "codex",
      `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    const send = (r) => process.stdout.write(JSON.stringify({ id: msg.id, result: r }) + "\\n");
    if (msg.method === "initialize") send({ userAgent: "plannotator/0.155.1 (Linux)" });
    else setTimeout(() => send({ data: [{ id: "gpt-6-sol", displayName: "GPT-6-Sol", isDefault: true }] }), 600);
  }
});
`,
    );
    try {
      const provider = new CodexAppServerProvider({ type: "codex-sdk", codexExecutablePath: cli.path });
      const discovery = provider.fetchModels();
      await new Promise((r) => setTimeout(r, 350));
      expect(provider.modelsSource).toBe("fallback");
      expect(provider.toolVersion).toBeUndefined();
      await discovery;
      expect(provider.modelsSource).toBe("discovered");
      expect(provider.toolVersion).toBe("0.155.1");
    } finally {
      cli.cleanup();
    }
  }, 15_000);
});

describe("Claude model discovery", () => {
  test("a claude that cannot start leaves the fallback in place and reports the failure", async () => {
    const provider = new ClaudeAgentSDKProvider({
      type: "claude-agent-sdk",
      cwd: process.cwd(),
      claudeExecutablePath: resolve(import.meta.dir, "does-not-exist", "claude"),
    });
    // Rejecting (rather than swallowing) is what lets the runtime's
    // once-wrapper retry discovery later instead of pinning the fallback.
    await expect(provider.fetchModels()).rejects.toThrow();
    expect(provider.models).toBe(CLAUDE_FALLBACK_MODELS);
  }, 15_000);

  // Discovery spawns `claude`, so neither runtime may run it at startup — only
  // behind the deferred initializer (?activate= from a picker, or a session).
  for (const relPath of ["packages/server/ai-runtime.ts", "apps/pi-extension/server/ai-runtime.ts"]) {
    test(`${relPath} defers Claude model discovery`, () => {
      const src = readFileSync(resolve(import.meta.dir, "../../..", relPath), "utf8");
      const start = src.indexOf('"claude-agent-sdk"');
      const end = src.indexOf("Claude SDK not available", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const block = src.slice(start, end);
      // Claude sessions never wait on discovery (fix: first Ask AI answer
      // blocked ~2-10s); both runtimes must register it that way.
      expect(block).toContain("deferModelDiscovery(providerId, provider, { blockSession: false })");
      expect(block).not.toContain("modelDiscovery.push");
    });
  }
});

describe("createDeferredModelDiscovery", () => {
  const hanging = () => {
    let calls = 0;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const provider = {
      models: CLAUDE_FALLBACK_MODELS,
      modelsSource: "fallback" as const,
      fetchModels: () => { calls++; return done; },
    };
    return { provider, finish, calls: () => calls };
  };
  const settledWithin = async (p: Promise<void>, ms = 50) =>
    Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  test("a non-blocking provider's session starts without waiting, while discovery runs in the background", async () => {
    const d = createDeferredModelDiscovery();
    const claude = hanging();
    d.defer("claude-agent-sdk", claude.provider, { blockSession: false });
    expect(await settledWithin(d.beforeProviderSession("claude-agent-sdk", "session"))).toBe(true);
    expect(claude.calls()).toBe(1);
    // An explicit ?activate= probe still waits: it reports the refreshed list.
    const activate = d.beforeProviderSession("claude-agent-sdk", "activate");
    expect(await settledWithin(activate)).toBe(false);
    claude.finish();
    expect(await settledWithin(activate)).toBe(true);
    expect(claude.calls()).toBe(1);
  });

  test("before discovery lands, a pick the fallback offers starts at once", async () => {
    const d = createDeferredModelDiscovery();
    const claude = hanging();
    d.defer("claude-agent-sdk", claude.provider, { blockSession: false });
    for (const pick of ["opus", "sonnet", "", undefined]) {
      expect(await settledWithin(d.beforeProviderSession("claude-agent-sdk", "session", pick))).toBe(true);
    }
  });

  test("before discovery lands, a pick only the tool offers waits for it (never resolved onto the fallback)", async () => {
    // opus[1m] is not in the fallback: resolving now would run the first
    // session on `opus` (another context window and billing) and later ones
    // on opus[1m].
    const d = createDeferredModelDiscovery();
    const claude = hanging();
    d.defer("claude-agent-sdk", claude.provider, { blockSession: false });
    const session = d.beforeProviderSession("claude-agent-sdk", "session", "opus[1m]");
    expect(await settledWithin(session)).toBe(false);
    claude.finish();
    expect(await settledWithin(session)).toBe(true);
  });

  test("a blocking provider's session waits for discovery", async () => {
    const d = createDeferredModelDiscovery();
    const codex = hanging();
    d.defer("codex-sdk", codex.provider);
    const session = d.beforeProviderSession("codex-sdk", "session");
    expect(await settledWithin(session)).toBe(false);
    codex.finish();
    expect(await settledWithin(session)).toBe(true);
  });
});
