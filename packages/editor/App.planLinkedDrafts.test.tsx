/**
 * Plan review with linked documents: a recovered draft brings back every
 * document's comments, each on its own document (#1545).
 *
 * What regresses if this fails:
 *  - Draft Recovered counts only the plan's comments, and a linked
 *    document's comments never come back (or come back on the plan);
 *  - the restored copy is read and merged a second time when the document is
 *    opened, or written back unchanged;
 *  - opening a linked document with no comments makes the plan's draft go
 *    empty, which deletes it;
 *  - Dismiss leaves the linked documents' copies behind, so dismissed
 *    comments come back when a document is opened.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";

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

function seedAnnouncementsSeen(): void {
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
  memory.set("plannotator-permission-mode-configured", "true");
}

class SilentEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = SilentEventSource.OPEN;
  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  constructor(url: string | URL) {
    this.url = String(url);
  }
  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

const DESIGN_PATH = "/tmp/plan-project/docs/design.md";
const EMPTY_PATH = "/tmp/plan-project/docs/empty.md";

const PLAN = "# Plan\n\nRead [the design](docs/design.md) and [the empty page](docs/empty.md) first.\n";

const PLAN_COMMENT = {
  id: "plan-comment",
  blockId: "",
  startOffset: 0,
  endOffset: 4,
  type: "COMMENT",
  text: "PLAN_COMMENT_SENTINEL",
  originalText: "Read",
  createdA: 1,
};

const DESIGN_COMMENT = {
  id: "design-comment",
  blockId: "",
  startOffset: 0,
  endOffset: 6,
  type: "COMMENT",
  text: "DESIGN_COMMENT_SENTINEL",
  originalText: "Design",
  createdA: 2,
};

interface Recorded { method: string; path: string; search: string; body?: string }
const requests: Recorded[] = [];

/** What GET /api/draft answers in the current test. */
let sessionDraft: unknown = null;

const fakeFetch: typeof fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
  const url = new URL(rawUrl, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  requests.push({ method, path: url.pathname, search: url.search, body: typeof init?.body === "string" ? init.body : undefined });
  if (url.pathname === "/api/plan") {
    return Response.json({
      plan: PLAN,
      origin: "claude-code",
      documentDrafts: true,
      sharingEnabled: false,
      projectRoot: "/tmp/plan-project",
      serverConfig: {},
    });
  }
  if (url.pathname === "/api/doc") {
    const requested = url.searchParams.get("path") ?? "";
    return requested.includes("empty")
      ? Response.json({ markdown: "# Empty\n\nNothing to see here.\n", filepath: EMPTY_PATH, renderAs: "markdown" })
      : Response.json({ markdown: "# Design\n\nDesign body text.\n", filepath: DESIGN_PATH, renderAs: "markdown" });
  }
  if (url.pathname === "/api/draft/document" && method === "GET") {
    return Response.json({ found: false, error: "No draft" }, { status: 404 });
  }
  if (url.pathname === "/api/draft" && method === "GET") {
    return sessionDraft ? Response.json(sessionDraft) : Response.json({ found: false }, { status: 404 });
  }
  if (url.pathname === "/api/archive/plans") return Response.json({ plans: [] });
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  return Response.json({ ok: true });
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = fakeFetch;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 20; attempt += 1) await settle();
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) document.body.replaceChildren();
  memory.clear();
  requests.length = 0;
  sessionDraft = null;
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

async function clickLink(text: string): Promise<void> {
  const link = Array.from(document.querySelectorAll("a")).find((a) => a.textContent?.includes(text));
  if (!link) throw new Error(`link "${text}" not rendered`);
  await act(async () => { link.click(); });
  // Past the 500ms debounce of both draft writers.
  for (let attempt = 0; attempt < 14; attempt += 1) await settle(60);
}

async function answerBanner(label: "Restore" | "Dismiss"): Promise<void> {
  const button = findButton(label);
  if (!button) throw new Error(`Draft recovery dialog did not offer ${label}`);
  await act(async () => { button.click(); });
  for (let attempt = 0; attempt < 6; attempt += 1) await settle(60);
}

const sessionSaves = (since = 0) => requests.slice(since).filter((r) => r.path === "/api/draft" && r.method === "POST");
const documentWrites = (since = 0) =>
  requests.slice(since).filter((r) => r.path === "/api/draft/document" && r.method === "POST")
    .map((r) => JSON.parse(r.body ?? "{}") as { documents: { path: string; annotations: { id: string }[] }[] });

describe.if(hasDom)("plan review: linked documents in a recovered draft", () => {
  test("Draft Recovered offers the linked document's comment and restores it on that document", async () => {
    sessionDraft = {
      annotations: [PLAN_COMMENT],
      globalAttachments: [],
      documents: [{ path: DESIGN_PATH, annotations: [DESIGN_COMMENT], globalAttachments: [] }],
      draftGeneration: 3,
      ts: Date.now(),
    };
    await mount();
    expect(document.body.textContent).toContain("Found 2 annotations (including comments on 1 linked document)");
    await answerBanner("Restore");
    for (let attempt = 0; attempt < 10; attempt += 1) await settle(60);

    // The plan's own draft carries the plan's comment and never the design's.
    const saves = sessionSaves();
    expect(saves.length).toBeGreaterThan(0);
    for (const save of saves) {
      expect(save.body ?? "").toContain("PLAN_COMMENT_SENTINEL");
      expect(save.body ?? "").not.toContain("DESIGN_COMMENT_SENTINEL");
    }

    const since = requests.length;
    await clickLink("the design");
    // The design's comment is on the design (shown in its panel), already
    // restored: its copy is not read and merged again, nor written back.
    expect(document.body.textContent).toContain("DESIGN_COMMENT_SENTINEL");
    expect(requests.slice(since).some((r) => r.path === "/api/draft/document" && r.method === "GET")).toBe(false);
    expect(documentWrites(since)).toEqual([]);
  });

  test("a draft with comments only on a linked document does not claim the plan has some", async () => {
    sessionDraft = {
      annotations: [],
      globalAttachments: [],
      documents: [{ path: DESIGN_PATH, annotations: [DESIGN_COMMENT], globalAttachments: [] }],
      draftGeneration: 3,
      ts: Date.now(),
    };
    await mount();
    expect(document.body.textContent).toContain("Found 1 annotation on 1 linked document");
    expect(document.body.textContent).not.toContain("including");
  });

  test("opening a linked document with no comments never deletes the plan's draft", async () => {
    sessionDraft = { annotations: [PLAN_COMMENT], globalAttachments: [], draftGeneration: 1, ts: Date.now() };
    await mount();
    await answerBanner("Restore");
    const since = requests.length;
    await clickLink("the empty page");

    expect(requests.slice(since).some((r) => r.path === "/api/draft" && r.method === "DELETE")).toBe(false);
    for (const save of sessionSaves(since)) expect(save.body ?? "").toContain("PLAN_COMMENT_SENTINEL");
  });

  test("Dismiss discards the linked documents' copies too", async () => {
    sessionDraft = {
      annotations: [PLAN_COMMENT],
      globalAttachments: [],
      documents: [{ path: DESIGN_PATH, annotations: [DESIGN_COMMENT], globalAttachments: [] }],
      draftGeneration: 3,
      ts: Date.now(),
    };
    await mount();
    await answerBanner("Dismiss");

    expect(requests.some((r) => r.path === "/api/draft" && r.method === "DELETE")).toBe(true);
    const cleared = documentWrites().flatMap((w) => w.documents);
    expect(cleared).toEqual([{ path: DESIGN_PATH, annotations: [], globalAttachments: [] }]);
  });
});
