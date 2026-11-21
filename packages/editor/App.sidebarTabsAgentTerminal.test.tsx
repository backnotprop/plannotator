/**
 * The collapsed sidebar tabs stay beside the annotate Agent TUI (DOM-gated).
 *
 * What regresses if this fails: opening the Agent TUI docked left hides the
 * left rail (the agent toggle, Contents, Files), so the reviewer loses the
 * one-click way back to those panels and to closing the terminal; or the rail
 * stays but sits under the terminal at the window's left edge instead of at
 * the terminal's edge; or the document stops reserving the rail's 30px and
 * the rail covers the first column of text.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";

const hasDom = typeof document !== "undefined";

if (hasDom) {
  document.cookie = "plannotator-look-feel-announcement-seen=2; path=/";
  document.cookie = "plannotator-announce-tui-herdr-seen=1; path=/";
  document.cookie = "plannotator-announce-inbox-seen=1; path=/";
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;
const originalInnerWidth = hasDom ? window.innerWidth : 0;
const originalUrl = hasDom ? window.location.href : "";
const originalWebSocket = globalThis.WebSocket;

/** Never connects: the panel may spawn its agent when it opens. */
class InertWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly readyState = 0;
  binaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly url: string) {
    super();
  }
  send(): void {}
  close(): void {}
}

/** The panel builds its WebSocket URL from the page URL, which is about:blank here. */
function setPageUrl(url: string): void {
  (window as unknown as { happyDOM?: { setURL(url: string): void } }).happyDOM?.setURL(url);
}

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

/** A wide desktop window with a fine pointer: no media query matches. */
function desktopMatchMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
}

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
  constructor(url: string | URL) {
    this.url = String(url);
  }
  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

function annotatePlan(serverConfig: Record<string, unknown>) {
  return {
    plan: "# Notes\n\nA paragraph to annotate.\n",
    origin: "claude-code",
    mode: "annotate",
    filePath: "/tmp/notes.md",
    sharingEnabled: false,
    serverConfig,
    agentTerminal: {
      enabled: true,
      cwd: "/tmp",
      wsPath: "/api/agent-terminal/pty/test-token",
      agents: [{ id: "claude", name: "Claude Code", available: true }],
    },
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const rail = () => document.querySelector<HTMLElement>('[data-sidebar-tabs="true"]');
const agentTab = () => rail()?.querySelector<HTMLButtonElement>('button[aria-pressed]') ?? null;
/** The z-index a Tailwind `z-N` / `z-[N]` class gives, or 0. */
function zIndexOf(element: Element | null | undefined): number {
  const match = element?.className.toString().match(/(?:^|\s)z-\[?(\d+)\]?(?:\s|$)/);
  return match ? Number(match[1]) : 0;
}
/** The left-docked terminal's resize handle: the box around its hover track. */
const terminalResizeHandle = () => document.querySelector('[data-resize-track="left"]')?.parentElement ?? null;
const documentArea = () => document.querySelector<HTMLElement>('main[data-print-region="document"]');

async function mount(serverConfig: Record<string, unknown> = {}): Promise<void> {
  setStorageBackend(memoryBackend);
  for (const key of [
    "plannotator-look-feel-announcement-seen",
    "plannotator-announce-tui-herdr-seen",
    "plannotator-announce-inbox-seen",
    "plannotator-vim-mode-announcement-seen",
    "plannotator-plan-ai-announcement-seen",
  ]) memory.set(key, key.includes("look-feel") || key.includes("vim") ? "2" : "1");
  window.matchMedia = desktopMatchMedia;
  setPageUrl("http://plannotator.invalid/");
  // SAFETY: the panel only constructs the socket and assigns its handlers.
  globalThis.WebSocket = InertWebSocket as unknown as typeof WebSocket;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const plan = annotatePlan(serverConfig);
  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
    if (url.pathname === "/api/plan") return Response.json(plan);
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname.startsWith("/api/draft")) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  }) as typeof fetch;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  const collapse = () => document.querySelector<HTMLButtonElement>('button[title="Collapse sidebar"]');
  for (let attempt = 0; attempt < 30 && !agentTab() && !collapse(); attempt += 1) await settle();
  // The left sidebar opens on load; the rail shows once it is collapsed.
  if (!agentTab() && collapse()) await act(async () => collapse()!.click());
  for (let attempt = 0; attempt < 10 && !agentTab(); attempt += 1) await settle();
  if (!agentTab()) throw new Error("the sidebar rail with the Agent toggle did not render");
}

async function openTerminal(): Promise<void> {
  await act(async () => agentTab()!.click());
  for (let attempt = 0; attempt < 10 && agentTab()?.getAttribute("aria-pressed") !== "true"; attempt += 1) {
    await settle();
  }
  expect(agentTab()?.getAttribute("aria-pressed")).toBe("true");
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  memory.clear();
  resetStorageBackend();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  if (hasDom) Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  if (hasDom) setPageUrl(originalUrl);
  globalThis.WebSocket = originalWebSocket;
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("sidebar tabs beside the Agent TUI", () => {
  test("docked left: the rail stays, at the terminal's edge, and the document keeps its inset", async () => {
    await mount();
    expect(rail()!.style.left).toBe("");
    expect(documentArea()?.className).toContain("lg:pl-[30px]");

    await openTerminal();

    expect(rail()).not.toBeNull();
    expect(rail()!.style.left).toContain("--agent-terminal-w");
    // 2px off the terminal's edge, and above its resize handle, whose grab
    // zone reaches 8px past the edge and would otherwise cover the buttons.
    expect(rail()!.style.left).toContain("+ 2px");
    const handle = terminalResizeHandle();
    expect(handle).not.toBeNull();
    expect(zIndexOf(rail())).toBeGreaterThan(zIndexOf(handle));
    expect(documentArea()?.className).toContain("lg:pl-[30px]");

    // The rail's own toggle closes the terminal again.
    await act(async () => agentTab()!.click());
    await settle();
    expect(agentTab()?.getAttribute("aria-pressed")).toBe("false");
    expect(rail()!.style.left).toBe("");
  });

  test("docked right: the rail stays at the window's left edge", async () => {
    await mount({ agentTerminalSide: "right" });
    await openTerminal();

    expect(rail()).not.toBeNull();
    expect(rail()!.style.left).toBe("");
    expect(documentArea()?.className).toContain("lg:pl-[30px]");
  });

  test("an open sidebar replaces the rail and the document drops the inset", async () => {
    await mount();
    await openTerminal();
    const contents = rail()!.querySelector<HTMLButtonElement>('button[title="Table of Contents"]');
    expect(contents).not.toBeNull();
    await act(async () => contents!.click());
    await settle();

    expect(rail()).toBeNull();
    expect(documentArea()?.className).not.toContain("lg:pl-[30px]");
  });
});
