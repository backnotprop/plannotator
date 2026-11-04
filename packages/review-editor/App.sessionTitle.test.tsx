/**
 * `plannotator review --title` in the page (DOM_TESTS=1, #2289).
 *
 * /api/diff carries the caller's title: the tab must show it, exactly as
 * given, in place of `<repo> · Code Review`. A review without one keeps that
 * title. Failures caught: the App dropping the field, and the repository
 * name arriving after it and taking the tab back.
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

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

const PATCH = [
  "diff --git a/src/refunds.ts b/src/refunds.ts",
  "index 0000001..0000002 100644",
  "--- a/src/refunds.ts",
  "+++ b/src/refunds.ts",
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

function makeFetch(title: string | undefined): typeof fetch {
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
        ...(title === undefined ? {} : { title }),
      });
    }
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

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

async function mount(title: string | undefined): Promise<void> {
  setStorageBackend(memoryBackend);
  seedUnrelatedAnnouncementsSeen();
  configStore.loadFromBackend();
  globalThis.fetch = makeFetch(title);
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
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("review --title: the tab", () => {
  test("with a title: the tab shows it, not the repository", async () => {
    await mount("PR 12 · refunds");
    expect(document.title).toBe("PR 12 · refunds");
  });

  test("without a title: the tab names the repository, as before", async () => {
    await mount(undefined);
    expect(document.title).toBe("acme/payments-service · Code Review");
  });
});
