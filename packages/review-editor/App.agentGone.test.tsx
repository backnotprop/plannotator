/**
 * Code review's page when the server says its agent is gone (DOM_TESTS=1):
 * `session-closed` with `by: "gone"` on the external-annotations stream
 * (packages/server/review.ts `announceAgentGone`).
 *
 * Regressions guarded: the page staying editable after its server quit (a
 * keystroke typed there is lost); text typed into a comment box but not added
 * yet lost (missing from the saved draft and from Copy feedback); the screen
 * closing the tab by itself (auto-close at 0 s took Copy feedback with it) or
 * telling the person to return to the agent that is gone; the ended screen
 * worded as the agent's own close; a review with no comments claiming some
 * were saved.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";
import { configStore } from "@plannotator/ui/config";
import { REVIEW_ENDED_KEPT_UNFINISHED_TEXT, REVIEW_ENDED_TITLE, reviewEndedSubtitle } from "./components/ReviewEnded";
import { describeSendFailure } from "@plannotator/ui/utils/sendFailure";

// Vite-only virtual module (`?worker&inline`): stubbed like App.panelView.test.tsx.
mock.module("./workerPool", () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== "undefined";

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalClose = hasDom ? window.close : () => {};


const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

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

function diffPayload(origin: string, agentTool: Record<string, unknown> | undefined) {
  return {
    rawPatch: PATCH,
    gitRef: "HEAD",
    snapshotId: "snap-1",
    origin,
    diffType: "uncommitted",
    hideWhitespace: false,
    gitContext: {
      vcsType: "git",
      defaultBranch: "main",
      currentBranch: "feature/parser",
      diffOptions: [{ id: "uncommitted", label: "Uncommitted" }],
    },
    serverConfig: { ...(agentTool ?? {}) },
  };
}

const streams: StubEventSource[] = [];

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1;
  constructor() {
    streams.push(this);
  }
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

let configPosts: unknown[] = [];
let draftPosts: string[] = [];
/** What /api/feedback answers: the server's agent-gone refusal, or ok (a live agent). */
let feedbackAnswer: "gone" | "ok" = "ok";
let feedbackPosts: Array<{ annotations?: Array<{ scope?: string; text?: string }> }> = [];

function makeFetch(origin: string, agentTool: Record<string, unknown> | undefined): typeof fetch {
  // SAFETY: the app only ever calls fetch(input, init).
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/diff") return Response.json(diffPayload(origin, agentTool));
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/config" && init?.method === "POST") {
      configPosts.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft" && init?.method === "POST") {
      draftPosts.push(String(init.body));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname === "/api/feedback" && init?.method === "POST") {
      feedbackPosts.push(JSON.parse(String(init.body)));
      // packages/shared/review-agent-gone.ts: what both review servers answer.
      if (feedbackAnswer === "gone") {
        return Response.json({ error: "The agent that asked for this review is gone.", code: "agent_gone" }, { status: 410 });
      }
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Retire every earlier one-time announcement, Ask this session included. */
function seedEarlierChainSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-announce-ask-session-seen", "1");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-token-hover-announcement-seen", "1");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

async function mount(origin: string, agentTool: Record<string, unknown> | undefined): Promise<void> {
  setStorageBackend(memoryBackend);
  configStore.loadFromBackend();
  globalThis.fetch = makeFetch(origin, agentTool);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 40 && !document.body.textContent?.includes("parse.ts"); attempt += 1) {
    await settle();
  }
  for (let attempt = 0; attempt < 10; attempt += 1) await settle();
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
}


async function closeStream(event: Record<string, unknown>): Promise<void> {
  await act(async () => {
    for (const stream of streams) stream.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  });
  for (let attempt = 0; attempt < 5; attempt += 1) await settle();
}

afterEach(async () => {
  await unmount();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  configPosts = [];
  draftPosts = [];
  feedbackAnswer = "ok";
  feedbackPosts = [];
  window.close = originalClose;
  streams.length = 0;
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("a code review whose agent is gone", () => {
  test("the page is covered by the ended screen, which never closes the tab or sends the person back to the agent", async () => {
    seedEarlierChainSeen();
    // Auto-close at 0 s: the done screen would close the tab at once.
    memory.set("plannotator-auto-close", "0");
    let closes = 0;
    window.close = () => { closes += 1; };
    await mount("claude-code", undefined);
    expect(document.querySelector("[data-review-ended]")).toBeNull();
    expect(streams.length).toBeGreaterThan(0);

    await closeStream({ type: "session-closed", by: "gone", unsentAnnotations: 0 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3_200)); });

    const screen = document.querySelector<HTMLElement>("[data-review-ended]");
    expect(screen?.textContent).toContain(REVIEW_ENDED_TITLE);
    expect(screen?.textContent).toContain(reviewEndedSubtitle(0));
    expect(document.querySelector("[data-completion-state]")).toBeNull();
    expect(closes).toBe(0);
    expect(document.body.textContent).not.toContain("return to");
    expect(document.body.textContent).not.toContain("Auto-close");
    // No comments: nothing to copy, no claim that a draft holds some.
    expect(screen?.querySelector("[data-review-ended-copy]")).toBeNull();
    expect(screen?.textContent).not.toContain("saved as a draft");
    expect(draftPosts).toEqual([]);
  }, 15_000);

  // Any comment box left open with text in it (here a stand-in text box the
  // person typed in): its words go into the draft and into Copy feedback.
  test("text typed but not added yet is kept: saved in the draft as a general comment and in Copy feedback", async () => {
    seedEarlierChainSeen();
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text); } },
    });
    await mount("claude-code", undefined);
    const box = document.createElement("textarea");
    document.body.appendChild(box);
    box.value = "Half-typed: why is b 2?";
    await act(async () => { box.dispatchEvent(new Event("input", { bubbles: true })); });
    // An AI question box is not a comment.
    const ask = document.createElement("textarea");
    ask.setAttribute("data-not-a-comment", "");
    document.body.appendChild(ask);
    ask.value = "What does parse do?";
    await act(async () => { ask.dispatchEvent(new Event("input", { bubbles: true })); });

    await closeStream({ type: "session-closed", by: "gone", unsentAnnotations: 0 });
    for (let attempt = 0; attempt < 20 && !document.querySelector("[data-review-ended]"); attempt += 1) await settle();

    expect(draftPosts.some((body) => body.includes("Half-typed: why is b 2?"))).toBe(true);
    expect(draftPosts.some((body) => body.includes("What does parse do?"))).toBe(false);
    const screen = document.querySelector<HTMLElement>("[data-review-ended]");
    expect(screen?.textContent).toContain(reviewEndedSubtitle(1));
    expect(screen?.textContent).toContain(REVIEW_ENDED_KEPT_UNFINISHED_TEXT);
    const copy = screen!.querySelector<HTMLButtonElement>("[data-review-ended-copy]")!;
    await act(async () => { copy.click(); await Promise.resolve(); });
    expect(written.join("\n")).toContain("Half-typed: why is b 2?");
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  test("the agent's own close keeps its own screen", async () => {
    seedEarlierChainSeen();
    await mount("claude-code", undefined);
    await closeStream({ type: "session-closed", by: "agent", unsentAnnotations: 0 });
    const screen = document.querySelector<HTMLElement>("[data-completion-state]");
    expect(screen).not.toBeNull();
    expect(document.querySelector("[data-review-ended]")).toBeNull();
    expect(screen?.textContent).not.toContain(REVIEW_ENDED_TITLE);
  });
});

/**
 * Send while the agent is gone, before any end was announced: the server
 * refuses it (`410 agent_gone`). Regression guarded: the page showing its sent
 * screen, or dropping the reviewer's comment, for a Send nobody received.
 */
describe.if(hasDom)("Send to an agent that is gone", () => {
  // Sonner keeps earlier toasts in its module store: find this one by title.
  const failureToast = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]"))
      .filter((el) => el.getAttribute("data-removed") !== "true")
      .find((el) => el.querySelector("[data-title]")?.textContent?.endsWith(" not sent"));
  const primaryButton = () => document.querySelector<HTMLButtonElement>("[data-decision-primary]");

  async function addGeneralCommentAndSend(text: string): Promise<void> {
    await act(async () => {
      document.querySelector<HTMLButtonElement>("button[data-review-panel-toggle]")!.click();
    });
    await settle();
    await act(async () => document.querySelector<HTMLButtonElement>("[data-add-general-comment]")!.click());
    await settle();
    const input = document.querySelector<HTMLTextAreaElement>("[data-review-general-composer] [data-decision-note-input]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>("[data-general-comment-add]")!.click());
    await settle();
    expect(primaryButton()!.textContent).toContain("Send Feedback");
    await act(async () => primaryButton()!.click());
    for (let attempt = 0; attempt < 10; attempt += 1) await settle();
  }

  test("is reported as not sent, shows no sent screen, and keeps the comment", async () => {
    seedEarlierChainSeen();
    feedbackAnswer = "gone";
    await mount("claude-code", undefined);
    await addGeneralCommentAndSend("Split this into two PRs.");
    for (let attempt = 0; attempt < 40 && !failureToast(); attempt += 1) await settle();

    expect(feedbackPosts).toHaveLength(1);
    expect(feedbackPosts[0]!.annotations?.some((a) => a.scope === "general" && a.text === "Split this into two PRs.")).toBe(true);
    expect(document.querySelector("[data-completion-state]")).toBeNull();
    expect(failureToast()!.textContent).toContain("Feedback not sent");
    expect(failureToast()!.textContent).toContain(describeSendFailure({ kind: "agent-gone" }));
    // Retry cannot reach a gone agent: not offered.
    expect(Array.from(failureToast()!.querySelectorAll("button")).some((b) => b.textContent === "Retry")).toBe(false);
    // The comment is still the reviewer's: still on the page, still sendable.
    expect(document.body.textContent).toContain("Split this into two PRs.");
    expect(primaryButton()!.textContent).toContain("Send Feedback");
  });

  test("a live agent still gets it: the sent screen, as before", async () => {
    seedEarlierChainSeen();
    feedbackAnswer = "ok";
    await mount("claude-code", undefined);
    await addGeneralCommentAndSend("Split this into two PRs.");
    for (let attempt = 0; attempt < 40 && !document.querySelector("[data-completion-state]"); attempt += 1) await settle();

    expect(feedbackPosts).toHaveLength(1);
    expect(document.querySelector("[data-completion-state]")).not.toBeNull();
    expect(failureToast()).toBeUndefined();
  });
});
