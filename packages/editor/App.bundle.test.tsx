/**
 * A review of several files (annotate-bundle) in the editor: the first file
 * opens by itself, the switcher and the file list follow the given order
 * (never sorted), Next moves to the following file, and one Send Feedback
 * carries one section per file in bundle order with each comment once.
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

const ROOT = "/tmp/bundle-review";
// Given in this order on purpose: sorted by name, alpha would come first.
const BETA = `${ROOT}/docs/beta.md`;
const ALPHA = `${ROOT}/alpha.md`;
const TEXT: Record<string, string> = {
  [BETA]: "# Beta\n\nBeta body text.\n",
  [ALPHA]: "# Alpha\n\nAlpha body text.\n",
};

/** A saved comment on each file, merged in when the file opens. */
const savedComment = (path: string) => ({
  id: `saved-${path.endsWith("beta.md") ? "beta" : "alpha"}`,
  blockId: "",
  startOffset: 0,
  endOffset: 4,
  type: "COMMENT",
  text: path.endsWith("beta.md") ? "BETA_COMMENT_SENTINEL" : "ALPHA_COMMENT_SENTINEL",
  originalText: path.endsWith("beta.md") ? "Beta" : "Alpha",
  createdA: 1,
});

interface Recorded { method: string; path: string; search: URLSearchParams; body?: string }
const requests: Recorded[] = [];

const fakeFetch: typeof fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
  const url = new URL(rawUrl, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  requests.push({ method, path: url.pathname, search: url.searchParams, body: typeof init?.body === "string" ? init.body : undefined });
  if (url.pathname === "/api/plan") {
    return Response.json({
      plan: "",
      origin: "claude-code",
      mode: "annotate-bundle",
      bundle: [
        { path: BETA, renderAs: "markdown" },
        { path: ALPHA, renderAs: "markdown" },
      ],
      filePath: ROOT,
      projectRoot: ROOT,
      documentDrafts: true,
      sharingEnabled: false,
      serverConfig: {},
    });
  }
  if (url.pathname === "/api/doc") {
    const path = url.searchParams.get("path") ?? "";
    return Response.json({ markdown: TEXT[path] ?? "", filepath: path, renderAs: "markdown" });
  }
  if (url.pathname === "/api/draft/document" && method === "GET") {
    const path = url.searchParams.get("path") ?? "";
    return Response.json({ found: true, annotations: [savedComment(path)], globalAttachments: [] });
  }
  if (url.pathname === "/api/draft" && method === "GET") return Response.json({ found: false }, { status: 404 });
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

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (check()) return;
    await settle(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const switcherText = () => document.querySelector("[data-bundle-switcher]")?.textContent ?? "";

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
  await waitFor(() => switcherText().includes("1 of 2"), "the first file to open");
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

const docRequests = () => requests.filter((r) => r.path === "/api/doc").map((r) => r.search.get("path"));

// --- Edit Mode against a real annotate server -------------------------------
//
// The capability comes from the server (`sourceSave` on /api/doc), so these
// tests run the real Bun annotate server in bundle mode over temp files, as a
// child process (testing/annotateBundleServer.ts) under a temp
// PLANNOTATOR_DATA_DIR, and route the page's requests to it.

interface RealBundle {
  dir: string;
  first: string;
  second: string;
  stop: () => Promise<void>;
}

async function startRealBundle(): Promise<RealBundle> {
  const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-bundle-edit-")));
  mkdirSync(join(dir, "work/docs"), { recursive: true });
  const first = join(dir, "work/docs/first.md");
  const second = join(dir, "work/second.md");
  writeFileSync(first, "# First\n\nFirst body text.\n");
  writeFileSync(second, "# Second\n\nSecond body text.\n");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("PLANNOTATOR_") && key !== "DOM_TESTS") env[key] = value;
  }
  env.PLANNOTATOR_DATA_DIR = join(dir, "data");
  env.PLANNOTATOR_REMOTE = "0";
  env.PLANNOTATOR_AI = "disabled";
  env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "testing/annotateBundleServer.ts"), join(dir, "work"), first, second],
    { env, stdout: "pipe", stderr: "inherit" },
  );
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the annotate server exited before it was ready");
    buffered += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const server = JSON.parse(buffered.slice(0, buffered.indexOf("\n"))) as { url: string };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, path: url.pathname, search: url.searchParams, body });
    // Bun's own fetch: happy-dom replaces the global one.
    const answer = await Bun.fetch(`${server.url}${url.pathname}${url.search}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
    });
    return new Response(await answer.text(), { status: answer.status, headers: { "Content-Type": answer.headers.get("Content-Type") ?? "application/json" } });
  }) as typeof fetch;
  return {
    dir,
    first,
    second,
    stop: async () => {
      child.kill("SIGTERM");
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function mountAgainstRealServer(): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  await waitFor(() => switcherText().includes("1 of 2"), "the first file to open");
}

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

/** The Save control carries a width-reserving "Saving" ghost span in front of its live label. */
const saveButton = (): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.startsWith("Saving"));

/** The mounted CodeMirror view, from its DOM back-reference (see App.editModeShortcut.test.tsx). */
function editorView(): { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } {
  const content = document.querySelector<HTMLElement>(".cm-editor .cm-content");
  if (!content) throw new Error("CodeMirror content DOM did not render");
  const backRef = content as unknown as {
    cmTile?: { view?: ReturnType<typeof editorView> };
    cmView?: { view?: ReturnType<typeof editorView> };
  };
  const view = backRef.cmTile?.view ?? backRef.cmView?.view;
  if (!view) throw new Error("EditorView not found from CodeMirror DOM back-reference");
  return view;
}

describe.if(hasDom)("annotate bundle Edit Mode", () => {
  let bundle: RealBundle | null = null;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    await bundle?.stop();
    bundle = null;
  });

  test("Edit Mode is offered on a bundle file and saves back to that file", async () => {
    bundle = await startRealBundle();
    const { readFileSync } = await import("node:fs");
    await mountAgainstRealServer();

    await waitFor(() => !!findButton("Edit"), "Edit Mode to be offered on the first file");
    await act(async () => { findButton("Edit")!.click(); });
    await waitFor(() => !!document.querySelector(".cm-editor"), "the editor");

    const view = editorView();
    await act(async () => {
      view.dispatch({ changes: { from: view.state.doc.toString().trimEnd().length, insert: " Edited." } });
    });
    await waitFor(() => !!saveButton()?.textContent?.includes("Save") && !saveButton()?.disabled, "the Save control");
    await act(async () => { saveButton()!.click(); });
    await waitFor(() => readFileSync(bundle!.first, "utf-8").includes("Edited."), "the save to reach the file");
    expect(readFileSync(bundle.first, "utf-8")).toBe("# First\n\nFirst body text. Edited.\n");
    expect(readFileSync(bundle.second, "utf-8")).toBe("# Second\n\nSecond body text.\n");
    const saveRequest = requests.find((r) => r.path === "/api/source/save");
    expect(JSON.parse(saveRequest?.body ?? "{}").path).toBe(bundle.first);
  });

  test("its switcher sibling is editable too", async () => {
    bundle = await startRealBundle();
    await mountAgainstRealServer();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Next file"]')!.click();
    });
    await waitFor(() => switcherText().includes("2 of 2"), "the second file");
    await waitFor(() => !!findButton("Edit"), "Edit Mode to be offered on the second file");
  });
});

describe.if(hasDom)("annotate bundle", () => {
  test("the first file opens by itself; the switcher and the file list keep the given order", async () => {
    await mount();
    expect(docRequests()[0]).toBe(BETA);
    expect(switcherText()).toContain("beta.md");
    expect(document.querySelector('[aria-label="Previous file"]')?.hasAttribute("disabled")).toBe(true);

    // The Files tab lists exactly the bundle, unsorted (beta before alpha),
    // labelled relative to the files' common directory.
    const items = Array.from(document.querySelectorAll<HTMLElement>(".file-tree-item")).map((el) => el.getAttribute("title"));
    expect(items).toEqual(["docs/beta.md", "alpha.md"]);
    // The bundle's directory is never walked as a folder.
    expect(requests.some((r) => r.path === "/api/reference/files")).toBe(false);
    // A bundle file has no in-document Close pill (it led to the folder's
    // empty "choose a file" state); the switcher moves between the files.
    const closePills = Array.from(document.querySelectorAll("button")).filter(
      (button) => button.textContent?.trim() === "Close" && button.className.includes("text-[9px]"),
    );
    expect(closePills).toHaveLength(0);
  });

  test("Next opens the following file, and one Send Feedback has one section per file in bundle order", async () => {
    await mount();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Next file"]')!.click();
    });
    await waitFor(() => switcherText().includes("2 of 2"), "the second file");
    expect(switcherText()).toContain("alpha.md");
    expect(docRequests()).toContain(ALPHA);
    // Both files' saved comments are in the session now.
    await waitFor(() => !!document.querySelector("[data-decision-primary]")?.textContent?.includes("Send Feedback"), "Send Feedback");

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-decision-primary]")!.click();
    });
    await waitFor(() => requests.some((r) => r.path === "/api/feedback"), "the decision");
    const body = JSON.parse(requests.find((r) => r.path === "/api/feedback")!.body ?? "{}") as {
      feedback: string;
      annotations: { id: string; documentPath?: string }[];
    };

    // One section per file, in the order given (beta, then alpha), each comment once.
    const betaAt = body.feedback.indexOf(`## ${BETA}`);
    const alphaAt = body.feedback.indexOf(`## ${ALPHA}`);
    expect(betaAt).toBeGreaterThan(-1);
    expect(alphaAt).toBeGreaterThan(betaAt);
    expect(body.feedback.split("BETA_COMMENT_SENTINEL")).toHaveLength(2);
    expect(body.feedback.split("ALPHA_COMMENT_SENTINEL")).toHaveLength(2);
    expect(body.annotations.map((a) => [a.id, a.documentPath]).sort()).toEqual([
      ["saved-alpha", ALPHA],
      ["saved-beta", BETA],
    ]);
  });
});
