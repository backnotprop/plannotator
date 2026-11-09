/**
 * AsciiDoc documents in the annotate surface (DOM-gated).
 *
 * `plannotator annotate guide.adoc` serves the RAW file with
 * `renderAs: "asciidoc"`; the document must then be the AsciiDoc parse
 * (`== Install` is a heading, `NOTE:` an alert), not the markdown parse that
 * shows the markup as text. A share link carries the kind as `r: 'asciidoc'`
 * so the portal, which has no server, parses it the same way.
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

const ADOC = "= Guide\n\n== Install\n\nNOTE: Back up *first*.\n\n* step one\n";

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

function planFetch(plan: Record<string, unknown> | null): typeof fetch {
  return async (input) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") return plan ? Response.json(plan) : new Response(null, { status: 404 });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function mount(plan: Record<string, unknown> | null): Promise<void> {
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

const annotatePlan = (renderAs: string) => ({
  plan: ADOC,
  origin: "claude-code",
  mode: "annotate",
  filePath: "/tmp/guide.adoc",
  renderAs,
  sharingEnabled: false,
  serverConfig: {},
});

function headingTexts(): string[] {
  return [...document.querySelectorAll("h1, h2")].map((h) => h.textContent?.trim() ?? "");
}

describeDom("annotate: AsciiDoc documents", () => {
  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    host?.remove();
    host = null;
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    window.location.hash = "";
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  test("renderAs asciidoc parses sections, admonitions and lists", async () => {
    await mount(annotatePlan("asciidoc"));
    expect(headingTexts()).toEqual(expect.arrayContaining(["Guide", "Install"]));
    expect(host?.textContent).not.toContain("== Install");
    expect(host?.textContent).not.toContain("NOTE:");
    expect(host?.querySelector("strong")?.textContent).toBe("first");
  });

  test("the same text as markdown shows the AsciiDoc markup (the regression this guards)", async () => {
    await mount(annotatePlan("markdown"));
    expect(host?.textContent).toContain("== Install");
  });

  test("a share link with r: asciidoc opens with the AsciiDoc parser", async () => {
    const { generateShareUrl } = await import("@plannotator/ui/utils/sharing");
    const url = await generateShareUrl(ADOC, [], undefined, "http://localhost", undefined, "asciidoc");
    window.location.hash = new URL(url!).hash;
    await mount(null);
    for (let attempt = 0; attempt < 30 && !headingTexts().includes("Install"); attempt += 1) await settle();
    expect(headingTexts()).toEqual(expect.arrayContaining(["Guide", "Install"]));
  });
});
