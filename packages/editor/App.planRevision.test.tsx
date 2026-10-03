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
};

function planPayload() {
  return {
    plan: server.plan,
    origin: "pi",
    ...(server.revision === undefined ? {} : { planRevision: server.revision }),
    previousPlan: server.plan === V2 ? V1 : null,
    versionInfo: { version: server.plan === V2 ? 2 : 1, totalVersions: server.plan === V2 ? 2 : 1, project: "demo" },
    sharingEnabled: false,
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

function approveButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    // The header button renders a compact "OK" label beside "Approve".
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

  test("a server that never revises gets the legacy body and no polling", async () => {
    server.revision = undefined;
    await mountPlan();

    await act(async () => approveButton()!.click());
    await waitUntil(() => server.decisions.length === 1);

    expect("planRevision" in server.decisions[0]!.body).toBe(false);
    expect(server.revisionPolls).toBe(0);
  });
});
