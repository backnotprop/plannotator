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
const originalMatchMedia = hasDom ? window.matchMedia : undefined;

// SAFETY: implements the MediaQueryList surface the shell hooks consume.
// Coarse-pointer matches put the app in its compact touch layout.
function coarseMatchMedia(query: string): MediaQueryList {
  return {
    matches: query.includes("pointer: coarse"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
}

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

function armedRing(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-annotate-armed-ring]");
}

/** Compact mounts wait on the armed ring: neither the pen nor the eye toggle
 * exists on the compact touch shell (that absence is what these tests guard). */
async function mountCompactHtmlAnnotate(): Promise<void> {
  globalThis.fetch = annotateFetch;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 20 && !armedRing(); attempt += 1) {
    await settle();
  }
  if (!armedRing()) throw new Error("compact HTML surface did not finish mounting (armed ring missing)");
}

async function openOptionsMenu(): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Options"]');
  if (!trigger) throw new Error("Options menu trigger missing");
  await act(async () => trigger.click());
}

function findMenuItem(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.includes(label));
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
  if (hasDom) {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    document.body.replaceChildren();
  }
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

  test("compact touch layout: a toolsHidden:true cookie is undoable through the Options menu 'Show tools' action", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: true, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    window.matchMedia = coarseMatchMedia as typeof window.matchMedia;
    await mountCompactHtmlAnnotate();

    // The cookie applies (desktop parity), but compact is not stranded: the
    // desktop-only eye toggle is absent and the menu action is the way back.
    expect(floatingCluster()).toBeNull();
    expect(toolsToggle()).toBeNull();

    await openOptionsMenu();
    const show = findMenuItem("Show tools");
    if (!show) throw new Error('compact menu is missing the "Show tools" action');
    await act(async () => show.click());
    expect(floatingCluster()).not.toBeNull();
  });

  test("compact touch layout: annotate mode is disarmable through the Options menu (no pen, no keyboard needed)", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    window.matchMedia = coarseMatchMedia as typeof window.matchMedia;
    await mountCompactHtmlAnnotate();

    // Armed by default, and the desktop pen is absent on compact — without
    // the menu action every tap annotates and the page is unreachable.
    expect(penToggle()).toBeNull();
    expect(armedRing()).not.toBeNull();

    await openOptionsMenu();
    const interact = findMenuItem("Interact with page");
    if (!interact) throw new Error('compact menu is missing the "Interact with page" action');
    await act(async () => interact.click());
    expect(armedRing()).toBeNull();

    // And back: the same slot re-arms.
    await openOptionsMenu();
    const annotate = findMenuItem("Annotate page");
    if (!annotate) throw new Error('compact menu is missing the "Annotate page" action');
    await act(async () => annotate.click());
    expect(armedRing()).not.toBeNull();
  });

  test("the restore commit never writes stale pre-restore values to the cookie", async () => {
    // The chrome writer runs in the same commit as the restore effect, before
    // the restored state has landed. If it saved there, a returning user's
    // remembered state would be transiently inverted in the cookie — and a
    // page ending between the two writes would freeze the inversion.
    // Instrument every chrome write: no write may ever carry a state other
    // than the remembered one, because this session never changes any chrome.
    const chromeWrites: string[] = [];
    setStorageBackend({
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        if (key === "plannotator-html-chrome") chromeWrites.push(value);
        memory.set(key, value);
      },
      removeItem: (key) => void memory.delete(key),
    });
    seedAnnouncementsSeen();
    const rememberedState = { toolsHidden: false, sidebarOpen: true, panelOpen: false };
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ ...rememberedState, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();

    // Writes re-stamp savedAt, so compare the semantic fields, not bytes.
    const semantic = (raw: string) => {
      const { toolsHidden, sidebarOpen, panelOpen } = JSON.parse(raw) as Record<string, unknown>;
      return { toolsHidden, sidebarOpen, panelOpen };
    };
    for (const write of chromeWrites) {
      expect(semantic(write)).toEqual(rememberedState);
    }
    expect(semantic(memory.get("plannotator-html-chrome")!)).toEqual(rememberedState);
  });

  test("the sidebar is still reachable by keyboard (Mod+B) while tools are hidden", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: true, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();
    expect(sidebarTabs()).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
    });
    await settle();

    expect(findButtonByText("Contents")).not.toBeUndefined();
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
