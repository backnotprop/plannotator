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

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);
}

function sidebarTabs(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-sidebar-tabs="true"]');
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountHtmlAnnotate(expectButton: string): Promise<void> {
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
  for (let attempt = 0; attempt < 20 && !findButton(expectButton); attempt += 1) {
    await settle();
  }
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

describe.if(hasDom)("HTML annotate chrome (minimal-first render + persistence)", () => {
  test("first-ever HTML session opens minimal: all chrome hidden, Show tools discoverable", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate("Show tools");

    // Nothing the hide-tools toggle controls may be mounted on first paint.
    expect(sidebarTabs()).toBeNull();
    const show = findButton("Show tools");
    if (!show) throw new Error('"Show tools" affordance did not render on first run');

    await act(async () => show.click());
    expect(sidebarTabs()).not.toBeNull();
    expect(findButton("Hide tools")).not.toBeUndefined();
  });

  test("hiding tools removes the collapsed sidebar tab flags, showing tools restores them", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    // Simulate a returning user who previously showed tools (fresh stamp —
    // untimestamped records are expired by design, see preferenceTtl.ts).
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: false, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate("Hide tools");

    const strip = sidebarTabs();
    if (!strip) throw new Error("Collapsed sidebar tab flags did not render");
    expect(strip.querySelectorAll("button").length).toBeGreaterThan(0);

    const hide = findButton("Hide tools");
    if (!hide) throw new Error('"Hide tools" toggle did not render');
    await act(async () => hide.click());

    // Unmounted, not merely invisible: nothing focusable may survive in the tab
    // order, and no hover/click target may sit over the rendered page.
    expect(sidebarTabs()).toBeNull();

    const show = findButton("Show tools");
    if (!show) throw new Error('"Show tools" toggle is not reachable while tools are hidden');
    await act(async () => show.click());

    expect(sidebarTabs()).not.toBeNull();
  });

  test("the restore commit never writes stale pre-restore values to the cookie", async () => {
    // The chrome writer runs in the same commit as the restore effect, before
    // the restored state has landed. If it saved there, a returning user's
    // remembered state would be transiently inverted in the cookie — and a
    // page ending between the two writes would freeze the inversion. Instrument
    // every chrome write: no write may ever carry a state other than the
    // remembered one, because this session never changes any chrome.
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
    await mountHtmlAnnotate("Hide tools");
    await settle();

    // Writes re-stamp savedAt, so compare the semantic fields, not bytes: no
    // write may ever carry chrome values other than the remembered ones,
    // because this session never changes any chrome.
    const semantic = (raw: string) => {
      const { toolsHidden, sidebarOpen, panelOpen } = JSON.parse(raw);
      return { toolsHidden, sidebarOpen, panelOpen };
    };
    for (const write of chromeWrites) {
      expect(semantic(write)).toEqual(rememberedState);
    }
    expect(semantic(memory.get("plannotator-html-chrome")!)).toEqual(rememberedState);
  });

  test("a 'user showed tools' state persists across a fresh mount", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate("Show tools");

    const show = findButton("Show tools");
    if (!show) throw new Error('"Show tools" toggle did not render');
    await act(async () => show.click());
    expect(sidebarTabs()).not.toBeNull();

    // Next session (fresh mount, same persisted prefs): opens exactly as left.
    await unmountHtmlAnnotate();
    await mountHtmlAnnotate("Hide tools");
    expect(findButton("Hide tools")).not.toBeUndefined();
    expect(sidebarTabs()).not.toBeNull();
  });

  test("a 'user re-hid everything' state persists across a fresh mount", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: false, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate("Hide tools");

    const hide = findButton("Hide tools");
    if (!hide) throw new Error('"Hide tools" toggle did not render');
    await act(async () => hide.click());
    expect(sidebarTabs()).toBeNull();

    await unmountHtmlAnnotate();
    await mountHtmlAnnotate("Show tools");
    expect(findButton("Show tools")).not.toBeUndefined();
    expect(sidebarTabs()).toBeNull();
  });

  test("the sidebar is still reachable by keyboard while tools are hidden", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate("Show tools");
    expect(sidebarTabs()).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
    });
    await settle();

    expect(findButton("Contents")).not.toBeUndefined();
  });
});
