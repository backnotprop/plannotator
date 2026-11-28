import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetStorageBackend, setStorageBackend, type StorageBackend } from "@plannotator/ui/utils/storage";
import { configStore } from "@plannotator/ui/config";

mock.module("./workerPool", () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

let workersCreated = 0;
mock.module("./semDiff/createSemDiffWorker", () => ({
  createSemDiffWorker: () => {
    workersCreated += 1;
    return { postMessage() {}, terminate() {}, addEventListener() {}, removeEventListener() {}, onmessage: null, onerror: null };
  },
}));

const hasDom = typeof document !== "undefined";
const App = hasDom ? (await import("./App")).default : null;
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 0000001..0000002 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-export function a() { return 1; }",
  "+export function a() { return 2; }",
  "",
].join("\n");

const fetchStub = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  if (url.pathname === "/api/diff") {
    return Response.json({
      rawPatch: PATCH,
      gitRef: "HEAD",
      snapshotId: "snap-1",
      origin: "claude-code",
      diffType: "uncommitted",
      gitContext: { vcsType: "git", defaultBranch: "main", currentBranch: "feature", diffOptions: [{ id: "uncommitted", label: "Uncommitted" }] },
      semDiff: { runtime: "/assets/sem-diff/runtime.wasm", grammars: { "tree-sitter-typescript.wasm": "/assets/sem-diff/tree-sitter-typescript.wasm" } },
      serverConfig: {},
    });
  }
  if (url.pathname === "/api/file-content") {
    return Response.json({ oldContent: "export function a() { return 1; }\n", newContent: "export function a() { return 2; }\n" });
  }
  if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({});
}) as unknown as typeof fetch;

class StubEventSource {
  readyState = 1;
  onmessage = null;
  onerror = null;
  onopen = null;
  constructor(readonly url: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  memory.set("plannotator-plan-look-choice-resolved", "true");
  setStorageBackend(memoryBackend);
  configStore.loadFromBackend();
  globalThis.fetch = fetchStub;
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(App ? <App /> : null);
  });
  for (let i = 0; i < 80 && !document.querySelector("[data-changes-tree]")?.shadowRoot?.textContent?.includes("a.ts"); i += 1) await settle();
  await settle(20);
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  workersCreated = 0;
  resetStorageBackend();
});

afterAll(() => resetStorageBackend());

describe.if(hasDom)("Settings › Reviews › Semantic changes", () => {
  test("on: the Semantic diff row and the per-file sem slot show, and the engine runs", async () => {
    await mount();
    expect(document.querySelector("[data-semantic-diff-icon]")).not.toBeNull();
    expect(document.querySelector("[data-semantic-file-badge]")).not.toBeNull();
    expect(workersCreated).toBeGreaterThan(0);
  });

  test("off: no Semantic diff row, no sem slot, and the engine never loads", async () => {
    memory.set("plannotator-semantic-diff-enabled", "false");
    await mount();
    expect(document.querySelector("[data-changes-tree]")).not.toBeNull();
    expect(document.querySelector("[data-semantic-diff-icon]")).toBeNull();
    expect(document.querySelector("[data-semantic-file-badge]")).toBeNull();
    expect(workersCreated).toBe(0);
  });
});
