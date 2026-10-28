/**
 * Following a link in a raw-HTML annotate page while a comment is being typed
 * (DOM-gated): the link waits. The draft stays where it is, a toast says why,
 * and the linked document is not requested. With no typed comment the same
 * link opens its document. The page's bridge is played by a `link-click`
 * message from the page's own frame, as the bridge posts it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetStorageBackend, setStorageBackend, type StorageBackend } from "@plannotator/ui/utils/storage";
import { LINK_WAITS_FOR_DRAFT_TITLE, typedCommentDraft } from "./htmlLinkDraftGuard";

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

class SilentEventSource {
  readonly readyState = 1;
  onerror = null;
  onmessage = null;
  onopen = null;
  constructor(readonly url: string | URL) {}
  addEventListener(): void {}
  close(): void {}
  dispatchEvent(): boolean { return true; }
  removeEventListener(): void {}
}

const plan = {
  plan: "",
  origin: "codex",
  mode: "annotate",
  filePath: "/tmp/site/page.html",
  renderAs: "html",
  rawHtml: '<h1>Page</h1><a href="next.html">Next</a>',
  sharingEnabled: false,
  serverConfig: {},
};

let docRequests: string[] = [];
const fetchImpl: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
  if (url.pathname === "/api/plan") return Response.json(plan);
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
  if (url.pathname === "/api/doc") {
    docRequests.push(url.searchParams.get("path") ?? "");
    return Response.json({ rawHtml: "<h1>Next</h1>", renderAs: "html", filepath: url.searchParams.get("path") });
  }
  return Response.json({});
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<HTMLIFrameElement> {
  setStorageBackend(memoryBackend);
  for (const key of ["plannotator-look-feel-announcement-seen", "plannotator-vim-mode-announcement-seen"]) memory.set(key, "2");
  for (const key of ["plannotator-announce-tui-herdr-seen", "plannotator-announce-inbox-seen", "plannotator-plan-ai-announcement-seen", "plannotator-announce-ask-session-seen"]) memory.set(key, "1");
  globalThis.fetch = fetchImpl;
  // SAFETY: the App only uses EventSource's constructor, handlers and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let i = 0; i < 40 && !document.querySelector("iframe"); i++) await settle();
  const frame = document.querySelector<HTMLIFrameElement>("iframe");
  if (!frame?.contentWindow) throw new Error("the HTML page did not mount");
  return frame;
}

async function clickLink(frame: HTMLIFrameElement, href: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { type: "plannotator-bridge-link-click", href } }));
  });
  await settle(3);
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  resetStorageBackend();
  docRequests = [];
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)("a link while a comment is being typed", () => {
  test("typedCommentDraft finds only a composer with words in it", () => {
    document.body.innerHTML = '<div data-comment-popover="true"><textarea></textarea></div>';
    expect(typedCommentDraft()).toBeNull();
    document.querySelector("textarea")!.value = "  ";
    expect(typedCommentDraft()).toBeNull();
    document.querySelector("textarea")!.value = "Why this order?";
    expect(typedCommentDraft()).toBe(document.querySelector("textarea"));
  });

  test("the link waits: the draft stays, a toast says why, the document is not requested", async () => {
    const frame = await mount();
    // An open composer with typed words (the HTML viewer portals its composer to the page).
    const composer = document.createElement("div");
    composer.setAttribute("data-comment-popover", "true");
    const area = document.createElement("textarea");
    area.value = "Why this order?";
    composer.appendChild(area);
    document.body.appendChild(composer);
    await clickLink(frame, "next.html");
    expect(docRequests).toEqual([]);
    expect(area.isConnected).toBe(true);
    expect(area.value).toBe("Why this order?");
    for (let i = 0; i < 20 && !document.body.textContent?.includes(LINK_WAITS_FOR_DRAFT_TITLE); i++) await settle();
    expect(document.body.textContent).toContain(LINK_WAITS_FOR_DRAFT_TITLE);
  });

  test("with no typed comment the link opens its document", async () => {
    const frame = await mount();
    await clickLink(frame, "next.html");
    for (let i = 0; i < 20 && docRequests.length === 0; i++) await settle();
    expect(docRequests).toEqual(["/tmp/site/next.html"]);
  });
});
