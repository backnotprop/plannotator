import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { resetStorageBackend, setStorageBackend, type StorageBackend } from "@plannotator/ui/utils/storage";
import { configStore } from "@plannotator/ui/config";

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

function makeFetch(): typeof fetch {
  const impl = async (input: RequestInfo | URL) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
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
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom && originalMatchMedia) window.matchMedia = originalMatchMedia;
  memory.clear();
  resetStorageBackend();
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => resetStorageBackend());

const paneTabs = (pane: number) => [...document.querySelectorAll<HTMLElement>(`[data-pane="${pane}"] [data-pane-tab]`)].map((tab) => tab.title);
const activeTab = (pane: number) => document.querySelector<HTMLElement>(`[data-pane="${pane}"] [data-pane-tab][aria-selected="true"]`)?.title ?? "";

describe.if(hasDom)("opening files from the tree into panes and tabs", () => {
  test("Open to the side leaves the left pane on its file and shows the new one beside it", async () => {
    await mount(false);
    await openFile("ledger.ts");
    expect(activeTab(0)).toContain("ledger.ts");
    const row = fileRow("review.ts")!;
    await act(async () => {
      row.dispatchEvent(new PointerEvent("pointerdown", { button: 2, bubbles: true, composed: true }));
      row.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true, composed: true }));
      row.focus();
      row.dispatchEvent(new MouseEvent("contextmenu", { button: 2, bubbles: true, composed: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle();
    const item = () => tree()!.shadowRoot!.querySelector<HTMLElement>("[data-tree-open-to-side]") ?? document.querySelector<HTMLElement>("[data-tree-open-to-side]");
    await waitFor(() => !!item(), "the row menu");
    await act(async () => item()!.click());
    await waitFor(() => !!document.querySelector('[data-pane="1"]'), "the side pane");
    await settle();
    expect(activeTab(0)).toContain("ledger.ts");
    expect(activeTab(1)).toContain("review.ts");
  });

  test("double-clicking a file keeps it in one tab, not a second one beside its preview", async () => {
    await mount(false);
    const row = fileRow("ledger.ts")!;
    await act(async () => row.click());
    await waitFor(() => isOpen("ledger.ts"), "ledger.ts to open");
    await act(async () => row.click());
    await act(async () => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, composed: true, detail: 2 })));
    await settle();
    await settle();
    const ledgerTabs = paneTabs(0).filter((title) => title.includes("ledger.ts"));
    expect(ledgerTabs).toEqual(["File src/ledger.ts"]);
    expect(activeTab(0)).toBe("File src/ledger.ts");
  });

  test("End then Home from the last file's header goes back to the first file", async () => {
    await mount(false);
    const rows = () => [...(tree()?.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-type="file"]') ?? [])];
    const first = rows()[0]!.dataset.itemPath!;
    const last = rows()[rows().length - 1]!.dataset.itemPath!;
    await openFile(first);
    await act(async () => (tree()!.shadowRoot!.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    await act(async () => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    await waitFor(() => isOpen(last) && !!document.activeElement?.closest("[data-file-header-path]"), "the last file's header to take focus");
    await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    await waitFor(() => isOpen(first), "the first file to open");
  });
});
