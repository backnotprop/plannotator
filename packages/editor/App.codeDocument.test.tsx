/**
 * Config and data files in the annotate surface (DOM-gated).
 *
 * `plannotator annotate config.toml` serves the RAW file with
 * `renderAs: "code"`; the document must then be ONE code block in the file's
 * language, not the markdown parse that turned each `#` comment into a
 * heading and each backticked name into a code chip (#1099's follow-up).
 */
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

const TOML = [
  "# Config for the notes-api service (version 1): one file for every environment,",
  "# each key named after its variable (`server.port` is `NOTES_SERVER_PORT`).",
  "",
  "[database]",
  'url = "postgres://localhost:5432/notes"',
  "",
].join("\n");

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
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 30 && !document.querySelector("[data-block-id]"); attempt += 1) {
    await settle();
  }
}

const describeDom = hasDom ? describe : describe.skip;

const annotatePlan = (renderAs: string, filePath = "/tmp/config.toml") => ({
  plan: TOML,
  origin: "claude-code",
  mode: "annotate",
  filePath,
  renderAs,
  sharingEnabled: false,
  serverConfig: {},
});

// Headings of the DOCUMENT only: the annotations panel has its own <h2>.
const headings = () => [...(host?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? [])].filter((h) => h.closest("[data-block-id]"));
const documentCode = () => host?.querySelector("[data-block-id] pre code") ?? null;

describeDom("annotate: config files as code", () => {
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

  test("renderAs code shows the file as one toml code block, comments as written", async () => {
    await mount(annotatePlan("code"));
    expect(documentCode()?.classList.contains("language-toml")).toBe(true);
    expect(documentCode()?.textContent).toBe(TOML);
    expect(headings()).toHaveLength(0);
  });

  test("the same text as markdown makes the comments headings (the regression this guards)", async () => {
    await mount(annotatePlan("markdown"));
    expect(headings().length).toBeGreaterThan(0);
  });

  test("the version diff of a .toml shows its chunks as code, not markdown", async () => {
    // The failure: App never told the diff view the document is code, so the
    // previous version's comments rendered as headings again in the diff.
    await mount({
      ...annotatePlan("code"),
      previousPlan: TOML.replace("(version 1)", "(version 2)"),
      versionInfo: { version: 2, totalVersions: 2, project: "demo" },
    });
    const badge = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.title === "Changes since you last reviewed this file",
    );
    expect(badge).toBeDefined();
    await act(async () => { badge!.click(); });
    for (let attempt = 0; attempt < 30 && !host?.querySelector("pre[data-plan-diff-code]"); attempt += 1) await settle();
    const diff = host!.querySelector("[data-diff-block-index]")!.closest("article")!;
    expect(diff.querySelectorAll("pre[data-plan-diff-code]").length).toBeGreaterThan(0);
    expect(diff.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(0);
    expect(diff.querySelector("pre[data-plan-diff-code] > code.language-toml")).not.toBeNull();
  });

  test("a .conf file is a code block with no grammar guessed", async () => {
    await mount(annotatePlan("code", "/etc/app/server.conf"));
    expect(documentCode()?.textContent).toBe(TOML);
    expect([...(documentCode()?.classList ?? [])].some((name) => name.startsWith("language-"))).toBe(false);
  });
});
