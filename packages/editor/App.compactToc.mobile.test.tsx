/**
 * Compact navigator "jump to heading" (DOM_TESTS=1)
 *
 * The compact navigator renders the SAME TableOfContents as the desktop rail,
 * and that component resolves its scroll target from ScrollViewportContext.
 * When the overlay rendered outside App's ScrollViewportProvider the context
 * was null, so every heading tap silently did nothing. This mounts the real
 * app in the compact touch shell and pins that a TOC activation still scrolls
 * the viewport.
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

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;
const originalScrollTo = hasDom ? window.scrollTo : undefined;

const PLAN = "# Alpha section\n\nFirst body paragraph.\n\n## Beta section\n\nSecond body paragraph.\n";

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

const planFetch: typeof fetch = async (input) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === "/api/plan") {
    return Response.json({ plan: PLAN, origin: "codex", sharingEnabled: false, serverConfig: {} });
  }
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({});
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    if (originalScrollTo) window.scrollTo = originalScrollTo;
    document.body.replaceChildren();
  }
  memory.clear();
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("compact navigator table of contents", () => {
  test("a heading activation scrolls the document viewport", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    window.matchMedia = coarseMatchMedia as typeof window.matchMedia;
    globalThis.fetch = planFetch;
    // SAFETY: the App only uses EventSource's constructor, handlers, and close.
    globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root?.render(<App />); });

    let trigger: HTMLElement | null = null;
    for (let attempt = 0; attempt < 20 && !trigger; attempt += 1) {
      await settle();
      trigger = document.getElementById("pn-compact-plan-navigator-trigger");
    }
    if (!trigger) throw new Error("compact navigator trigger never rendered");

    await act(async () => trigger?.click());
    await settle();

    const tocButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('nav[aria-label="Table of contents"] button'),
    ).find((button) => button.textContent?.includes("Beta section"));
    if (!tocButton) throw new Error("compact navigator did not render the plan's headings");

    // The heading has to exist in the document under the overlay, otherwise the
    // no-op being guarded against would be indistinguishable from a miss.
    expect(document.querySelector("[data-block-id]")).not.toBeNull();

    const scrollCalls: unknown[] = [];
    window.scrollTo = ((...args: unknown[]) => { scrollCalls.push(args); }) as typeof window.scrollTo;

    await act(async () => tocButton.click());

    expect(scrollCalls.length).toBeGreaterThan(0);
  });
});
