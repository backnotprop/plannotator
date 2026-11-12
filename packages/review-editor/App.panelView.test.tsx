import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";
import { configStore } from "@plannotator/ui/config";

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
  const group = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Panel view"]');
  return Array.from(group?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    .find((el) => el.textContent?.trim() === label);
}

function selectedPanelSegment(): string | undefined {
  const group = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Panel view"]');
  return Array.from(group?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    .find((el) => el.getAttribute("aria-selected") === "true")
    ?.textContent?.trim();
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function seedUnrelatedAnnouncementsSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
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
  configStore.loadFromBackend();
  globalThis.fetch = makeFetch();
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 40 && !selectedPanelSegment(); attempt += 1) {
    await settle();
  }
  if (!selectedPanelSegment()) throw new Error("panel view toggle did not render");
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

    expect(selectedPanelSegment()).toBe("Tree");
    expect(panelSegment("Git status")).toBeDefined();
    expect(document.querySelector('[class*="fixed inset-0"][class*="z-[100]"]')).toBeNull();
    expect(memory.get("plannotator-review-panel-view")).toBe("tree");
  });

  test("a persisted sections cookie still opens on Git status", async () => {
    await mount(() => {
      memory.set("plannotator-review-panel-view", "sections");
    });

    expect(selectedPanelSegment()).toBe("Git status");
  });

  test("the last-used memo still layers over the persisted default", async () => {
    await mount(() => {
      memory.set("plannotator-review-panel-view", "tree");
      memory.set("plannotator-review-panel-view-last-used", "sections");
    });

    expect(selectedPanelSegment()).toBe("Git status");
  });
});
