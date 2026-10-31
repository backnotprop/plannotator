/**
 * Relative references in an annotated document on Windows (DOM-gated).
 *
 * The server reports the document as `C:\docs\guide\notes.md`. Relative
 * images and links in it resolve against its directory, so `/api/image` and
 * `/api/doc` must get `C:/docs/guide` as their base. A slash-only dirname
 * leaves the backslash path whole: the base becomes the file itself, and the
 * images 404 unless the session happened to start in the document's folder.
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

const NOTES = "# Notes\n\n![Flow](images/flow.png)\n\nSee [retry](retry.md).\n";
const RETRY = "# Retry\n\nBack to [notes](notes.md).\n";

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
let docRequests: URL[] = [];

/** Serves the session, and `retry.md` / `notes.md` beside the document. */
function sessionFetch(filePath: string, dir: string, sep: string): typeof fetch {
  return async (input) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") {
      return Response.json({
        plan: NOTES,
        origin: "claude-code",
        mode: "annotate",
        filePath,
        projectRoot: `${sep === "\\" ? "C:\\" : "/"}elsewhere`,
        sharingEnabled: false,
        serverConfig: {},
      });
    }
    if (url.pathname === "/api/doc") {
      docRequests.push(url);
      const name = url.searchParams.get("path") ?? "";
      if (name === "retry.md") return Response.json({ markdown: RETRY, filepath: `${dir}${sep}retry.md` });
      if (name === "notes.md") return Response.json({ markdown: NOTES, filepath: filePath });
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

async function mount(filePath: string, dir: string, sep: string): Promise<void> {
  docRequests = [];
  globalThis.fetch = sessionFetch(filePath, dir, sep);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  await waitFor(() => !!document.querySelector("[data-block-id]"));
}

function imageBase(alt: string): string | null {
  const img = [...document.querySelectorAll("img")].find((i) => i.getAttribute("alt") === alt);
  const src = img?.getAttribute("src");
  return src ? new URL(src, "http://localhost").searchParams.get("base") : null;
}

async function clickLink(text: string): Promise<void> {
  const link = [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === text);
  expect(link).toBeDefined();
  await act(async () => { link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

describe.if(hasDom)("annotate: relative references resolve from the document's folder", () => {
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

  test("a Windows path: an image's base is the document's folder, not the file", async () => {
    await mount("C:\\docs\\guide\\notes.md", "C:\\docs\\guide", "\\");
    await waitFor(() => imageBase("Flow") !== null);
    expect(imageBase("Flow")).toBe("C:/docs/guide");
  });

  test("a POSIX path keeps the same base", async () => {
    await mount("/docs/guide/notes.md", "/docs/guide", "/");
    await waitFor(() => imageBase("Flow") !== null);
    expect(imageBase("Flow")).toBe("/docs/guide");
  });

  test("a Windows path: links resolve from the document's folder, then the linked document's", async () => {
    await mount("C:\\docs\\guide\\notes.md", "C:\\docs\\guide", "\\");
    await clickLink("retry");
    await waitFor(() => docRequests.some((u) => u.searchParams.get("path") === "retry.md"));
    const toRetry = docRequests.find((u) => u.searchParams.get("path") === "retry.md");
    expect(toRetry?.searchParams.get("base")).toBe("C:/docs/guide");

    await waitFor(() => [...document.querySelectorAll("a")].some((a) => a.textContent?.trim() === "notes"));
    await clickLink("notes");
    await waitFor(() => docRequests.some((u) => u.searchParams.get("path") === "notes.md"));
    const back = docRequests.find((u) => u.searchParams.get("path") === "notes.md");
    expect(back?.searchParams.get("base")).toBe("C:/docs/guide");
  });
});
