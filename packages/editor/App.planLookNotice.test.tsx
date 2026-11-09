/**
 * The one-time "Plans now open in Clean" notice (owner, 2026-10-27: move
 * everyone to Clean once, "maybe give them a dialog notice"). Someone holding
 * only an old look marker with Grid stored sees the look chooser once more,
 * Clean preselected; Continue or Escape records the choice and it never shows
 * again. A Clean user and a first-run user never see it. The cookie-state
 * table itself is in packages/ui/config/gridEnabledSetting.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const hasDom = typeof document !== "undefined";

const storageModule = hasDom ? await import("@plannotator/ui/utils/storage") : null;
const configModule = hasDom ? await import("@plannotator/ui/config") : null;
const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const V1_KEY = "plannotator-plan-look-choice-resolved";
const V2_KEY = "plannotator-plan-look-v2";
const GRID_KEY = "plannotator-grid-enabled";
const DIALOG = '[aria-labelledby="plan-look-choice-title"]';

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

let root: Root | null = null;
let host: HTMLElement | null = null;

const stubFetch: typeof fetch = async (input) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === "/api/plan") {
    return Response.json({ plan: "# Session document\n\nA paragraph to review.", origin: "codex", sharingEnabled: false, serverConfig: {} });
  }
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({});
};

async function mountApp(): Promise<void> {
  globalThis.fetch = stubFetch;
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

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(DIALOG);
}

function option(label: string): HTMLButtonElement {
  const match = Array.from(dialog()?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? [])
    .find((button) => button.textContent?.includes(label));
  if (!match) throw new Error(`Missing ${label} option`);
  return match;
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

describe.if(hasDom)("plan look: the one-time move to Clean", () => {
  beforeEach(() => {
    memory.clear();
    storageModule?.setStorageBackend(memoryBackend);
    // One store per process: start every test from a page load that resolved Clean.
    configModule?.configStore.seed("gridEnabled", false);
    memory.clear();
  });

  afterEach(async () => {
    await unmountApp();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    storageModule?.resetStorageBackend();
    memory.clear();
  });

  test("Grid kept on the old chooser: the notice shows with Clean selected, Continue records it, and it never shows again", async () => {
    memory.set(V1_KEY, "true");
    memory.set(GRID_KEY, "true");
    await mountApp();

    expect(dialog()?.getAttribute("data-plan-look-prompt")).toBe("moved");
    expect(option("Clean").getAttribute("aria-pressed")).toBe("true");
    expect(memory.get(GRID_KEY)).toBe("false");

    const continueButton = Array.from(dialog()!.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Continue");
    if (!continueButton) throw new Error("Continue did not render");
    await act(async () => continueButton.click());
    expect(dialog()).toBeNull();
    expect(memory.get(V2_KEY)).toBe("resolved");

    await unmountApp();
    await mountApp();
    expect(dialog()).toBeNull();
  });

  test("Escape on the notice records it too", async () => {
    memory.set("plannotator-look-feel-announcement-seen", "2");
    memory.set(GRID_KEY, "true");
    await mountApp();
    expect(dialog()?.getAttribute("data-plan-look-prompt")).toBe("moved");

    await pressEscape();
    expect(dialog()).toBeNull();
    expect(memory.get(V2_KEY)).toBe("resolved");

    await unmountApp();
    await mountApp();
    expect(dialog()).toBeNull();
  });

  test("picking Grid on the notice keeps Grid", async () => {
    memory.set(V1_KEY, "true");
    memory.set(GRID_KEY, "true");
    await mountApp();
    await act(async () => option("Grid").click());
    await pressEscape();
    expect(memory.get(GRID_KEY)).toBe("true");
    expect(memory.get(V2_KEY)).toBe("resolved");
  });

  test("two tabs: Grid picked in the other tab survives Escape on this tab's notice", async () => {
    memory.set(V1_KEY, "true");
    memory.set(GRID_KEY, "true");
    await mountApp();
    expect(dialog()?.getAttribute("data-plan-look-prompt")).toBe("moved");
    expect(option("Clean").getAttribute("aria-pressed")).toBe("true");

    // The other tab: Grid + Continue.
    memory.set(GRID_KEY, "true");
    memory.set(V2_KEY, "resolved");

    await pressEscape();
    expect(dialog()).toBeNull();
    expect(memory.get(GRID_KEY)).toBe("true");
    expect(memory.get(V2_KEY)).toBe("resolved");
  });

  test("two tabs: coming back to this tab after answering in the other closes the notice and adopts Grid", async () => {
    memory.set(V1_KEY, "true");
    memory.set(GRID_KEY, "true");
    await mountApp();
    expect(dialog()).not.toBeNull();

    memory.set(GRID_KEY, "true");
    memory.set(V2_KEY, "resolved");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(dialog()).toBeNull();
    expect(memory.get(GRID_KEY)).toBe("true");
  });

  test("a Clean user sees nothing", async () => {
    memory.set(V1_KEY, "true");
    memory.set(GRID_KEY, "false");
    await mountApp();
    expect(dialog()).toBeNull();
    expect(memory.get(V2_KEY)).toBe("resolved");
  });

  test("a first run gets the first-run chooser, not the notice", async () => {
    await mountApp();
    expect(dialog()?.getAttribute("data-plan-look-prompt")).toBe("first-run");
  });
});
