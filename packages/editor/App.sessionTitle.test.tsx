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

const TITLE = "add-refund-flow review";
const PROPOSAL = "# Proposal\n\nSee the [design](design.md).\n";
const DESIGN = "# Design\n\nThe refund flow.\n";

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

function sessionFetch(title: string | undefined): typeof fetch {
  return async (input) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") {
      return Response.json({
        plan: PROPOSAL,
        origin: "claude-code",
        mode: "annotate",
        filePath: "/repo/docs/proposal.md",
        projectRoot: "/repo",
        repoInfo: { display: "acme/payments-service", branch: "main", host: "github.com" },
        sharingEnabled: false,
        serverConfig: {},
        ...(title === undefined ? {} : { title }),
      });
    }
    if (url.pathname === "/api/doc") {
      if (url.searchParams.get("path") === "design.md") return Response.json({ markdown: DESIGN, filepath: "/repo/docs/design.md" });
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40 && !check(); attempt += 1) await settle();
}

async function mount(title: string | undefined): Promise<void> {
  globalThis.fetch = sessionFetch(title);
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  await waitFor(() => !!document.querySelector("[data-block-id]"));
}

function headerName(): Element | null {
  return document.querySelector('[data-header-document-name="true"]');
}

describe.if(hasDom)("annotate --title: the tab and the header", () => {
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

  test("with a title: the tab and the header show it, and keep it when a linked document opens", async () => {
    await mount(TITLE);
    await waitFor(() => document.title === TITLE);
    expect(document.title).toBe(TITLE);
    expect(headerName()?.textContent).toBe(TITLE);
    const describedBy = headerName()?.getAttribute("aria-describedby");
    expect(describedBy ? document.getElementById(describedBy)?.textContent : null).toBe("/repo/docs/proposal.md");

    const link = [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === "design");
    expect(link).toBeDefined();
    await act(async () => { link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    await waitFor(() => !!document.querySelector("h1") && document.querySelector("h1")?.textContent === "Design");
    expect(document.querySelector("h1")?.textContent).toBe("Design");
    expect(document.title).toBe(TITLE);
    expect(headerName()?.textContent).toBe(TITLE);
  });

  test("without a title: the tab and the header name the open file, as before", async () => {
    await mount(undefined);
    await waitFor(() => document.title.startsWith("proposal.md"));
    expect(document.title).toBe("proposal.md · acme/payments-service");
    expect(headerName()?.textContent).toBe("proposal.md");
  });
});
