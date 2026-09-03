/**
 * Review (agent-mode) decision-control wiring (DOM_TESTS=1) — spec §8D review
 * payloads + E16-review, through the real posted /api/feedback body.
 *
 * Regressions each test guards:
 *  - Empty-state `Approve` must post the bare approval body (`approved: true`,
 *    `feedback: ''`, `annotations: []`): the LGTM placeholder was removed with
 *    PR5's delivery (spec §6.4) — consumers now print approve-time feedback,
 *    so any filler here would be appended to every approval, and the empty
 *    body is what makes the archive's `lgtm` decision reachable.
 *  - `Send Feedback` must post the live annotations with `approved: false` —
 *    the state where the old header offered a data-destroying Approve.
 *  - `Request changes…` must deliver the note as a `scope:'general'`
 *    CodeAnnotation with the ''/0/0 sentinels riding the annotations array
 *    AND inside the exported `## General` section, one render after the
 *    commit — a same-tick submit posts the pre-note payload and silently
 *    drops it (#1449 transport).
 *  - The discard confirm must post the bare approval (empty annotations), and
 *    nothing before the confirm.
 *  - Mod+Enter always equals the visible primary.
 *  - Approve-carrying menu items must be absent while the server does not
 *    advertise approval-note delivery — an OLD server's payload has no
 *    `approvalNotesSupported`, which must read as false (spec §2.2's "never
 *    render an item that silently drops content") — and under a capable
 *    server's advert `Approve with notes` must deliver the live annotations
 *    on the approval body.
 *  - Compact/touch must offer a visible positive decision row at zero and it
 *    must post (E16-review: touch has no Mod+Enter).
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";

// Vite-only virtual module (`?worker&inline`) — bun cannot resolve it, so the
// pool hooks are stubbed exactly like AllFilesCodeView.lifecycle.test.tsx does.
mock.module("./workerPool", () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));
// Image assets only Vite can load; the values are never asserted.
mock.module("@plannotator/ui/assets/workspaces.webp", () => ({ default: "workspaces.webp" }));
mock.module("@plannotator/ui/assets/review-sections.png", () => ({ default: "review-sections.png" }));
mock.module("@plannotator/ui/assets/review-tree.png", () => ({ default: "review-tree.png" }));

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

/** Suppress the one-time dialog chain (guide intro → look-and-feel → review
 *  setup → edit mode) so the header is interactable on first render. */
function seedFirstRunSeen(): void {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-review-setup-seen", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  memory.set("plannotator-review-dest-spotlight-seen", "1");
}

/** External annotations delivered as the stream's opening snapshot, so a test
 *  can seed the session with pre-existing findings without driving the diff
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
  approved?: boolean;
  feedback?: string;
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
/** How many upcoming /api/feedback POSTs answer 500. Each failed attempt is
 *  still recorded in `submissions` so its captured body can be asserted. */
let failFeedbackPosts = 0;
/** When true, /api/diff carries `approvalNotesSupported: true` — the capable
 *  server. Default false mimics an OLD server whose payload has no such
 *  field at all, pinning that absent reads as not-capable. */
let advertiseApprovalNotes = false;
/** Extra fields merged into the /api/diff payload — a PR session is entered by
 *  shipping `prMetadata` (+ `platformUser`) exactly the way the server does. */
let prDiffExtras: Record<string, unknown> | null = null;

/** GithubPRMetadata shape the diff payload carries in PR mode. */
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

function seedPlatformSession(options?: { selfAuthored?: boolean }): void {
  prDiffExtras = {
    prMetadata: PR_METADATA,
    platformUser: options?.selfAuthored ? PR_METADATA.author : "reviewer",
  };
  // The submission's success path opens the PR in a new tab by default;
  // window.open is not a browser here, so keep the toggle off.
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
  // SAFETY: the app only ever calls fetch(input, init); the double implements
  // that call signature and not `fetch.preconnect`.
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
        // Absent (not false) in the old-server shape: the pre-advert payload
        // simply had no such field.
        ...(advertiseApprovalNotes ? { approvalNotesSupported: true } : {}),
        ...(prDiffExtras ?? {}),
      });
    }
    if (url.pathname === "/api/pr-action") {
      submissions.push({ endpoint: "pr-action" });
      return Response.json({ ok: true, submission: { status: "complete" } });
    }
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
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

async function mount(waitFor: () => unknown): Promise<void> {
  setStorageBackend(memoryBackend);
  seedFirstRunSeen();
  globalThis.fetch = makeFetch();
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
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
  advertiseApprovalNotes = false;
  prDiffExtras = null;
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
    // Empty since PR5: consumers print approve-time feedback, so the old
    // placeholder would be appended to every approval; '' is also what lets
    // the archive record a bare approval as `lgtm` with no sidecar.
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
    // The export the agent reads carries the note under ## General.
    expect(body.feedback).toContain("## General");
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

    // Frozen copy (maintainer-approved): 'Discard & approve' is the confirm.
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((el) => el.textContent === "Discard & approve");
    if (!confirm) throw new Error("discard confirm did not open");
    expect(submissions).toHaveLength(0); // nothing sent before the confirm
    await act(async () => confirm.click());
    await settle();

    expect(submissions).toHaveLength(1);
    const body = submissions[0]!;
    expect(body.approved).toBe(true);
    // Discard means discard: bare approval, no placeholder, no annotations.
    expect(body.feedback).toBe("");
    expect(body.annotations).toEqual([]);
  });

  // HIGH-1 repro (stage review): ConfirmDialog owns Mod+Enter through its own
  // window-level handler, and stopPropagation cannot stop same-target
  // listeners — without the sentinel guard in the app's Mod+Enter effect, one
  // keystroke over the open discard confirm posted TWO contradictory
  // decisions (this effect's approved:false send AND the confirm's
  // approved:true LGTM), leaving the session outcome to a race.
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

  // MEDIUM-1 (stage review): the armed-note failure path. A failed POST must
  // keep the committed note in state (the primary flips to Send Feedback with
  // the count), the next primary invocation must retry the SAME note-carrying
  // body, and success must clear the armed decision so nothing re-dispatches.
  test("a failed note submit stays armed; the primary retries the note-carrying body once", async () => {
    failFeedbackPosts = 1;
    await mountReview();

    await openComposer("Request changes");
    await typeNote("hold the line");
    await pressNoteKey("Enter", { metaKey: true });

    // First attempt: captured note body, but the POST failed — no completion.
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.approved).toBe(false);
    expect((submissions[0]!.annotations ?? []).some((a) => a.scope === "general" && a.text === "hold the line")).toBe(true);
    const primary = primaryButton();
    expect(primary).not.toBeNull(); // still reviewable, not submitted
    expect(primary!.title).toContain("Send"); // the note kept the feedback state

    // Retry via the primary: the same note-carrying body posts and succeeds.
    await act(async () => primary!.click());
    await settle();

    expect(submissions).toHaveLength(2);
    const retry = submissions[1]!;
    expect(retry.approved).toBe(false);
    const notes = (retry.annotations ?? []).filter((a) => a.scope === "general");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("hold the line");
    expect(retry.feedback).toContain("hold the line");

    // Cleared on success: nothing left to re-dispatch.
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

  // Spec §2.2's single mechanism + the compatibility matrix (spec §6.4):
  // the mock /api/diff here carries NO approvalNotesSupported field — the
  // old-server shape — which must read as not-capable, so an approve-carrying
  // item can never render where its note would be silently discarded.
  test("approve-with-notes items are absent when the server sends no advert (old server)", async () => {
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    await openMenu();
    expect(menuItem("Approve with notes")).toBeUndefined();
    expect(menuItem("discard 1 annotation")).toBeDefined(); // the menu itself is live
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
  });

  // PR5 delivery, App-level (spec §6.4): under a capable server's advert the
  // menu offers `Approve with notes`, and choosing it posts `approved: true`
  // with the live annotations riding AND their export as the feedback — the
  // string consumers print after the approved prompt. A regression to the old
  // handleApprove (empty annotations, placeholder feedback) approves while
  // silently discarding the reviewer's findings.
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

  // Spec §3.3 / test 17 — the state-driven proof, wired end to end: the
  // sidebar's "+ General comment" goes through the App handler (durable,
  // history-recorded, NOT PR-stamped) and the header control flips on the
  // same state. Guards the wiring a component test cannot see: the prop being
  // dropped from the sidebar mount, or the handler stamping PR context.
  test("a sidebar general comment flips the header to Send Feedback and rides the posted body", async () => {
    await mountReview();
    expect(primaryButton()!.textContent).toContain("Approve");

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[title="Annotations"]')!.click();
    });
    await settle();

    const addButton = document.querySelector<HTMLButtonElement>("[data-add-general-comment]");
    expect(addButton).not.toBeNull(); // reachable at totalCount === 0
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

    // The control is state-driven: one durable comment flips the primary.
    expect(primaryButton()!.textContent).toContain("Send Feedback");
    expect(primaryButton()!.textContent).toContain("1");

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
    // Not withPRContext-stamped — what lets it survive an in-place PR switch.
    expect((general as Record<string, unknown>).prUrl).toBeUndefined();
  });

  // Guards the exact regression this project exists to fix on the surface
  // that has no Mod+Enter (E16-review): compact at zero must offer a visible
  // positive decision row, and it must post the bare approval body.
  test("compact touch offers a positive decision row at zero and it posts", async () => {
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

    await mount(() => document.querySelector('button[aria-label="Options"]'));

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Options"]')!.click();
    });
    await settle();

    // Frozen copy (maintainer-approved): the positive row is 'Approve'.
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

// PR6 (§3.4): platform mode adopts the control's SHAPE. Every action must
// open the EXISTING ReviewSubmissionDialog (the only note field on this side)
// and never post a decision by itself — the failures these guard are a menu
// item bypassing the dialog straight into /api/pr-action or /api/feedback,
// the self-approval mute regressing into a dead end or a live approve, and
// Mod+Enter double-firing while the dialog is open.
describe.if(hasDom)("review decision control (platform mode)", () => {
  const submissionDialogOpen = (title: "Post Review Comments" | `Approve ${string}`) =>
    Array.from(document.querySelectorAll("h2")).some((el) => el.textContent === title);

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

    // Frozen copy (maintainer-approved): 'Post Comments' is the platform primary.
    expect(primaryButton()!.textContent).toContain("Post Comments");
    await act(async () => primaryButton()!.click());
    await settle();

    expect(submissionDialogOpen("Post Review Comments")).toBe(true);
    // The dialog owns submission: opening it must post NOTHING.
    expect(submissions).toHaveLength(0);
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
    expect(item.disabled).toBe(false); // not self-authored
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

    // The primary is Post Comments — never muted by self-authorship.
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

    // While the dialog is open, Mod+Enter belongs to the dialog: exactly one
    // /api/pr-action submit, and the header handler must not also fire (a
    // second dialog or a decision POST of its own).
    await pressModEnter();

    expect(submissions.filter((s) => s.endpoint === "pr-action")).toHaveLength(1);
    // The post-success status message is an FYI to the agent session, not a
    // decision: approved stays false.
    const statuses = submissions.filter((s) => s.endpoint === "feedback");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.approved).toBe(false);
    expect(statuses[0]!.feedback).toContain("approved on GitHub");
  });

  test("self-authored empty state: muted primary is a no-op (click and Mod+Enter); Request changes… stays live", async () => {
    seedPlatformSession({ selfAuthored: true });
    await mountReview();

    const primary = primaryButton()!;
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    // Frozen copy (maintainer-approved): the self-approval reason. The muted
    // primary carries it as a persistent accessible description (the visual
    // tooltip is the Tooltip component, not a native title).
    const describedBy = primary.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent)
      .toBe("You can't approve your own pull request on GitHub.");
    expect(primary.title).toBe(""); // no native title doubling the tooltip

    await act(async () => primary.click());
    await settle();
    await pressModEnter();
    expect(submissionDialogOpen("Approve PR")).toBe(false);
    expect(submissions).toHaveLength(0);

    // No dead end: the menu's Request changes… still opens the comment dialog.
    await openMenu();
    const approveItem = menuItem("Approve with a comment");
    if (!approveItem) throw new Error("muted approve item must render, not disappear");
    expect(approveItem.disabled).toBe(true);
    const requestItem = menuItem("Request changes");
    if (!requestItem) throw new Error("Request changes… did not render");
    expect(requestItem.disabled).toBe(false);
    // Roving focus skips the dead row: initial focus lands on the first
    // NON-disabled row, so keyboard users are never stranded on the mute.
    expect(document.activeElement).toBe(requestItem);
    await act(async () => requestItem.click());
    await settle();
    expect(submissionDialogOpen("Post Review Comments")).toBe(true);
    expect(submissions).toHaveLength(0);
  });

  test("double-tap Alt flips the spec between destinations and strands nothing", async () => {
    seedPlatformSession();
    seededExternalAnnotations = [EXTERNAL_FINDING];
    await mountReview();
    await settle();
    await settle();

    expect(primaryButton()!.textContent).toContain("Post Comments");
    expect(primaryButton()!.textContent).toContain("1");

    const doubleTapAlt = async () => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", bubbles: true }));
      });
      await settle();
    };

    await doubleTapAlt();
    // Agent spec, same annotation count — the flip swaps the spec, never the state.
    expect(primaryButton()!.textContent).toContain("Send Feedback");
    expect(primaryButton()!.textContent).toContain("1");

    await doubleTapAlt();
    expect(primaryButton()!.textContent).toContain("Post Comments");
    expect(primaryButton()!.textContent).toContain("1");
    expect(submissions).toHaveLength(0);
  });
});
