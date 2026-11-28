/**
 * config.json `annotateView`: the view an annotate session opens in (the
 * document toolbar's Wide | Focus | Edit). Mounts the real App against a
 * stubbed /api/plan whose serverConfig carries the key, the way both server
 * runtimes send it.
 *
 *  - set: the session opens in that view;
 *  - unset: exactly today (no view pressed, not editing);
 *  - a click in the toolbar wins for the session, and the key is not
 *    re-applied afterwards;
 *  - a view the document cannot use falls back to today's default silently
 *    (Edit on annotate-last, Edit while a saved draft is offered);
 *  - plan review ignores it.
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

class SilentEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = SilentEventSource.OPEN;
  readonly url: string;
  readonly withCredentials = false;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
  }

  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

function fetchFor(plan: Record<string, unknown>, draft: unknown = null): typeof fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/api/plan") return Response.json(plan);
    if (url.pathname === "/api/archive/plans") return Response.json({ plans: [] });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") {
      if (method === "GET" && draft) return Response.json(draft);
      if (method === "GET") return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(plan: Record<string, unknown>, draft?: unknown): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = fetchFor(plan, draft);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 10; attempt += 1) await settle();
}

const annotateFile = (serverConfig: Record<string, unknown>) => ({
  plan: "# Review target\n\nFirst body paragraph.\n\n## Second section\n\nSecond body paragraph.\n",
  origin: "claude-code",
  mode: "annotate",
  filePath: "/tmp/review.md",
  sharingEnabled: false,
  serverConfig,
});

const toolbarButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"))
    .find((button) => button.textContent?.trim() === label);

const pressed = (label: string): boolean => toolbarButton(label)?.getAttribute("aria-pressed") === "true";
const editing = (): boolean => document.querySelector(".cm-editor") !== null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) document.body.replaceChildren();
  memory.clear();
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("config.json annotateView", () => {
  test("unset opens exactly as today: no view pressed, not editing", async () => {
    await mount(annotateFile({}));
    expect(toolbarButton("Focus")).not.toBeUndefined();
    expect(pressed("Wide")).toBe(false);
    expect(pressed("Focus")).toBe(false);
    expect(editing()).toBe(false);
  });

  test("focus opens the session in Focus", async () => {
    await mount(annotateFile({ annotateView: "focus" }));
    expect(pressed("Focus")).toBe(true);
    expect(pressed("Wide")).toBe(false);
    expect(editing()).toBe(false);
  });

  test("wide opens the session in Wide", async () => {
    await mount(annotateFile({ annotateView: "wide" }));
    expect(pressed("Wide")).toBe(true);
    expect(pressed("Focus")).toBe(false);
  });

  test("edit opens the session in the editor", async () => {
    await mount(annotateFile({ annotateView: "edit" }));
    expect(editing()).toBe(true);
    expect(toolbarButton("Done")).not.toBeUndefined();
  });

  test("a click in the toolbar wins for the session, and the key is not applied again", async () => {
    await mount(annotateFile({ annotateView: "focus" }));
    expect(pressed("Focus")).toBe(true);

    await act(async () => { toolbarButton("Wide")?.click(); });
    expect(pressed("Wide")).toBe(true);
    expect(pressed("Focus")).toBe(false);

    // Leaving the view returns to the plain layout and stays there.
    await act(async () => { toolbarButton("Wide")?.click(); });
    for (let attempt = 0; attempt < 5; attempt += 1) await settle();
    expect(pressed("Wide")).toBe(false);
    expect(pressed("Focus")).toBe(false);
  });

  test("edit on a document that cannot be edited (annotate-last) falls back to today's default", async () => {
    await mount({
      plan: "# Last message\n\nThe reply text.\n",
      origin: "claude-code",
      mode: "annotate-last",
      filePath: "last-message",
      sharingEnabled: false,
      serverConfig: { annotateView: "edit" },
    });
    expect(document.body.textContent).toContain("The reply text.");
    expect(toolbarButton("Focus")).not.toBeUndefined();
    expect(editing()).toBe(false);
    expect(pressed("Wide")).toBe(false);
    expect(pressed("Focus")).toBe(false);
  });

  test("edit stays off while a saved draft is offered, so restoring it is never refused", async () => {
    await mount(annotateFile({ annotateView: "edit" }), {
      annotations: [{
        id: "ann-draft",
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: "GLOBAL_COMMENT",
        text: "A comment from last time",
        originalText: "",
        createdA: 1,
      }],
      globalAttachments: [],
      ts: 1,
    });
    expect(document.body.textContent).toContain("Draft Recovered");
    expect(editing()).toBe(false);
  });

  test("plan review ignores it", async () => {
    await mount({
      plan: "# A plan\n\nStep one.\n",
      origin: "claude-code",
      sharingEnabled: false,
      serverConfig: { annotateView: "focus" },
    });
    expect(document.body.textContent).toContain("Step one.");
    expect(pressed("Focus")).toBe(false);
  });
});
