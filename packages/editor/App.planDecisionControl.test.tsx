/**
 * Plan review's decision control (#1057, DOM_TESTS=1): the header, menu and
 * compact rows per host and state, and the bodies each choice posts.
 *
 * Regressions each test guards:
 *  - With comments, Approve stays the main button (the issue): the primary
 *    must flip to Send Feedback, and Mod+Enter must post that same deny.
 *  - The discard row must post a bare approval: a body that still carries
 *    the comments would arrive as "approved with notes" on a host that
 *    delivers notes, the opposite of what the reviewer confirmed.
 *  - "Approve with notes" must appear only where the server says notes on
 *    approval reach the agent (`approvalNotesSupported`); on the classic
 *    Claude Code hook it would silently lose them.
 *  - Request changes… and the notes must reach the agent as a GLOBAL_COMMENT
 *    in the posted feedback, on the right endpoint.
 *  - Send answers must keep `answersOnly: true` on the deny.
 *  - OpenCode's agent picker moved into the menu: a pick there must change
 *    the Approve label and the `agentSwitch` the approval posts.
 *  - Claude Code's permission line must state the mode Approve posts, and
 *    Change must open Settings.
 *  - Compact rows come from the same spec.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";
import { configStore } from "@plannotator/ui/config";

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
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function seedStorage(): void {
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
  memory.set("plannotator-announce-ask-session-seen", "1");
  memory.set("plannotator-announce-agent-tool-seen", "1");
  // Claude Code: a configured permission mode, so the first-run setup dialog
  // stays away and Approve posts this mode.
  memory.set("plannotator-permission-mode", "acceptEdits");
  memory.set("plannotator-permission-mode-configured", "true");
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
    const payload = seededExternalAnnotations;
    if (payload.length > 0) {
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ type: "snapshot", annotations: payload }) } as MessageEvent);
      }, 0);
    }
  }

  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

interface Decision {
  endpoint: "approve" | "deny";
  body: {
    feedback?: string;
    answersOnly?: boolean;
    agentSwitch?: string;
    permissionMode?: string;
    planSave?: { enabled: boolean };
    serverSession?: string;
    draftGeneration?: number;
  };
}

let decisions: Decision[] = [];
let agents: Array<{ id: string; name: string }> = [];
/** Upcoming /api/approve POSTs that fail as a network error (recorded first). */
let approveNetworkFailures = 0;
/** How the next /api/deny POST fails (recorded first), then it answers ok.
 *  "closed" is Pi's refusal once the session that opened the review ended. */
let nextDenyFailure: "network" | 500 | "closed" | null = null;
/** When set, /api/deny POSTs wait for it before answering (a send in flight). */
let denyGate: Promise<void> | null = null;

const PLAN = "# Plan: move tokens\n\nStore refresh tokens in the keychain.\n";
const QUESTION_PLAN = [
  "# Plan: move tokens",
  "",
  "Store refresh tokens in the keychain.",
  "",
  ":::question",
  "Where should the fallback live?",
  "- [ ] A file",
  "- [ ] Nowhere",
  ":::",
  "",
].join("\n");

function planPayload(extra: Record<string, unknown> = {}) {
  return {
    plan: PLAN,
    origin: "claude-code",
    sharingEnabled: false,
    serverSession: "sess-1",
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
    if (url.pathname === "/api/agents") return Response.json({ agents });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname === "/api/approve" || url.pathname === "/api/deny") {
      decisions.push({
        endpoint: url.pathname === "/api/approve" ? "approve" : "deny",
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      if (url.pathname === "/api/approve" && approveNetworkFailures > 0) {
        approveNetworkFailures -= 1;
        throw new TypeError("Failed to fetch");
      }
      if (url.pathname === "/api/deny" && nextDenyFailure !== null) {
        const failure = nextDenyFailure;
        nextDenyFailure = null;
        if (failure === "network") throw new TypeError("Failed to fetch");
        if (failure === "closed") {
          // apps/pi-extension/server/serverPlan.ts refuseClosed.
          return Response.json({ error: "This review was closed: the session that opened it ended.", code: "already_decided" }, { status: 409 });
        }
        return Response.json({ error: "boom" }, { status: failure });
      }
      if (url.pathname === "/api/deny" && denyGate) await denyGate;
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
  // SAFETY: the app only calls fetch(input, init); the double implements that.
  return impl as unknown as typeof fetch;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

const primaryButton = () => document.querySelector<HTMLButtonElement>("[data-decision-primary]");
const caretButton = () => document.querySelector<HTMLButtonElement>("[data-decision-caret]");
const noteInput = () => document.querySelector<HTMLTextAreaElement>("[data-decision-note-input]");
const menuLabels = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-decision-popover="menu"] [role="menuitem"]'))
    .filter((el) => !el.hasAttribute("data-permission-mode-change"))
    // ActionMenuItem: [icon span][label span + subtitle span].
    .map((el) => (el.querySelector("span.flex-col > span:first-child") ?? el.querySelector("span.flex-1"))?.textContent ?? "");
function menuItem(labelPart: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find((el) => el.textContent?.includes(labelPart));
}
function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((el) => el.textContent === text);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => unknown, what: string): Promise<void> {
  for (let attempt = 0; attempt < 40 && !check(); attempt += 1) await settle();
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

async function mount(plan: unknown): Promise<void> {
  setStorageBackend(memoryBackend);
  seedStorage();
  globalThis.fetch = makeFetch(plan);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  await waitFor(() => caretButton() || document.getElementById("pn-compact-plan-review-trigger"), "the decision control");
}

async function openMenu(): Promise<void> {
  await act(async () => caretButton()!.click());
  await settle();
}

async function writeNote(labelPart: string, note: string): Promise<void> {
  await openMenu();
  const item = menuItem(labelPart);
  if (!item) throw new Error(`menu item "${labelPart}" not found`);
  await act(async () => item.click());
  await settle();
  const input = noteInput()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, note);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
  });
  await settle();
}

async function chooseComposer(labelPart: string, note: string): Promise<void> {
  await writeNote(labelPart, note);
  await waitFor(() => decisions.length > 0, "the decision POST");
}

/** After a refused or cancelled "Approve with a note…": nothing is armed, so
 *  the primary reads Send Feedback (the note is now a general comment) and a
 *  click posts the deny it names, never the approve. */
async function expectPrimarySendsFeedback(note: string, before: number): Promise<void> {
  await waitFor(() => primaryButton()?.textContent?.includes("Send Feedback"), "Send Feedback");
  await act(async () => primaryButton()!.click());
  await waitFor(() => decisions.length > before, "the deny");
  expect(decisions.slice(before).map((d) => d.endpoint)).toEqual(["deny"]);
  expect(decisions[before]!.body.feedback).toContain(note);
}

const COMMENT = {
  id: "ext-1",
  blockId: "",
  startOffset: 0,
  endOffset: 0,
  type: "COMMENT",
  text: "use libsecret on Linux",
  originalText: "Store refresh tokens in the keychain.",
  createdA: 1,
  source: "eslint",
};

async function mountWithComment(plan: Record<string, unknown>): Promise<void> {
  seededExternalAnnotations = [COMMENT];
  await mount(planPayload(plan));
  await waitFor(() => primaryButton()?.textContent?.includes("Send Feedback"), "Send Feedback");
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom && originalMatchMedia) window.matchMedia = originalMatchMedia;
  decisions = [];
  agents = [];
  approveNetworkFailures = 0;
  nextDenyFailure = null;
  denyGate = null;
  seededExternalAnnotations = [];
  memory.clear();
  configStore.set("agentSwitch", null);
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("plan review decision control", () => {
  test("Claude Code hook, nothing to send: Approve; the menu has Request changes and the permission line", async () => {
    await mount(planPayload());
    expect(primaryButton()!.textContent).toContain("Approve");
    expect(buttonWithText("Send Feedback")).toBeUndefined(); // one control, not two buttons

    await openMenu();
    expect(menuLabels()).toEqual(["Request changes…"]);
    const line = document.querySelector("[data-permission-mode-line]");
    expect(line?.textContent).toContain("Claude Code");
    expect(line?.textContent).toContain("Auto-accept Edits");

    await act(async () => primaryButton()!.click());
    await waitFor(() => decisions.length > 0, "approve");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.endpoint).toBe("approve");
    expect(decisions[0]!.body.feedback).toBeUndefined();
    expect(decisions[0]!.body.permissionMode).toBe("acceptEdits");
    expect(decisions[0]!.body.serverSession).toBe("sess-1");
    expect(decisions[0]!.body.planSave).toBeDefined();
  });

  test("Change on the permission line opens Settings at the permission mode", async () => {
    await mount(planPayload());
    await openMenu();
    const change = document.querySelector<HTMLButtonElement>("[data-permission-mode-change]")!;
    await act(async () => change.click());
    await settle();
    expect(document.querySelector('[data-decision-popover]')).toBeNull();
    await waitFor(() => document.body.textContent?.includes("Automation level after plan approval"), "Settings");
  });

  test("Request changes… posts the note as a GLOBAL_COMMENT on /api/deny", async () => {
    await mount(planPayload());
    await chooseComposer("Request changes", "split the migration out");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.endpoint).toBe("deny");
    expect(decisions[0]!.body.feedback).toContain("split the migration out");
    expect(decisions[0]!.body.answersOnly).toBeUndefined();
  });

  test("Claude Code hook with a comment: Send Feedback; Mod+Enter posts the deny; no Approve with notes", async () => {
    await mountWithComment({});
    await openMenu();
    expect(menuLabels()).toEqual(["Send with a note…", "Approve, discard 1 annotation…"]);
    expect(menuItem("Approve, discard")!.textContent).toContain("Claude Code can't take notes on approval");
    await act(async () => caretButton()!.click());
    await settle();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor(() => decisions.length > 0, "deny");
    expect(decisions[0]!.endpoint).toBe("deny");
    expect(decisions[0]!.body.feedback).toContain("use libsecret on Linux");
  });

  test("the discard confirm names the agent and posts a bare approval", async () => {
    await mountWithComment({});
    await openMenu();
    await act(async () => menuItem("Approve, discard")!.click());
    await settle();
    expect(document.body.textContent).toContain("Claude Code doesn't take feedback on approval");
    expect(decisions).toHaveLength(0);
    await act(async () => buttonWithText("Discard & approve")!.click());
    await waitFor(() => decisions.length > 0, "approve");
    expect(decisions[0]!.endpoint).toBe("approve");
    expect(decisions[0]!.body.feedback).toBeUndefined();
    expect(decisions[0]!.body.permissionMode).toBe("acceptEdits");
  });

  test("a host that delivers notes: Approve with notes posts the comments as the approval's feedback", async () => {
    await mountWithComment({ origin: "pi", approvalNotesSupported: true });
    await openMenu();
    expect(menuLabels()).toEqual(["Send with a note…", "Approve with notes", "Approve, discard 1 annotation…"]);
    await act(async () => menuItem("Approve with notes")!.click());
    await waitFor(() => decisions.length > 0, "approve");
    expect(decisions[0]!.endpoint).toBe("approve");
    expect(decisions[0]!.body.feedback).toContain("use libsecret on Linux");
    expect(decisions[0]!.body.permissionMode).toBeUndefined();
  });

  test("Approve with a note… rides the approval on a host that delivers notes", async () => {
    await mount(planPayload({ origin: "pi", approvalNotesSupported: true }));
    await chooseComposer("Approve with a note", "ship it after the spike");
    expect(decisions[0]!.endpoint).toBe("approve");
    expect(decisions[0]!.body.feedback).toContain("ship it after the spike");
  });

  test("answers only: Send answers posts answersOnly", async () => {
    await mount(planPayload({ plan: QUESTION_PLAN, origin: "pi", approvalNotesSupported: true }));
    await waitFor(() => document.querySelector("fieldset[data-question-key]"), "the question card");
    const label = Array.from(document.querySelectorAll("fieldset[data-question-key] label"))
      .find((el) => el.textContent?.includes("Nowhere"))!.querySelector("span")!;
    await act(async () => (label as HTMLElement).click());
    await waitFor(() => primaryButton()?.textContent?.includes("Send answers"), "Send answers");

    await openMenu();
    expect(menuLabels()).toEqual(["Send answers with a note…", "Approve with notes", "Approve, discard 1 answer…"]);
    await act(async () => caretButton()!.click());
    await settle();

    await act(async () => primaryButton()!.click());
    await waitFor(() => decisions.length > 0, "deny");
    expect(decisions[0]!.endpoint).toBe("deny");
    expect(decisions[0]!.body.answersOnly).toBe(true);
  });

  test("OpenCode: the agent picker is a menu section; a pick renames Approve and is what approval posts", async () => {
    agents = [{ id: "build", name: "build" }, { id: "plan", name: "plan" }];
    await mount(planPayload({ origin: "opencode", approvalNotesSupported: true }));
    await waitFor(() => primaryButton()?.textContent?.includes("Approve → build"), "Approve → build");

    await openMenu();
    const radios = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    expect(radios.map((el) => el.textContent?.trim())).toEqual(["build", "plan", "No switch"]);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    await act(async () => radios[1]!.click());
    await settle();
    // A pick is not a decision: the menu stays open and nothing is posted.
    expect(document.querySelector('[data-decision-popover="menu"]')).not.toBeNull();
    expect(decisions).toHaveLength(0);
    expect(primaryButton()!.textContent).toContain("Approve → plan");

    await act(async () => primaryButton()!.click());
    await waitFor(() => decisions.length > 0, "approve");
    expect(decisions[0]!.endpoint).toBe("approve");
    expect(decisions[0]!.body.agentSwitch).toBe("plan");
  });

  // What regresses (review of #2055): a refused or cancelled "Approve with a
  // note…" left its approve armed, so the button read Send Feedback while a
  // click posted /api/approve.
  test("Approve with a note… cancelled at Agent Not Found: the primary then sends feedback", async () => {
    agents = [{ id: "build", name: "build" }];
    await mount(planPayload({ origin: "opencode", approvalNotesSupported: true }));
    await act(async () => configStore.set("agentSwitch", { switchTo: "ghost" }));
    await settle();
    await writeNote("Approve with a note", "note sentinel foxtrot");
    await waitFor(() => document.body.textContent?.includes("Agent Not Found"), "Agent Not Found");
    expect(decisions).toHaveLength(0);
    await act(async () => buttonWithText("Cancel")!.click());
    await settle();
    await expectPrimarySendsFeedback("note sentinel foxtrot", 0);
  });

  test("Approve with a note… whose POST fails: the primary then sends feedback", async () => {
    approveNetworkFailures = 1;
    await mount(planPayload({ origin: "pi", approvalNotesSupported: true }));
    await chooseComposer("Approve with a note", "note sentinel golf");
    expect(decisions[0]!.endpoint).toBe("approve");
    await expectPrimarySendsFeedback("note sentinel golf", 1);
  });

  // Agent Not Found's "Approve Anyway" must run the approve that raised it:
  // from the discard row that is a bare approval, not one with the comments.
  test("Agent Not Found on the discard row: Approve Anyway posts a bare approval", async () => {
    agents = [{ id: "build", name: "build" }];
    await mountWithComment({ origin: "opencode", approvalNotesSupported: true });
    await act(async () => configStore.set("agentSwitch", { switchTo: "ghost" }));
    await settle();
    await openMenu();
    await act(async () => menuItem("Approve, discard")!.click());
    await settle();
    await act(async () => buttonWithText("Discard & approve")!.click());
    await waitFor(() => document.body.textContent?.includes("Agent Not Found"), "Agent Not Found");
    expect(decisions).toHaveLength(0);
    await act(async () => buttonWithText("Approve Anyway")!.click());
    await waitFor(() => decisions.length > 0, "approve");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.endpoint).toBe("approve");
    expect(decisions[0]!.body.feedback).toBeUndefined();
    expect(decisions[0]!.body.agentSwitch).toBe("ghost");
  });

  test("compact touch rows come from the same spec", async () => {
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
    seededExternalAnnotations = [COMMENT];
    await mount(planPayload());
    await waitFor(() => document.getElementById("pn-compact-plan-review-trigger"), "the compact trigger");
    await settle();
    await act(async () => {
      document.getElementById("pn-compact-plan-review-trigger")!.click();
    });
    await settle();

    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-pn-compact-review-action]"));
    expect(rows.map((row) => row.getAttribute("data-pn-compact-review-action"))).toEqual(["feedback", "note", "discard-finish"]);
    expect(rows[2]!.textContent).toContain("Approve, discard 1 annotation…");

    await act(async () => rows[2]!.click());
    await settle();
    expect(decisions).toHaveLength(0); // the discard row asks first
    await act(async () => buttonWithText("Discard & approve")!.click());
    await waitFor(() => decisions.length > 0, "approve");
    expect(decisions[0]!.endpoint).toBe("approve");
    expect(decisions[0]!.body.feedback).toBeUndefined();
  });
});

/**
 * #1392: a decision that never reached Plannotator (the server stopped, or it
 * answered 500) must leave the review exactly as it was and say so. Before,
 * a 500 on deny or approve fell through to the Feedback Sent / Approved
 * screen, and a stopped server changed nothing visible at all.
 */
describe.if(hasDom)("plan review: a decision that does not reach Plannotator", () => {
  // Sonner keeps earlier tests' toasts in its module store, so find this one
  // by its title rather than taking the first toast on the page.
  const failureToast = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]"))
      // A dismissed toast stays in the DOM while it animates out.
      .filter((el) => el.getAttribute("data-removed") !== "true")
      .find((el) => el.querySelector("[data-title]")?.textContent?.endsWith(" not sent"));
  const toastButton = (label: string) =>
    Array.from(failureToast()?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => b.textContent === label);
  const completionState = () => document.querySelector("[data-completion-state]")?.getAttribute("data-completion-state") ?? null;

  test("Send Feedback answered 500: no Feedback Sent screen, the comment stays, Retry sends it", async () => {
    nextDenyFailure = 500;
    await mountWithComment({});
    await act(async () => primaryButton()!.click());
    await waitFor(failureToast, "the failure message");

    expect(completionState()).toBeNull();
    // Deliberate copy: the title says the feedback did not go out.
    expect(failureToast()!.textContent).toContain("Feedback not sent");
    expect(failureToast()!.textContent).toContain("500");
    expect(primaryButton()!.textContent).toContain("Send Feedback");
    expect(primaryButton()!.disabled).toBe(false);

    await act(async () => toastButton("Retry")!.click());
    await waitFor(() => completionState(), "the completion screen");
    expect(decisions.map((d) => d.endpoint)).toEqual(["deny", "deny"]);
    expect(decisions[1]!.body.feedback).toContain("use libsecret on Linux");
    expect(completionState()).toBe("denied");
  });

  test("Send Feedback with the server gone: Copy feedback copies what the page's Copy does", async () => {
    nextDenyFailure = "network";
    const clipboard = navigator.clipboard;
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
    try {
      await mountWithComment({});
      await act(async () => primaryButton()!.click());
      await waitFor(failureToast, "the failure message");

      expect(completionState()).toBeNull();
      expect(failureToast()!.textContent).toContain("isn't running");
      await act(async () => toastButton("Copy feedback")!.click());
      await waitFor(() => copied.length > 0, "the copy");
      // The deny framing the annotation panel's Copy adds, around the comment.
      expect(copied[0]).toContain("use libsecret on Linux");
      expect(copied[0]).not.toBe(decisions[0]!.body.feedback);
      // The message stays after a copy, so Retry is still there.
      await waitFor(() => toastButton("Copied"), "the Copied label");
      expect(Boolean(toastButton("Retry"))).toBe(true);
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
    }
  });

  test("a bare Approve with the server gone: Approval not sent, nothing to copy, no Approved screen", async () => {
    approveNetworkFailures = 1;
    await mount(planPayload());
    await act(async () => primaryButton()!.click());
    await waitFor(failureToast, "the failure message");

    expect(completionState()).toBeNull();
    expect(failureToast()!.textContent).toContain("Approval not sent");
    expect(Boolean(toastButton("Copy feedback"))).toBe(false);
    expect(Boolean(toastButton("Retry"))).toBe(true);
  });

  test("the next send takes the message down, and a success leaves none behind", async () => {
    nextDenyFailure = 500;
    await mountWithComment({});
    await act(async () => primaryButton()!.click());
    await waitFor(failureToast, "the failure message");

    // The header's own Send, not Retry: the message no longer applies.
    await act(async () => primaryButton()!.click());
    await waitFor(() => completionState(), "the completion screen");
    expect(completionState()).toBe("denied");
    expect(failureToast()).toBeUndefined();
  });

  // Retry beside a send already in flight would post the decision twice; the
  // Bun plan server has no already-decided check, so integrations (a Bear
  // note) and the archive would run twice.
  test("Retry while a send is in flight sends nothing", async () => {
    nextDenyFailure = "network";
    await mountWithComment({});
    await act(async () => primaryButton()!.click());
    await waitFor(failureToast, "the failure message");
    const retry = toastButton("Retry")!;

    let open!: () => void;
    denyGate = new Promise<void>((resolve) => { open = resolve; });
    await act(async () => primaryButton()!.click());
    await waitFor(() => decisions.length === 2, "the second send");
    // Still on the page (sonner animates a dismissed toast out).
    expect(retry.isConnected).toBe(true);
    await act(async () => retry.click());
    await settle();
    expect(decisions).toHaveLength(2);

    open();
    await waitFor(() => completionState(), "the completion screen");
    expect(decisions.map((d) => d.endpoint)).toEqual(["deny", "deny"]);
  });

  // Pi's plan server refuses a decision after the session that opened the
  // review ended (409 already_decided). It used to read as "The agent
  // revised the plan", which sends the reviewer looking for a new version.
  test("Pi's already_decided refusal is not a plan revision and offers no Retry", async () => {
    nextDenyFailure = "closed";
    await mountWithComment({ origin: "pi" });
    await act(async () => primaryButton()!.click());
    await waitFor(failureToast, "the failure message");

    expect(failureToast()!.textContent).toContain("already decided");
    expect(Boolean(toastButton("Retry"))).toBe(false);
    expect(Boolean(toastButton("Copy feedback"))).toBe(true);
    expect(document.body.textContent).not.toContain("The agent revised the plan");
    expect(completionState()).toBeNull();
  });
});
