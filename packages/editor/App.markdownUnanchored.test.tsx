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

const PLAN = [
  "# Unanchored target",
  "",
  "Alpha paragraph one ends at ALPHAEND.",
  "",
  "Beta paragraph two opens at BETASTART.",
].join("\n");

const DRAFT = {
  annotations: [
    {
      id: "annDrifted",
      blockId: "",
      startOffset: 0,
      endOffset: 34,
      type: "COMMENT",
      text: "this line no longer exists",
      originalText: "A sentence removed in an earlier revision.",
      createdA: 1,
      startMeta: { parentTagName: "P", parentIndex: 0, textOffset: 0 },
      endMeta: { parentTagName: "P", parentIndex: 0, textOffset: 5 },
    },
    {
      id: "annLive",
      blockId: "",
      startOffset: 0,
      endOffset: 8,
      type: "COMMENT",
      text: "still fine",
      originalText: "ALPHAEND",
      createdA: 2,
    },
  ],
  globalAttachments: [],
  ts: 1,
};

function fetchForPlan(plan: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname === "/api/plan") return Response.json(plan);
    if (url.pathname === "/api/archive/plans") return Response.json({ plans: [] });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") {
      if (method === "GET") return Response.json(DRAFT);
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function settleRepaint(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) await settle(60);
}

async function mount(): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = fetchForPlan({
    plan: PLAN,
    origin: "claude-code",
    mode: "annotate",
    filePath: "/tmp/unanchored.md",
    sharingEnabled: false,
    serverConfig: {},
  });
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 20; attempt += 1) await settle();
}

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);

const chipCount = (): number =>
  document.querySelectorAll("[data-annotation-unanchored]").length;

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

describe.if(hasDom)("markdown unanchored chip", () => {
  test("marks only the comment the restore could not anchor", async () => {
    await mount();
    expect(chipCount()).toBe(0);

    const restore = findButton("Restore");
    if (!restore) throw new Error("Draft recovery dialog did not offer Restore");
    await act(async () => { restore.click(); });
    await settleRepaint();

    expect(document.body.textContent).toContain("this line no longer exists");
    expect(document.body.textContent).toContain("still fine");
    expect(chipCount()).toBe(1);
    expect(document.querySelector("[data-annotation-unanchored]")?.textContent)
      .toContain("Unanchored");
    expect(document.querySelector('[data-bind-id="annLive"], [data-highlight-id="annLive"]'))
      .not.toBeNull();
  });
});
