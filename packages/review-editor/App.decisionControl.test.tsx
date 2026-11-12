import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";

mock.module("./workerPool", () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== "undefined";

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

function seedFirstRunSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

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
    if (this.url.includes("external-annotations")) {
      const payload = seededExternalAnnotations;
      if (payload.length > 0) {
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({ type: "snapshot", annotations: payload }),
          } as MessageEvent);
        }, 0);
      }
    }
  }

  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

interface SubmittedBody {
  endpoint: "feedback" | "exit" | "pr-action";
  action?: string;
  body?: string;
  approved?: boolean;
  feedback?: string;
  platform?: unknown;
  annotations?: Array<{
    id?: string;
    type?: string;
    scope?: string;
    filePath?: string;
    lineStart?: number;
    lineEnd?: number;
    text?: string;
  }>;
}

let submissions: SubmittedBody[] = [];
let failFeedbackPosts = 0;
let feedbackNetworkFailures = 0;
let advertiseApprovalNotes = false;
let prDiffExtras: Record<string, unknown> | null = null;
let prActionRefusal: string | null = null;
let aiCapabilities: Record<string, unknown> = { available: false, providers: [] };

const PR_METADATA = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  number: 7,
  title: "Add widget parser",
  author: "leoreisdias",
  baseBranch: "main",
  headBranch: "feature/parser",
  baseSha: "aaa1111",
  headSha: "bbb2222",
  url: "https://github.com/acme/widgets/pull/7",
};

const MR_METADATA = {
  platform: "gitlab",
  host: "gitlab.com",
  projectPath: "acme/widgets",
  iid: 7,
  title: "Add widget parser",
  author: "leoreisdias",
  baseBranch: "main",
  headBranch: "feature/parser",
  baseSha: "aaa1111",
  headSha: "bbb2222",
  url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
};

function seedPlatformSession(options?: { selfAuthored?: boolean; gitlab?: boolean }): void {
  const metadata = options?.gitlab ? MR_METADATA : PR_METADATA;
  prDiffExtras = {
    prMetadata: metadata,
    platformUser: options?.selfAuthored ? metadata.author : "reviewer",
  };
  memory.set("plannotator-platform-open-pr", "false");
}

const PATCH = [
  "diff --git a/src/parse.ts b/src/parse.ts",
  "index 0000001..0000002 100644",
  "--- a/src/parse.ts",
  "+++ b/src/parse.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");

const EXTERNAL_FINDING = {
  id: "ext-1",
  type: "comment",
  filePath: "src/parse.ts",
  lineStart: 1,
  lineEnd: 1,
  side: "new",
  text: "still drops null",
  createdAt: 1,
  source: "eslint",
};

function makeFetch(): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });

    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/diff") {
      return Response.json({
        rawPatch: PATCH,
        gitRef: "HEAD",
        snapshotId: "snap-1",
        origin: "claude-code",
        diffType: "uncommitted",
        base: null,
        hideWhitespace: false,
        ...(advertiseApprovalNotes ? { approvalNotesSupported: true } : {}),
        ...(prDiffExtras ?? {}),
      });
    }
    if (url.pathname === "/api/pr-action") {
      const posted = JSON.parse(String(init?.body ?? "{}")) as { action?: string; body?: string };
      submissions.push({ endpoint: "pr-action", action: posted.action, body: posted.body });
      if (prActionRefusal) return Response.json({ error: prActionRefusal }, { status: 500 });
      return Response.json({ ok: true, submission: { status: "complete" } });
    }
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/ai/capabilities") return Response.json(aiCapabilities);
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname === "/api/feedback") {
      submissions.push({
        endpoint: "feedback",
        ...(JSON.parse(String(init?.body ?? "{}")) as Omit<SubmittedBody, "endpoint">),
      });
      if (failFeedbackPosts > 0) {
        failFeedbackPosts -= 1;
        return Response.json({ error: "boom" }, { status: 500 });
      }
      if (feedbackNetworkFailures > 0) {
        feedbackNetworkFailures -= 1;
        throw new TypeError("Failed to fetch");
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/exit") {
      submissions.push({ endpoint: "exit" });
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

function seedFirstRunSeenExceptTerminalTools(): void {
  seedFirstRunSeen();
  memory.set("plannotator-token-hover-announcement-seen", "1");
  memory.delete("plannotator-announce-tui-herdr-seen");
}

async function mount(
  waitFor: () => unknown,
  seed: () => void = seedFirstRunSeen,
): Promise<void> {
  setStorageBackend(memoryBackend);
  seed();
  globalThis.fetch = makeFetch();
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 40 && !waitFor(); attempt += 1) {
    await settle();
  }
  if (!waitFor()) throw new Error("app did not finish mounting");
}

const mountReview = () => mount(() => caretButton());

async function openMenu(): Promise<void> {
  await act(async () => caretButton()!.click());
  await settle();
}

async function openComposer(labelPart: string): Promise<void> {
  await openMenu();
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
  advertiseApprovalNotes = false;
  prDiffExtras = null;
  prActionRefusal = null;
  aiCapabilities = { available: false, providers: [] };
  seededExternalAnnotations = [];
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("review decision control (agent mode)", () => {
  test("empty-state Approve posts the bare approval body (no LGTM placeholder)", async () => {
    await mountReview();

    expect(primaryButton()!.title).toContain("Approve");
    await act(async () => primaryButton()!.click());
    await settle();

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.endpoint).toBe("feedback");
    expect(body.approved).toBe(true);
    expect(body.feedback).toBe("");
    expect(body.annotations).toEqual([]);
  });

  test("with annotations the primary posts the real feedback body", async () => {
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    expect(primaryButton()!.title).toContain("Send");
    await act(async () => primaryButton()!.click());
    await settle();

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.approved).toBe(false);
    expect((body.annotations ?? []).some((a) => a.id === "ext-1")).toBe(true);
    expect(body.feedback).toContain("still drops null");
    expect("platform" in body).toBe(false);
  });

  test("Request changes… delivers the note as a scope:'general' sentinel annotation and in the export", async () => {
    await mountReview();

    await openComposer("Request changes");
    await typeNote("rebase on main before merging");
    await pressNoteKey("Enter", { metaKey: true });

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.approved).toBe(false);
    const notes = (body.annotations ?? []).filter((a) => a.scope === "general");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      scope: "general",
      filePath: "",
      lineStart: 0,
      lineEnd: 0,
      text: "rebase on main before merging",
    });
    expect(body.feedback).toContain("## Global comments");
    expect(body.feedback).toContain("rebase on main before merging");
  });

  test("discard confirm posts the bare approval, and nothing before the confirm", async () => {
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    await openMenu();
    const discardItem = menuItem("discard 1 annotation");
    if (!discardItem) throw new Error("discard menu item not found");
    await act(async () => discardItem.click());
    await settle();

    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((el) => el.textContent === "Discard & approve");
    if (!confirm) throw new Error("discard confirm did not open");
    expect(submissions).toHaveLength(0);
    await act(async () => confirm.click());
    await settle();

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.approved).toBe(true);
    expect(body.feedback).toBe("");
    expect(body.annotations).toEqual([]);
  });

  test("Mod+Enter over the open discard confirm posts exactly one decision — the confirm's", async () => {
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    await openMenu();
    const discardItem = menuItem("discard 1 annotation");
    if (!discardItem) throw new Error("discard menu item not found");
    await act(async () => discardItem.click());
    await settle();
    if (!document.querySelector('[data-plannotator-confirm-dialog="true"]')) {
      throw new Error("discard confirm did not open");
    }

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await settle();

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.approved).toBe(true);
    expect(body.feedback).toBe("");
    expect(body.annotations).toEqual([]);
  });

  test("a failed note submit stays armed; the primary retries the note-carrying body once", async () => {
    failFeedbackPosts = 1;
    await mountReview();

    await openComposer("Request changes");
    await typeNote("hold the line");
    await pressNoteKey("Enter", { metaKey: true });

    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.approved).toBe(false);
    expect((submissions[0]!.annotations ?? []).some((a) => a.scope === "general" && a.text === "hold the line")).toBe(true);
    const primary = primaryButton();
    expect(primary).not.toBeNull();
    expect(primary!.title).toContain("Send");

    await act(async () => primary!.click());
    await settle();

    expect(submissions).toHaveLength(2);
    const retry = submissions[1]!;
    expect(retry.approved).toBe(false);
    const notes = (retry.annotations ?? []).filter((a) => a.scope === "general");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("hold the line");
    expect(retry.feedback).toContain("hold the line");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await settle();
    expect(submissions).toHaveLength(2);
  });

  test("Mod+Enter fires the visible primary", async () => {
    await mountReview();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await settle();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.approved).toBe(true);
    expect(submissions[0]!.annotations).toEqual([]);
  });

  test("approve-with-notes items are absent when the server sends no advert (old server)", async () => {
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    await openMenu();
    expect(menuItem("Approve with notes")).toBeUndefined();
    expect(menuItem("discard 1 annotation")).toBeDefined();
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
  });

  test("under the advert, Approve with notes delivers the live annotations on the approval", async () => {
    advertiseApprovalNotes = true;
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    await openMenu();
    const item = menuItem("Approve with notes");
    if (!item) throw new Error("Approve with notes did not render under the advert");
    await act(async () => item.click());
    await settle();

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.approved).toBe(true);
    expect((body.annotations ?? []).some((a) => a.id === "ext-1")).toBe(true);
    expect(body.feedback).toContain("still drops null");
  });

  test("empty-state menu carries only Request changes… (no Approve with a note…)", async () => {
    await mountReview();

    await openMenu();
    expect(menuItem("Approve with a note")).toBeUndefined();
    expect(menuItem("Request changes")).toBeDefined();
  });

  test("a sidebar general comment flips the header to Send Feedback and rides the posted body", async () => {
    await mountReview();
    expect(primaryButton()!.textContent).toContain("Approve");

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[title="Annotations"]')!.click();
    });
    await settle();

    const addButton = document.querySelector<HTMLButtonElement>("[data-add-general-comment]");
    expect(addButton).not.toBeNull();
    await act(async () => addButton!.click());
    await settle();

    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-review-general-composer] [data-decision-note-input]",
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(input!, "Split this into two PRs.");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-general-comment-add]")!.click();
    });
    await settle();

    expect(primaryButton()!.textContent).toContain("Send Feedback");
    expect(primaryButton()!.textContent).not.toMatch(/\d/);

    await act(async () => primaryButton()!.click());
    await settle();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.approved).toBe(false);
    const general = submissions[0]!.annotations?.find((a) => a.scope === "general");
    expect(general).toMatchObject({
      scope: "general",
      filePath: "",
      lineStart: 0,
      lineEnd: 0,
      text: "Split this into two PRs.",
    });
    expect((general as Record<string, unknown>).prUrl).toBeUndefined();
  });

  test("the terminal-tools announcement takes its turn once the rest of the chain is done", async () => {
    const DIALOG = "[data-terminal-tools-announcement-dialog]";
    await mount(() => document.querySelector(DIALOG), seedFirstRunSeenExceptTerminalTools);

    expect(document.querySelector(DIALOG)).not.toBeNull();

    const gotIt = Array.from(document.querySelectorAll<HTMLButtonElement>(`${DIALOG} button`))
      .find((button) => button.textContent?.trim() === "Got it");
    if (!gotIt) throw new Error("Dismiss action did not render");
    await act(async () => gotIt.click());
    await settle();

    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.get("plannotator-announce-tui-herdr-seen")).toBe("1");
    expect(submissions).toHaveLength(0);
  });

  test("the Inbox announcement shows once, links to the Inbox page, and Mod+Enter cannot post behind it", async () => {
    const DIALOG = "[data-inbox-announcement-dialog]";
    const isOpen = () => document.querySelector(DIALOG) !== null;
    const seed = () => {
      seedFirstRunSeen();
      memory.set("plannotator-token-hover-announcement-seen", "1");
      memory.delete("plannotator-announce-inbox-seen");
    };
    await mount(isOpen, seed);
    expect(isOpen()).toBe(true);

    const link = document.querySelector<HTMLAnchorElement>(`${DIALOG} a[data-inbox-announcement-learn-more]`);
    expect(link?.getAttribute("href")).toBe("https://plannotator.ai/inbox");
    expect(link?.getAttribute("target")).toBe("_blank");

    const close = document.querySelector<HTMLButtonElement>(`${DIALOG} [data-inbox-announcement-close]`);
    if (!close) throw new Error("Close action did not render");
    await act(async () => {
      close.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    await settle();
    expect(submissions).toHaveLength(0);

    await act(async () => close.click());
    await settle();
    expect(isOpen()).toBe(false);
    expect(memory.get("plannotator-announce-inbox-seen")).toBe("1");
    expect(submissions).toHaveLength(0);

    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    await mount(() => document.body.textContent?.includes("Approve"), () => {});
    expect(isOpen()).toBe(false);
  });

  test("the Inbox announcement never shows in the VS Code webview", async () => {
    const target = window as { __PLANNOTATOR_VSCODE?: unknown };
    target.__PLANNOTATOR_VSCODE = true;
    try {
      await mount(() => document.body.textContent?.includes("Approve"), () => {
        seedFirstRunSeen();
        memory.set("plannotator-token-hover-announcement-seen", "1");
        memory.delete("plannotator-announce-inbox-seen");
      });
      for (let attempt = 0; attempt < 5; attempt += 1) await settle();
      expect(document.querySelector("[data-inbox-announcement-dialog]") !== null).toBe(false);
      expect(memory.has("plannotator-announce-inbox-seen")).toBe(false);
    } finally {
      delete target.__PLANNOTATOR_VSCODE;
    }
  });

  test("the Ask this session announcement takes the last turn, and Mod+Enter cannot post behind it", async () => {
    const DIALOG = "[data-ask-session-announcement-dialog]";
    aiCapabilities = {
      available: true,
      providers: [{
        id: "session-bridge",
        name: "session-bridge",
        label: "Ask this session · Claude Code",
        capabilities: {},
        models: [],
        sessionBridge: { host: "claude-code", status: "ready", modes: { turn: true, transient: false } },
      }],
      defaultProvider: null,
    };
    await mount(() => document.querySelector(DIALOG), () => {
      seedFirstRunSeen();
      memory.set("plannotator-token-hover-announcement-seen", "1");
    });

    expect(document.querySelector(DIALOG)?.getAttribute("data-ask-session-agent")).toBe("claude-code");
    expect(document.querySelector(`${DIALOG} [data-ask-session-status="connected"]`)).not.toBeNull();

    const gotIt = Array.from(document.querySelectorAll<HTMLButtonElement>(`${DIALOG} button`))
      .find((button) => button.textContent?.trim() === "Got it");
    if (!gotIt) throw new Error("Dismiss action did not render");
    await act(async () => {
      gotIt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    await settle();
    expect(submissions).toHaveLength(0);

    await act(async () => gotIt.click());
    await settle();
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.get("plannotator-announce-ask-session-seen")).toBe("1");
    expect(submissions).toHaveLength(0);
  });

  test("the Ask this session announcement never shares a load with the terminal-tools one", async () => {
    aiCapabilities = { available: true, providers: [], defaultProvider: null };
    await mount(() => document.querySelector("[data-terminal-tools-announcement-dialog]"), seedFirstRunSeenExceptTerminalTools);
    expect(document.querySelector("[data-ask-session-announcement-dialog]")).toBeNull();
    expect(memory.has("plannotator-announce-ask-session-seen")).toBe(false);
  });

  test("compact touch offers a positive decision row at zero and it posts", async () => {
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

    await mount(() => document.querySelector('button[aria-label="Options"]'));

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Options"]')!.click();
    });
    await settle();

    const positive = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((el) => el.textContent?.trim() === "Approve");
    expect(positive).toBeDefined();
    await act(async () => positive!.click());
    await settle();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.approved).toBe(true);
    expect(submissions[0]!.feedback).toBe("");
    expect(submissions[0]!.annotations).toEqual([]);
  });
});

describe.if(hasDom)("review decision control (platform mode)", () => {
  const submissionDialogOpen = (title: "Post Review Comments" | "Request Changes" | `Approve ${string}`) =>
    Array.from(document.querySelectorAll("h2")).some((el) => el.textContent === title);

  const eventRadio = (value: "comment" | "request_changes") =>
    document.querySelector<HTMLInputElement>(`[data-review-event-choice] input[value="${value}"]`);

  const dialogConfirm = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((el) => el.textContent?.trim() === label);

  async function typeGeneralComment(text: string): Promise<void> {
    const input = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Leave a comment..."]');
    if (!input) throw new Error("general comment field is not open");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function pressModEnter(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await settle();
  }

  test("with annotations the primary opens the dialog in comment mode and posts nothing", async () => {
    seedPlatformSession();
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    expect(primaryButton()!.textContent).toContain("Post Comments");
    await act(async () => primaryButton()!.click());
    await settle();

    expect(submissionDialogOpen("Post Review Comments")).toBe(true);
    expect(submissions).toHaveLength(0);
    expect(document.querySelector("[data-review-event-choice]")).toBeNull();
  });

  test("Post comments, then… offers Comment / Request changes and posts the chosen event", async () => {
    seedPlatformSession();
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    await openMenu();
    const thenItem = menuItem("Post comments, then");
    if (!thenItem) throw new Error("Post comments, then… did not render");
    await act(async () => thenItem.click());
    await settle();

    expect(eventRadio("comment")?.checked).toBe(true);
    const requestChanges = eventRadio("request_changes");
    if (!requestChanges) throw new Error("Request changes choice did not render");
    expect(requestChanges.disabled).toBe(false);
    await act(async () => requestChanges.click());
    await settle();
    expect(submissionDialogOpen("Request Changes")).toBe(true);

    const confirm = dialogConfirm("Request Changes");
    if (!confirm) throw new Error("Request Changes confirm did not render");
    await act(async () => confirm.click());
    await settle();
    const posted = submissions.filter((s) => s.endpoint === "pr-action");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.action).toBe("request_changes");
    expect(posted[0]!.body?.trim()).toBeTruthy();
  });

  test("the status post after a platform submission marks itself platform: true", async () => {
    seedPlatformSession();
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    await act(async () => primaryButton()!.click());
    await settle();
    const confirm = dialogConfirm("Post Comments");
    if (!confirm) throw new Error("Post Comments confirm did not render");
    await act(async () => confirm.click());
    await settle();
    await settle();

    expect(submissions.filter((s) => s.endpoint === "pr-action")).toHaveLength(1);
    const status = submissions.filter((s) => s.endpoint === "feedback");
    expect(status).toHaveLength(1);
    expect(status[0]!.platform).toBe(true);
    expect(status[0]!.annotations).toEqual([]);
  });

  test("empty-state Request changes… preselects Request changes and posts it", async () => {
    seedPlatformSession();
    await mountReview();

    await openMenu();
    const requestItem = menuItem("Request changes");
    if (!requestItem) throw new Error("Request changes… did not render");
    expect(requestItem.disabled).toBe(false);
    await act(async () => requestItem.click());
    await settle();

    expect(submissionDialogOpen("Request Changes")).toBe(true);
    expect(eventRadio("request_changes")?.checked).toBe(true);
    await typeGeneralComment("Please split the parser change.");
    await act(async () => dialogConfirm("Request Changes")!.click());
    await settle();
    const posted = submissions.filter((s) => s.endpoint === "pr-action");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.action).toBe("request_changes");
    expect(posted[0]!.body).toBe("Please split the parser change.");
  });

  test("Approve with comments… opens the dialog in approve mode, still posting nothing", async () => {
    seedPlatformSession();
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    await openMenu();
    const item = menuItem("Approve with comments");
    if (!item) throw new Error("Approve with comments… did not render");
    expect(item.disabled).toBe(false);
    await act(async () => item.click());
    await settle();

    expect(submissionDialogOpen("Approve PR")).toBe(true);
    expect(submissions).toHaveLength(0);
  });

  test("self-authored mutes the approve item while Post comments, then… stays live", async () => {
    seedPlatformSession({ selfAuthored: true });
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    expect(primaryButton()!.getAttribute("aria-disabled")).toBeNull();

    await openMenu();
    const approveItem = menuItem("Approve with comments");
    if (!approveItem) throw new Error("muted approve item must render, not disappear");
    expect(approveItem.disabled).toBe(true);
    expect(approveItem.textContent).toContain("You can't approve your own PR");

    const thenItem = menuItem("Post comments, then");
    if (!thenItem) throw new Error("Post comments, then… did not render");
    expect(thenItem.disabled).toBe(false);
    await act(async () => thenItem.click());
    await settle();

    expect(submissionDialogOpen("Post Review Comments")).toBe(true);
    expect(submissions).toHaveLength(0);
  });

  test("empty-state primary opens approve mode; Mod+Enter over the open dialog submits it exactly once", async () => {
    seedPlatformSession();
    await mountReview();

    expect(primaryButton()!.textContent).toContain("Approve");
    await act(async () => primaryButton()!.click());
    await settle();
    expect(submissionDialogOpen("Approve PR")).toBe(true);
    expect(submissions).toHaveLength(0);

    await pressModEnter();

    expect(submissions.filter((s) => s.endpoint === "pr-action")).toHaveLength(1);
    const statuses = submissions.filter((s) => s.endpoint === "feedback");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.approved).toBe(false);
    expect(statuses[0]!.feedback).toContain("approved on GitHub");
  });

  test("own GitLab MR: Approve is live; GitLab's refusal shows in the dialog and the review stays open", async () => {
    seedPlatformSession({ selfAuthored: true, gitlab: true });
    const refusal = "GitLab refused the approval (401 Unauthorized). The project may not let you approve this merge request.";
    prActionRefusal = refusal;
    await mountReview();

    const primary = primaryButton()!;
    expect(primary.textContent).toContain("Approve");
    expect(primary.getAttribute("aria-disabled")).toBeNull();
    await act(async () => primary.click());
    await settle();
    expect(submissionDialogOpen("Approve MR")).toBe(true);

    await pressModEnter();

    expect(submissions.filter((s) => s.endpoint === "pr-action").map((s) => s.action)).toEqual(["approve"]);
    expect(submissionDialogOpen("Approve MR")).toBe(true);
    expect(document.body.textContent).toContain(refusal);
    expect(submissions.filter((s) => s.endpoint === "feedback")).toHaveLength(0);

    await act(async () => Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Cancel")?.click());
    await settle();
    await openMenu();
    expect(menuItem("Request changes")?.disabled).toBe(false);
  });

  test("self-authored empty state: muted primary is a no-op (click and Mod+Enter); Request changes… mutes, Comment… stays live", async () => {
    seedPlatformSession({ selfAuthored: true });
    await mountReview();

    const primary = primaryButton()!;
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    const describedBy = primary.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent)
      .toBe("You can't approve your own pull request on GitHub.");
    expect(primary.title).toBe("");

    await act(async () => primary.click());
    await settle();
    await pressModEnter();
    expect(submissionDialogOpen("Approve PR")).toBe(false);
    expect(submissions).toHaveLength(0);

    await openMenu();
    const approveItem = menuItem("Approve with a comment");
    if (!approveItem) throw new Error("muted approve item must render, not disappear");
    expect(approveItem.disabled).toBe(true);
    const requestItem = menuItem("Request changes");
    if (!requestItem) throw new Error("Request changes… must render muted, not disappear");
    expect(requestItem.disabled).toBe(true);
    expect(requestItem.textContent).toContain("You can't request changes on your own PR");
    const commentItem = menuItem("Comment…");
    if (!commentItem) throw new Error("Comment… did not render");
    expect(commentItem.disabled).toBe(false);
    expect(document.activeElement).toBe(commentItem);
    await act(async () => requestItem.click());
    await settle();
    expect(submissionDialogOpen("Request Changes")).toBe(false);
    await act(async () => commentItem.click());
    await settle();
    expect(submissionDialogOpen("Post Review Comments")).toBe(true);
    expect(eventRadio("comment")?.checked).toBe(true);
    expect(eventRadio("request_changes")?.disabled).toBe(true);
    expect(document.getElementById("review-request-changes-reason")?.textContent)
      .toContain("own pull request");
    expect(submissions).toHaveLength(0);
  });

  test("double-tap Alt flips the spec between destinations and strands nothing", async () => {
    seedPlatformSession();
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    expect(primaryButton()!.textContent).toContain("Post Comments");

    const tapAlt = () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));
    };
    const doubleTapAlt = async () => {
      await act(async () => {
        tapAlt();
        tapAlt();
      });
      await settle();
    };

    await doubleTapAlt();
    expect(primaryButton()!.textContent).toContain("Send Feedback");

    await doubleTapAlt();
    expect(primaryButton()!.textContent).toContain("Post Comments");
    expect(submissions).toHaveLength(0);

    for (const key of ["F5", "ArrowLeft"]) {
      await act(async () => {
        for (let i = 0; i < 2; i += 1) {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", altKey: true, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, altKey: true, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, altKey: true, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));
        }
      });
      await settle();
      expect(primaryButton()!.textContent).toContain("Post Comments");
    }
  });
});

describe.if(hasDom)("review: a send that does not reach Plannotator", () => {
  const failureToast = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]"))
      .filter((el) => el.getAttribute("data-removed") !== "true")
      .find((el) => el.querySelector("[data-title]")?.textContent?.endsWith(" not sent"));
  const toastButton = (label: string) =>
    Array.from(failureToast()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => b.textContent === label);
  const completionState = () => document.querySelector("[data-completion-state]")?.getAttribute("data-completion-state") ?? null;

  async function waitFor(check: () => unknown, what: string): Promise<void> {
    for (let attempt = 0; attempt < 40 && !check(); attempt += 1) await settle();
    if (!check()) throw new Error(`timed out waiting for ${what}`);
  }

  test("Send Feedback with the server gone: the message, Copy feedback, then Retry sends it", async () => {
    feedbackNetworkFailures = 1;
    const clipboard = navigator.clipboard;
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    try {
      seededExternalAnnotations = [EXTERNAL_FINDING];
      await mountReview();
      await settle();
      await settle();
      expect(primaryButton()!.title).toContain("Send");
      await act(async () => primaryButton()!.click());
      await waitFor(failureToast, "the failure message");

      expect(completionState()).toBeNull();
      expect(failureToast()!.textContent).toContain("Feedback not sent");
      expect(failureToast()!.textContent).toContain("isn't running");

      await act(async () => toastButton("Copy feedback")!.click());
      await waitFor(() => copied.length > 0, "the copy");
      expect(copied[0]).toBe(submissions[0]!.feedback!);

      await act(async () => toastButton("Retry")!.click());
      await waitFor(() => completionState(), "the completion screen");
      expect(submissions).toHaveLength(2);
      expect(submissions[1]!.feedback).toContain("still drops null");
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    }
  });

  test("a bare Approve answered 500: Approval not sent, nothing to copy, no Approved screen", async () => {
    failFeedbackPosts = 1;
    await mountReview();
    await act(async () => primaryButton()!.click());
    await waitFor(failureToast, "the failure message");

    expect(completionState()).toBeNull();
    expect(failureToast()!.textContent).toContain("Approval not sent");
    expect(failureToast()!.textContent).toContain("500");
    expect(Boolean(toastButton("Copy feedback"))).toBe(false);
    expect(primaryButton()!.title).toContain("Approve");
  });
});
