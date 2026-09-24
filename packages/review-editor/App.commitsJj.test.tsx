/**
 * The Commits view in a jj session (DOM_TESTS=1): the same detour contract
 * git sessions have, over the jj diff family.
 *
 * Regressions each test guards:
 *  - The Commits segment is missing in a jj session (the reported bug: a jj
 *    repo colocated with .git picks the jj provider first, and the view was
 *    gated to `vcsType === 'git'`).
 *  - Entering the view auto-opens the top row as `jj-commit:<id>` — never
 *    git's `commit:<sha>`, which the git provider owns and a jj session's
 *    server rejects — and leaving it to Tree restores the jj diff the
 *    session was on.
 *  - A reload that lands on a jj-commit diff snaps back to the session
 *    default once, exactly like a git commit diff.
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

const patchFor = (path: string) => [
  `diff --git a/${path} b/${path}`,
  "index 0000001..0000002 100644",
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");

const HEAD_ID = "1".repeat(40);
const PARENT_ID = "2".repeat(40);

const JJ_CONTEXT = {
  vcsType: "jj",
  currentBranch: "",
  defaultBranch: "trunk()",
  diffOptions: [
    { id: "jj-current", label: "Current change" },
    { id: "jj-last", label: "Last change" },
    { id: "jj-line", label: "Line of work" },
    { id: "jj-all", label: "All files" },
  ],
  worktrees: [],
};

const COMMITS_PAGE = {
  commits: [
    { sha: HEAD_ID, shortSha: "kmqzsnwp", subject: "wire the parser", author: "Rail Test", authorEmail: "r@example.invalid", committedAt: Date.now(), isHead: true, isPastBase: false },
    { sha: PARENT_ID, shortSha: "vvsznypo", subject: "base", author: "Rail Test", authorEmail: "r@example.invalid", committedAt: Date.now(), isHead: false, isPastBase: true },
  ],
  hasMore: false,
  base: "main@origin",
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

let switchRequests: Array<{ diffType: string; base?: string }> = [];

function makeFetch(initialDiffType: string): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init); the double implements
  // that call signature and not `fetch.preconnect`.
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/diff") {
      return Response.json({
        rawPatch: patchFor("src/current.ts"),
        gitRef: "Current change",
        snapshotId: "snap-1",
        origin: "claude-code",
        diffType: initialDiffType,
        base: "trunk()",
        hideWhitespace: false,
        gitContext: JJ_CONTEXT,
      });
    }
    if (url.pathname === "/api/diff/switch") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { diffType: string; base?: string };
      switchRequests.push(body);
      const isCommit = body.diffType.startsWith("jj-commit:");
      return Response.json({
        rawPatch: patchFor(isCommit ? "src/parser.ts" : "src/current.ts"),
        gitRef: isCommit ? "Commit kmqzsnwp — wire the parser" : "Current change",
        snapshotId: `snap-${switchRequests.length + 1}`,
        diffType: body.diffType,
        base: "trunk()",
        hideWhitespace: false,
        ...(isCommit && {
          commitInfo: {
            sha: HEAD_ID,
            shortSha: "kmqzsnwp",
            subject: "wire the parser",
            body: "",
            author: "Rail Test",
            authorEmail: "r@example.invalid",
            committedAt: Date.now(),
          },
        }),
      });
    }
    if (url.pathname === "/api/commits") return Response.json(COMMITS_PAGE);
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 60 && !check(); attempt += 1) await settle();
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

function seedUnrelatedAnnouncementsSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-token-hover-announcement-seen", "1");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

async function mount(initialDiffType = "jj-current"): Promise<void> {
  setStorageBackend(memoryBackend);
  seedUnrelatedAnnouncementsSeen();
  configStore.loadFromBackend();
  switchRequests = [];
  globalThis.fetch = makeFetch(initialDiffType);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  await waitFor(() => !!panelSegment("Tree"), "the panel view toggle");
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

describe.if(hasDom)("Commits view in a jj session", () => {
  test("offers Commits, opens the top row as jj-commit, and restores the jj diff on exit", async () => {
    await mount();
    // jj has no git status sections; the Commits segment is the new one.
    expect(panelSegment("Git status")).toBeUndefined();
    const commits = panelSegment("Commits");
    expect(commits).toBeDefined();

    await act(async () => commits!.click());
    await waitFor(() => switchRequests.length > 0, "the auto-select switch");
    expect(switchRequests[0].diffType).toBe(`jj-commit:${HEAD_ID}`);
    // The working copy row carries jj's own badge.
    await waitFor(() => document.body.textContent?.includes("wire the parser") ?? false, "the rail");
    const badges = Array.from(document.querySelectorAll("span")).map((el) => el.textContent?.trim());
    expect(badges).toContain("@");
    expect(badges).not.toContain("HEAD");

    await act(async () => panelSegment("Tree")!.click());
    await waitFor(() => switchRequests.length > 1, "the restore switch");
    expect(switchRequests[1].diffType).toBe("jj-current");
  });

  test("a reload that lands on a jj-commit diff snaps back to the session default", async () => {
    await mount(`jj-commit:${HEAD_ID}`);
    await waitFor(() => switchRequests.length > 0, "the snap-back switch");
    // The persisted default (a git type) is not offered here, so the jj
    // session's first option is where the review resumes.
    expect(switchRequests[0].diffType).toBe("jj-current");
  });
});
