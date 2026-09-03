/**
 * Annotate decision-control wiring (DOM_TESTS=1) — spec §8C/§8D annotate
 * payloads. Adapted from the held branch's App.submitNote.test.tsx harness.
 *
 * Regressions each test guards:
 *  - `Done` must post the byte-identical legacy `/api/feedback` body (the
 *    "no feedback" sentence + empty arrays): every existing CLI consumer's
 *    plain-mode output and the strict-gate exit codes branch on that shape
 *    (spec §5.3/§6.1). Routing it through /api/approve, or changing the
 *    sentence, breaks exit codes for every caller.
 *  - The note must reach the agent AS A GLOBAL COMMENT in both the exported
 *    feedback string AND the annotations array, one render after the commit —
 *    a same-tick submit sends the pre-note payload and silently drops it.
 *  - "Send a note…" (the collapsed non-gate composer) must post plain,
 *    unframed feedback: a note is a note, never a fabricated approval.
 *  - Gate mode's empty primary must approve through /api/approve (that is
 *    what makes a strict gate exit 0).
 *  - The discard confirm must drop the annotations from the posted body, not
 *    just relabel the submit.
 *  - Escape in the composer steps back without submitting and keeps the
 *    half-typed note.
 *  - Compact/touch must offer a visible positive decision row at zero (the
 *    #1436 review's silent-data-loss finding: touch has no Mod+Enter).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";
import { ANNOTATE_NO_FEEDBACK_SENTENCE } from "./annotateSubmission";

const hasDom = typeof document !== "undefined";

if (hasDom) {
  document.cookie = "plannotator-look-feel-announcement-seen=2; path=/";
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function seedAnnouncementsSeen(): void {
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
}

/** External annotations delivered as the stream's opening snapshot, so a test
 *  can seed the session with pre-existing feedback without driving the DOM
 *  annotation flow. Read by the EventSource double at construction time. */
let seededExternalAnnotations: unknown[] = [];

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = StubEventSource.OPEN;
  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    const payload = seededExternalAnnotations;
    if (payload.length > 0) {
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({ type: "snapshot", annotations: payload }),
        } as MessageEvent);
      }, 0);
    }
  }

  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

interface SubmittedBody {
  endpoint: "feedback" | "approve";
  feedback?: string;
  annotations?: Array<{ type?: string; text?: string; originalText?: string }>;
  codeAnnotations?: unknown[];
}

let submissions: SubmittedBody[] = [];
/** How many upcoming /api/feedback POSTs answer 500. Each failed attempt is
 *  still recorded in `submissions` so its captured body can be asserted. */
let failFeedbackPosts = 0;

const MARKDOWN = "# Notes\n\nSome body text.\n";

function annotatePlan(extra: Record<string, unknown> = {}) {
  return {
    plan: MARKDOWN,
    origin: "codex",
    mode: "annotate",
    filePath: "/tmp/notes.md",
    sharingEnabled: false,
    serverConfig: {},
    ...extra,
  };
}

function makeFetch(plan: unknown): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init); the double implements
  // that call signature and not `fetch.preconnect`.
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });

    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") return Response.json(plan);
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname === "/api/feedback" || url.pathname === "/api/approve") {
      submissions.push({
        endpoint: url.pathname === "/api/feedback" ? "feedback" : "approve",
        ...(JSON.parse(String(init?.body ?? "{}")) as Omit<SubmittedBody, "endpoint">),
      });
      if (url.pathname === "/api/feedback" && failFeedbackPosts > 0) {
        failFeedbackPosts -= 1;
        return Response.json({ error: "boom" }, { status: 500 });
      }
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function primaryButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-decision-primary]");
}

function caretButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-decision-caret]");
}

function noteInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>("[data-decision-note-input]");
}

function menuItem(labelPart: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find((el) => el.textContent?.includes(labelPart));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(plan: unknown, waitFor: () => unknown): Promise<void> {
  globalThis.fetch = makeFetch(plan);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 20 && !waitFor(); attempt += 1) {
    await settle();
  }
  if (!waitFor()) throw new Error("app did not finish mounting");
}

const mountAnnotate = (extra: Record<string, unknown> = {}) =>
  mount(annotatePlan(extra), () => caretButton());

async function openComposer(labelPart: string): Promise<void> {
  await act(async () => caretButton()!.click());
  await settle();
  const item = menuItem(labelPart);
  if (!item) throw new Error(`menu item containing "${labelPart}" not found`);
  await act(async () => item.click());
  await settle();
}

async function typeNote(text: string): Promise<void> {
  const input = noteInput();
  if (!input) throw new Error("note field is not open");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressNoteKey(key: string, init: KeyboardEventInit = {}): Promise<void> {
  const input = noteInput();
  if (!input) throw new Error("note field is not open");
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
  await settle();
}

function globalComments(body: SubmittedBody) {
  return (body.annotations ?? []).filter((a) => a.type === "GLOBAL_COMMENT");
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom && originalMatchMedia) window.matchMedia = originalMatchMedia;
  submissions = [];
  failFeedbackPosts = 0;
  seededExternalAnnotations = [];
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("annotate decision control", () => {
  test("Done at zero posts the byte-identical legacy /api/feedback body", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate();

    await act(async () => primaryButton()!.click());
    await settle();

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.endpoint).toBe("feedback"); // NEVER /api/approve (spec §5.3)
    expect(body.feedback).toBe(ANNOTATE_NO_FEEDBACK_SENTENCE);
    expect(body.annotations).toEqual([]);
    expect(body.codeAnnotations).toEqual([]);
  });

  test("Mod+Enter fires the same primary the header shows", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await settle();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.endpoint).toBe("feedback");
    expect(submissions[0]!.feedback).toBe(ANNOTATE_NO_FEEDBACK_SENTENCE);
  });

  test("Send a note… posts one GLOBAL_COMMENT without approval framing", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate();

    await openComposer("Send a note");
    await typeNote("tighten the intro");
    await pressNoteKey("Enter", { metaKey: true });

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.endpoint).toBe("feedback");
    const notes = globalComments(body);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("tighten the intro");
    expect(body.feedback).toContain("tighten the intro");
    expect(body.feedback!.startsWith(ANNOTATE_NO_FEEDBACK_SENTENCE)).toBe(false);
  });

  // Maintainer ruling (empty-menu collapse): the non-gate empty menu is ONE
  // composer. A resurrected "Done with a note…" row would silently split the
  // decision back into two costumes.
  test("the empty non-gate menu offers exactly one composer item", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate();

    await act(async () => caretButton()!.click());
    await settle();

    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items).toHaveLength(1);
    expect(menuItem("Done with a note")).toBeUndefined();
  });

  test("the note rides alongside annotations already in the session", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    seededExternalAnnotations = [{
      id: "ext-1",
      blockId: "",
      startOffset: 0,
      endOffset: 0,
      type: "COMMENT",
      text: "existing finding",
      originalText: "Some body text.",
      createdA: 1,
      source: "eslint",
    }];
    await mountAnnotate();
    await settle();
    await settle();

    await openComposer("Send with a note");
    await typeNote("also: ship it");
    await pressNoteKey("Enter", { metaKey: true });

    expect(submissions).toHaveLength(1);
    const annotations = submissions[0]!.annotations ?? [];
    expect(annotations.some((a) => a.text === "existing finding")).toBe(true);
    expect(annotations.some((a) => a.type === "GLOBAL_COMMENT" && a.text === "also: ship it")).toBe(true);
    expect(submissions[0]!.feedback).toContain("existing finding");
    expect(submissions[0]!.feedback).toContain("also: ship it");
  });

  test("gate: the empty primary approves through /api/approve", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate({ gate: true });

    await act(async () => primaryButton()!.click());
    await settle();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.endpoint).toBe("approve");
  });

  test("discard confirm drops the annotations from the posted body", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    seededExternalAnnotations = [{
      id: "ext-1",
      blockId: "",
      startOffset: 0,
      endOffset: 0,
      type: "COMMENT",
      text: "existing finding",
      originalText: "Some body text.",
      createdA: 1,
      source: "eslint",
    }];
    await mountAnnotate();
    await settle();
    await settle();

    await act(async () => caretButton()!.click());
    await settle();
    const discardItem = menuItem("discard 1 annotation");
    if (!discardItem) throw new Error("discard menu item not found");
    await act(async () => discardItem.click());
    await settle();

    // Frozen copy (maintainer-approved): 'Discard & finish' is the confirm.
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((el) => el.textContent === "Discard & finish");
    if (!confirm) throw new Error("discard confirm did not open");
    expect(submissions).toHaveLength(0); // nothing sent before the confirm
    await act(async () => confirm.click());
    await settle();

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.endpoint).toBe("feedback");
    expect(body.feedback).toBe(ANNOTATE_NO_FEEDBACK_SENTENCE);
    expect(body.annotations).toEqual([]);
  });

  test("Escape in the composer steps back without submitting and keeps the note", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate();

    await openComposer("Send a note");
    await typeNote("not ready to send");
    await pressNoteKey("Escape");

    // Back at the menu, nothing submitted.
    expect(noteInput()).toBeNull();
    expect(menuItem("Send a note")).toBeDefined();
    expect(submissions).toHaveLength(0);

    const item = menuItem("Send a note")!;
    await act(async () => item.click());
    await settle();
    expect(noteInput()?.value).toBe("not ready to send");
  });

  // L3 pin: a failed POST must keep the captured decision armed — retrying
  // through the primary replays THAT decision. Without it, the retry would
  // either drop the armed note or commit it a second time (two
  // GLOBAL_COMMENTs from one composer submit).
  test("a failed note submit keeps the decision armed; retry replays it without a second note", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    failFeedbackPosts = 1;
    await mountAnnotate();

    await openComposer("Send a note");
    await typeNote("hold the line");
    await pressNoteKey("Enter", { metaKey: true });

    // First attempt: captured decision posted, but the POST failed — no
    // completion overlay, the session stays reviewable.
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.endpoint).toBe("feedback");
    expect(submissions[0]!.feedback).toContain("hold the line");
    const primary = primaryButton();
    expect(primary).not.toBeNull(); // still reviewable, not submitted

    // Retry via the primary: the armed decision replays with the SAME single
    // note — never a re-commit, never a dropped note.
    await act(async () => primary!.click());
    await settle();

    expect(submissions).toHaveLength(2);
    const retry = submissions[1]!;
    expect(retry.endpoint).toBe("feedback");
    expect(retry.feedback).toContain("hold the line");
    const notes = globalComments(retry);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("hold the line");
  });

  // The HTML pinpoint Esc ladder must still receive Escape when the popover
  // is closed: the control's dismissal hook consumes Escape at the document
  // level, so a leak here (listening while closed) would eat the ladder's
  // first rung on every raw-HTML/live-app session.
  test("HTML surface: Escape is consumed only while the decision popover is open", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate({
      filePath: "/tmp/page.html",
      renderAs: "html",
      rawHtml: "<h1>Rendered page</h1><p>Body copy.</p>",
      plan: "",
    });

    await act(async () => caretButton()!.click());
    await settle();
    expect(document.querySelector("[data-decision-popover]")).not.toBeNull();

    const whileOpen = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(whileOpen); });
    await settle();
    expect(whileOpen.defaultPrevented).toBe(true); // the popover's rung
    expect(document.querySelector("[data-decision-popover]")).toBeNull();

    const whileClosed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(whileClosed); });
    // Not consumed by the decision layer: the annotate Esc ladder (bridge /
    // vim / draft rungs) still sees it.
    expect(whileClosed.defaultPrevented).toBe(false);
    expect(submissions).toHaveLength(0);
  });

  // Guards the exact regression this project exists to fix on the surface
  // that has no Mod+Enter (spec §8 E16): compact at zero must offer a visible
  // positive decision row, and it must post the legacy Done body.
  test("compact touch offers a positive decision row at zero and it posts the legacy body", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    // SAFETY: implements the MediaQueryList surface the shell hooks consume;
    // coarse-pointer matches put the app in its compact touch layout.
    window.matchMedia = ((query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    })) as unknown as typeof window.matchMedia;

    await mount(annotatePlan(), () =>
      document.getElementById("pn-compact-plan-review-trigger"));

    await act(async () => {
      document.getElementById("pn-compact-plan-review-trigger")!.click();
    });
    await settle();

    const positive = document.querySelector<HTMLButtonElement>(
      '[data-pn-compact-review-action="approve"]',
    );
    expect(positive).not.toBeNull();
    await act(async () => positive!.click());
    await settle();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.endpoint).toBe("feedback");
    expect(submissions[0]!.feedback).toBe(ANNOTATE_NO_FEEDBACK_SENTENCE);
    expect(submissions[0]!.annotations).toEqual([]);
  });
});
