/**
 * Back in a review of several files keeps the reader's place (#2128, the
 * bundle follow-up of #2082), through the whole editor: the bundle opens its
 * first file, the reader scrolls to the middle, follows a link to a linked
 * markdown document (then, a second time, to a local HTML page), and uses the
 * sidebar's "Back to review-alpha.md" (the header's Back for the HTML page).
 * The bundle file must come back at the same block, not at its top.
 *
 * The failure this guards: bundle Back reopens the file as a linked document
 * (useLinkedDoc keeps one root, the empty bundle state, not a stack), so the
 * restore that back() runs for a single-file session never ran, and the short
 * linked document had already clamped the scroll to 0.
 *
 * happy-dom has no layout, so the document's scroll container (`<main>`) and
 * its blocks get a stand-in geometry: every block is BLOCK_HEIGHT tall,
 * stacked from the viewport's top, moving with `<main>`'s scrollTop, which is
 * clamped to the content's height like a browser's.
 *
 * Requires DOM (happy-dom) — runs under DOM_TESTS=1.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
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

// The issue's fixture: a long bundle file whose every section links out.
const ROOT = "/tmp/scroll-back-repro";
const ALPHA = `${ROOT}/review-alpha.md`;
const BETA = `${ROOT}/review-beta.md`;
const LINKED = `${ROOT}/linked.md`;
const MODULE = `${ROOT}/module.html`;
const ALPHA_TEXT = ["# Review document\n\n"]
  .concat(Array.from({ length: 80 }, (_, i) =>
    `## Section ${i + 1}\n\n[Open linked Markdown](linked.md) · [Open HTML module](module.html)\n\n${"Plain sample text for a long document. ".repeat(12)}\n\n`,
  ))
  .join("");

const fakeFetch: typeof fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
  const url = new URL(rawUrl, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/plan") {
    return Response.json({
      plan: "",
      origin: "claude-code",
      mode: "annotate-bundle",
      bundle: [
        { path: ALPHA, renderAs: "markdown" },
        { path: BETA, renderAs: "markdown" },
      ],
      filePath: ROOT,
      projectRoot: ROOT,
      documentDrafts: true,
      sharingEnabled: false,
      serverConfig: {},
    });
  }
  if (url.pathname === "/api/doc") {
    const path = url.searchParams.get("path") ?? "";
    if (path.endsWith("linked.md")) {
      return Response.json({ markdown: "# Linked document\n\nSample text.\n", filepath: LINKED, renderAs: "markdown" });
    }
    if (path.endsWith("module.html")) {
      return Response.json({
        rawHtml: "<!doctype html><html><head><title>Sample module</title></head><body><h1>Sample module</h1></body></html>",
        filepath: MODULE,
        renderAs: "html",
      });
    }
    if (path === ALPHA) return Response.json({ markdown: ALPHA_TEXT, filepath: ALPHA, renderAs: "markdown" });
    if (path === BETA) return Response.json({ markdown: "# Second document\n\nSample text.\n", filepath: BETA, renderAs: "markdown" });
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (url.pathname === "/api/draft/document" && method === "GET") return Response.json({ found: false }, { status: 404 });
  if (url.pathname === "/api/draft" && method === "GET") return Response.json({ found: false }, { status: 404 });
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  return Response.json({ ok: true });
};

// --- Stand-in geometry for <main> and its blocks ----------------------------

const BLOCK_HEIGHT = 100;
const VIEWPORT_HEIGHT = 500;
const originalRect = hasDom ? HTMLElement.prototype.getBoundingClientRect : (undefined as unknown as () => DOMRect);
const scrollTops = new WeakMap<HTMLElement, number>();
let ownScrollTop: PropertyDescriptor | undefined;
let clampObserver: MutationObserver | null = null;

const isMain = (el: HTMLElement) => el.tagName === "MAIN";
const blocksOf = (main: HTMLElement) => Array.from(main.querySelectorAll<HTMLElement>("[data-block-id]"));
const maxTop = (main: HTMLElement) => Math.max(0, blocksOf(main).length * BLOCK_HEIGHT - VIEWPORT_HEIGHT);
const rect = (top: number, height: number) => ({
  top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}),
}) as DOMRect;

function installGeometry(): void {
  ownScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      if (!isMain(this)) return 0;
      // A short document pulls the offset back for good, as in a browser.
      const top = Math.min(scrollTops.get(this) ?? 0, maxTop(this));
      scrollTops.set(this, top);
      return top;
    },
    set(this: HTMLElement, value: number) {
      if (!isMain(this)) return;
      scrollTops.set(this, Math.min(Math.max(0, value), maxTop(this)));
    },
  });
  // A browser clamps the offset as soon as the content gets shorter, whether
  // or not anything reads it: do the same on every DOM change.
  clampObserver = new MutationObserver(() => {
    for (const el of document.querySelectorAll<HTMLElement>("main")) void el.scrollTop;
  });
  clampObserver.observe(document.body, { childList: true, subtree: true });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (isMain(this)) return rect(0, VIEWPORT_HEIGHT);
    const main = this.closest("main");
    if (main && this.hasAttribute("data-block-id")) {
      const index = blocksOf(main).indexOf(this);
      return rect(index * BLOCK_HEIGHT - main.scrollTop, BLOCK_HEIGHT);
    }
    return originalRect.call(this);
  };
}

function removeGeometry(): void {
  clampObserver?.disconnect();
  clampObserver = null;
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  if (ownScrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", ownScrollTop);
  else delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
}

// --- Mounting ----------------------------------------------------------------

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (check()) return;
    await settle(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const main = () => document.querySelector<HTMLElement>("main")!;
const headingText = () => main().querySelector("h1")?.textContent ?? "";
const showsAlpha = () => (main().textContent ?? "").includes("Section 80");

/** The first block whose bottom is below the viewport's top, and its top. */
function topBlock(): { id: string | null; top: number } {
  for (const el of blocksOf(main())) {
    const r = el.getBoundingClientRect();
    if (r.bottom > 1) return { id: el.getAttribute("data-block-id"), top: r.top };
  }
  return { id: null, top: 0 };
}

/** The link of section 40 ("Open linked Markdown" or "Open HTML module"). */
function section40Link(text: string): HTMLAnchorElement {
  const links = Array.from(main().querySelectorAll<HTMLAnchorElement>("a")).filter((a) => a.textContent?.trim() === text);
  expect(links.length).toBe(80);
  return links[39]!;
}

async function mount(): Promise<void> {
  setStorageBackend(memoryBackend);
  seedAnnouncementsSeen();
  globalThis.fetch = fakeFetch;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  await waitFor(showsAlpha, "review-alpha.md to open");
}

beforeEach(() => {
  if (hasDom) installGeometry();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) {
    document.body.replaceChildren();
    removeGeometry();
  }
  memory.clear();
  resetStorageBackend();
});

afterAll(() => {
  resetStorageBackend();
});

/** Scroll review-alpha.md so a block in the middle sits 50px above the top. */
async function scrollToMiddle(): Promise<{ id: string | null; top: number }> {
  await act(async () => {
    main().scrollTop = 0;
    const index = blocksOf(main()).findIndex((el) => el.textContent?.trim() === "Section 40");
    main().scrollTop = index * BLOCK_HEIGHT + 50;
    main().dispatchEvent(new Event("scroll"));
  });
  await settle(50);
  const at = topBlock();
  expect(main().scrollTop).toBeGreaterThan(5_000);
  return at;
}

describe.if(hasDom)("annotate bundle Back keeps the reader's place", () => {
  test("sidebar Back from a linked markdown document returns to the same block", async () => {
    await mount();
    const before = await scrollToMiddle();

    await act(async () => { section40Link("Open linked Markdown").click(); });
    await waitFor(() => headingText().includes("Linked document"), "the linked document");
    expect(main().scrollTop).toBe(0); // the short document clamped the offset

    const back = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => /Back to review-alpha\.md/.test(b.textContent ?? ""));
    expect(back).toBeDefined();
    await act(async () => { back!.click(); });
    await waitFor(showsAlpha, "review-alpha.md to come back");
    await settle(1_300); // the restore's frames and settle passes

    expect(topBlock()).toEqual(before);
  });

  test("header Back from a linked HTML page returns to the same block", async () => {
    await mount();
    const before = await scrollToMiddle();

    await act(async () => { section40Link("Open HTML module").click(); });
    await waitFor(() => document.querySelector("[data-html-back]") !== null, "the HTML page's Back control");
    expect(main().scrollTop).toBe(0); // the page has no blocks: the offset is gone
    const htmlBack = document.querySelector<HTMLButtonElement>("[data-html-back]")!;
    expect(`${htmlBack.getAttribute("aria-label") ?? ""} ${htmlBack.textContent ?? ""}`).toContain("review-alpha.md");

    await act(async () => { document.querySelector<HTMLButtonElement>("[data-html-back]")!.click(); });
    await waitFor(showsAlpha, "review-alpha.md to come back");
    await settle(1_300);

    expect(topBlock()).toEqual(before);
  });

  test("the switcher still opens a bundle file at its top", async () => {
    await mount();
    await scrollToMiddle();
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-bundle-switcher] button[aria-label="Next file"]')!.click(); });
    await waitFor(() => headingText().includes("Second document"), "review-beta.md");
    expect(main().scrollTop).toBe(0);
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-bundle-switcher] button[aria-label="Previous file"]')!.click(); });
    await waitFor(showsAlpha, "review-alpha.md again");
    await settle(1_300);
    expect(main().scrollTop).toBe(0);
  });
});
