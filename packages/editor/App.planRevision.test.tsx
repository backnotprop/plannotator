/**
 * Revised plans pushed into an open plan review (non-blocking Pi plan
 * review), driven through the real App against a fetch double (DOM_TESTS=1).
 *
 * Regressions each test guards:
 *  - A decision must name the revision on screen. Without `planRevision` in
 *    the body the server cannot refuse an approval of text the agent has
 *    already replaced, and the reviewer approves a plan they never saw.
 *  - A 409 (stale revision) must NOT mark the review decided: the tab has to
 *    load the revised plan in place and let the reviewer decide again, with
 *    the next decision naming the new revision.
 *  - A revision must not load while a comment composer is open: applying it
 *    re-renders the document under the composer and the half-written comment
 *    is lost. It must load once the composer closes.
 *  - A server that never revises (no `planRevision` on /api/plan, e.g. the
 *    Claude Code plan server) must keep sending the legacy body and never
 *    poll the revision endpoint.
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
  document.cookie = "plannotator-announce-tui-herdr-seen=1; path=/";
  document.cookie = "plannotator-announce-inbox-seen=1; path=/";
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
  memory.set("plannotator-announce-tui-herdr-seen", "1");
  memory.set("plannotator-announce-inbox-seen", "1");
  memory.set("plannotator-vim-mode-announcement-seen", "2");
  memory.set("plannotator-plan-ai-announcement-seen", "1");
}

class StubEventSource {
  readonly readyState = 1;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  constructor(readonly url: string | URL) {}
  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

const V1 = "# Rollout plan\n\nFirst draft sentinel alpha.\n";
const V2 = "# Rollout plan\n\nRevised sentinel bravo.\n";

/** What the fake server holds: the live revision and the plan it shows. */
const server = {
  revision: 0 as number | undefined,
  plan: V1,
  decisions: [] as Array<{ endpoint: string; body: Record<string, unknown> }>,
  revisionPolls: 0,
  notes: false,
};

function planPayload() {
  return {
    plan: server.plan,
    origin: "pi",
    ...(server.revision === undefined ? {} : { planRevision: server.revision }),
    previousPlan: server.plan === V2 ? V1 : null,
    versionInfo: { version: server.plan === V2 ? 2 : 1, totalVersions: server.plan === V2 ? 2 : 1, project: "demo" },
    sharingEnabled: false,
    ...(server.notes ? { approvalNotesSupported: true } : {}),
    serverConfig: {},
  };
}

function makeFetch(): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") return Response.json(planPayload());
    if (url.pathname === "/api/plan/revision") {
      server.revisionPolls += 1;
      return Response.json({ revision: server.revision, decided: false });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    if (url.pathname === "/api/approve" || url.pathname === "/api/deny") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      server.decisions.push({ endpoint: url.pathname, body });
      if (typeof body.planRevision === "number" && body.planRevision !== server.revision) {
        return Response.json({ code: "plan_revised", planRevision: server.revision }, { status: 409 });
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

async function waitUntil(check: () => boolean, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts && !check(); i += 1) await settle();
  if (!check()) throw new Error("condition not reached");
}

/** Real-time wait for the 2s revision poll (settle() alone runs no timers). */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

function approveButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    // The decision control's primary reads "Approve" with nothing to send.
    (button) => button.textContent?.trim().endsWith("Approve") ?? false,
  );
}

async function mountPlan(): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = makeFetch();
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  await waitUntil(() => !!approveButton() && document.body.textContent!.includes("sentinel alpha"));
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  server.revision = 0;
  server.plan = V1;
  server.decisions = [];
  server.revisionPolls = 0;
  server.notes = false;
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("plan revisions pushed into an open review", () => {
  test("a stale approval loads the revised plan in place and the retry names the new revision", async () => {
    await mountPlan();

    // The agent revises while the reviewer is reading v1.
    server.revision = 1;
    server.plan = V2;

    await act(async () => approveButton()!.click());
    await waitUntil(() => document.body.textContent!.includes("sentinel bravo"));

    expect(server.decisions[0]).toMatchObject({ endpoint: "/api/approve", body: { planRevision: 0 } });
    // Still undecided: the reviewer gets to decide on v2.
    const retry = approveButton();
    expect(retry).toBeDefined();

    await act(async () => retry!.click());
    await waitUntil(() => server.decisions.length === 2);
    expect(server.decisions[1]).toMatchObject({ endpoint: "/api/approve", body: { planRevision: 1 } });
  });

  test("a revision waits while a comment composer is open and loads once it closes", async () => {
    await mountPlan();
    const globalButton = document.querySelector<HTMLButtonElement>('button[title="Add global comment"]');
    expect(globalButton).not.toBeNull();
    await act(async () => globalButton!.click());
    await waitUntil(() => !!document.querySelector('[data-comment-popover="true"] textarea'));
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover="true"] textarea')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(textarea, "Half-written sentinel charlie");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The agent revises while the reviewer is typing.
    server.revision = 1;
    server.plan = V2;
    const pollsBefore = server.revisionPolls;
    await waitFor(() => server.revisionPolls > pollsBefore, 4000);
    await waitFor(() => false, 600).catch(() => undefined);

    // Held: v1 still on screen, the composer and its text intact.
    expect(document.body.textContent).toContain("sentinel alpha");
    expect(document.body.textContent).not.toContain("sentinel bravo");
    expect(document.querySelector<HTMLTextAreaElement>('[data-comment-popover="true"] textarea')?.value).toBe("Half-written sentinel charlie");

    // Finishing the comment closes the composer; the revision then loads.
    const add = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-comment-popover="true"] button'))
      .find((button) => button.textContent?.trim() === "Add");
    expect(add).toBeDefined();
    await act(async () => add!.click());
    await waitFor(() => document.body.textContent!.includes("sentinel bravo"), 4000);
    expect(document.querySelector('[data-comment-popover="true"]')).toBeNull();
    // The finished comment survives the revision.
    expect(document.body.textContent).toContain("Half-written sentinel charlie");
  }, 15000);

  test("a server that never revises gets the legacy body and no polling", async () => {
    server.revision = undefined;
    await mountPlan();

    await act(async () => approveButton()!.click());
    await waitUntil(() => server.decisions.length === 1);

    expect("planRevision" in server.decisions[0]!.body).toBe(false);
    expect(server.revisionPolls).toBe(0);
  });
});

const decisionCaret = () => document.querySelector<HTMLButtonElement>("[data-decision-caret]");
const decisionPrimary = () => document.querySelector<HTMLButtonElement>("[data-decision-primary]");
const decisionNote = () => document.querySelector<HTMLTextAreaElement>("[data-decision-note-input]");

async function openDecisionComposer(labelPart: string, text: string): Promise<void> {
  await act(async () => decisionCaret()!.click());
  await settle();
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find((el) => el.textContent?.includes(labelPart));
  if (!item) throw new Error(`menu item "${labelPart}" not found`);
  await act(async () => item.click());
  await settle();
  const input = decisionNote()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe.if(hasDom)("plan revisions and the decision control (#1057)", () => {
  // What regresses: the reviewer is writing "Request changes…" about v1 and
  // the revision swaps the plan under the note, so the note answers a plan
  // they never read.
  test("a revision waits while the decision note is being written", async () => {
    await mountPlan();
    await openDecisionComposer("Request changes", "Half-written sentinel delta");

    server.revision = 1;
    server.plan = V2;
    const pollsBefore = server.revisionPolls;
    await waitFor(() => server.revisionPolls > pollsBefore, 4000);
    await waitFor(() => false, 600).catch(() => undefined);
    expect(document.body.textContent).toContain("sentinel alpha");
    expect(document.body.textContent).not.toContain("sentinel bravo");
    expect(decisionNote()?.value).toBe("Half-written sentinel delta");

    // Putting the note away (Escape: back to the menu, then close) lets it load.
    await act(async () => {
      decisionNote()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
    await act(async () => decisionCaret()!.click());
    await waitFor(() => document.body.textContent!.includes("sentinel bravo"), 4000);
  }, 15000);

  // What regresses: "Approve with a note…" is refused because the agent
  // revised the plan; the armed approve survives, the button now reads Send
  // Feedback (the note is a comment), and a click posts /api/approve anyway.
  test("an approve refused as plan_revised leaves nothing armed: the primary then sends feedback", async () => {
    server.notes = true;
    await mountPlan();
    server.revision = 1; // the agent revised; the tab has not polled yet
    server.plan = V2;
    await openDecisionComposer("Approve with a note", "ship it sentinel echo");
    await act(async () => {
      decisionNote()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor(() => server.decisions.length >= 1, 4000);
    expect(server.decisions[0]).toMatchObject({ endpoint: "/api/approve", body: { planRevision: 0 } });
    await waitFor(() => document.body.textContent!.includes("sentinel bravo"), 4000);
    await waitUntil(() => decisionPrimary()?.textContent?.includes("Send Feedback") ?? false);

    await act(async () => decisionPrimary()!.click());
    await waitFor(() => server.decisions.length >= 2, 4000);
    expect(server.decisions[1]!.endpoint).toBe("/api/deny");
    expect(server.decisions[1]!.body.planRevision).toBe(1);
    expect(String(server.decisions[1]!.body.feedback)).toContain("ship it sentinel echo");
    expect(server.decisions).toHaveLength(2);
  }, 15000);
});
