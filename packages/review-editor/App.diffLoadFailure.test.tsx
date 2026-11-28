/**
 * A review whose first GET /api/diff fails (DOM_TESTS=1).
 *
 * The page used to fall back to the built-in demo diff on any failure: the
 * person saw a TypeScript file nobody changed, and no Feedback button (the
 * decision controls need the session's origin), so the review could not be
 * answered (#940: the server ran out of memory building the diff). Guards:
 *  - a failed load shows the load error state with the server's reason, and
 *    no demo file; the alert holds the reason only, and focus lands on
 *    Retry (on the heading once feedback is sent);
 *  - Retry loads the diff again and the review opens on the real files;
 *  - after a 5xx (a live review server that failed to build the diff),
 *    feedback and Close still reach the server; feedback carries
 *    draftGeneration 0, so a saved server draft is kept, and the agent switch
 *    a normal decision sends;
 *  - an unreachable server or a 404 offers no decision: those requests carry
 *    no session nonce and could end a different session on a reused port;
 *  - an "already decided" answer says so instead of blaming a stopped server.
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
import { saveAgentSwitchSettings } from "@plannotator/ui/utils/agentSwitch";
import { DEMO_DIFF } from "./demoData";

// Vite-only virtual module (`?worker&inline`), stubbed like App.panelView.test.tsx.
mock.module("./workerPool", () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

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

const PATCH = [
  "diff --git a/src/refunds.ts b/src/refunds.ts",
  "index 0000001..0000002 100644",
  "--- a/src/refunds.ts",
  "+++ b/src/refunds.ts",
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");

/** The first file path of the demo diff: what the old fallback showed. */
const DEMO_PATH = /^diff --git a\/(\S+)/m.exec(DEMO_DIFF)?.[1] ?? "";

class StubEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

interface Posted { path: string; search: string; body: unknown }

/**
 * /api/diff answers each scripted response in turn (the last one repeats); a
 * throwing answer is a network error. Decisions answer `decisionAnswer`.
 */
function makeFetch(
  diffAnswers: Array<() => Response>,
  posted: Posted[],
  decisionAnswer: () => Response,
): typeof fetch {
  let diffCalls = 0;
  // SAFETY: the app only ever calls fetch(input, init); the double implements
  // that call signature and not `fetch.preconnect`.
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (init?.method === "POST") {
      posted.push({ path: url.pathname, search: url.search, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      return url.pathname === "/api/feedback" || url.pathname === "/api/exit" ? decisionAnswer() : Response.json({ ok: true });
    }
    if (url.pathname === "/api/diff") {
      const answer = diffAnswers[Math.min(diffCalls, diffAnswers.length - 1)];
      diffCalls += 1;
      return answer();
    }
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

const failing = () => new Response("Internal Server Error: Out of memory", { status: 500, headers: { "Content-Type": "text/plain" } });
const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
const unreachable = (): Response => { throw new TypeError("Failed to fetch"); };
const serving = (rawPatch: string) => () => Response.json({
  rawPatch,
  gitRef: "uncommitted",
  snapshotId: "snap-1",
  origin: "claude-code",
  diffType: "uncommitted",
  hideWhitespace: false,
  repoInfo: { display: "acme/payments-service", branch: "add-refund-flow" },
});
const accepted = () => Response.json({ ok: true });
const alreadyDecided = () => Response.json({ error: "Review already decided", code: "already_decided" }, { status: 409 });

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 80 && !check(); attempt += 1) await settle();
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

function seedUnrelatedAnnouncementsSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-token-hover-announcement-seen", "1");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

const errorState = () => document.querySelector("[data-review-load-error='']");

async function mount(
  diffAnswers: Array<() => Response>,
  posted: Posted[] = [],
  decisionAnswer: () => Response = accepted,
): Promise<void> {
  setStorageBackend(memoryBackend);
  seedUnrelatedAnnouncementsSeen();
  configStore.loadFromBackend();
  globalThis.fetch = makeFetch(diffAnswers, posted, decisionAnswer);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
}

async function mountFailed(diffAnswers: Array<() => Response>, posted: Posted[] = [], decisionAnswer?: () => Response): Promise<void> {
  await mount(diffAnswers, posted, decisionAnswer);
  await waitFor(() => errorState() !== null, "the load error state");
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === label) as HTMLButtonElement | undefined;
}

function button(label: string): HTMLButtonElement {
  const found = findButton(label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

async function typeNote(text: string): Promise<void> {
  const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    // React tracks the value through the native setter.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const decisions = (posted: Posted[]) => posted.filter((p) => p.path === "/api/feedback" || p.path === "/api/exit");

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("review: the diff fails to load", () => {
  test("shows the server's reason, never the demo diff, and focuses Retry", async () => {
    expect(DEMO_PATH).not.toBe("");
    await mountFailed([failing]);
    expect(document.querySelector("[data-review-load-error-detail]")?.textContent).toContain("Out of memory");
    expect(document.body.textContent).not.toContain(DEMO_PATH);
    // The alert carries the reason only, never the form under it.
    const alert = document.querySelector("[data-review-load-error] [role='alert']");
    expect(alert?.querySelector("button, textarea")).toBeNull();
    expect(document.activeElement?.textContent?.trim()).toBe("Retry");
  });

  test("Retry loads the diff and opens the review on the real files", async () => {
    await mountFailed([failing, serving(PATCH)]);
    await act(async () => button("Retry").click());
    await waitFor(() => document.body.textContent?.includes("add-refund-flow") ?? false, "the review to load");
    expect(errorState()).toBeNull();
    expect(document.body.textContent).not.toContain(DEMO_PATH);
  });

  test("after a 5xx, feedback reaches the server with draftGeneration 0 and the agent switch", async () => {
    const posted: Posted[] = [];
    await mountFailed([failing], posted);
    saveAgentSwitchSettings({ switchTo: "build" });
    await typeNote("The diff broke; add dist/ to .gitignore");
    await act(async () => button("Send Feedback").click());
    await waitFor(() => decisions(posted).length === 1, "the feedback post");
    const [sent] = decisions(posted);
    expect(sent.path).toBe("/api/feedback");
    // Without a generation the server deletes a saved draft unchecked.
    expect(sent.body).toMatchObject({
      draftGeneration: 0,
      approved: false,
      feedback: "The diff broke; add dist/ to .gitignore",
      annotations: [],
      agentSwitch: "build",
    });
    await waitFor(() => document.querySelector("[data-review-load-error='done'] [role='status']") !== null, "the sent state");
    expect(document.activeElement?.tagName).toBe("H1");
  });

  test("after a 5xx, Close reaches the server with draftGeneration 0", async () => {
    const posted: Posted[] = [];
    await mountFailed([failing], posted);
    await act(async () => button("Close review").click());
    await waitFor(() => decisions(posted).length === 1, "the exit post");
    expect(decisions(posted)[0].path).toBe("/api/exit");
    expect(new URLSearchParams(decisions(posted)[0].search).get("draftGeneration")).toBe("0");
  });

  test("an unreachable server offers Retry only", async () => {
    await mountFailed([unreachable]);
    expect(findButton("Retry")).toBeDefined();
    expect(findButton("Send Feedback")).toBeUndefined();
    expect(findButton("Close review")).toBeUndefined();
  });

  test("a 404 (maybe another session on this port) offers Retry only", async () => {
    await mountFailed([notFound]);
    expect(findButton("Retry")).toBeDefined();
    expect(findButton("Send Feedback")).toBeUndefined();
    expect(findButton("Close review")).toBeUndefined();
  });

  test("an already decided review says so", async () => {
    const posted: Posted[] = [];
    await mountFailed([failing], posted, alreadyDecided);
    await act(async () => button("Close review").click());
    await waitFor(() => decisions(posted).length === 1, "the exit post");
    await waitFor(() => /already decided/i.test(document.body.textContent ?? ""), "the decided message");
    expect(document.body.textContent).not.toMatch(/may have stopped|isn't running/);
    expect(errorState()).not.toBeNull();
  });
});
