/**
 * The plan-look notice in code review, with two tabs open (DOM_TESTS=1).
 * Both tabs show the one-time "Plans now open in Clean" notice with Clean
 * preselected. When the other tab picks Grid first, this tab must adopt Grid
 * and write nothing: Escape here, or coming back to this tab, must not put
 * Clean over the Grid picked there. The plan editor's copy of this is in
 * packages/editor/App.planLookNotice.test.tsx.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";
import { configStore } from "@plannotator/ui/config";

// Vite-only virtual module (`?worker&inline`), stubbed like App.panelView.test.tsx.
mock.module("./workerPool", () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== "undefined";

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const V1_KEY = "plannotator-plan-look-choice-resolved";
const V2_KEY = "plannotator-plan-look-v2";
const GRID_KEY = "plannotator-grid-enabled";
const DIALOG = '[aria-labelledby="plan-look-choice-title"]';

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

const PATCH = [
  "diff --git a/src/parse.ts b/src/parse.ts",
  "index 0000001..0000002 100644",
  "--- a/src/parse.ts",
  "+++ b/src/parse.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

// SAFETY: the app only ever calls fetch(input, init); the double implements
// that call signature and not `fetch.preconnect`.
const stubFetch = (async (input: RequestInfo | URL) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === "/api/diff") {
    return Response.json({
      rawPatch: PATCH,
      gitRef: "uncommitted",
      snapshotId: "snap-1",
      origin: "claude-code",
      diffType: "uncommitted",
      base: "origin/main",
      hideWhitespace: false,
    });
  }
  if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({});
}) as unknown as typeof fetch;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>(DIALOG);
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 80 && !check(); attempt += 1) await settle();
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

function cleanOption(): HTMLButtonElement {
  const match = Array.from(dialog()?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? [])
    .find((button) => button.textContent?.includes("Clean"));
  if (!match) throw new Error("Missing Clean option");
  return match;
}

/** A browser that kept Grid on the old chooser; every other one-time dialog already seen. */
function seedMovedFromGrid(): void {
  memory.set(V1_KEY, "true");
  memory.set(GRID_KEY, "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-token-hover-announcement-seen", "1");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

/** What the other tab writes when its person picks Grid and presses Continue. */
function otherTabPicksGrid(): void {
  memory.set(GRID_KEY, "true");
  memory.set(V2_KEY, "resolved");
  memory.set(V1_KEY, "true");
}

async function mountWithNotice(): Promise<void> {
  setStorageBackend(memoryBackend);
  // One store per process: start from a page load that resolved Clean.
  configStore.seed("gridEnabled", false);
  memory.clear();
  seedMovedFromGrid();
  configStore.loadFromBackend();
  globalThis.fetch = stubFetch;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  await waitFor(() => dialog() !== null, "the plan-look notice");
  expect(dialog()?.getAttribute("data-plan-look-prompt")).toBe("moved");
  expect(cleanOption().getAttribute("aria-pressed")).toBe("true");
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("code review: the plan-look notice in two tabs", () => {
  test("Grid picked in the other tab survives Escape on this tab's notice", async () => {
    await mountWithNotice();
    otherTabPicksGrid();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(memory.get(GRID_KEY)).toBe("true");
    expect(memory.get(V2_KEY)).toBe("resolved");
  });

  test("coming back to this tab after answering in the other closes the notice and keeps Grid", async () => {
    await mountWithNotice();
    otherTabPicksGrid();

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(dialog()).toBeNull();
    expect(memory.get(GRID_KEY)).toBe("true");
  });
});
