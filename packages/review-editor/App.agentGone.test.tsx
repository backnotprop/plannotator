/**
 * Code review's page when the server says its agent is gone (DOM_TESTS=1):
 * `session-closed` with `by: "gone"` on the external-annotations stream
 * (packages/server/review.ts `announceAgentGone`).
 *
 * Regressions guarded: the page staying editable after its server quit (a
 * keystroke typed there is lost); the ended screen missing, or worded as the
 * agent's own close; a review with no comments claiming some were saved.
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
import { REVIEW_ENDED_TITLE, reviewEndedSubtitle } from "./components/ReviewEnded";

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

function diffPayload(origin: string, agentTool: Record<string, unknown> | undefined) {
  return {
    rawPatch: PATCH,
    gitRef: "HEAD",
    snapshotId: "snap-1",
    origin,
    diffType: "uncommitted",
    hideWhitespace: false,
    gitContext: {
      vcsType: "git",
      defaultBranch: "main",
      currentBranch: "feature/parser",
      diffOptions: [{ id: "uncommitted", label: "Uncommitted" }],
    },
    serverConfig: { ...(agentTool ?? {}) },
  };
}

const streams: StubEventSource[] = [];

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1;
  constructor() {
    streams.push(this);
  }
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

let configPosts: unknown[] = [];
let draftPosts = 0;

function makeFetch(origin: string, agentTool: Record<string, unknown> | undefined): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init).
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/diff") return Response.json(diffPayload(origin, agentTool));
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/config" && init?.method === "POST") {
      configPosts.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft" && init?.method === "POST") {
      draftPosts += 1;
      return Response.json({ ok: true });
    }
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

/** Retire every earlier one-time announcement, Ask this session included. */
function seedEarlierChainSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-announce-ask-session-seen", "1");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-token-hover-announcement-seen", "1");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

async function mount(origin: string, agentTool: Record<string, unknown> | undefined): Promise<void> {
  setStorageBackend(memoryBackend);
  configStore.loadFromBackend();
  globalThis.fetch = makeFetch(origin, agentTool);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 40 && !document.body.textContent?.includes("parse.ts"); attempt += 1) {
    await settle();
  }
  for (let attempt = 0; attempt < 10; attempt += 1) await settle();
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
}


async function closeStream(event: Record<string, unknown>): Promise<void> {
  await act(async () => {
    for (const stream of streams) stream.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  });
  for (let attempt = 0; attempt < 5; attempt += 1) await settle();
}

afterEach(async () => {
  await unmount();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  configPosts = [];
  draftPosts = 0;
  streams.length = 0;
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("a code review whose agent is gone", () => {
  test("the page is covered by the ended screen: no comment can be typed into a review that cannot save it", async () => {
    seedEarlierChainSeen();
    await mount("claude-code", undefined);
    expect(document.querySelector("[data-completion-state]")).toBeNull();
    expect(streams.length).toBeGreaterThan(0);

    await closeStream({ type: "session-closed", by: "gone", unsentAnnotations: 0 });

    const screen = document.querySelector<HTMLElement>("[data-completion-state]");
    expect(screen?.getAttribute("data-completion-state")).toBe("exited");
    expect(screen?.textContent).toContain(REVIEW_ENDED_TITLE);
    expect(screen?.textContent).toContain(reviewEndedSubtitle(0));
    // No comments: nothing to copy, no claim that a draft holds some.
    expect(screen?.querySelector("[data-review-ended-copy]")).toBeNull();
    expect(screen?.textContent).not.toContain("saved as a draft");
    expect(draftPosts).toBe(0);
  });

  test("the agent's own close keeps its own screen", async () => {
    seedEarlierChainSeen();
    await mount("claude-code", undefined);
    await closeStream({ type: "session-closed", by: "agent", unsentAnnotations: 0 });
    const screen = document.querySelector<HTMLElement>("[data-completion-state]");
    expect(screen).not.toBeNull();
    expect(screen?.textContent).not.toContain(REVIEW_ENDED_TITLE);
  });
});
