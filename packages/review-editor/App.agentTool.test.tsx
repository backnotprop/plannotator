/**
 * The `plannotator` agent tool switch in code review (DOM_TESTS=1): the
 * one-time "turn it on" offer and the Settings row, from the serverConfig on
 * /api/diff. The plan editor's twin is packages/editor/App.agentTool.test.tsx.
 *
 * Regressions guarded: the offer missing from code review on Pi / OpenCode 2
 * or showing where the server reports no tool host; "Yes, turn it on" not posting
 * `{ agentTool: true }` or not retiring the offer; the Settings row missing
 * from code review, or editable under PLANNOTATOR_AGENT_TOOL.
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

const AGENT_TOOL_KEY = "plannotator-announce-agent-tool-seen";
const DIALOG = "[data-agent-tool-announcement-dialog]";
const SETTING_ROW = "[data-agent-tool-setting]";

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

let configPosts: unknown[] = [];

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
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
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

function buttonIn(selector: string, label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`"${label}" did not render`);
  return button;
}

async function openSettings(): Promise<void> {
  const options = document.querySelector<HTMLButtonElement>('button[aria-label="Options"]');
  if (!options) throw new Error("Options menu did not render");
  await act(async () => options.click());
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === "Settings");
  if (!item) throw new Error("Settings item did not render");
  await act(async () => item.click());
  await settle();
}

const PI_OFF = { agentTool: false, agentToolConfigured: false, agentToolHost: "pi", agentToolEnabled: false };

afterEach(async () => {
  await unmount();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  configPosts = [];
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("agent tool switch in code review", () => {
  test("Pi with the tool off: the offer turns it on and the Settings row follows", async () => {
    seedEarlierChainSeen();
    await mount("pi", PI_OFF);
    expect(document.querySelector(DIALOG)?.getAttribute("data-agent-tool-host")).toBe("pi");

    await act(async () => buttonIn(DIALOG, "Yes, turn it on").click());
    await settle();
    expect(configPosts).toEqual([{ agentTool: true }]);
    expect(memory.get(AGENT_TOOL_KEY)).toBe("1");

    await act(async () => buttonIn(DIALOG, "Done").click());
    expect(document.querySelector(DIALOG)).toBeNull();

    await openSettings();
    expect(document.querySelector(`${SETTING_ROW} button[role="switch"]`)?.getAttribute("aria-checked")).toBe("true");
  });

  test("no offer and no row where the server reports no tool host", async () => {
    seedEarlierChainSeen();
    await mount("opencode", undefined);
    expect(document.querySelector(DIALOG)).toBeNull();
    expect(memory.has(AGENT_TOOL_KEY)).toBe(false);
    await openSettings();
    expect(document.querySelectorAll("nav.hidden button").length).toBeGreaterThan(0);
    expect(document.querySelector(SETTING_ROW)).toBeNull();
  });

  test("the Settings row is locked under PLANNOTATOR_AGENT_TOOL, and there is no offer", async () => {
    seedEarlierChainSeen();
    await mount("pi", { ...PI_OFF, agentToolEnv: false });
    expect(document.querySelector(DIALOG)).toBeNull();
    await openSettings();
    const toggle = document.querySelector<HTMLButtonElement>(`${SETTING_ROW} button[role="switch"]`);
    expect(toggle?.disabled).toBe(true);
    expect(document.querySelector(SETTING_ROW)?.textContent).toContain("PLANNOTATOR_AGENT_TOOL");
  });
});
