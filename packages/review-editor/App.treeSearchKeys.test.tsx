import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetStorageBackend, setStorageBackend, type StorageBackend } from "@plannotator/ui/utils/storage";
import { configStore } from "@plannotator/ui/config";
import { key, searchInput, typeInSearch } from "./components/treeKeys.testing";

mock.module("./workerPool", () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== "undefined";
const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;

const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (k) => memory.get(k) ?? null,
  setItem: (k, value) => void memory.set(k, value),
  removeItem: (k) => void memory.delete(k),
};

const file = (name: string) => [
  `diff --git a/src/${name} b/src/${name}`,
  "index 0000001..0000002 100644",
  `--- a/src/${name}`,
  `+++ b/src/${name}`,
  "@@ -1 +1 @@",
  "-a",
  "+b",
  "",
].join("\n");
const PATCH = file("refunds.ts") + file("ledger.ts") + file("review.ts");

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

const posted: string[] = [];

function makeFetch(): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if ((init?.method ?? "GET") !== "GET") posted.push(url.pathname);
    if (url.pathname === "/api/diff") {
      return Response.json({
        rawPatch: PATCH,
        gitRef: "uncommitted",
        snapshotId: "snap-1",
        origin: "claude-code",
        diffType: "uncommitted",
        hideWhitespace: false,
        repoInfo: { display: "acme/payments-service", branch: "add-refund-flow" },
        gitContext: { vcsType: "git", defaultBranch: "main", currentBranch: "add-refund-flow", diffOptions: [{ id: "uncommitted", label: "Uncommitted" }] },
      });
    }
    if (url.pathname === "/api/diff/fresh") return Response.json({ fresh: true });
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
  return impl as unknown as typeof fetch;
}

const media = (phone: boolean) => ((query: string) => ({
  matches: phone && query.includes("max-width: 639px"),
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
})) as unknown as typeof window.matchMedia;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 80 && !check(); attempt += 1) await settle();
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

async function mount(phone: boolean): Promise<void> {
  setStorageBackend(memoryBackend);
  for (const name of ["plannotator-announce-tui-herdr-seen", "plannotator-announce-inbox-seen", "plannotator-token-hover-announcement-seen", "plannotator-review-dest-spotlight-seen"]) memory.set(name, "1");
  memory.set("plannotator-plan-look-choice-resolved", "true");
  memory.set("plannotator-guide-intro-seen", "2");
  memory.set("plannotator-guide-hint-acked", "true");
  memory.set("plannotator-edit-mode-announcement-seen", "3");
  configStore.loadFromBackend();
  window.matchMedia = media(phone);
  globalThis.fetch = makeFetch();
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  await waitFor(() => document.body.textContent?.includes("add-refund-flow") ?? false, "the review to load");
  await waitFor(() => !!tree()?.shadowRoot?.querySelector('[data-item-type="file"]'), "the tree");
  await settle();
}

const tree = () => document.querySelector<HTMLElement>("[data-changes-tree]");
const fileRow = (name: string) => [...(tree()?.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-type="file"]') ?? [])].find((row) => row.dataset.itemPath?.endsWith(name));
const viewed = (name: string) => fileRow(name)?.dataset.itemMuted === "true";
const isOpen = (name: string) => fileRow(name)?.getAttribute("aria-selected") === "true";

async function openFile(name: string): Promise<void> {
  await act(async () => fileRow(name)?.click());
  await waitFor(() => isOpen(name), `${name} to open`);
  await settle();
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  posted.length = 0;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom && originalMatchMedia) window.matchMedia = originalMatchMedia;
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => resetStorageBackend());

describe.if(hasDom)("the tree's search box and the page's one-key shortcuts", () => {
  test("typing in the search box neither marks the open file viewed nor stages it, and every letter lands", async () => {
    await mount(false);
    await openFile("ledger.ts");
    expect(viewed("ledger.ts")).toBe(false);
    const events = await typeInSearch(tree()!, "review");
    await settle();
    expect(events.filter((event) => event.defaultPrevented).map((event) => event.key)).toEqual([]);
    expect(searchInput(tree()!).value).toBe("review");
    expect(viewed("ledger.ts")).toBe(false);
    expect(posted.filter((path) => path.includes("git-add"))).toEqual([]);
    expect(isOpen("review.ts")).toBe(false);
  });

  test("with a file row focused, V marks the open file viewed and no search opens", async () => {
    await mount(false);
    await openFile("ledger.ts");
    expect(viewed("ledger.ts")).toBe(false);
    const row = fileRow("ledger.ts")!;
    await act(async () => row.focus());
    await act(async () => key(row, "v"));
    await settle();
    await waitFor(() => viewed("ledger.ts"), "ledger.ts to show as viewed");
    expect(tree()!.shadowRoot!.querySelector<HTMLElement>("[data-file-tree-search-container]")!.dataset.open).toBe("false");
    expect(searchInput(tree()!).value).toBe("");
  });

  test("on a phone, typing in the search box keeps the file sheet open", async () => {
    await mount(true);
    const sheet = () => document.querySelector("[data-review-navigation-sheet]");
    await waitFor(() => sheet() !== null, "the file sheet");
    await typeInSearch(tree()!, "rev");
    await settle();
    expect(sheet()).not.toBeNull();
    expect(searchInput(tree()!).value).toBe("rev");
  });
});
