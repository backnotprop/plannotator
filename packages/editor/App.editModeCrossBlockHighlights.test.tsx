/**
 * Editing a word the reviewer did not annotate must not cost them every
 * cross-block highlight.
 *
 * `applyEditedDocument` re-anchors annotations against the new parse by looking
 * for a block whose content CONTAINS the quote — which no single block ever
 * does for a quote spanning two of them — so every cross-block annotation has
 * its stored positions stripped on every edit-mode commit, whether or not the
 * edit touched it. Text search is then the only path left, and until block
 * boundaries were normalized on both sides it could not bridge one either: a
 * one-word edit in an unannotated list item silently unpainted every
 * cross-block comment and toasted "n annotations no longer match the text".
 *
 * Mounts the real App so the edit session, the remap and the repaint are the
 * shipped ones.
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

const PLAN = [
  "# Edit mode target",
  "",
  "Alpha paragraph one ends at ALPHAEND.",
  "",
  "Beta paragraph two opens at BETASTART.",
  "",
  "- First list item about logging behaviour",
  "- Second list item about retry",
].join("\n");

const CROSS_BLOCK_QUOTE =
  "Alpha paragraph one ends at ALPHAEND.\n\nBeta paragraph two opens at BETASTART.";

/** A recovered draft holding one comment that spans the two paragraphs. The
 *  positions are absent on purpose: that is the state an edit-mode commit
 *  leaves every cross-block annotation in, so the restore path under test is
 *  the text search either way. */
const DRAFT = {
  annotations: [
    {
      id: "annCrossBlock",
      blockId: "",
      startOffset: 0,
      endOffset: CROSS_BLOCK_QUOTE.length,
      type: "COMMENT",
      text: "these two paragraphs disagree",
      originalText: CROSS_BLOCK_QUOTE,
      createdA: 1,
    },
  ],
  globalAttachments: [],
  ts: 1,
};

function fetchForPlan(plan: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname === "/api/plan") return Response.json(plan);
    if (url.pathname === "/api/archive/plans") return Response.json({ plans: [] });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") {
      if (method === "GET") return Response.json(DRAFT);
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** The App defers every highlight repaint behind a `setTimeout(…, 100)`, so a
 *  run of zero-delay macrotasks is not enough to see one land. */
async function settleRepaint(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) await settle(60);
}

async function mount(plan: Record<string, unknown>): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = fetchForPlan(plan);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 20; attempt += 1) await settle();
}

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);

/** Everything painted for one annotation, in document order. */
const paintedText = (id: string): string =>
  Array.from(document.querySelectorAll<HTMLElement>(
    `[data-bind-id="${id}"], [data-highlight-id="${id}"]`,
  )).map((el) => el.textContent ?? "").join("");

function pressModE(target: EventTarget): void {
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key: "e",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  }));
}

/** CodeMirror's EditorView, via the DOM back-reference EditorView.findFromDOM
 *  reads (@codemirror/view is not a dependency of this package). */
function editorView(): { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } {
  const content = document.querySelector<HTMLElement>(".cm-editor .cm-content");
  if (!content) throw new Error("CodeMirror content DOM did not render");
  const backRef = content as unknown as {
    cmTile?: { view?: { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } };
    cmView?: { view?: { state: { doc: { toString(): string } }; dispatch(spec: unknown): void } };
  };
  const view = backRef.cmTile?.view ?? backRef.cmView?.view;
  if (!view) throw new Error("EditorView not found from CodeMirror DOM back-reference");
  return view;
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

describe.if(hasDom)("edit mode and cross-block highlights", () => {
  test("a word edited outside every annotated span keeps them painted", async () => {
    await mount({
      plan: PLAN,
      origin: "claude-code",
      mode: "annotate",
      filePath: "/tmp/edit-cross-block.md",
      sharingEnabled: false,
      serverConfig: {},
    });

    const restore = findButton("Restore");
    if (!restore) throw new Error("Draft recovery dialog did not offer Restore");
    await act(async () => { restore.click(); });
    await settleRepaint();

    expect(paintedText("annCrossBlock")).toContain("ALPHAEND");
    expect(paintedText("annCrossBlock")).toContain("BETASTART");

    await act(async () => { pressModE(document.body); });
    const view = editorView();
    const source = view.state.doc.toString();
    const at = source.indexOf("logging");
    expect(at).toBeGreaterThan(-1);
    await act(async () => {
      view.dispatch({ changes: { from: at, to: at + "logging".length, insert: "tracing" } });
    });
    for (let attempt = 0; attempt < 10; attempt += 1) await settle();

    const content = document.querySelector<HTMLElement>(".cm-editor .cm-content");
    if (!content) throw new Error("CodeMirror content DOM went away mid-session");
    await act(async () => { pressModE(content); });
    await settleRepaint();

    // The edit landed, and the untouched comment is still painted over both
    // paragraphs rather than listed in the panel with no highlight.
    expect(document.body.textContent).toContain("tracing behaviour");
    expect(paintedText("annCrossBlock")).toContain("ALPHAEND");
    expect(paintedText("annCrossBlock")).toContain("BETASTART");
  });
});
