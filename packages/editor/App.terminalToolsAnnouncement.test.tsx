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

const ANNOUNCEMENT_KEY = "plannotator-announce-tui-herdr-seen";
const LOOK_AND_FEEL_KEY = "plannotator-plan-look-choice-resolved";
const DIALOG = "[data-terminal-tools-announcement-dialog]";

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

interface PlanResponse {
  readonly plan: string;
  readonly origin: "codex";
  readonly mode?: "archive" | "annotate";
  readonly filePath?: string;
  readonly archivePlans?: readonly {
    readonly filename: string;
    readonly status: "approved";
    readonly timestamp: string;
    readonly title: string;
  }[];
  readonly sharingEnabled: false;
  readonly serverConfig: Record<string, never>;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function stubFetch(planResponse: PlanResponse): typeof fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") return Response.json(planResponse);
    if (url.pathname === "/api/archive/plans") {
      return Response.json({ plans: planResponse.archivePlans ?? [] });
    }
    if (url.pathname === "/api/archive/plan") {
      return Response.json({ markdown: planResponse.plan, filepath: "saved.md" });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
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

async function mountApp(planResponse: PlanResponse): Promise<void> {
  globalThis.fetch = stubFetch(planResponse);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 20 && !document.body.textContent?.includes("Session document"); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function unmountApp(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
}

const PLAN: PlanResponse = {
  plan: "# Session document\n\nA paragraph to review.",
  origin: "codex",
  sharingEnabled: false,
  serverConfig: {},
};

describe.if(hasDom)("terminal tools announcement in the plan editor", () => {
  beforeEach(() => {
    memory.clear();
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

  test("announces once, then never again in this browser", async () => {
    memory.set(LOOK_AND_FEEL_KEY, "true");
    await mountApp(PLAN);

    const dialog = document.querySelector(DIALOG);
    expect(dialog).not.toBeNull();
    expect(memory.has(ANNOUNCEMENT_KEY)).toBe(false);

    const gotIt = Array.from(document.querySelectorAll<HTMLButtonElement>(`${DIALOG} button`))
      .find((button) => button.textContent?.trim() === "Got it");
    if (!gotIt) throw new Error("Dismiss action did not render");
    await act(async () => gotIt.click());

    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.get(ANNOUNCEMENT_KEY)).toBe("1");

    await unmountApp();
    await mountApp(PLAN);
    expect(document.querySelector(DIALOG)).toBeNull();
  });

  test("defers behind the look-and-feel chooser without spending the announcement", async () => {
    // No look-and-feel marker: that chooser owns this session.
    await mountApp(PLAN);

    expect(document.querySelector('[aria-labelledby="plan-look-choice-title"]')).not.toBeNull();
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(ANNOUNCEMENT_KEY)).toBe(false);
  });

  test("stays out of a read-only archive session and keeps the announcement for later", async () => {
    memory.set(LOOK_AND_FEEL_KEY, "true");
    await mountApp({
      ...PLAN,
      mode: "archive",
      archivePlans: [{
        filename: "saved.md",
        status: "approved",
        timestamp: "2026-07-31T00:00:00.000Z",
        title: "Session document",
      }],
    });

    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(ANNOUNCEMENT_KEY)).toBe(false);
  });

  test("stays out of the compact touch shell and keeps the announcement for later", async () => {
    memory.set(LOOK_AND_FEEL_KEY, "true");
    useCompactTouchMedia();
    await mountApp(PLAN);

    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(ANNOUNCEMENT_KEY)).toBe(false);
  });
});
