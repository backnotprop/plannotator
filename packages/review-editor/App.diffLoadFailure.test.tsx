/**
 * A review whose first GET /api/diff fails (DOM_TESTS=1).
 *
 * The page used to fall back to the built-in demo diff on any failure: the
 * person saw a TypeScript file nobody changed, and no Feedback button (the
 * decision controls need the session's origin), so the review could not be
 * answered (#940: the server ran out of memory building the diff). Guards:
 *  - a failed load shows the load error state with the server's reason, and
 *    no demo file;
 *  - Retry loads the diff again and the review opens on the real files;
 *  - feedback and Close still reach the server from the error state;
 *  - untracked files the server left out are counted in one visible line.
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
import { UNTRACKED_CAP_STUB_MARKER } from "@plannotator/shared/diff-paths";
import { DEMO_DIFF } from "./demoData";

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

function leftOutStub(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    UNTRACKED_CAP_STUB_MARKER,
    "new file mode 100644",
    `Binary files /dev/null and b/${path} differ`,
    "",
  ].join("\n");
}

/** The first file path of the demo diff: what the old fallback showed. */
const DEMO_PATH = /^diff --git a\/(\S+)/m.exec(DEMO_DIFF)?.[1] ?? "";

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

interface Posted { path: string; body: unknown }

/** /api/diff answers each scripted response in turn (the last one repeats). */
function makeFetch(diffAnswers: Array<() => Response>, posted: Posted[]): typeof fetch {
  let diffCalls = 0;
  // SAFETY: the app only ever calls fetch(input, init); the double implements
  // that call signature and not `fetch.preconnect`.
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (init?.method === "POST") {
      posted.push({ path: url.pathname, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/diff") {
      const answer = diffAnswers[Math.min(diffCalls, diffAnswers.length - 1)];
      diffCalls += 1;
      return answer();
    }
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

const failing = () => new Response("Internal Server Error: Out of memory", { status: 500, headers: { "Content-Type": "text/plain" } });
const serving = (rawPatch: string) => () => Response.json({
  rawPatch,
  gitRef: "uncommitted",
  snapshotId: "snap-1",
  origin: "claude-code",
  diffType: "uncommitted",
  hideWhitespace: false,
  repoInfo: { display: "acme/payments-service", branch: "add-refund-flow" },
});

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

async function mount(diffAnswers: Array<() => Response>, posted: Posted[] = []): Promise<void> {
  setStorageBackend(memoryBackend);
  seedUnrelatedAnnouncementsSeen();
  configStore.loadFromBackend();
  globalThis.fetch = makeFetch(diffAnswers, posted);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found as HTMLButtonElement;
}

const errorState = () => document.querySelector("[data-review-load-error='']");

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

describe.if(hasDom)("review: the diff fails to load", () => {
  test("shows the server's reason and never the demo diff", async () => {
    expect(DEMO_PATH).not.toBe("");
    await mount([failing]);
    await waitFor(() => errorState() !== null, "the load error state");
    expect(document.querySelector("[data-review-load-error-message]")?.textContent).toContain("Out of memory");
    expect(document.body.textContent).not.toContain(DEMO_PATH);
  });

  test("Retry loads the diff and opens the review on the real files", async () => {
    await mount([failing, serving(PATCH)]);
    await waitFor(() => errorState() !== null, "the load error state");
    await act(async () => button("Retry").click());
    await waitFor(() => document.body.textContent?.includes("add-refund-flow") ?? false, "the review to load");
    expect(errorState()).toBeNull();
    expect(document.body.textContent).not.toContain(DEMO_PATH);
  });

  test("feedback and Close still reach the server", async () => {
    const posted: Posted[] = [];
    await mount([failing], posted);
    await waitFor(() => errorState() !== null, "the load error state");
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      // React tracks the value through the native setter.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "The diff broke; add dist/ to .gitignore");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Send Feedback").click());
    await waitFor(() => posted.length === 1, "the feedback post");
    expect(posted[0].path).toBe("/api/feedback");
    expect(posted[0].body).toMatchObject({ approved: false, feedback: "The diff broke; add dist/ to .gitignore", annotations: [] });

    if (root) await act(async () => root?.unmount());
    document.body.replaceChildren();
    posted.length = 0;
    await mount([failing], posted);
    await waitFor(() => errorState() !== null, "the load error state");
    await act(async () => button("Close review").click());
    await waitFor(() => posted.length === 1, "the exit post");
    expect(posted[0].path).toBe("/api/exit");
  });
});

describe.if(hasDom)("review: untracked files the server left out", () => {
  test("one line counts them", async () => {
    await mount([serving(PATCH + leftOutStub("dist/a.js") + leftOutStub("dist/b.js"))]);
    await waitFor(() => document.body.textContent?.includes("add-refund-flow") ?? false, "the review to load");
    const line = document.querySelector("[data-untracked-left-out]");
    expect(line?.getAttribute("data-untracked-left-out")).toBe("2");
    expect(line?.textContent).toContain("2 untracked files");
  });

  test("no line when nothing was left out", async () => {
    await mount([serving(PATCH)]);
    await waitFor(() => document.body.textContent?.includes("add-refund-flow") ?? false, "the review to load");
    expect(document.querySelector("[data-untracked-left-out]")).toBeNull();
  });
});
