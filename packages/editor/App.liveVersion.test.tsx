/**
 * #2037: an agent's edit to the file open in annotate becomes a version, so
 * the +N/-M badge shows the edit in the same session. Driven through the real
 * App against a fetch double and a scripted file-watch stream (DOM_TESTS=1).
 *
 * Regressions each test guards:
 *  - A disk change that reloads the text must ask the server to save it as a
 *    version, naming the hash of the text on screen, and the badge must then
 *    diff against the version before the edit.
 *  - A burst of writes must save ONE version (the settle delay), for the last
 *    text, not one per write.
 *  - A session the server does not advertise for (`liveVersions` absent:
 *    PLANNOTATOR_ANNOTATE_HISTORY=0, a data file, an older server) must never
 *    post.
 *  - A file with no version yet (empty at open: no versionInfo) must still
 *    post once text arrives, since the server makes it version 1.
 *  - "Reload from disk" after a conflict puts the agent's text on screen
 *    through another path; it must ask for the version too.
 *  - A refused save (the file moved on, `409 stale`) must change nothing.
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

if (hasDom) {
  document.cookie = "plannotator-look-feel-announcement-seen=2; path=/";
  document.cookie = "plannotator-announce-tui-herdr-seen=1; path=/";
  document.cookie = "plannotator-announce-inbox-seen=1; path=/";
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

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

const streams: StubEventSource[] = [];
class StubEventSource {
  readonly readyState = 1;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  constructor(readonly url: string | URL) {
    streams.push(this);
  }
  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

const DIR = "/docs";
const PATH = "/docs/notes.md";
const V1 = "# Notes\n\nFirst line sentinel alpha.\n";
const V2 = "# Notes\n\nFirst line sentinel alpha.\n\nAgent wrote bravo.\n";
const V3 = "# Notes\n\nFirst line sentinel alpha.\n\nAgent wrote charlie.\n";

const hashOf = (text: string) => `hash-${text.length}-${text.charCodeAt(text.length - 2)}`;

const sourceSave = (text: string) => ({
  enabled: true as const,
  kind: "local-text-file" as const,
  scope: "single-file" as const,
  path: PATH,
  basename: "notes.md",
  language: "markdown" as const,
  hash: hashOf(text),
  mtimeMs: text.length,
  size: text.length,
  eol: "lf" as const,
});

const server = {
  disk: V1,
  history: true,
  /** versionInfo on /api/plan (false: a file that had no version at open). */
  opened: true,
  stale: false,
  saves: [] as Array<Record<string, unknown>>,
};

function makeFetch(): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") {
      return Response.json({
        plan: V1,
        origin: "claude-code",
        mode: "annotate",
        filePath: PATH,
        sourceSave: sourceSave(V1),
        renderAs: "markdown",
        ...(server.history && server.opened ? { previousPlan: null, versionInfo: { version: 1, totalVersions: 1, project: "demo" } } : {}),
        ...(server.history ? { liveVersions: true } : {}),
        sharingEnabled: false,
        serverConfig: {},
      });
    }
    if (url.pathname === "/api/doc") {
      return Response.json({ markdown: server.disk, filepath: PATH, renderAs: "markdown", sourceSave: sourceSave(server.disk) });
    }
    if (url.pathname === "/api/plan/versions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      server.saves.push(body);
      if (server.stale) return Response.json({ ok: false, code: "stale" }, { status: 409 });
      return Response.json({
        ok: true,
        saved: true,
        previousPlan: V1,
        versionInfo: { version: 2, totalVersions: 2, project: "demo" },
      });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const badge = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.title === "Changes since you last reviewed this file",
  );

function stream(): StubEventSource {
  const found = streams.find((s) => String(s.url).includes("/api/reference/files/stream"));
  if (!found) throw new Error("no file-watch stream");
  return found;
}

/** The agent writes the file; the watcher reports its folder changed. */
async function agentWrites(text: string): Promise<void> {
  server.disk = text;
  await act(async () => {
    stream().onmessage?.({ data: JSON.stringify({ type: "changed", dirPath: DIR }) } as MessageEvent);
  });
}

async function mount(): Promise<void> {
  setStorageBackend(memoryBackend);
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  globalThis.fetch = makeFetch();
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  await waitFor(() => document.body.textContent!.includes("sentinel alpha"));
  await waitFor(() => streams.some((s) => String(s.url).includes("/api/reference/files/stream")));
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  streams.length = 0;
  server.disk = V1;
  server.history = true;
  server.opened = true;
  server.stale = false;
  server.saves = [];
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

function pressModE(target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "e", metaKey: true, bubbles: true, cancelable: true }));
}

/** CodeMirror's EditorView through its DOM back-reference. */
function editorView(): { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } {
  const content = document.querySelector<HTMLElement>(".cm-editor .cm-content");
  if (!content) throw new Error("CodeMirror content DOM did not render");
  const backRef = content as unknown as {
    cmTile?: { view?: { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } };
    cmView?: { view?: { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } };
  };
  const view = backRef.cmTile?.view ?? backRef.cmView?.view;
  if (!view) throw new Error("EditorView not found");
  return view;
}

const buttonNamed = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === label);

describe.if(hasDom)("annotate: a disk change becomes a version (#2037)", () => {
  test("a burst of agent writes saves one version and the badge shows the edit", async () => {
    await mount();
    expect(badge()).toBeUndefined();

    await agentWrites(V2);
    await waitFor(() => document.body.textContent!.includes("bravo"));
    await agentWrites(V3);
    await waitFor(() => document.body.textContent!.includes("charlie"));

    await waitFor(() => server.saves.length > 0, 4000);
    // One save, for the text on screen once the writes settled.
    await wait(1000);
    expect(server.saves).toHaveLength(1);
    expect(server.saves[0]).toMatchObject({ hash: hashOf(V3) });

    await waitFor(() => badge() !== undefined);
    // V1 -> V3: the agent's blank line and sentence.
    expect(badge()!.textContent).toContain("+2/-0");
  }, 15000);

  test("a session without version history never posts", async () => {
    server.history = false;
    await mount();
    await agentWrites(V2);
    await waitFor(() => document.body.textContent!.includes("bravo"));
    await wait(1200);
    expect(server.saves).toHaveLength(0);
    expect(badge()).toBeUndefined();
  }, 15000);

  test("a file with no version yet saves its first one", async () => {
    server.opened = false;
    await mount();
    await agentWrites(V2);
    await waitFor(() => server.saves.length === 1, 4000);
    expect(server.saves[0]).toMatchObject({ hash: hashOf(V2) });
  }, 15000);

  test("Reload from disk after a conflict saves the agent's text as a version", async () => {
    await mount();
    // The reviewer has an unsaved edit in Edit Mode...
    await act(async () => { pressModE(document.body); });
    await waitFor(() => !!document.querySelector(".cm-editor .cm-content"));
    const view = editorView();
    const at = view.state.doc.toString().indexOf("sentinel");
    await act(async () => {
      view.dispatch({ changes: { from: at, to: at + "sentinel".length, insert: "reviewer" } });
    });
    // ...when the agent writes the file: a conflict, nothing saved yet.
    await agentWrites(V2);
    await waitFor(() => buttonNamed("Reload from disk") !== undefined, 4000);
    await wait(1000);
    expect(server.saves).toHaveLength(0);

    await act(async () => buttonNamed("Reload from disk")!.click());
    await waitFor(() => server.saves.length === 1, 4000);
    expect(server.saves[0]).toMatchObject({ hash: hashOf(V2) });
  }, 15000);

  test("a refused save leaves the diff as it was", async () => {
    server.stale = true;
    await mount();
    await agentWrites(V2);
    await waitFor(() => server.saves.length === 1, 4000);
    await wait(100);
    expect(badge()).toBeUndefined();
  }, 15000);
});
