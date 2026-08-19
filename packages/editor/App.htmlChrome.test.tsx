/**
 * HTML-surface chrome contract (DOM-gated).
 *
 * The header "Hide tools" eye toggle (left of the pen) removes ALL floating
 * chrome over the page from the DOM: the sidebar tongue tabs and the
 * comment/attachments cluster, with no residual artifact. The toggle itself
 * lives in the header, so a hidden state (including one restored from an old
 * cookie) always has a way back. Sidebar/panel halves of the persisted state
 * round-trip; the pen reports the armed-by-default Interact/Annotate state.
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
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const RAW_HTML = "<h1>Rendered page</h1><p>Body copy.</p>";

// In-memory storage backend (the codebase-standard persistence-test pattern):
// keeps values across mounts within a test, so a remount simulates the next
// session with the same cookies.
const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function seedAnnouncementsSeen(): void {
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
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

let root: Root | null = null;
let host: HTMLElement | null = null;

const htmlAnnotatePlan = {
  plan: "",
  origin: "codex",
  mode: "annotate",
  filePath: "/tmp/page.html",
  renderAs: "html",
  rawHtml: RAW_HTML,
  sharingEnabled: false,
  serverConfig: {},
};

const annotateFetch: typeof fetch = async (input) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });

  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === "/api/plan") return Response.json(htmlAnnotatePlan);
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({});
};

function findButtonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);
}

function penToggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-html-annotate-toggle]");
}

function toolsToggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-html-tools-toggle]");
}

function floatingCluster(): HTMLElement | null {
  // The full-viewport comment/attachments cluster over the page.
  return document.querySelector<HTMLElement>('[data-print-hide].absolute.top-3.right-3');
}

function sidebarTabs(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-sidebar-tabs="true"]');
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountHtmlAnnotate(): Promise<void> {
  globalThis.fetch = annotateFetch;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close;
  // this test double implements those browser-facing members without I/O.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 20 && !penToggle(); attempt += 1) {
    await settle();
  }
  if (!penToggle()) throw new Error("HTML surface did not finish mounting (pen toggle missing)");
}

async function unmountHtmlAnnotate(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

afterEach(async () => {
  await unmountHtmlAnnotate();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("HTML annotate chrome (tools toggle + pen toggle)", () => {
  test("tools default visible: eye toggle present, tongue tabs + cluster render", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    expect(toolsToggle()).not.toBeNull();
    expect(toolsToggle()!.getAttribute("aria-pressed")).toBe("false");
    expect(sidebarTabs()).not.toBeNull();
    expect(floatingCluster()).not.toBeNull();
  });

  test("Hide tools removes ALL floating chrome from the DOM, with no residual artifact; Show tools brings it back", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    const toggle = toolsToggle();
    if (!toggle) throw new Error("tools toggle missing");
    await act(async () => toggle.click());

    expect(sidebarTabs()).toBeNull();
    expect(floatingCluster()).toBeNull();
    // No leftover pill/expander: the toggle in the header is the only way back.
    expect(toolsToggle()).not.toBeNull();
    expect(toolsToggle()!.getAttribute("aria-pressed")).toBe("true");

    await act(async () => toolsToggle()!.click());
    expect(sidebarTabs()).not.toBeNull();
    expect(floatingCluster()).not.toBeNull();
  });

  test("a cookie recording toolsHidden:true restores hidden, and the header toggle is the way back", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: true, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();

    expect(sidebarTabs()).toBeNull();
    expect(floatingCluster()).toBeNull();
    const toggle = toolsToggle();
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => toggle!.click());
    expect(sidebarTabs()).not.toBeNull();
  });

  test("the sidebar-open half of the persisted chrome still restores", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ sidebarOpen: true, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();

    // Open sidebar renders the full tab strip (Contents label), and the
    // collapsed flags are gone.
    expect(findButtonByText("Contents")).not.toBeUndefined();
  });

  test("the pen toggle starts ARMED (aria-pressed) on a static HTML session and click flips it to Interact", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    const pen = penToggle();
    if (!pen) throw new Error("pen toggle missing");
    expect(pen.getAttribute("aria-pressed")).toBe("true");

    await act(async () => pen.click());
    expect(penToggle()!.getAttribute("aria-pressed")).toBe("false");

    await act(async () => penToggle()!.click());
    expect(penToggle()!.getAttribute("aria-pressed")).toBe("true");
  });
});
