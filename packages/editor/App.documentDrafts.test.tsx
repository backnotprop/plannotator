/**
 * A linked document's saved comments come back when it is opened
 * (per-document draft copies, hooks/useDocumentDrafts.ts).
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
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
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

const ROOT_PATH = "/tmp/docdrafts/index.md";
const LINKED_PATH = "/tmp/docdrafts/other.md";

const SAVED_COMMENT = {
  id: "saved-on-other",
  blockId: "",
  startOffset: 0,
  endOffset: 10,
  type: "COMMENT",
  text: "SAVED_COMMENT_SENTINEL",
  originalText: "Other body",
  createdA: 1,
};

/** A comment on the ROOT document, recovered from the session draft. */
const ROOT_COMMENT = {
  id: "root-comment",
  blockId: "",
  startOffset: 0,
  endOffset: 3,
  type: "COMMENT",
  text: "ROOT_COMMENT_SENTINEL",
  originalText: "See",
  createdA: 1,
};

interface Recorded { method: string; path: string; search: string; body?: string }
const requests: Recorded[] = [];

/** What GET /api/draft/document answers in the current test. */
let documentCopy: { status: number; body: unknown } = {
  status: 200,
  body: { found: true, annotations: [SAVED_COMMENT], globalAttachments: [] },
};

const fakeFetch: typeof fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
  const url = new URL(rawUrl, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  requests.push({ method, path: url.pathname, search: url.search, body: typeof init?.body === "string" ? init.body : undefined });
  if (url.pathname === "/api/plan") {
    return Response.json({
      plan: "# Index\n\nSee [the other doc](other.md) for details.\n",
      origin: "claude-code",
      mode: "annotate",
      filePath: ROOT_PATH,
      documentDrafts: true,
      sharingEnabled: false,
      serverConfig: {},
    });
  }
  if (url.pathname === "/api/doc") {
    return Response.json({ markdown: "# Other\n\nOther body text.\n", filepath: LINKED_PATH, renderAs: "markdown" });
  }
  if (url.pathname === "/api/draft/document" && method === "GET") {
    return Response.json(documentCopy.body, { status: documentCopy.status });
  }
  if (url.pathname === "/api/draft" && method === "GET") {
    return Response.json({ annotations: [ROOT_COMMENT], globalAttachments: [], draftGeneration: 1, ts: 1 });
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
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

/** Restore the root's comment from the session draft, then open the linked document. */
async function restoreRootThenOpenLinked(): Promise<number> {
  await mount();
  const restore = findButton("Restore");
  if (!restore) throw new Error("Draft recovery dialog did not offer Restore");
  await act(async () => { restore.click(); });
  for (let attempt = 0; attempt < 6; attempt += 1) await settle(60);
  const link = Array.from(document.querySelectorAll("a")).find((a) => a.textContent?.includes("the other doc"));
  if (!link) throw new Error("linked document link not rendered");
  const before = requests.length;
  await act(async () => { link.click(); });
  // Past the 500ms debounce of both draft writers.
  for (let attempt = 0; attempt < 14; attempt += 1) await settle(60);
  return before;
}

const documentWrites = (since = 0) =>
  requests.slice(since).filter((r) => r.path === "/api/draft/document" && r.method === "POST")
    .map((r) => JSON.parse(r.body ?? "{}") as { documents: { path: string; annotations: { id: string }[] }[] });

describe.if(hasDom)("per-document draft copies", () => {
  test("opening a linked document merges its saved comments in, and the session draft stays the root's", async () => {
    documentCopy = { status: 200, body: { found: true, annotations: [SAVED_COMMENT], globalAttachments: [] } };
    const since = await restoreRootThenOpenLinked();

    const read = requests.find((r) => r.path === "/api/draft/document" && r.method === "GET");
    expect(read?.search).toContain(encodeURIComponent(LINKED_PATH));
    // The saved comment is now the open document's (listed in the panel).
    expect(document.body.textContent).toContain("SAVED_COMMENT_SENTINEL");

    // While the linked document is open, the session draft still carries the
    // ROOT's comment and never the linked document's.
    const sessionSaves = requests.slice(since).filter((r) => r.path === "/api/draft" && r.method === "POST");
    expect(sessionSaves.length).toBeGreaterThan(0);
    for (const save of sessionSaves) {
      expect(save.body ?? "").toContain("ROOT_COMMENT_SENTINEL");
      expect(save.body ?? "").not.toContain("SAVED_COMMENT_SENTINEL");
    }
    // The merged copy is never written back empty (or at all: it is unchanged).
    for (const write of documentWrites()) {
      for (const doc of write.documents) {
        if (doc.path === LINKED_PATH) expect(doc.annotations.length).toBeGreaterThan(0);
      }
    }
  });

  test("a change on the open linked document is written to its path copy", async () => {
    documentCopy = { status: 200, body: { found: true, annotations: [SAVED_COMMENT], globalAttachments: [] } };
    await restoreRootThenOpenLinked();
    const before = requests.length;

    const remove = document.querySelector<HTMLButtonElement>('button[title="Delete annotation"]');
    if (!remove) throw new Error("merged comment has no Delete control");
    await act(async () => { remove.click(); });
    for (let attempt = 0; attempt < 12; attempt += 1) await settle(60);

    const writes = documentWrites(before).flatMap((w) => w.documents).filter((d) => d.path === LINKED_PATH);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)?.annotations).toEqual([]);
  });

  test("comments on a document the server keeps no copy for ride the session draft", async () => {
    // An Obsidian vault document, or a symlink alias of the root: 403.
    documentCopy = { status: 403, body: { error: "Path not allowed" } };
    await mount();
    const link = Array.from(document.querySelectorAll("a")).find((a) => a.textContent?.includes("the other doc"));
    if (!link) throw new Error("linked document link not rendered");
    await act(async () => { link.click(); });
    for (let attempt = 0; attempt < 6; attempt += 1) await settle(60);
    // Restoring while the linked document is open puts the comment on it.
    const restore = findButton("Restore");
    if (!restore) throw new Error("Draft recovery dialog did not offer Restore");
    await act(async () => { restore.click(); });
    for (let attempt = 0; attempt < 14; attempt += 1) await settle(60);

    const sessionSaves = requests.filter((r) => r.path === "/api/draft" && r.method === "POST");
    expect(sessionSaves.at(-1)?.body ?? "").toContain("ROOT_COMMENT_SENTINEL");
    expect(documentWrites()).toEqual([]);
  });
});

