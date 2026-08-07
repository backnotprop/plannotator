import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

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
  for (let attempt = 0; attempt < 20 && !findButton("Hide tools"); attempt += 1) {
    await settle();
  }
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)("HTML annotate hide-tools", () => {
  test("hiding tools removes the collapsed sidebar tab flags, showing tools restores them", async () => {
    await mountHtmlAnnotate();

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

  test("the sidebar is still reachable by keyboard while tools are hidden", async () => {
    await mountHtmlAnnotate();

    const hide = findButton("Hide tools");
    if (!hide) throw new Error('"Hide tools" toggle did not render');
    await act(async () => hide.click());
    expect(sidebarTabs()).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
    });
    await settle();

    expect(findButton("Contents")).not.toBeUndefined();
  });
});
