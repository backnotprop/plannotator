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

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

const file = (name: string) => [
  `diff --git a/src/${name} b/src/${name}`,
  "index 0000001..0000002 100644",
  `--- a/src/${name}`,
  `+++ b/src/${name}`,
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");
const PATCH = file("refunds.ts") + file("ledger.ts");

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
  constructor(url: string) {
    if (url === "/api/pr-context/stream") {
      queueMicrotask(() => this.onerror?.(new Event("error")));
    }
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

function makeFetch(pullRequest: boolean): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init); the double implements
  // that call signature and not `fetch.preconnect`.
  const impl = async (input: RequestInfo | URL) => {
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
        hideWhitespace: false,
        repoInfo: { display: "acme/payments-service", branch: "add-refund-flow" },
        ...(pullRequest ? {
          prMetadata: {
            platform: "github", host: "github.com", owner: "acme", repo: "payments-service",
            number: 42, title: "Refund flow", author: "review-author", baseBranch: "main",
            headBranch: "add-refund-flow", baseSha: "a".repeat(40), headSha: "b".repeat(40),
            url: "https://github.com/acme/payments-service/pull/42",
          },
        } : {}),
      });
    }
    if (url.pathname === "/api/pr-context") {
      return Response.json({
        body: "Add refunds to the payment ledger.",
        reviewDecision: "", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        state: "OPEN", isDraft: false, labels: [], comments: [], checks: [],
        reviews: [], reviewThreads: [], linkedIssues: [],
      });
    }
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

const originalMatchMedia = hasDom ? window.matchMedia : undefined;
// SAFETY: the MediaQueryList surface the layout hooks read; only the phone width query matches.
const phoneMatchMedia = ((query: string) => ({
  matches: query.includes("max-width: 639px"),
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
})) as unknown as typeof window.matchMedia;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 80 && !check(); attempt += 1) await settle();
  if (!check()) throw new Error(`timed out waiting for ${what}`);
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

async function mount(pullRequest = false): Promise<void> {
  setStorageBackend(memoryBackend);
  seedUnrelatedAnnouncementsSeen();
  configStore.loadFromBackend();
  configStore.set("diffStyle", "split");
  window.matchMedia = phoneMatchMedia;
  globalThis.fetch = makeFetch(pullRequest);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  const headerLabel = pullRequest ? "Refund flow" : "add-refund-flow";
  await waitFor(() => document.body.textContent?.includes(headerLabel) ?? false, "the review to load");
  await settle();
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom && originalMatchMedia) window.matchMedia = originalMatchMedia;
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

const sheet = () => document.querySelector<HTMLElement>('[data-review-navigation-sheet]');
const sheetOpen = () => sheet() !== null;

describe.if(hasDom)("phone width: one thing on screen at a time", () => {
  test("a pull request opens its description after dismissing navigation", async () => {
    await mount(true);
    await waitFor(sheetOpen, "the review navigation to open");
    await act(async () => {
      sheet()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => !sheetOpen(), "the review navigation to close");
    await waitFor(
      () => document.body.textContent?.includes("Add refunds to the payment ledger.") ?? false,
      "the PR description",
    );
  });

  test("nothing viewed yet: the file sheet opens on load; picking a file closes it; the saved split setting is left alone", async () => {
    await mount();
    await waitFor(sheetOpen, "the file sheet to open on first load");
    expect(sheet()!.getAttribute("aria-label")).toBe("Review navigation");
    expect(document.activeElement).toBe(sheet());
    expect(document.querySelector('[data-header-branch]')?.textContent).not.toContain("payments-service");
    const ledgerRow = () => [...(document.querySelector("[data-changes-tree]")?.shadowRoot?.querySelectorAll<HTMLElement>('[data-type="item"][data-item-type="file"]') ?? [])].find((el) => el.getAttribute("aria-selected") !== "true");
    await waitFor(() => ledgerRow() !== undefined, "a file row that is not the open file");
    for (let attempt = 0; attempt < 10 && sheetOpen(); attempt += 1) {
      await act(async () => {
        const row = ledgerRow();
        row?.focus();
        row?.click();
      });
      await settle();
    }
    await waitFor(() => !sheetOpen(), "the sheet to close after the pick");
    expect(configStore.get("diffStyle")).toBe("split");
  });
});

describe("phone width: the diff is unified whatever the saved setting", () => {
  test("below the phone width split becomes unified; on a wide screen the saved choice applies again", async () => {
    const { phoneDiffStyle } = await import("./utils/phoneLayout");
    expect(phoneDiffStyle(true, "split")).toBe("unified");
    expect(phoneDiffStyle(false, "split")).toBe("split");
    expect(phoneDiffStyle(false, "unified")).toBe("unified");
  });
});
