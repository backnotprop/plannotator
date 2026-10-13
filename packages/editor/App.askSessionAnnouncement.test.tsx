import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const hasDom = typeof document !== "undefined";

const storageModule = hasDom ? await import("@plannotator/ui/utils/storage") : null;
const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;

const ASK_KEY = "plannotator-announce-ask-session-seen";
const TERMINAL_TOOLS_KEY = "plannotator-announce-tui-herdr-seen";
const LOOK_AND_FEEL_KEY = "plannotator-plan-look-choice-resolved";
const PERMISSION_MODE_KEY = "plannotator-permission-mode-configured";
const DIALOG = "[data-ask-session-announcement-dialog]";
const TERMINAL_TOOLS_DIALOG = "[data-terminal-tools-announcement-dialog]";

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
  readonly mode?: "archive";
  /** What /api/ai/capabilities answers. */
  readonly ai: "bridge" | "gone" | "providers" | "off";
}

function sessionBridge(host: string, status: "ready" | "gone") {
  return {
    id: "session-bridge",
    name: "session-bridge",
    label: "Ask this session",
    capabilities: {},
    models: [],
    sessionBridge: { host, status, modes: { turn: true, transient: false } },
  };
}
const SDK_PROVIDER = { id: "claude-agent-sdk", name: "claude-agent-sdk", capabilities: {}, models: [] };

let decisions: string[] = [];
/** When set, /api/ai/capabilities waits for it before answering. */
let capabilitiesGate: Promise<void> | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;

function stubFetch(session: Session): typeof fetch {
  return async (input) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") {
      return Response.json({
        plan: "# Session document\n\nA paragraph to review.",
        origin: session.origin,
        sharingEnabled: false,
        serverConfig: {},
        ...(session.mode === "archive"
          ? { mode: "archive", archivePlans: [{ filename: "saved.md", status: "approved", timestamp: "2026-07-31T00:00:00.000Z", title: "Session document" }] }
          : {}),
      });
    }
    if (url.pathname === "/api/archive/plans") return Response.json({ plans: [] });
    if (url.pathname === "/api/ai/capabilities") {
      if (capabilitiesGate) await capabilitiesGate;
      if (session.ai === "off") return Response.json({ available: false, providers: [] });
      const providers = session.ai === "bridge"
        ? [sessionBridge(session.origin, "ready")]
        : session.ai === "gone"
          ? [sessionBridge(session.origin, "gone")]
          : [SDK_PROVIDER];
      return Response.json({ available: true, providers, defaultProvider: null });
    }
    if (url.pathname === "/api/approve" || url.pathname === "/api/deny") {
      decisions.push(url.pathname);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
}

function useCompactTouchMedia(): void {
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: query.includes("max-width") || query.includes("pointer: coarse"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })) as typeof window.matchMedia;
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
  // Capabilities land after the plan; give them a few ticks.
  for (let attempt = 0; attempt < 10; attempt += 1) await settle();
}

async function unmountApp(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
}

function gotIt(selector: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`))
    .find((candidate) => candidate.textContent?.trim() === "Got it");
  if (!button) throw new Error("Dismiss action did not render");
  return button;
}

/** A browser that has already answered every earlier first-run dialog. */
function seedEarlierChainSeen(): void {
  memory.set(LOOK_AND_FEEL_KEY, "true");
  memory.set(PERMISSION_MODE_KEY, "true");
  memory.set(TERMINAL_TOOLS_KEY, "1");
}

describe.if(hasDom)("Ask this session announcement in the plan editor", () => {
  beforeEach(() => {
    memory.clear();
    decisions = [];
    capabilitiesGate = null;
    storageModule?.setStorageBackend(memoryBackend);
  });

  afterEach(async () => {
    await unmountApp();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    storageModule?.resetStorageBackend();
    memory.clear();
  });

  test("a connected Claude Code session sees it once, then never again", async () => {
    seedEarlierChainSeen();
    await mountApp({ origin: "claude-code", ai: "bridge" });

    expect(document.querySelector(DIALOG)?.getAttribute("data-ask-session-agent")).toBe("claude-code");
    expect(document.querySelector(`${DIALOG} [data-ask-session-status="connected"]`)).not.toBeNull();
    expect(memory.has(ASK_KEY)).toBe(false);

    await act(async () => gotIt(DIALOG).click());
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.get(ASK_KEY)).toBe("1");

    await unmountApp();
    await mountApp({ origin: "claude-code", ai: "bridge" });
    expect(document.querySelector(DIALOG)).toBeNull();
  });

  test("names the connected host", async () => {
    seedEarlierChainSeen();
    await mountApp({ origin: "pi", ai: "bridge" });
    expect(document.querySelector(DIALOG)?.getAttribute("data-ask-session-agent")).toBe("pi");
  });

  test("a session that is not connected never sees it and never spends it", async () => {
    // A Claude Code session without the bridge (mod off, remote, older CLI),
    // a bridge whose session is gone, and another host entirely.
    const sessions: Session[] = [
      { origin: "claude-code", ai: "providers" },
      { origin: "pi", ai: "gone" },
      { origin: "codex", ai: "providers" },
    ];
    for (const session of sessions) {
      seedEarlierChainSeen();
      await mountApp(session);
      expect(document.querySelector(DIALOG)).toBeNull();
      expect(memory.has(ASK_KEY)).toBe(false);
      await unmountApp();
    }
  });

  test("a reader who starts working before the session answers is not interrupted", async () => {
    seedEarlierChainSeen();
    let answerCapabilities: () => void = () => {};
    capabilitiesGate = new Promise<void>((resolve) => { answerCapabilities = resolve; });
    await mountApp({ origin: "claude-code", ai: "bridge" });
    expect(document.querySelector(DIALOG)).toBeNull();

    // The reader's first click, and only then the capabilities answer.
    await act(async () => { document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
    await act(async () => { answerCapabilities(); });
    for (let attempt = 0; attempt < 10; attempt += 1) await settle();

    expect(document.querySelector(DIALOG)).toBeNull();
    // Deferred, not spent: a later load may show it.
    expect(memory.has(ASK_KEY)).toBe(false);
  });

  test("with Ask AI turned off it waits for a session that has it", async () => {
    seedEarlierChainSeen();
    await mountApp({ origin: "claude-code", ai: "off" });

    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(ASK_KEY)).toBe(false);
  });

  test("follows the terminal-tools announcement on the next load, never the same one", async () => {
    memory.set(LOOK_AND_FEEL_KEY, "true");
    memory.set(PERMISSION_MODE_KEY, "true");
    await mountApp({ origin: "claude-code", ai: "bridge" });

    // The terminal-tools announcement owns this load.
    expect(document.querySelector(TERMINAL_TOOLS_DIALOG)).not.toBeNull();
    expect(document.querySelector(DIALOG)).toBeNull();

    await act(async () => gotIt(TERMINAL_TOOLS_DIALOG).click());
    await settle();
    // Not back to back on the same load.
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(ASK_KEY)).toBe(false);

    await unmountApp();
    await mountApp({ origin: "claude-code", ai: "bridge" });
    expect(document.querySelector(TERMINAL_TOOLS_DIALOG)).toBeNull();
    expect(document.querySelector(DIALOG)).not.toBeNull();
  });

  test("defers behind the look-and-feel chooser without spending the announcement", async () => {
    memory.set(TERMINAL_TOOLS_KEY, "1");
    memory.set(PERMISSION_MODE_KEY, "true");
    await mountApp({ origin: "claude-code", ai: "bridge" });

    expect(document.querySelector('[aria-labelledby="plan-look-choice-title"]')).not.toBeNull();
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(ASK_KEY)).toBe(false);
  });

  test("defers behind Claude Code's permission-mode setup without spending the announcement", async () => {
    memory.set(LOOK_AND_FEEL_KEY, "true");
    memory.set(TERMINAL_TOOLS_KEY, "1");
    await mountApp({ origin: "claude-code", ai: "bridge" });

    // The setup flow's heading (a structural landmark, not copy under test).
    expect(document.body.textContent).toContain("New: Permission Mode Preservation");
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(ASK_KEY)).toBe(false);
  });

  test("stays out of archive browsing and the compact touch shell", async () => {
    seedEarlierChainSeen();
    await mountApp({ origin: "claude-code", ai: "bridge", mode: "archive" });
    expect(document.querySelector(DIALOG)).toBeNull();
    await unmountApp();

    useCompactTouchMedia();
    await mountApp({ origin: "claude-code", ai: "bridge" });
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(ASK_KEY)).toBe(false);
  });

  test("Mod+Enter over the announcement does not decide the plan behind it", async () => {
    seedEarlierChainSeen();
    await mountApp({ origin: "claude-code", ai: "bridge" });
    expect(document.querySelector(DIALOG)).not.toBeNull();

    await act(async () => {
      gotIt(DIALOG).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
      gotIt(DIALOG).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    await settle();

    expect(decisions).toEqual([]);
    expect(document.querySelector(DIALOG)).not.toBeNull();
  });
});
