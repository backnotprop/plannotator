/**
 * Code review's page when its agent is gone (DOM_TESTS=1): `agent-gone` on
 * the external-annotations stream (packages/server/review.ts `setAgentGone`),
 * and `/api/feedback` refused with `410 agent_gone`
 * (packages/shared/review-agent-gone.ts).
 *
 * Regressions guarded: the page covering or closing itself when it hears the
 * agent is gone (the comments leave the screen); the page not saying so until
 * a Send fails; the notice staying after the agent is back; a refused Send
 * shown as sent, dropping the comment, or leaving it out of the draft.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";
import { configStore } from "@plannotator/ui/config";
import { AGENT_GONE_REASON } from "@plannotator/shared/review-agent-gone-words";
import { dismissSendFailureToast } from "@plannotator/ui/components/SendFailureToast";
import { dismissAgentGoneNotice } from "./components/AgentGoneNotice";

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
  // A toast closed by its own button stays in sonner's store, and the next
  // test's Toaster would show it again: dismiss them all, and forget the
  // notice and the failure the modules hold.
  dismissAgentGoneNotice();
  dismissSendFailureToast();
  toast.dismiss();
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

// Sonner keeps earlier toasts in its module store: find these by their words.
// Asserted as booleans: Bun's toBeUndefined() passes on a happy-dom element.
const liveToasts = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]"))
    .filter((el) => el.getAttribute("data-removed") !== "true");
const goneNotice = () => liveToasts().find((el) => el.querySelector("[data-title]")?.textContent === AGENT_GONE_REASON);
const failureToast = () => liveToasts().find((el) => el.querySelector("[data-title]")?.textContent?.endsWith(" not sent"));
const primaryButton = () => document.querySelector<HTMLButtonElement>("[data-decision-primary]");

async function addGeneralComment(text: string): Promise<void> {
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
}

async function waitFor(check: () => boolean, attempts = 60): Promise<void> {
  for (let attempt = 0; attempt < attempts && !check(); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  }
}

describe.if(hasDom)("a code review whose agent is gone", () => {
  test("the page says so at once and stays as it is: the comment on screen, in the draft, and in Copy feedback; no ended or sent screen", async () => {
    seedEarlierChainSeen();
    // Auto-close at 0 s: a done screen would close the tab at once.
    memory.set("plannotator-auto-close", "0");
    let closes = 0;
    window.close = () => { closes += 1; };
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text); } },
    });
    await mount("claude-code", undefined);
    await addGeneralComment("Split this into two PRs.");
    expect(streams.length).toBeGreaterThan(0);
    expect(!!goneNotice()).toBe(false);

    await closeStream({ type: "agent-gone", gone: true });
    await waitFor(() => !!goneNotice());

    expect(!!goneNotice()).toBe(true);
    expect(document.querySelector("[data-completion-state]")).toBeNull();
    expect(closes).toBe(0);
    // The comment is still on the page and still the reviewer's to send.
    expect(document.body.textContent).toContain("Split this into two PRs.");
    expect(primaryButton()!.textContent).toContain("Send Feedback");
    // The draft keeps saving it, so a reload brings it back.
    await waitFor(() => draftPosts.some((body) => body.includes("Split this into two PRs.")));
    expect(draftPosts.some((body) => body.includes("Split this into two PRs."))).toBe(true);
    const copy = goneNotice()!.querySelector<HTMLButtonElement>("[data-send-failure-copy]")!;
    await act(async () => { copy.click(); await Promise.resolve(); });
    await waitFor(() => written.length > 0);
    expect(written.join("\n")).toContain("Split this into two PRs.");
    delete (navigator as { clipboard?: unknown }).clipboard;
  }, 20_000);

  test("the agent back: the notice goes, and Send reaches it", async () => {
    seedEarlierChainSeen();
    await mount("claude-code", undefined);
    await addGeneralComment("Split this into two PRs.");
    await closeStream({ type: "agent-gone", gone: true });
    await waitFor(() => !!goneNotice());
    expect(!!goneNotice()).toBe(true);

    await closeStream({ type: "agent-gone", gone: false });
    await waitFor(() => !goneNotice());
    expect(!!goneNotice()).toBe(false);

    feedbackAnswer = "ok";
    await act(async () => primaryButton()!.click());
    await waitFor(() => !!document.querySelector("[data-completion-state]"));
    expect(feedbackPosts).toHaveLength(1);
    expect(document.querySelector("[data-completion-state]")).not.toBeNull();
  }, 20_000);

  // A stale "not sent" (no Retry) would tell the person Send cannot work while it now does.
  test("the agent back after a refused Send: the not-sent toast goes too, and Send reaches it", async () => {
    seedEarlierChainSeen();
    await mount("claude-code", undefined);
    await addGeneralComment("Split this into two PRs.");
    await closeStream({ type: "agent-gone", gone: true });
    await waitFor(() => !!goneNotice());
    feedbackAnswer = "gone";
    await act(async () => primaryButton()!.click());
    await waitFor(() => !!failureToast());
    expect(failureToast()!.textContent).toContain(AGENT_GONE_REASON);

    await closeStream({ type: "agent-gone", gone: false });
    await waitFor(() => !failureToast() && !goneNotice());
    expect(!!failureToast()).toBe(false);
    expect(!!goneNotice()).toBe(false);

    feedbackAnswer = "ok";
    await act(async () => primaryButton()!.click());
    await waitFor(() => !!document.querySelector("[data-completion-state]"));
    expect(feedbackPosts).toHaveLength(2);
    expect(document.querySelector("[data-completion-state]")).not.toBeNull();
  }, 20_000);

  // packages/server/external-annotations.ts tells every stream that opens where things stand.
  test("a reconnect that hears gone again keeps a closed notice closed; a new time gone shows it again", async () => {
    seedEarlierChainSeen();
    await mount("claude-code", undefined);
    await closeStream({ type: "agent-gone", gone: true });
    await waitFor(() => !!goneNotice());
    await act(async () => goneNotice()!.querySelector<HTMLButtonElement>("[data-close-button]")!.click());
    await waitFor(() => !goneNotice());
    expect(!!goneNotice()).toBe(false);

    await closeStream({ type: "agent-gone", gone: true });
    for (let attempt = 0; attempt < 10; attempt += 1) await settle();
    expect(!!goneNotice()).toBe(false);

    await closeStream({ type: "agent-gone", gone: false });
    await closeStream({ type: "agent-gone", gone: true });
    await waitFor(() => !!goneNotice());
    expect(!!goneNotice()).toBe(true);
    await closeStream({ type: "agent-gone", gone: false });
  }, 20_000);

  test("the agent's own close keeps its own screen", async () => {
    seedEarlierChainSeen();
    await mount("claude-code", undefined);
    await closeStream({ type: "session-closed", by: "agent", unsentAnnotations: 0 });
    const screen = document.querySelector<HTMLElement>("[data-completion-state]");
    expect(screen).not.toBeNull();
    expect(!!goneNotice()).toBe(false);
  });
});

/**
 * Send while the agent is gone, before the page heard it: the server refuses
 * it (`410 agent_gone`). Regression guarded: the page showing its sent
 * screen, or dropping the reviewer's comment, for a Send nobody received.
 */
describe.if(hasDom)("Send to an agent that is gone", () => {
  async function addGeneralCommentAndSend(text: string): Promise<void> {
    await addGeneralComment(text);
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
    expect(failureToast()!.textContent).toContain(AGENT_GONE_REASON);
    // Retry cannot reach a gone agent: not offered.
    expect(Array.from(failureToast()!.querySelectorAll("button")).some((b) => b.textContent === "Retry")).toBe(false);
    // The comment is still the reviewer's: still on the page, still sendable.
    expect(document.body.textContent).toContain("Split this into two PRs.");
    expect(primaryButton()!.textContent).toContain("Send Feedback");
    // And still in the draft, so a reload brings it back.
    await waitFor(() => draftPosts.some((body) => body.includes("Split this into two PRs.")));
    expect(draftPosts.some((body) => body.includes("Split this into two PRs."))).toBe(true);
  });

  test("a live agent still gets it: the sent screen, as before", async () => {
    seedEarlierChainSeen();
    feedbackAnswer = "ok";
    await mount("claude-code", undefined);
    await addGeneralCommentAndSend("Split this into two PRs.");
    for (let attempt = 0; attempt < 40 && !document.querySelector("[data-completion-state]"); attempt += 1) await settle();

    expect(feedbackPosts).toHaveLength(1);
    expect(document.querySelector("[data-completion-state]")).not.toBeNull();
    expect(!!failureToast()).toBe(false);
  });
});
