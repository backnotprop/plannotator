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

function fetchForPlan(plan: Record<string, unknown>): typeof fetch {
  return async (input) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") return Response.json(plan);
    if (url.pathname === "/api/archive/plans") return Response.json({ plans: [] });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(plan: Record<string, unknown>): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = fetchForPlan(plan);
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 10; attempt += 1) await settle();
}

const ANNOTATE_PLAN = {
  plan: "# Scroll target\n\nFirst body paragraph.\n\n## Second section\n\nSecond body paragraph.\n",
  origin: "claude-code",
  mode: "annotate",
  filePath: "/tmp/scroll.md",
  sharingEnabled: false,
  serverConfig: {},
};

const documentViewport = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('main[data-print-region="document"]');

const editorScroller = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(".cm-editor .cm-scroller");

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);

function saveLabel(): string | undefined {
  const button = Array.from(document.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.startsWith("Saving"));
  if (!button) return undefined;
  return Array.from(button.querySelectorAll("span"))
    .map((span) => span.textContent ?? "")
    .find((text) => text === "Saved" || text === "Save");
}

function pressModE(target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key: "e",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  }));
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
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("Mod+E edit-mode toggle", () => {
  test("enters edit mode from the viewer, commits and returns when pressed inside the editor", async () => {
    await mount(ANNOTATE_PLAN);
    expect(document.querySelector(".cm-editor")).toBeNull();

    await act(async () => { pressModE(document.body); });
    const scroller = editorScroller();
    expect(scroller).not.toBeNull();

    const content = document.querySelector<HTMLElement>(".cm-editor .cm-content");
    if (!content) throw new Error("CodeMirror content DOM did not render");
    await act(async () => { pressModE(content); });
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(document.body.textContent).toContain("Scroll target");
  });

  test("carries the scroll offset across both swaps", async () => {
    await mount(ANNOTATE_PLAN);

    const viewport = documentViewport();
    if (!viewport) throw new Error("Document viewport did not render");

    const written: number[] = [];
    let current = 0;
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => current,
      set: (next: number) => { current = next; written.push(next); },
    });

    viewport.scrollTop = 480;
    written.length = 0;
    await act(async () => { pressModE(document.body); });
    expect(document.querySelector(".cm-editor")).not.toBeNull();
    expect(written).toContain(480);

    viewport.scrollTop = 260;
    written.length = 0;
    const content = document.querySelector<HTMLElement>(".cm-editor .cm-content");
    if (!content) throw new Error("CodeMirror content DOM did not render");
    await act(async () => { pressModE(content); });
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(written).toContain(260);
  });

  test("is a no-op on a read-only surface", async () => {
    await mount({
      plan: "# Archived document\n\nRead-only body.\n",
      origin: "claude-code",
      mode: "archive",
      archivePlans: [],
      sharingEnabled: false,
      serverConfig: {},
    });

    await act(async () => { pressModE(document.body); });
    expect(document.querySelector(".cm-editor")).toBeNull();
  });

  test("leaves the chord to a foreign text field, but still exits from CodeMirror", async () => {
    await mount(ANNOTATE_PLAN);

    await act(async () => { pressModE(document.body); });
    const content = document.querySelector<HTMLElement>(".cm-editor .cm-content");
    if (!content) throw new Error("CodeMirror content DOM did not render");

    const foreign = document.createElement("textarea");
    document.body.appendChild(foreign);
    try {
      await act(async () => { pressModE(foreign); });
      expect(document.querySelector(".cm-editor")).not.toBeNull();
    } finally {
      foreign.remove();
    }

    await act(async () => { pressModE(content); });
    expect(document.querySelector(".cm-editor")).toBeNull();
  });

  test("never discards an unsaved source-backed buffer silently", async () => {
    await mount({
      plan: "# Source document\n\nEditable body.\n",
      origin: "claude-code",
      mode: "annotate",
      filePath: "/tmp/source.md",
      sourceSave: {
        enabled: true,
        kind: "local-text-file",
        scope: "single-file",
        path: "/tmp/source.md",
        basename: "source.md",
        language: "markdown",
        hash: "sha256:source",
        mtimeMs: 1_000,
        size: 32,
        eol: "lf",
      },
      sharingEnabled: false,
      serverConfig: {},
    });

    await act(async () => { pressModE(document.body); });
    const content = document.querySelector<HTMLElement>(".cm-editor .cm-content");
    if (!content) throw new Error("CodeMirror content DOM did not render");
    expect(saveLabel()).toBe("Saved");

    const backRef = content as unknown as {
      cmTile?: { view?: { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } };
      cmView?: { view?: { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } };
    };
    const view = backRef.cmTile?.view ?? backRef.cmView?.view;
    if (!view) throw new Error("EditorView not found from CodeMirror DOM back-reference");
    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.toString().trimEnd().length, insert: "x" },
      });
    });
    for (let attempt = 0; attempt < 40 && saveLabel() !== "Save"; attempt += 1) {
      await settle();
    }
    expect(saveLabel()).toBe("Save");
    expect(findButton("Cancel")).not.toBeUndefined();

    await act(async () => { pressModE(content); });
    expect(document.querySelector(".cm-editor")).not.toBeNull();
    expect(findButton("Cancel")).not.toBeUndefined();
    expect(content.textContent).toContain("Editable body.x");
  });
});
