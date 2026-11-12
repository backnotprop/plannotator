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
  document.cookie = "plannotator-announce-tui-herdr-seen=1; path=/";
  document.cookie = "plannotator-announce-inbox-seen=1; path=/";
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const fileBrowserModule = hasDom ? await import("@plannotator/ui/hooks/useFileBrowser") : null;
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
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
}

let seededExternalAnnotations: unknown[] = [];
const savedDocumentDrafts = new Map<string, unknown[]>();

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
  nothingToSend?: boolean;
}

let submissions: SubmittedBody[] = [];
let failFeedbackPosts = 0;
let feedbackNetworkFailures = 0;
let failApprovePosts = 0;
let refuseNextFeedbackAsDecided = false;

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
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });

    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") return Response.json(plan);
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname === "/api/draft/document") {
      const saved = savedDocumentDrafts.get(url.searchParams.get("path") ?? "");
      if (!saved || (init?.method ?? "GET") !== "GET") {
        return saved ? Response.json({ ok: true }) : Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json({ annotations: saved, globalAttachments: [] });
    }
    if (url.pathname === "/api/doc") {
      const filepath = url.searchParams.get("path") ?? "";
      const name = filepath.split("/").pop() ?? filepath;
      return Response.json({ markdown: `# ${name}\n\nBody of ${name}.\n`, filepath, renderAs: "markdown" });
    }
    if (url.pathname === "/api/feedback" || url.pathname === "/api/approve") {
      submissions.push({
        endpoint: url.pathname === "/api/feedback" ? "feedback" : "approve",
        ...(JSON.parse(String(init?.body ?? "{}")) as Omit<SubmittedBody, "endpoint">),
      });
      if (url.pathname === "/api/feedback" && failFeedbackPosts > 0) {
        failFeedbackPosts -= 1;
        return Response.json({ error: "boom" }, { status: 500 });
      }
      if (url.pathname === "/api/feedback" && refuseNextFeedbackAsDecided) {
        refuseNextFeedbackAsDecided = false;
        return Response.json({ error: "This review session has already been decided.", code: "already_decided" }, { status: 409 });
      }
      if (url.pathname === "/api/feedback" && feedbackNetworkFailures > 0) {
        feedbackNetworkFailures -= 1;
        throw new TypeError("Failed to fetch");
      }
      if (url.pathname === "/api/approve" && failApprovePosts > 0) {
        failApprovePosts -= 1;
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
  feedbackNetworkFailures = 0;
  failApprovePosts = 0;
  refuseNextFeedbackAsDecided = false;
  seededExternalAnnotations = [];
  savedDocumentDrafts.clear();
  fileBrowserModule?.resetFileTreeBackend();
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
    expect(body.endpoint).toBe("feedback");
    expect(body.feedback).toBe(ANNOTATE_NO_FEEDBACK_SENTENCE);
    expect(body.annotations).toEqual([]);
    expect(body.codeAnnotations).toEqual([]);
    expect(body.nothingToSend).toBe(true);
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
    expect(body.nothingToSend).toBeUndefined();
  });

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

    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((el) => el.textContent === "Discard & finish");
    if (!confirm) throw new Error("discard confirm did not open");
    expect(submissions).toHaveLength(0);
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

    expect(noteInput()).toBeNull();
    expect(menuItem("Send a note")).toBeDefined();
    expect(submissions).toHaveLength(0);

    const item = menuItem("Send a note")!;
    await act(async () => item.click());
    await settle();
    expect(noteInput()?.value).toBe("not ready to send");
  });

  test("a failed note submit keeps the decision armed; retry replays it without a second note", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    failFeedbackPosts = 1;
    await mountAnnotate();

    await openComposer("Send a note");
    await typeNote("hold the line");
    await pressNoteKey("Enter", { metaKey: true });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.endpoint).toBe("feedback");
    expect(submissions[0]!.feedback).toContain("hold the line");
    const primary = primaryButton();
    expect(primary).not.toBeNull();

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
    expect(whileOpen.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-decision-popover]")).toBeNull();

    const whileClosed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { document.body.dispatchEvent(whileClosed); });
    expect(whileClosed.defaultPrevented).toBe(false);
    expect(submissions).toHaveLength(0);
  });

  test("compact touch offers a positive decision row at zero and it posts the legacy body", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
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

function fileButton(name: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === name);
}

function completionState(): string | null {
  return document.querySelector("[data-completion-state]")?.getAttribute("data-completion-state") ?? null;
}

function completionTitle(): string | null {
  return document.querySelector("[data-completion-state] h2")?.textContent ?? null;
}

describe.if(hasDom)("annotate completion screen", () => {
  type GlimpseWindow = Window & { glimpse?: { close?: () => void } };

  afterEach(() => {
    delete (window as GlimpseWindow).glimpse;
  });

  function useImmediateHostClose(): void {
    memory.set("plannotator-auto-close", "0");
    (window as GlimpseWindow).glimpse = { close: () => {} };
  }

  async function clickPrimary(): Promise<void> {
    await act(async () => primaryButton()!.click());
    await settle();
  }

  function completionText(): string {
    return document.querySelector("[data-completion-state]")?.textContent ?? "";
  }

  function expectNoSentClaim(): void {
    const text = completionText();
    expect(text).not.toContain("Feedback Sent");
    expect(text).not.toContain("address your feedback");
    expect(text).not.toContain("has been sent");
  }

  test("Done with nothing to send shows the Done screen, not Feedback Sent", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    useImmediateHostClose();
    await mountAnnotate();

    await clickPrimary();

    expect(submissions[0]!.nothingToSend).toBe(true);
    expect(completionState()).toBe("done");
    expect(completionTitle()).toBe("Done");
    expectNoSentClaim();
  });

  test("a note that was sent still shows Feedback Sent", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    useImmediateHostClose();
    await mountAnnotate();

    await openComposer("Send a note");
    await typeNote("tighten the intro");
    await pressNoteKey("Enter", { metaKey: true });

    expect(submissions[0]!.nothingToSend).toBeUndefined();
    expect(completionState()).toBe("denied");
    expect(completionTitle()).toBe("Feedback Sent");
    expect(completionText()).toContain("has been sent");
  });

  test("Close keeps Session Closed but does not claim a response was sent", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    useImmediateHostClose();
    await mountAnnotate();

    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Close session without sending"]',
    );
    if (!close) throw new Error("Close button not found");
    await act(async () => close.click());
    await settle();

    expect(submissions).toHaveLength(0);
    expect(completionState()).toBe("exited");
    expect(completionTitle()).toBe("Session Closed");
    expectNoSentClaim();
  });

  test("folder: a comment on another document still shows Feedback Sent", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    useImmediateHostClose();
    fileBrowserModule!.setFileTreeBackend({
      loadTree: async () => Response.json({
        tree: [
          { name: "alpha.md", path: "alpha.md", type: "file" },
          { name: "beta.md", path: "beta.md", type: "file" },
        ],
      }),
      loadVaultTree: async () => Response.json({ error: "Unavailable" }, { status: 404 }),
      watchTrees: () => undefined,
    });
    savedDocumentDrafts.set("/repo/alpha.md", [{
      id: "alpha-1",
      blockId: "",
      startOffset: 0,
      endOffset: 0,
      type: "COMMENT",
      text: "alpha needs work",
      originalText: "Body of alpha.md.",
      createdA: 1,
    }]);
    await mount(annotatePlan({
      plan: "",
      mode: "annotate-folder",
      filePath: "/repo",
      projectRoot: "/repo",
      documentDrafts: true,
    }), () => fileButton("alpha"));

    async function openFile(name: string): Promise<void> {
      await act(async () => fileButton(name)!.click());
      for (let attempt = 0; attempt < 20; attempt += 1) await settle();
    }
    await openFile("alpha");
    await openFile("beta");

    await clickPrimary();

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.endpoint).toBe("feedback");
    expect(body.feedback).toContain("alpha needs work");
    expect(body.nothingToSend).toBeUndefined();
    expect(completionState()).toBe("denied");
    expect(completionTitle()).toBe("Feedback Sent");
  });

  test("discarding every annotation finishes on the Done screen", async () => {
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
    await act(async () => menuItem("discard 1 annotation")!.click());
    await settle();
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((el) => el.textContent === "Discard & finish");
    await act(async () => confirm!.click());
    await settle();

    expect(submissions).toHaveLength(1);
    expect(completionState()).toBe("done");
    expectNoSentClaim();
  });

  test("gate: the empty Approve keeps the approval screen", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate({ gate: true });

    await clickPrimary();

    expect(submissions[0]!.endpoint).toBe("approve");
    expect(completionState()).toBe("approved");
  });

  test("annotate-last: Done with nothing to send shows the Done screen", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate({ mode: "annotate-last", filePath: undefined });

    await clickPrimary();

    expect(submissions[0]!.nothingToSend).toBe(true);
    expect(completionState()).toBe("done");
    expectNoSentClaim();
  });

  test("raw HTML: Done with nothing to send shows the Done screen", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountAnnotate({
      filePath: "/tmp/page.html",
      renderAs: "html",
      rawHtml: "<h1>Rendered page</h1><p>Body copy.</p>",
      plan: "",
    });

    await clickPrimary();

    expect(submissions[0]!.nothingToSend).toBe(true);
    expect(completionState()).toBe("done");
    expectNoSentClaim();
  });
});

describe.if(hasDom)("annotate: a send that does not reach Plannotator", () => {
  const failureToast = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]"))
      .filter((el) => el.getAttribute("data-removed") !== "true")
      .find((el) => el.querySelector("[data-title]")?.textContent?.endsWith(" not sent"));
  const toastButton = (label: string) =>
    Array.from(failureToast()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => b.textContent === label);

  async function waitFor(check: () => unknown, what: string): Promise<void> {
    for (let attempt = 0; attempt < 40 && !check(); attempt += 1) await settle();
    if (!check()) throw new Error(`timed out waiting for ${what}`);
  }

  async function sendNote(text: string): Promise<void> {
    await openComposer("Send a note");
    await typeNote(text);
    await pressNoteKey("Enter", { metaKey: true });
  }

  test("server gone: no sent screen, Feedback not sent, and Copy feedback copies the panel's Copy text", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    feedbackNetworkFailures = 1;
    const clipboard = navigator.clipboard;
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    try {
      await mountAnnotate();
      await sendNote("keep the second example");
      await waitFor(failureToast, "the failure message");

      expect(submissions).toHaveLength(1);
      expect(completionState()).toBeNull();
      expect(failureToast()!.textContent).toContain("Feedback not sent");
      expect(failureToast()!.textContent).toContain("isn't running");
      expect(primaryButton()!.disabled).toBe(false);

      await act(async () => toastButton("Copy feedback")!.click());
      await waitFor(() => copied.length > 0, "the copy");
      expect(copied[0]).toContain("keep the second example");
      expect(copied[0]).toContain("/tmp/notes.md");
      await waitFor(() => toastButton("Copied"), "the Copied label");
      expect(Boolean(toastButton("Retry"))).toBe(true);
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    }
  });

  test("answered 500: Retry sends the same note once and only then shows Feedback Sent", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    failFeedbackPosts = 1;
    await mountAnnotate();
    await sendNote("hold the line");
    await waitFor(failureToast, "the failure message");

    expect(completionState()).toBeNull();
    expect(failureToast()!.textContent).toContain("500");

    await act(async () => toastButton("Retry")!.click());
    await waitFor(() => completionState(), "the completion screen");
    expect(submissions).toHaveLength(2);
    const notes = globalComments(submissions[1]!);
    expect(notes.map((n) => n.text)).toEqual(["hold the line"]);
    expect(completionState()).toBe("denied");
  });

  test("annotate-last: server gone keeps the message review open and says so", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    feedbackNetworkFailures = 1;
    await mountAnnotate({ mode: "annotate-last", filePath: undefined });
    await sendNote("answer the second question too");
    await waitFor(failureToast, "the failure message");

    expect(completionState()).toBeNull();
    expect(failureToast()!.textContent).toContain("Feedback not sent");
    expect(Boolean(toastButton("Copy feedback"))).toBe(true);
  });

  test("gate: an Approve answered 500 says Approval not sent and shows no Approved screen", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    failApprovePosts = 1;
    await mountAnnotate({ gate: true });
    await act(async () => primaryButton()!.click());
    await waitFor(failureToast, "the failure message");

    expect(submissions[0]!.endpoint).toBe("approve");
    expect(completionState()).toBeNull();
    expect(failureToast()!.textContent).toContain("Approval not sent");
    expect(Boolean(toastButton("Copy feedback"))).toBe(false);
  });

  test("a send that then succeeds leaves no failure message over Feedback Sent", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    failFeedbackPosts = 1;
    await mountAnnotate();
    await sendNote("tighten the intro");
    await waitFor(failureToast, "the failure message");

    await act(async () => primaryButton()!.click());
    await waitFor(() => completionState(), "the completion screen");
    expect(completionState()).toBe("denied");
    expect(failureToast()).toBeUndefined();
  });

  test("already decided elsewhere: its own message, Copy feedback, no Retry", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    refuseNextFeedbackAsDecided = true;
    await mountAnnotate();
    await sendNote("one more thing");
    await waitFor(failureToast, "the failure message");

    expect(completionState()).toBeNull();
    expect(failureToast()!.textContent).toContain("Feedback not sent");
    expect(failureToast()!.textContent).toContain("already decided");
    expect(failureToast()!.textContent).not.toContain("409");
    expect(Boolean(toastButton("Retry"))).toBe(false);
    expect(Boolean(toastButton("Copy feedback"))).toBe(true);
  });
});
