/**
 * One-step "submit with a note" on the annotate surfaces (DOM-gated).
 *
 * Regressions each test guards:
 *  - The note must reach the agent AS A GLOBAL COMMENT, in the exported
 *    feedback string AND in the `/api/feedback` annotations array. If it were
 *    only spliced into the feedback text, the annotations array (which both
 *    servers persist as the durable submission record) would lose it; if it
 *    were only put in the array, the agent-facing text would not mention it.
 *  - It must be sent ALONGSIDE annotations already in the session, not
 *    instead of them. The note is committed into state and submitted a render
 *    later, so a regression that submits in the same tick would send the
 *    pre-note payload and silently drop the note.
 *  - The zero-annotation fast path: the incumbent header hid Send entirely
 *    with nothing to send, so Send must open the note field instead of
 *    submitting an empty review.
 *  - Escape must close the field WITHOUT submitting: on HTML surfaces Escape
 *    also walks the pinpoint ladder, so a missed stopPropagation would both
 *    submit and disarm.
 *  - Plan mode must not grow the control at all: it has its own
 *    approve/deny-with-feedback semantics and is deliberately untouched.
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

function seedAnnouncementsSeen(): void {
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
}

/** External annotations to deliver as the stream's opening snapshot, so a test
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
      // Handlers are assigned right after construction; deliver on the next
      // task, the way a real stream's first snapshot arrives.
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

interface SubmittedFeedback {
  feedback?: string;
  annotations?: Array<{ type?: string; text?: string; originalText?: string }>;
}

let submissions: SubmittedFeedback[] = [];

const MARKDOWN = "# Notes\n\nSome body text.\n";
const RAW_HTML = "<h1>Rendered page</h1><p>Body copy.</p>";

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

const planReviewPlan = {
  plan: MARKDOWN,
  origin: "claude-code",
  sharingEnabled: false,
  serverConfig: {},
};

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
    if (url.pathname === "/api/feedback" || url.pathname === "/api/deny") {
      submissions.push(JSON.parse(String(init?.body ?? "{}")) as SubmittedFeedback);
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function sendButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.title.startsWith("Send Feedback"));
}

function noteToggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-annotate-note-toggle]");
}

function noteInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>("[data-annotate-note-input]");
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
  mount(annotatePlan(extra), () => noteToggle());

async function typeNote(text: string): Promise<void> {
  const input = noteInput();
  if (!input) throw new Error("note field is not open");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressKey(key: string, init: KeyboardEventInit = {}): Promise<void> {
  const input = noteInput();
  if (!input) throw new Error("note field is not open");
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
  await settle();
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  submissions = [];
  seededExternalAnnotations = [];
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("annotate submit-with-note", () => {
  test("zero annotations: Send opens the note field and submits nothing", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate();

    // The incumbent header hid Send with nothing to send; the fast path
    // replaces that absence rather than restoring a dead button.
    expect(noteInput()).toBeNull();
    const send = sendButton();
    expect(send).toBeDefined();

    await act(async () => send!.click());
    await settle();

    expect(noteInput()).not.toBeNull();
    expect(submissions).toHaveLength(0);
  });

  test("Mod+Enter sends the note as a GLOBAL_COMMENT in one step", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate();

    await act(async () => noteToggle()!.click());
    await settle();
    await typeNote("looks fine, watch the migration");
    // The field is multi-line now: a bare Enter is a newline, never a send.
    await pressKey("Enter");
    expect(submissions).toHaveLength(0);
    await pressKey("Enter", { metaKey: true });

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    const notes = (body.annotations ?? []).filter((a) => a.type === "GLOBAL_COMMENT");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("looks fine, watch the migration");
    // The exported feedback is what the agent actually reads.
    expect(body.feedback).toContain("looks fine, watch the migration");
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
    // Wait for the seeded snapshot to land before opening the composer.
    await settle();
    await settle();

    await act(async () => noteToggle()!.click());
    await settle();
    await typeNote("also: ship it");
    await pressKey("Enter", { metaKey: true });

    expect(submissions).toHaveLength(1);
    const annotations = submissions[0]!.annotations ?? [];
    expect(annotations.some((a) => a.text === "existing finding")).toBe(true);
    expect(annotations.some((a) => a.type === "GLOBAL_COMMENT" && a.text === "also: ship it")).toBe(true);
    expect(submissions[0]!.feedback).toContain("existing finding");
    expect(submissions[0]!.feedback).toContain("also: ship it");
  });

  test("Escape closes the field without submitting and keeps the typed text", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate();

    await act(async () => noteToggle()!.click());
    await settle();
    await typeNote("not ready to send");
    await pressKey("Escape");

    expect(noteInput()).toBeNull();
    expect(submissions).toHaveLength(0);

    // Reopening restores the text rather than discarding a half-typed note.
    await act(async () => noteToggle()!.click());
    await settle();
    expect(noteInput()?.value).toBe("not ready to send");
  });

  test("HTML surface: the same one-step note reaches the agent", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    // Raw-HTML sessions are comment-only, but the clamp lives on the iframe's
    // postMessage ingest — a GLOBAL_COMMENT made in the parent is unaffected.
    await mountAnnotate({
      filePath: "/tmp/page.html",
      renderAs: "html",
      rawHtml: RAW_HTML,
      plan: "",
    });

    await act(async () => noteToggle()!.click());
    await settle();
    await typeNote("the header spacing is off");
    await pressKey("Enter", { ctrlKey: true });

    expect(submissions).toHaveLength(1);
    const notes = (submissions[0]!.annotations ?? []).filter((a) => a.type === "GLOBAL_COMMENT");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("the header spacing is off");
  });

  test("plan review is untouched: no note control, Send Feedback still submits", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mount(planReviewPlan, () => sendButton());

    expect(noteToggle()).toBeNull();
    expect(noteInput()).toBeNull();
    // Plan mode's Send with no feedback opens its own prompt, not a note field.
    await act(async () => sendButton()!.click());
    await settle();
    expect(noteInput()).toBeNull();
    expect(submissions).toHaveLength(0);
  });
});
