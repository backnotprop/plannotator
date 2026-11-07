/**
 * Switching through an empty diff (DOM_TESTS=1): the diff pane must show the
 * new files at once, with no click on a file and no reload.
 *
 * Regression guarded (the owner's QA item 25): the dock only mounts while the
 * diff has files. Switching to a diff with 0 files unmounted it, but the App
 * kept the disposed dock's API; the next switch with files mounted a new dock
 * and the "open the All files panel" effect ran against the OLD api first,
 * spent its one-shot flag there, and the new dock stayed empty. The tree
 * filled, the centre pane stayed blank.
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

const HEAD_SHA = "1".repeat(40);

/** Which diff types have files. `merge-base` and the HEAD commit are empty. */
const PATCHES: Record<string, string> = {
  "since-base": patchFor("src/parse.ts"),
  uncommitted: patchFor("src/parse.ts"),
  "merge-base": "",
  [`commit:${HEAD_SHA}`]: "",
};

const GIT_CONTEXT = {
  vcsType: "git",
  defaultBranch: "main",
  currentBranch: "feature/parser",
  diffOptions: [
    { id: "since-base", label: "All changes" },
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "merge-base", label: "Committed changes" },
  ],
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

let switchRequests: string[] = [];

function makeFetch(initialDiffType: string): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init); the double implements
  // that call signature and not `fetch.preconnect`.
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/diff") {
      return Response.json({
        rawPatch: PATCHES[initialDiffType],
        gitRef: initialDiffType,
        snapshotId: "snap-1",
        origin: "claude-code",
        diffType: initialDiffType,
        base: "origin/main",
        hideWhitespace: false,
        gitContext: GIT_CONTEXT,
      });
    }
    if (url.pathname === "/api/diff/switch") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { diffType: string };
      switchRequests.push(body.diffType);
      const isCommit = body.diffType.startsWith("commit:");
      return Response.json({
        rawPatch: PATCHES[body.diffType] ?? "",
        gitRef: body.diffType,
        snapshotId: `snap-${switchRequests.length + 1}`,
        diffType: body.diffType,
        base: "origin/main",
        hideWhitespace: false,
        ...(isCommit && {
          commitInfo: {
            sha: HEAD_SHA,
            shortSha: "1111111",
            subject: "empty commit",
            body: "",
            author: "Rail Test",
            authorEmail: "r@example.invalid",
            committedAt: Date.now(),
          },
        }),
      });
    }
    if (url.pathname === "/api/commits") {
      return Response.json({
        commits: [
          { sha: HEAD_SHA, shortSha: "1111111", subject: "empty commit", author: "Rail Test", authorEmail: "r@example.invalid", committedAt: Date.now(), isHead: true, isPastBase: false },
        ],
        hasMore: false,
        base: "origin/main",
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

/** The dock's tab titles: the panel the centre pane shows lives in one of them. */
function dockTabs(): string[] {
  return Array.from(document.querySelectorAll(".dv-tab")).map((el) => el.textContent?.trim() ?? "");
}

// The every-change dock tab is titled "All changes" (approved design record
// "review-sidebar-header"), so it never reads like the All files scope.
const allFilesShown = () => dockTabs().some((title) => title.includes("All changes"));
const noChangesShown = () => document.body.textContent?.includes("No changes") ?? false;

function panelSegment(label: string): HTMLButtonElement | undefined {
  const group = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Panel view"]');
  return Array.from(group?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    .find((el) => el.textContent?.trim() === label);
}

/** Pick a diff type in the sidebar's diff-type menu, the way a reviewer does. */
async function pickDiffType(label: string): Promise<void> {
  const before = switchRequests.length;
  const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((el) => el.getAttribute("aria-haspopup") === "menu"
      && /^(All changes|Uncommitted changes|Committed changes)/.test(el.textContent?.trim() ?? ""));
  if (!trigger) throw new Error("diff type picker not found");
  await act(async () => trigger.click());
  await waitFor(() => document.querySelectorAll('[role="menuitem"]').length > 0, "the diff type menu");
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((el) => el.textContent?.trim().startsWith(label));
  if (!item) throw new Error(`diff type "${label}" not in the menu`);
  await act(async () => item.click());
  await waitFor(() => switchRequests.length > before, `the switch to ${label}`);
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

async function mount(initialDiffType: string): Promise<void> {
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

describe.if(hasDom)("switching through an empty diff", () => {
  test("full, then empty, then full: the All files panel comes back at once", async () => {
    await mount("since-base");
    await waitFor(allFilesShown, "the initial All files panel");

    await pickDiffType("Committed changes");
    await waitFor(noChangesShown, "the empty state");

    await pickDiffType("Uncommitted changes");
    await waitFor(() => !noChangesShown(), "the dock to come back");
    // The bug: the dock mounted again but no panel was ever added to it.
    await waitFor(allFilesShown, "the All files panel after the empty diff");
  });

  test("empty first, then full: the All files panel opens", async () => {
    await mount("merge-base");
    await waitFor(noChangesShown, "the empty state");

    await pickDiffType("Uncommitted changes");
    await waitFor(allFilesShown, "the All files panel");
  });

  test("a Commits rail visit to an empty commit, then back to Tree", async () => {
    await mount("since-base");
    await waitFor(allFilesShown, "the initial All files panel");

    await act(async () => panelSegment("Commits")!.click());
    await waitFor(() => switchRequests.includes(`commit:${HEAD_SHA}`), "the commit switch");
    await waitFor(noChangesShown, "the empty commit");

    await act(async () => panelSegment("Tree")!.click());
    await waitFor(() => switchRequests.length >= 2, "the restore switch");
    await waitFor(allFilesShown, "the All files panel after the empty commit");
  });
});
