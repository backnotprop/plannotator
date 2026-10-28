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

const INBOX_KEY = "plannotator-announce-inbox-seen";
const ASK_KEY = "plannotator-announce-ask-session-seen";
const TERMINAL_TOOLS_KEY = "plannotator-announce-tui-herdr-seen";
const LOOK_AND_FEEL_KEY = "plannotator-plan-look-choice-resolved";
const PERMISSION_MODE_KEY = "plannotator-permission-mode-configured";
const DIALOG = "[data-inbox-announcement-dialog]";
const TERMINAL_TOOLS_DIALOG = "[data-terminal-tools-announcement-dialog]";
const ASK_DIALOG = "[data-ask-session-announcement-dialog]";

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
  readonly mode?: "annotate" | "archive";
  /** Answer capabilities with a connected "Ask this session" bridge. */
  readonly bridge?: boolean;
}

let decisions: string[] = [];
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
        origin: "claude-code",
        sharingEnabled: false,
        serverConfig: {},
        ...(session.mode === "annotate" ? { mode: "annotate", filePath: "/tmp/notes.md" } : {}),
        ...(session.mode === "archive"
          ? { mode: "archive", archivePlans: [{ filename: "saved.md", status: "approved", timestamp: "2026-07-31T00:00:00.000Z", title: "Session document" }] }
          : {}),
      });
    }
    if (url.pathname === "/api/archive/plans") return Response.json({ plans: [] });
    if (url.pathname === "/api/ai/capabilities") {
      if (!session.bridge) return Response.json({ available: false, providers: [] });
      return Response.json({
        available: true,
        providers: [{
          id: "session-bridge",
          name: "session-bridge",
          label: "Ask this session",
          capabilities: {},
          models: [],
          sessionBridge: { host: "claude-code", status: "ready", modes: { turn: true, transient: false } },
        }],
        defaultProvider: null,
      });
    }
    if (url.pathname === "/api/approve" || url.pathname === "/api/deny" || url.pathname === "/api/feedback") {
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

async function mountApp(session: Session = {}): Promise<void> {
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

/**
 * Booleans, not elements: a failed toBeNull() on a Base UI dialog element
 * crashes bun's diff printer instead of reporting the failure.
 */
function isOpen(selector: string): boolean {
  return document.querySelector(selector) !== null;
}

function closeButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`${DIALOG} [data-inbox-announcement-close]`);
  if (!button) throw new Error("Close action did not render");
  return button;
}

function gotIt(selector: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`))
    .find((candidate) => candidate.textContent?.trim() === "Got it");
  if (!button) throw new Error("Dismiss action did not render");
  return button;
}

/** A browser that has answered every dialog ahead of the Inbox announcement. */
function seedEarlierChainSeen(): void {
  memory.set(LOOK_AND_FEEL_KEY, "true");
  memory.set(PERMISSION_MODE_KEY, "true");
  memory.set(TERMINAL_TOOLS_KEY, "1");
}

describe.if(hasDom)("Plannotator Inbox announcement in the plan and annotate editor", () => {
  beforeEach(() => {
    memory.clear();
    decisions = [];
    storageModule?.setStorageBackend(memoryBackend);
  });

  afterEach(async () => {
    await unmountApp();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    delete (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE;
    storageModule?.resetStorageBackend();
    memory.clear();
  });

  test("an annotate session sees it once, then never again", async () => {
    seedEarlierChainSeen();
    await mountApp({ mode: "annotate" });

    expect(isOpen(DIALOG)).toBe(true);
    expect(memory.has(INBOX_KEY)).toBe(false);
    const link = document.querySelector<HTMLAnchorElement>(`${DIALOG} a[data-inbox-announcement-learn-more]`);
    expect(link?.getAttribute("href")).toBe("https://plannotator.ai/inbox");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");

    await act(async () => closeButton().click());
    await settle();
    expect(isOpen(DIALOG)).toBe(false);
    expect(memory.get(INBOX_KEY)).toBe("1");

    await unmountApp();
    await mountApp({ mode: "annotate" });
    expect(isOpen(DIALOG)).toBe(false);
  });

  test("Escape closes it and Mod+Enter cannot approve the plan behind it", async () => {
    seedEarlierChainSeen();
    await mountApp();
    expect(isOpen(DIALOG)).toBe(true);

    await act(async () => {
      closeButton().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    await settle();
    expect(decisions).toHaveLength(0);
    expect(isOpen(DIALOG)).toBe(true);

    await act(async () => {
      closeButton().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(isOpen(DIALOG)).toBe(false);
    expect(memory.get(INBOX_KEY)).toBe("1");
    expect(decisions).toHaveLength(0);
  });

  test("never shows in the VS Code webview, and keeps the announcement for a browser", async () => {
    seedEarlierChainSeen();
    (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE = true;
    await mountApp({ mode: "annotate" });

    expect(document.body.textContent).toContain("Session document");
    expect(isOpen(DIALOG)).toBe(false);
    expect(memory.has(INBOX_KEY)).toBe(false);
  });

  test("stays out of archive browsing and keeps the announcement for later", async () => {
    seedEarlierChainSeen();
    await mountApp({ mode: "archive" });

    expect(isOpen(DIALOG)).toBe(false);
    expect(memory.has(INBOX_KEY)).toBe(false);
  });

  test("follows the terminal-tools announcement on the next load, never the same one", async () => {
    memory.set(LOOK_AND_FEEL_KEY, "true");
    memory.set(PERMISSION_MODE_KEY, "true");
    await mountApp({ mode: "annotate" });

    expect(isOpen(TERMINAL_TOOLS_DIALOG)).toBe(true);
    expect(isOpen(DIALOG)).toBe(false);

    await act(async () => gotIt(TERMINAL_TOOLS_DIALOG).click());
    await settle();
    expect(isOpen(DIALOG)).toBe(false);
    expect(memory.has(INBOX_KEY)).toBe(false);

    await unmountApp();
    await mountApp({ mode: "annotate" });
    expect(isOpen(TERMINAL_TOOLS_DIALOG)).toBe(false);
    expect(isOpen(DIALOG)).toBe(true);
  });

  test("Ask this session waits behind it for a later load", async () => {
    seedEarlierChainSeen();
    await mountApp({ bridge: true });

    expect(isOpen(DIALOG)).toBe(true);
    expect(isOpen(ASK_DIALOG)).toBe(false);

    await act(async () => closeButton().click());
    await settle();
    expect(isOpen(ASK_DIALOG)).toBe(false);
    expect(memory.has(ASK_KEY)).toBe(false);

    await unmountApp();
    await mountApp({ bridge: true });
    expect(isOpen(DIALOG)).toBe(false);
    expect(isOpen(ASK_DIALOG)).toBe(true);
  });

  test("shows on the compact touch shell", async () => {
    seedEarlierChainSeen();
    useCompactTouchMedia();
    await mountApp({ mode: "annotate" });

    expect(isOpen(DIALOG)).toBe(true);
  });
});
