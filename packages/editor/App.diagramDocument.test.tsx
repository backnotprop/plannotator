import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

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

const MERMAID = "flowchart TD\n  A[Start] --> B{Choice}\n  B --> C[Done]\n";
const DOT = "digraph G {\n  a -> b;\n}\n";

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
  constructor(url: string | URL) { this.url = String(url); }
  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function planFetch(plan: Record<string, unknown>): typeof fetch {
  return async (input) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") return Response.json(plan);
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(plan: Record<string, unknown>): Promise<void> {
  globalThis.fetch = planFetch(plan);
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 30 && !document.querySelector("[data-diagram-block]"); attempt += 1) {
    await settle();
  }
}

function diagramBlock(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-diagram-block]");
}

const describeDom = hasDom ? describe : describe.skip;

describeDom("annotate: whole-file diagram sources", () => {
  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  test("a .mmd session renders the Mermaid engine's block, carrying the file's raw source", async () => {
    await mount({
      plan: MERMAID,
      origin: "claude-code",
      mode: "annotate",
      filePath: "/tmp/flow.mmd",
      renderAs: "mermaid",
      sharingEnabled: false,
      serverConfig: {},
    });

    const block = diagramBlock();
    expect(block).not.toBeNull();
    expect(block?.getAttribute("data-diagram-block")).toBe("mermaid");
    expect(host?.textContent).toContain("A[Start] --> B{Choice}");
  });

  test("a .dot session renders the Graphviz engine's block", async () => {
    await mount({
      plan: DOT,
      origin: "claude-code",
      mode: "annotate",
      filePath: "/tmp/graph.dot",
      renderAs: "graphviz",
      sharingEnabled: false,
      serverConfig: {},
    });
    expect(diagramBlock()?.getAttribute("data-diagram-block")).toBe("graphviz");
  });

  test("the same text with renderAs markdown is NOT a diagram (the regression this replaces)", async () => {
    await mount({
      plan: MERMAID,
      origin: "claude-code",
      mode: "annotate",
      filePath: "/tmp/flow.txt",
      renderAs: "markdown",
      sharingEnabled: false,
      serverConfig: {},
    });
    for (let attempt = 0; attempt < 10; attempt += 1) await settle();
    expect(diagramBlock()).toBeNull();
  });
});
