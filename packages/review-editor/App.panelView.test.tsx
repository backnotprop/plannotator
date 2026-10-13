/**
 * Opening panel view (DOM_TESTS=1) — what a code review renders in the left
 * panel on first paint, and what it does NOT render on the way there.
 *
 * Regressions each test guards:
 *  - A fresh profile (no cookies at all) must open on Tree and must NOT show
 *    a first-run setup chooser. The dialog was removed by owner ruling; a
 *    reintroduced one-time chooser, or a `reviewPanelView` default that slips
 *    back to 'sections', both fail here.
 *  - A reviewer who persisted `reviewPanelView=sections` must still open on
 *    Git status. The removal must be invisible to anyone holding a cookie.
 *  - The last-used memo still layers over the persisted default, which is the
 *    mechanism the panel toggle writes through.
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

// Vite-only virtual module (`?worker&inline`) — bun cannot resolve it, so the
// pool hooks are stubbed exactly like App.decisionControl.test.tsx does.
mock.module("./workerPool", () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== "undefined";

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

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

/** A plain local-git session that CAN serve both panel views: since-base is a
 *  resolvable diff option and the sections sidecar is present. This is exactly
 *  the session the removed chooser used to interrupt. */
const DIFF_PAYLOAD = {
  rawPatch: PATCH,
  gitRef: "HEAD",
  snapshotId: "snap-1",
  origin: "claude-code",
  diffType: "since-base",
  base: "origin/main",
  hideWhitespace: false,
  gitContext: {
    vcsType: "git",
    defaultBranch: "main",
    currentBranch: "feature/parser",
    diffOptions: [
      { id: "since-base", label: "All changes" },
      { id: "uncommitted", label: "Uncommitted" },
    ],
  },
  sections: {
    base: "origin/main",
    mergeBase: "aaa1111",
    files: { "src/parse.ts": { group: "changes", staged: false } },
  },
};

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

function makeFetch(): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init); the double implements
  // that call signature and not `fetch.preconnect`.
  const impl = async (input: RequestInfo | URL) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/diff") return Response.json(DIFF_PAYLOAD);
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function panelSegment(label: string): HTMLButtonElement | undefined {
  const group = document.querySelector<HTMLElement>('[role="group"][aria-label="Panel view"]');
  return Array.from(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((el) => el.textContent?.trim() === label);
}

function pressedPanelSegment(): string | undefined {
  const group = document.querySelector<HTMLElement>('[role="group"][aria-label="Panel view"]');
  return Array.from(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((el) => el.getAttribute("aria-pressed") === "true")
    ?.textContent?.trim();
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Retire the unrelated one-time announcements (guide intro, look-and-feel,
 *  Edit Mode, token hover, terminal tools) so the review renders its panel.
 *  Deliberately seeds NO panel-view or review-setup key: what these tests
 *  measure is what a profile that never chose a view opens on. */
function seedUnrelatedAnnouncementsSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-token-hover-announcement-seen", "1");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

async function mount(seed: () => void = () => {}): Promise<void> {
  setStorageBackend(memoryBackend);
  seedUnrelatedAnnouncementsSeen();
  seed();
  // configStore is a module singleton that resolves cookies once per process,
  // so a per-test seed only reaches it through this host re-hydration hook.
  configStore.loadFromBackend();
  globalThis.fetch = makeFetch();
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 40 && !pressedPanelSegment(); attempt += 1) {
    await settle();
  }
  if (!pressedPanelSegment()) throw new Error("panel view toggle did not render");
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

describe.if(hasDom)("opening panel view", () => {
  test("a fresh profile opens on Tree with no setup dialog", async () => {
    await mount();

    expect(pressedPanelSegment()).toBe("Tree");
    expect(panelSegment("Git status")).toBeDefined(); // still one click away
    // No setup chooser interrupts the session. With every UNRELATED one-time
    // announcement retired above, any remaining chain dialog would have to be
    // a review-setup one, so the absence of a modal overlay is the assertion.
    expect(document.querySelector('[class*="fixed inset-0"][class*="z-[100]"]')).toBeNull();
    // The removal is not a server-config change: reviewPanelView is a
    // cookie-only setting, so a fresh profile must POST nothing to /api/config.
    expect(memory.get("plannotator-review-panel-view")).toBe("tree");
  });

  test("a persisted sections cookie still opens on Git status", async () => {
    // Failure caught: the default flip reaching existing users. Anyone who
    // chose Git status in Settings keeps it.
    await mount(() => {
      memory.set("plannotator-review-panel-view", "sections");
    });

    expect(pressedPanelSegment()).toBe("Git status");
  });

  test("the last-used memo still layers over the persisted default", async () => {
    // Failure caught: removing the initializer taking the memo with it — the
    // panel toggle's only persistence.
    await mount(() => {
      memory.set("plannotator-review-panel-view", "tree");
      memory.set("plannotator-review-panel-view-last-used", "sections");
    });

    expect(pressedPanelSegment()).toBe("Git status");
  });
});
