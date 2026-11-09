/**
 * Guided Review: ticking a section "Reviewed" marks its files viewed (#1786),
 * across the whole review app (DOM_TESTS=1).
 *
 * Regressions guarded: the tick saving only itself (files stay unviewed, the
 * reviewer marks them again in All files); a file the guide splits across
 * chapters being checked off before its other chapters are read; un-ticking
 * unmarking files the reviewer already saw; the mark skipping durable
 * review progress (`POST /api/review-progress`) or, in PR mode, GitHub's
 * Viewed state (`POST /api/pr-viewed`); either guide source (a live guide job,
 * a saved `saved:{id}` guide) not doing it.
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

// Vite-only virtual module (`?worker&inline`): stubbed like App.panelView.test.tsx.
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

function filePatch(path: string): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    "index 0000001..0000002 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ];
}

const PATCH = [...filePatch("src/a.ts"), ...filePatch("src/b.ts"), ...filePatch("src/c.ts"), ""].join("\n");

// src/b.ts is split across chapters 1 and 2; src/gone.ts is a stale ref (not
// in the diff on screen).
const GUIDE = {
  title: "Parser rework",
  intent: "Why the parser changed.",
  sections: [
    { title: "Core", overview: "Core change.", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
    { title: "Callers", overview: "Callers follow.", diffs: [{ file: "src/b.ts" }, { file: "src/c.ts" }, { file: "src/gone.ts" }] },
  ],
  reviewed: [false, false],
};

const PR_METADATA = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "parser",
  number: 7,
  title: "Parser rework",
  author: "someone-else",
  baseBranch: "main",
  headBranch: "feature/parser",
  baseSha: "1111111111111111111111111111111111111111",
  headSha: "2222222222222222222222222222222222222222",
  url: "https://github.com/acme/parser/pull/7",
};

function diffPayload(pr: boolean) {
  return {
    rawPatch: PATCH,
    gitRef: "HEAD",
    snapshotId: "snap-1",
    origin: "claude-code",
    diffType: "uncommitted",
    hideWhitespace: false,
    ...(pr
      ? { prMetadata: PR_METADATA }
      : {
          gitContext: {
            vcsType: "git",
            defaultBranch: "main",
            currentBranch: "feature/parser",
            diffOptions: [{ id: "uncommitted", label: "Uncommitted" }],
          },
        }),
    serverConfig: {},
  };
}

const LIVE_JOB = {
  id: "job-1",
  provider: "guide",
  status: "done",
  label: "Guided Review",
  command: [],
  cwd: "/repo",
  startedAt: 1,
  endedAt: 2,
};

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: StubEventSource[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

interface Calls {
  progress: Array<{ key: string; changes: Array<{ path: string; viewed: boolean; fingerprint: string }> }>;
  prViewed: Array<{ filePaths: string[]; viewed: boolean }>;
  reviewedPuts: Array<{ url: string; reviewed: boolean[] }>;
}

let calls: Calls = { progress: [], prViewed: [], reviewedPuts: [] };

function makeFetch(pr: boolean): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init).
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    const method = init?.method ?? "GET";
    const body = () => JSON.parse(String(init?.body));
    if (url.pathname === "/api/diff") return Response.json(diffPayload(pr));
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/review-progress") {
      if (method === "POST") {
        calls.progress.push(body());
        return Response.json({ ok: true });
      }
      return Response.json({
        available: true,
        key: "scope-1",
        fingerprints: { "src/a.ts": "fa", "src/b.ts": "fb", "src/c.ts": "fc" },
        viewedFiles: [],
        suppressedFiles: [],
      });
    }
    if (url.pathname === "/api/pr-viewed" && method === "POST") {
      calls.prViewed.push(body());
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/agents/capabilities") return Response.json({ available: true, providers: [] });
    if (url.pathname === "/api/guides") {
      return Response.json([
        { id: "g1", label: "PR #7", title: "Parser rework", savedAt: 1, progress: { reviewed: 0, total: 2 }, moved: false },
      ]);
    }
    if (url.pathname.endsWith("/reviewed") && method === "PUT") {
      calls.reviewedPuts.push({ url: url.pathname, reviewed: body().reviewed });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/guide/job-1" || url.pathname === "/api/guide/saved:g1") {
      return Response.json({ ...GUIDE, saved: true });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Retire every one-time announcement so nothing covers the guide. */
function seedAnnouncementsSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-announce-ask-session-seen", "1");
  memory.set("plannotator-announce-agent-tool-seen", "1");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-token-hover-announcement-seen", "1");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

async function mount(pr: boolean): Promise<void> {
  seedAnnouncementsSeen();
  setStorageBackend(memoryBackend);
  configStore.loadFromBackend();
  globalThis.fetch = makeFetch(pr);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  await waitFor(() => !!document.body.textContent?.includes("a.ts"), "the diff");
  await settle(10);
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
}

/** Push a done guide job through the agent-jobs stream: the guide auto-opens. */
async function openLiveGuide(): Promise<void> {
  const stream = StubEventSource.instances.find((es) => es.url.includes("/api/agents/jobs/stream"));
  if (!stream) throw new Error("agent jobs stream not opened");
  await act(async () => {
    stream.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "snapshot", jobs: [LIVE_JOB] }) }));
  });
  await waitFor(() => tickButtons().length === 2, "the guide's sections");
}

/** Open the guide takeover, then the saved guide from "Previous guides". */
async function openSavedGuide(): Promise<void> {
  const guideButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => b.title === "Open guided review");
  if (!guideButton) throw new Error("Guide button did not render");
  await act(async () => guideButton.click());
  let entry: HTMLButtonElement | undefined;
  await waitFor(() => {
    entry = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent?.includes("PR #7") && b.textContent?.includes("Parser rework"));
    return !!entry;
  }, "the saved guide entry");
  await act(async () => entry!.click());
  await waitFor(() => tickButtons().length === 2, "the guide's sections");
}

function tickButtons(): HTMLButtonElement[] {
  // One per section: the open card's "Reviewed" button (title), or the
  // collapsed card's checkbox (aria-label) once a section is ticked.
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[title$="as reviewed"], button[aria-label$="as reviewed"]'),
  );
}

async function tick(index: number): Promise<void> {
  const button = tickButtons()[index];
  if (!button) throw new Error(`section ${index} has no Reviewed control`);
  await act(async () => button.click());
  await settle(5);
}

function viewedWrites(): Array<{ path: string; viewed: boolean }> {
  return calls.progress.flatMap((request) => request.changes.map(({ path, viewed }) => ({ path, viewed })));
}

afterEach(async () => {
  await unmount();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  StubEventSource.instances = [];
  memory.clear();
  calls = { progress: [], prViewed: [], reviewedPuts: [] };
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("Guided Review: ticking a section marks its files viewed", () => {
  test("live guide job: a file is marked once every chapter showing it is ticked; un-ticking unmarks nothing", async () => {
    await mount(false);
    await openLiveGuide();

    // Chapter 1 shows a.ts and half of b.ts: only a.ts is fully read.
    await tick(0);
    expect(viewedWrites()).toEqual([{ path: "src/a.ts", viewed: true }]);
    expect(calls.progress[0].key).toBe("scope-1");
    expect(calls.progress[0].changes[0].fingerprint).toBe("fa");

    // Chapter 2 completes b.ts and shows c.ts; the stale ref is skipped.
    await tick(1);
    expect(viewedWrites()).toEqual([
      { path: "src/a.ts", viewed: true },
      { path: "src/b.ts", viewed: true },
      { path: "src/c.ts", viewed: true },
    ]);

    // Un-ticking keeps the files viewed.
    await tick(0);
    expect(viewedWrites().some((write) => !write.viewed)).toBe(false);
    expect(viewedWrites()).toHaveLength(3);

    // Local review: no platform sync.
    expect(calls.prViewed).toEqual([]);

    // The tick still saves itself (debounced PUT).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(calls.reviewedPuts.at(-1)).toEqual({ url: "/api/guide/job-1/reviewed", reviewed: [false, true] });
  });

  test("saved guide in PR mode: the marks also sync GitHub's Viewed state", async () => {
    await mount(true);
    await openSavedGuide();

    await tick(1);
    // Chapter 2 alone: c.ts is complete, b.ts still has chapter 1 to go.
    expect(viewedWrites()).toEqual([{ path: "src/c.ts", viewed: true }]);
    expect(calls.prViewed).toEqual([{ filePaths: ["src/c.ts"], viewed: true }]);

    await tick(0);
    expect(viewedWrites()).toEqual([
      { path: "src/c.ts", viewed: true },
      { path: "src/a.ts", viewed: true },
      { path: "src/b.ts", viewed: true },
    ]);
    expect(calls.prViewed).toEqual([
      { filePaths: ["src/c.ts"], viewed: true },
      { filePaths: ["src/a.ts", "src/b.ts"], viewed: true },
    ]);
  });
});
