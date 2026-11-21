/**
 * The `plannotator` agent tool switch in the plan editor (plan review and
 * annotate), DOM_TESTS=1: the one-time "turn it on" offer and the Settings
 * row, both driven by the server's serverConfig.
 *
 * Regressions each test guards:
 *  - The offer shows only where turning the tool on means something here: a
 *    Pi / OpenCode 2 host whose tool is off for the next session, never
 *    chosen, and not decided by PLANNOTATOR_AGENT_TOOL. Claude Code (on by
 *    default), a server that reports no tool host (OpenCode 1, Codex, an
 *    older server) and an env override never see it.
 *  - "Yes, turn it on" posts `{ agentTool: true }` and only then retires the
 *    offer; a failed save shows the reason and leaves it pending.
 *  - It never shares a load with the "Ask this session" announcement, but a
 *    reader whose session is never connected still gets it.
 *  - Settings shows the switch in plan review and annotate, locked under an
 *    env override, and not at all without a tool host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const hasDom = typeof document !== "undefined";

const storageModule = hasDom ? await import("@plannotator/ui/utils/storage") : null;
const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const AGENT_TOOL_KEY = "plannotator-announce-agent-tool-seen";
const ASK_KEY = "plannotator-announce-ask-session-seen";
const DIALOG = "[data-agent-tool-announcement-dialog]";
const ASK_DIALOG = "[data-ask-session-announcement-dialog]";
const SETTING_ROW = "[data-agent-tool-setting]";

const memory = new Map<string, string>();
const memoryBackend = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
};

class SilentEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = SilentEventSource.OPEN;
  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  constructor(url: string | URL) { this.url = String(url); }
  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

interface Session {
  readonly origin: string;
  /** The agentTool* fields of serverConfig (absent: the server reports no tool host). */
  readonly agentTool?: Record<string, unknown>;
  readonly mode?: "annotate";
  /** Answer /api/ai/capabilities with a connected "Ask this session" bridge. */
  readonly bridge?: boolean;
  /** Status POST /api/config answers. */
  readonly configStatus?: number;
}

/** What #1724's getServerConfig sends for a host whose tool is off by default and unset. */
function offByDefault(host: "pi" | "opencode"): Record<string, unknown> {
  return { agentTool: false, agentToolConfigured: false, agentToolHost: host, agentToolEnabled: false };
}

let configPosts: unknown[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;

function stubFetch(session: Session): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") {
      return Response.json({
        plan: "# Session document\n\nA paragraph to review.",
        origin: session.origin,
        sharingEnabled: false,
        serverConfig: { ...(session.agentTool ?? {}) },
        ...(session.mode === "annotate" ? { mode: "annotate", filePath: "/repo/notes.md" } : {}),
      });
    }
    if (url.pathname === "/api/config" && init?.method === "POST") {
      configPosts.push(JSON.parse(String(init.body)));
      const status = session.configStatus ?? 200;
      return status === 200
        ? Response.json({ ok: true })
        : Response.json({ error: "Could not save the setting to config.json." }, { status });
    }
    if (url.pathname === "/api/ai/capabilities") {
      const providers = session.bridge
        ? [{
            id: "session-bridge",
            name: "session-bridge",
            label: "Ask this session",
            capabilities: {},
            models: [],
            sessionBridge: { host: session.origin, status: "ready", modes: { turn: true, transient: false } },
          }]
        : [{ id: "claude-agent-sdk", name: "claude-agent-sdk", capabilities: {}, models: [] }];
      return Response.json({ available: true, providers, defaultProvider: null });
    }
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  }) as typeof fetch;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mountApp(session: Session): Promise<void> {
  globalThis.fetch = stubFetch(session);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 20 && !document.body.textContent?.includes("Session document"); attempt += 1) {
    await settle();
  }
  for (let attempt = 0; attempt < 10; attempt += 1) await settle();
}

async function unmountApp(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
}

function buttonIn(selector: string, label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`"${label}" did not render`);
  return button;
}

/** A browser that has answered every earlier first-run dialog, Ask this session included. */
function seedEarlierChainSeen({ askSession = true } = {}): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-permission-mode-configured", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  if (askSession) memory.set(ASK_KEY, "1");
}

async function openSettings(): Promise<void> {
  const options = document.querySelector<HTMLButtonElement>('button[aria-label="Options"]');
  if (!options) throw new Error("Options menu did not render");
  await act(async () => options.click());
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === "Settings");
  if (!item) throw new Error("Settings item did not render");
  await act(async () => item.click());
  await settle();
}

function settingSwitch(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`${SETTING_ROW} button[role="switch"]`);
}

describe.if(hasDom)("agent tool offer in the plan editor", () => {
  beforeEach(() => {
    memory.clear();
    configPosts = [];
    storageModule?.setStorageBackend(memoryBackend);
  });

  afterEach(async () => {
    await unmountApp();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    storageModule?.resetStorageBackend();
    memory.clear();
  });

  test("Pi with the tool off: Turn it on saves the setting, reports it, and retires the offer", async () => {
    seedEarlierChainSeen();
    await mountApp({ origin: "pi", agentTool: offByDefault("pi") });

    expect(document.querySelector(DIALOG)?.getAttribute("data-agent-tool-host")).toBe("pi");
    expect(memory.has(AGENT_TOOL_KEY)).toBe(false);

    await act(async () => buttonIn(DIALOG, "Yes, turn it on").click());
    await settle();

    expect(configPosts).toEqual([{ agentTool: true }]);
    expect(document.querySelector(`${DIALOG} [data-agent-tool-status="saved"]`)).not.toBeNull();
    expect(memory.get(AGENT_TOOL_KEY)).toBe("1");

    await act(async () => buttonIn(DIALOG, "Done").click());
    expect(document.querySelector(DIALOG)).toBeNull();

    // The Settings row already reads the new value.
    await openSettings();
    expect(settingSwitch()?.getAttribute("aria-checked")).toBe("true");
  });

  test("Declining retires it without writing anything", async () => {
    seedEarlierChainSeen();
    await mountApp({ origin: "opencode", agentTool: offByDefault("opencode") });
    expect(document.querySelector(DIALOG)?.getAttribute("data-agent-tool-host")).toBe("opencode");

    await act(async () => buttonIn(DIALOG, "No, I’ll just use slash commands").click());
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.get(AGENT_TOOL_KEY)).toBe("1");
    expect(configPosts).toEqual([]);

    await unmountApp();
    await mountApp({ origin: "opencode", agentTool: offByDefault("opencode") });
    expect(document.querySelector(DIALOG)).toBeNull();
  });

  test("a failed save shows the reason and leaves the offer pending", async () => {
    seedEarlierChainSeen();
    await mountApp({ origin: "pi", agentTool: offByDefault("pi"), configStatus: 500 });

    await act(async () => buttonIn(DIALOG, "Yes, turn it on").click());
    await settle();

    expect(document.querySelector(`${DIALOG} [data-agent-tool-status="failed"]`)?.textContent)
      .toContain("config.json");
    expect(buttonIn(DIALOG, "Try again")).toBeDefined();
    expect(memory.has(AGENT_TOOL_KEY)).toBe(false);
  });

  test("never shown where turning it on is not the reader's to do here", async () => {
    const sessions: Session[] = [
      // Claude Code: on by default.
      { origin: "claude-code", agentTool: { agentTool: true, agentToolConfigured: false, agentToolHost: "claude-code", agentToolEnabled: true } },
      // Oh My Pi (the Pi extension inside OMP): on by default, nothing to offer.
      { origin: "pi", agentTool: { agentTool: true, agentToolConfigured: false, agentToolHost: "oh-my-pi", agentToolEnabled: true } },
      // No tool host reported: OpenCode 1, Codex, a server older than the switch.
      { origin: "opencode" },
      { origin: "codex" },
      // PLANNOTATOR_AGENT_TOOL decides it.
      { origin: "pi", agentTool: { ...offByDefault("pi"), agentToolEnv: false } },
      // Already on for the next session, or turned off on purpose.
      { origin: "pi", agentTool: { agentTool: true, agentToolConfigured: true, agentToolHost: "pi", agentToolEnabled: true } },
      { origin: "pi", agentTool: { agentTool: false, agentToolConfigured: true, agentToolHost: "pi", agentToolEnabled: false } },
    ];
    for (const session of sessions) {
      seedEarlierChainSeen();
      await mountApp(session);
      expect(document.querySelector(DIALOG)).toBeNull();
      expect(memory.has(AGENT_TOOL_KEY)).toBe(false);
      await unmountApp();
    }
  });

  test("a connected session gets Ask this session first and the offer on a later load", async () => {
    seedEarlierChainSeen({ askSession: false });
    await mountApp({ origin: "pi", agentTool: offByDefault("pi"), bridge: true });
    expect(document.querySelector(ASK_DIALOG)).not.toBeNull();
    expect(document.querySelector(DIALOG)).toBeNull();

    await act(async () => buttonIn(ASK_DIALOG, "Got it").click());
    await settle();
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(AGENT_TOOL_KEY)).toBe(false);

    await unmountApp();
    await mountApp({ origin: "pi", agentTool: offByDefault("pi"), bridge: true });
    expect(document.querySelector(DIALOG)).not.toBeNull();
  });

  test("a session that is never connected still gets the offer", async () => {
    seedEarlierChainSeen({ askSession: false });
    await mountApp({ origin: "pi", agentTool: offByDefault("pi"), bridge: false });
    expect(document.querySelector(ASK_DIALOG)).toBeNull();
    expect(document.querySelector(DIALOG)).not.toBeNull();
  });

  test("Mod+Enter over the offer does not reach the plan behind it", async () => {
    seedEarlierChainSeen();
    await mountApp({ origin: "pi", agentTool: offByDefault("pi") });
    const notNow = buttonIn(DIALOG, "No, I’ll just use slash commands");
    const reached: string[] = [];
    const listener = (event: KeyboardEvent) => { if (event.key === "Enter") reached.push("window"); };
    window.addEventListener("keydown", listener);
    try {
      await act(async () => {
        notNow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
      });
    } finally {
      window.removeEventListener("keydown", listener);
    }
    expect(reached).toEqual([]);
    expect(document.querySelector(DIALOG)).not.toBeNull();
  });
});

describe.if(hasDom)("agent tool switch in plan and annotate Settings", () => {
  beforeEach(() => {
    memory.clear();
    configPosts = [];
    storageModule?.setStorageBackend(memoryBackend);
    // Every first-run dialog retired, the offer included, so Settings is reachable.
    seedEarlierChainSeen();
    memory.set(AGENT_TOOL_KEY, "1");
  });

  afterEach(async () => {
    await unmountApp();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    storageModule?.resetStorageBackend();
    memory.clear();
  });

  for (const mode of [undefined, "annotate"] as const) {
    const surface = mode ?? "plan";
    test(`${surface}: the switch reads and writes the next session's value`, async () => {
      await mountApp({
        origin: "claude-code",
        mode,
        agentTool: { agentTool: true, agentToolConfigured: false, agentToolHost: "claude-code", agentToolEnabled: true },
      });
      await openSettings();
      const toggle = settingSwitch();
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
      expect(toggle?.disabled).toBe(false);

      await act(async () => toggle?.click());
      await settle();
      expect(configPosts).toEqual([{ agentTool: false }]);
      expect(settingSwitch()?.getAttribute("aria-checked")).toBe("false");
    });

    test(`${surface}: locked under PLANNOTATOR_AGENT_TOOL`, async () => {
      await mountApp({ origin: "pi", mode, agentTool: { ...offByDefault("pi"), agentToolEnv: true, agentToolEnabled: true } });
      await openSettings();
      const toggle = settingSwitch();
      expect(toggle?.disabled).toBe(true);
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
      expect(document.querySelector(SETTING_ROW)?.textContent).toContain("PLANNOTATOR_AGENT_TOOL");
    });

    test(`${surface}: absent where the server reports no tool host`, async () => {
      await mountApp({ origin: "opencode", mode });
      await openSettings();
      // Settings itself is open (its tab list rendered), only this row is missing.
      expect(document.querySelectorAll("nav.hidden button").length).toBeGreaterThan(0);
      expect(document.querySelector(SETTING_ROW)).toBeNull();
    });
  }
});
