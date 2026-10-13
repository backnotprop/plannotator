/**
 * A draft restored after the file was edited must export TRUE line numbers.
 *
 * Annotate drafts follow the file's path (#1710), so a reviewer's comments
 * come back after an agent edits the file. They re-anchor by their text, but
 * their stored `blockId` is positional (`block-N`), and the export turns it
 * into a line label: after lines were inserted above, "(line 3) Feedback on:
 * 'The retry loop…'" pointed at whatever block-1 now was, while the text sat
 * on line 11. A comment whose text was deleted got the same confident wrong
 * label, and no "Unanchored" chip either, because the restore only reported
 * a comment whose stored positions resolved onto the WRONG text, not one they
 * did not resolve at all.
 *
 * Covered here through the real App: Restore, then Send Feedback, reading the
 * posted feedback. The third test pins that an unchanged document exports
 * exactly what it exported before the fix.
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
import { exportAnnotations, parseMarkdownToBlocks } from "@plannotator/ui/utils/parser";
import type { Annotation } from "@plannotator/ui/types";

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

/** The file when the reviewer commented on it. */
const ORIGINAL = [
  "# Chip notes",
  "",
  "The retry loop backs off too slowly.",
  "",
  "Cache keys collide on Windows paths.",
].join("\n");

/** The same file after an agent edit: lines inserted above both comments,
 *  the retry sentence extended, the cache sentence rewritten (its quote gone). */
const EDITED = [
  "# Chip notes",
  "",
  "Added context paragraph one.",
  "",
  "## Background",
  "",
  "Another inserted paragraph.",
  "",
  "- a new list item",
  "",
  "The retry loop backs off too slowly, so double it.",
  "",
  "Cache keys now hash the full path.",
].join("\n");

/** The 1-based line `needle` sits on in `doc`. */
const lineOf = (doc: string, needle: string): number =>
  doc.split("\n").findIndex((line) => line.includes(needle)) + 1;

/** Two comments made on ORIGINAL, as the draft stored them. */
const DRAFT_ANNOTATIONS: Annotation[] = [
  {
    id: "annRetry",
    blockId: "block-1",
    startOffset: 0,
    endOffset: 14,
    type: "COMMENT" as Annotation["type"],
    text: "make it exponential",
    originalText: "The retry loop",
    createdA: 1,
    startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 0 },
    endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 14 },
  },
  {
    id: "annCache",
    blockId: "block-2",
    startOffset: 11,
    endOffset: 29,
    type: "COMMENT" as Annotation["type"],
    text: "normalize separators",
    originalText: "collide on Windows",
    createdA: 2,
    startMeta: { parentTagName: "P", parentIndex: 1, textOffset: 11 },
    endMeta: { parentTagName: "P", parentIndex: 1, textOffset: 29 },
  },
  // No stored positions (Edit Mode's remap drops them when a block moves), so
  // a restore can only search for the quote. When the search fails nothing
  // is painted at all — the case that used to raise no chip.
  {
    id: "annPaths",
    blockId: "block-2",
    startOffset: 22,
    endOffset: 35,
    type: "COMMENT" as Annotation["type"],
    text: "what about UNC paths",
    originalText: "Windows paths",
    createdA: 3,
  },
];

interface FeedbackBody {
  feedback?: string;
  annotations?: Array<{ id?: string; blockId?: string }>;
}

let submissions: FeedbackBody[] = [];
let draftAnnotations: Annotation[] = DRAFT_ANNOTATIONS;

function fetchFor(document: string): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname === "/api/plan") {
      return Response.json({
        plan: document,
        origin: "claude-code",
        mode: "annotate",
        filePath: "/tmp/chip.md",
        sharingEnabled: false,
        serverConfig: {},
      });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") {
      if (method === "GET") {
        return Response.json({ annotations: draftAnnotations, globalAttachments: [], ts: 1 });
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/feedback") {
      submissions.push(JSON.parse(String(init?.body ?? "{}")) as FeedbackBody);
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
  // SAFETY: the app only ever calls fetch(input, init).
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Highlight repaints are deferred behind a `setTimeout(…, 100)`. */
async function settleRepaint(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) await settle(60);
}

async function mountAndRestore(document_: string): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = fetchFor(document_);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 20; attempt += 1) await settle();

  const restore = Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === "Restore");
  if (!restore) throw new Error("Draft recovery dialog did not offer Restore");
  await act(async () => { restore.click(); });
  await settleRepaint();
}

async function sendFeedback(): Promise<FeedbackBody> {
  const primary = document.querySelector<HTMLButtonElement>("[data-decision-primary]");
  if (!primary) throw new Error("decision control did not render");
  await act(async () => { primary.click(); });
  for (let attempt = 0; attempt < 10 && submissions.length === 0; attempt += 1) await settle(10);
  if (submissions.length !== 1) throw new Error(`expected one feedback post, saw ${submissions.length}`);
  return submissions[0]!;
}

/** The numbered entry heading that quotes `quote`. */
const entryHeading = (feedback: string, quote: string): string => {
  const line = feedback.split("\n").find((l) => /^#+ \d+\. /.test(l) && l.includes(quote));
  if (!line) throw new Error(`no entry quoting "${quote}" in:\n${feedback}`);
  return line;
};

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) document.body.replaceChildren();
  submissions = [];
  draftAnnotations = DRAFT_ANNOTATIONS;
  memory.clear();
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("restoring a draft across a file edit", () => {
  test("the export labels each comment with the line its text is on now", async () => {
    await mountAndRestore(EDITED);

    // The comment whose text survived is painted where the text now is.
    expect(document.querySelector('[data-bind-id="annRetry"], [data-highlight-id="annRetry"]'))
      .not.toBeNull();

    const body = await sendFeedback();
    const feedback = body.feedback ?? "";
    const retryLine = lineOf(EDITED, "The retry loop");
    expect(retryLine).toBe(11);
    expect(entryHeading(feedback, "The retry loop")).toContain(`(line ${retryLine}) `);
    // block-1 is now "Added context paragraph one." on line 3: the old label.
    expect(feedback).not.toContain("(line 3)");
  });

  test("comments whose text was deleted are chipped Unanchored and export with no line label", async () => {
    await mountAndRestore(EDITED);

    for (const id of ["annCache", "annPaths"]) {
      expect(document.querySelector(`[data-bind-id="${id}"], [data-highlight-id="${id}"]`)).toBeNull();
    }
    // One chip each: annCache's positions resolved onto other text, annPaths
    // had none to try. Both are equally absent from the document.
    expect(document.querySelectorAll("[data-annotation-unanchored]").length).toBe(2);
    expect(document.body.textContent).toContain("normalize separators");
    expect(document.body.textContent).toContain("what about UNC paths");

    const body = await sendFeedback();
    const feedback = body.feedback ?? "";
    for (const [quote, comment] of [
      ["collide on Windows", "normalize separators"],
      ["Windows paths", "what about UNC paths"],
    ] as const) {
      // Still delivered — the reviewer's words are not dropped...
      expect(feedback).toContain(comment);
      // ...but with no line label: block-2 now names "## Background" (line 5).
      expect(entryHeading(feedback, `"${quote}"`)).not.toContain("(line");
    }
  });

  test("an unchanged document exports exactly what it did before", async () => {
    await mountAndRestore(ORIGINAL);

    expect(document.querySelectorAll("[data-annotation-unanchored]").length).toBe(0);

    const body = await sendFeedback();
    const expected = exportAnnotations(
      parseMarkdownToBlocks(ORIGINAL),
      DRAFT_ANNOTATIONS,
      [],
      "File Feedback",
      "file",
    );
    expect(body.feedback).toContain(expected);
    expect(expected).toContain(`(line ${lineOf(ORIGINAL, "The retry loop")}) `);
    // The stored anchors went out untouched.
    const sent = new Map((body.annotations ?? []).map((a) => [a.id, a.blockId]));
    expect(sent.get("annRetry")).toBe("block-1");
    expect(sent.get("annCache")).toBe("block-2");
    expect(sent.get("annPaths")).toBe("block-2");
  });

  test("diff-view comments and checkbox toggles are not restored as text, chipped or moved", async () => {
    // A checkbox toggle quotes its list item's raw markdown and is keyed by
    // that block; a diff-view comment's blockId indexes the version diff.
    // Neither is a text highlight, so a restore must leave both alone.
    const doc = [ORIGINAL, "", "- [ ] Ship **the** fix"].join("\n");
    const task = parseMarkdownToBlocks(doc).find((b) => b.content.includes("Ship"));
    if (!task) throw new Error("task block did not parse");
    const checkboxId = `ann-checkbox-${task.id}-1`;
    draftAnnotations = [
      DRAFT_ANNOTATIONS[0]!,
      {
        id: checkboxId,
        blockId: task.id,
        startOffset: 0,
        endOffset: task.content.length,
        type: "COMMENT" as Annotation["type"],
        text: `Mark as completed: ${task.content}`,
        originalText: task.content,
        createdA: 4,
      },
      {
        id: "annDiff",
        blockId: "diff-block-0",
        startOffset: 0,
        endOffset: 12,
        type: "COMMENT" as Annotation["type"],
        text: "why was this dropped?",
        originalText: "Removed line",
        createdA: 5,
        diffContext: "removed",
      },
    ];
    await mountAndRestore(doc);

    expect(document.querySelectorAll("[data-annotation-unanchored]").length).toBe(0);

    const body = await sendFeedback();
    const sent = new Map((body.annotations ?? []).map((a) => [a.id, a.blockId]));
    expect(sent.get(checkboxId)).toBe(task.id);
    expect(sent.get("annDiff")).toBe("diff-block-0");
    expect(sent.get("annRetry")).toBe("block-1");
  });
});
