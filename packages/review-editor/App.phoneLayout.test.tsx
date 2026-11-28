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
  constructor(url?: string | URL) {
    // The PR context stream refuses, as a server without it does: the hook
    // falls back to reading /api/pr-context.
    if (String(url ?? "").includes("/api/pr-context/stream")) {
      setTimeout(() => this.onerror?.(new Event("error")), 0);
    }
  }
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

/** Set: /api/diff serves a pull request, as `plannotator review <pr-url>` does. */
let prSession = false;
const PR_METADATA = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "payments-service",
  number: 42,
  title: "Add the refund flow",
  author: "ada-novak",
  baseBranch: "main",
  headBranch: "add-refund-flow",
  baseSha: "aaa1111",
  headSha: "bbb2222",
  url: "https://github.com/acme/payments-service/pull/42",
};
const PR_DESCRIPTION = "Refunds post a reversing entry to the ledger.";
const PR_CONTEXT = {
  body: PR_DESCRIPTION,
  state: "OPEN",
  isDraft: false,
  labels: [],
  reviewDecision: "",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  comments: [],
  reviews: [],
  reviewThreads: [],
  checks: [],
  linkedIssues: [],
};

function makeFetch(): typeof fetch {
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
        ...(prSession ? { prMetadata: PR_METADATA, platformUser: "charlie-dunn" } : {}),
      });
    }
    if (url.pathname === "/api/pr-context") return Response.json(PR_CONTEXT);
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

async function mount(matchMedia: typeof window.matchMedia = phoneMatchMedia): Promise<void> {
  setStorageBackend(memoryBackend);
  seedUnrelatedAnnouncementsSeen();
  configStore.loadFromBackend();
  configStore.set("diffStyle", "split");
  window.matchMedia = matchMedia;
  globalThis.fetch = makeFetch();
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  // The header's repository label: /api/diff has been applied.
  await waitFor(() => document.body.textContent?.includes("add-refund-flow") ?? false, "the review to load");
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
  prSession = false;
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

const sheet = () => document.querySelector<HTMLElement>('[data-review-navigation-sheet]');
const sheetOpen = () => sheet() !== null;

describe.if(hasDom)("phone width: one thing on screen at a time", () => {
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

// SAFETY: as phoneMatchMedia, with no query matching: a wide desktop window.
const wideMatchMedia = ((query: string) => ({ ...phoneMatchMedia(query), matches: false })) as unknown as typeof window.matchMedia;
const descriptionShown = () => document.body.textContent?.includes(PR_DESCRIPTION) ?? false;

describe.if(hasDom)("a pull request review opens on its description (#3667)", () => {
  test("on a phone the PR overview is the landing tab, with the description in the page", async () => {
    prSession = true;
    await mount();
    await waitFor(descriptionShown, "the PR description on a phone");
  });

  test("on a wide screen it is the landing tab too, as before", async () => {
    prSession = true;
    await mount(wideMatchMedia);
    await waitFor(descriptionShown, "the PR description on a wide screen");
  });

  test("a local review on a phone still lands on All changes", async () => {
    await mount();
    await waitFor(() => document.querySelector("[data-changes-tree]") !== null, "the file tree");
    for (let i = 0; i < 5; i += 1) await settle();
    expect(descriptionShown()).toBe(false);
    expect(document.body.textContent).not.toContain("Loading PR");
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
