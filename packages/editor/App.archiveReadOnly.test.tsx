import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SourceSaveCapability } from "@plannotator/core/source-save";

const hasDom = typeof document !== "undefined";

if (hasDom) {
  document.cookie = "plannotator-look-feel-announcement-seen=2; path=/";
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

const storageModule = hasDom ? await import("@plannotator/ui/utils/storage") : null;
const fileTreeModule = hasDom ? await import("@plannotator/ui/hooks/useFileBrowser") : null;
const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;

interface PlanResponse {
  readonly plan: string;
  readonly origin: "codex";
  readonly mode: "archive" | "annotate" | "annotate-folder";
  readonly filePath?: string;
  readonly sourceSave?: SourceSaveCapability;
  readonly gate?: boolean;
  readonly projectRoot?: string;
  readonly archivePlans?: readonly [{
    readonly filename: string;
    readonly status: "approved";
    readonly timestamp: string;
    readonly title: string;
  }];
  readonly sharingEnabled: false;
  readonly serverConfig: Record<string, never>;
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

let root: Root | null = null;
let host: HTMLElement | null = null;
let requestedRoutes: string[] = [];
let aiCapabilitiesAvailable = false;
let documentLoadGate: Promise<void> | null = null;

const noteSettings = new Map<string, string>();

function configureNotesApps(): void {
  storageModule?.setStorageBackend({
    getItem: (key) => noteSettings.get(key) ?? null,
    setItem: (key, value) => noteSettings.set(key, value),
    removeItem: (key) => { noteSettings.delete(key); },
  });
  noteSettings.set("plannotator-obsidian-enabled", "true");
  noteSettings.set("plannotator-obsidian-vault", "TestVault");
  noteSettings.set("plannotator-bear-enabled", "true");
  noteSettings.set("plannotator-octarine-enabled", "true");
  noteSettings.set("plannotator-octarine-workspace", "TestWorkspace");
  noteSettings.set("plannotator-default-notes-app", "obsidian");
}

function useCompactTouchMedia(): void {
  if (!hasDom) return;
  window.matchMedia = ((query: string): MediaQueryList => ({
    matches: query.includes("max-width") || query.includes("pointer: coarse"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })) as typeof window.matchMedia;
}

function useSingleFileTree(): void {
  fileTreeModule?.setFileTreeBackend({
    loadTree: async () => Response.json({
      tree: [{ name: "alpha.md", path: "alpha.md", type: "file" }],
    }),
    loadVaultTree: async () => Response.json({ error: "Unavailable" }, { status: 404 }),
    watchTrees: () => undefined,
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);
}

function findButtonContaining(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.includes(label));
}

function responseFor(planResponse: PlanResponse): typeof fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const method = input instanceof Request ? input.method : init?.method ?? "GET";
    if (rawUrl.startsWith("https://api.github.com/")) {
      return new Response(null, { status: 404 });
    }

    const url = new URL(rawUrl, "http://localhost");
    requestedRoutes.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/plan") return Response.json(planResponse);
    if (url.pathname === "/api/archive/plans") {
      return Response.json({ plans: planResponse.archivePlans ?? [] });
    }
    if (url.pathname === "/api/archive/plan") {
      return Response.json({ markdown: planResponse.plan, filepath: "saved.md" });
    }
    if (url.pathname === "/api/ai/capabilities") {
      return Response.json(aiCapabilitiesAvailable
        ? {
            available: true,
            defaultProvider: "codex",
            providers: [{ id: "codex", name: "Codex", models: [] }],
          }
        : { available: false, providers: [] });
    }
    if (url.pathname === "/api/open-in/apps") {
      return Response.json({
        available: true,
        apps: [{ id: "reveal", label: "Finder", kind: "file-manager", icon: "finder" }],
      });
    }
    if (url.pathname === "/api/draft") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (url.pathname === "/api/doc") {
      await documentLoadGate;
      const filepath = url.searchParams.get("path");
      return Response.json({
        markdown: "# Selected file\n\nLoaded from the compact navigator.",
        filepath,
        renderAs: "markdown",
      });
    }
    if (url.pathname === "/api/save-notes") {
      return Response.json({
        results: {
          obsidian: { success: true },
          bear: { success: true },
          octarine: { success: true },
        },
      });
    }
    return Response.json({});
  };
}

async function mountApp(planResponse: PlanResponse): Promise<void> {
  requestedRoutes = [];
  globalThis.fetch = responseFor(planResponse);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close;
  // this test double implements those browser-facing members without I/O.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });

  const expectedTitle = planResponse.plan.match(/^#\s+(.+)$/m)?.[1] ?? planResponse.plan;
  for (let attempt = 0; attempt < 20 && !document.body.textContent?.includes(expectedTitle); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom && originalMatchMedia) window.matchMedia = originalMatchMedia;
  noteSettings.clear();
  aiCapabilitiesAvailable = false;
  documentLoadGate = null;
  storageModule?.resetStorageBackend();
  fileTreeModule?.resetFileTreeBackend();
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)("App document permissions", () => {
  test("standalone archive renders Markdown without mutation entry points", async () => {
    configureNotesApps();
    await mountApp({
      plan: "# Archived document\n\n```typescript\nconst archived = true;\n```",
      origin: "codex",
      mode: "archive",
      archivePlans: [{
        filename: "saved.md",
        status: "approved",
        timestamp: "2026-07-31T00:00:00.000Z",
        title: "Archived document",
      }],
      sharingEnabled: false,
      serverConfig: {},
    });

    expect(document.body.textContent).toContain("Archived document");
    expect(document.querySelector('button[title="Add global comment"]')).toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).toBeNull();

    const codeBlock = document.querySelector<HTMLElement>('pre')?.closest<HTMLElement>('[data-block-id]');
    const code = codeBlock?.querySelector('code');
    if (!codeBlock || !code) throw new Error("Archived fenced code block did not render");
    // Text, NOT innerHTML: `applyHighlight` writes plain text first and swaps in
    // Shiki markup once the grammar attaches, so the fence's MARKUP legitimately
    // changes on its own schedule and an innerHTML comparison races that swap.
    // What this test is actually asserting is that the click/hover opened no
    // mutation entry point, which is exactly what the text plus the absence of an
    // annotation `<mark>` says (a code-block annotation is one whole-fence
    // `<mark data-bind-id>`, per codeBlockMark.ts).
    const renderedCodeText = code.textContent;
    await act(async () => {
      codeBlock.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      codeBlock.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('.annotation-toolbar')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[data-quick-label-picker]')).toBeNull();
    expect(code.querySelector('mark')).toBeNull();
    expect(code.textContent).toBe(renderedCodeText);

    const optionsButton = document.querySelector<HTMLButtonElement>('button[title="Options"]');
    if (!optionsButton) throw new Error("Options menu trigger did not render");
    await act(async () => optionsButton.click());
    expect(findButton("Save to Obsidian")).toBeUndefined();
    expect(findButton("Save to Bear")).toBeUndefined();
    expect(findButton("Save to Octarine")).toBeUndefined();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "s",
        metaKey: true,
      }));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
      }));
    });
    expect(requestedRoutes).not.toContain("POST /api/save-notes");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
      }));
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
      }));
    });
    expect(requestedRoutes).not.toContain("POST /api/approve");
    expect(requestedRoutes).not.toContain("POST /api/deny");

    const exportButton = findButton("Export");
    if (!exportButton) throw new Error("Export menu item did not render");
    await act(async () => exportButton.click());
    expect(findButton("Notes")).toBeUndefined();
  });

  test("normal annotate remains writable", async () => {
    configureNotesApps();
    await mountApp({
      plan: "# Writable document",
      origin: "codex",
      mode: "annotate",
      filePath: "/tmp/writable.md",
      sharingEnabled: false,
      serverConfig: {},
    });

    expect(document.body.textContent).toContain("Writable document");
    expect(document.querySelector("[data-pn-compact-plan-completion]")).toBeNull();
    expect(document.querySelector('button[title="Add global comment"]')).not.toBeNull();
    expect(document.querySelector('button[title="Attachments"]')).not.toBeNull();

    const optionsButton = document.querySelector<HTMLButtonElement>('button[title="Options"]');
    if (!optionsButton) throw new Error("Options menu trigger did not render");
    await act(async () => optionsButton.click());
    expect(findButton("Save to Obsidian")).not.toBeUndefined();
    expect(findButton("Save to Bear")).not.toBeUndefined();
    expect(findButton("Save to Octarine")).not.toBeUndefined();

    requestedRoutes = [];
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "s",
        metaKey: true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requestedRoutes).toContain("POST /api/save-notes");
  });

  test("compact touch presents a reading-first file surface without mutating desktop preferences", async () => {
    configureNotesApps();
    noteSettings.set("plannotator-input-method", "pinpoint");
    aiCapabilitiesAvailable = true;
    useCompactTouchMedia();
    await mountApp({
      plan: "# Mobile document\n\nA paragraph to annotate and edit.",
      origin: "codex",
      mode: "annotate",
      filePath: "/repo/docs/mobile.md",
      sourceSave: {
        enabled: true,
        kind: "local-text-file",
        scope: "single-file",
        path: "/repo/docs/mobile.md",
        basename: "mobile.md",
        language: "markdown",
        hash: "sha256:mobile",
        mtimeMs: 1_000,
        size: 52,
        eol: "lf",
      },
      gate: true,
      sharingEnabled: false,
      serverConfig: {},
    });

    expect(document.querySelector("[data-pn-compact-document-title]")?.textContent).toBe("mobile.md");
    expect(document.querySelector("[data-pn-compact-annotate-entry]")?.textContent).toContain("Pinpoint");
    for (const label of ["Wide", "Focus", "Edit", "Markup", "Comment", "Redline", "Label"]) {
      expect(findButton(label)).toBeUndefined();
    }

    const annotateEntry = document.querySelector<HTMLButtonElement>("[data-pn-compact-annotate-entry]");
    if (!annotateEntry) throw new Error("Compact annotation entry did not render");
    await act(async () => annotateEntry.click());
    expect(findButtonContaining("Select text")).not.toBeUndefined();
    expect(findButtonContaining("Pinpoint")).not.toBeUndefined();

    await act(async () => findButtonContaining("Select text")?.click());
    expect(document.querySelector("[data-pn-compact-annotate-entry]")?.textContent).toContain("Select text");
    expect(noteSettings.get("plannotator-input-method")).toBe("pinpoint");

    const optionsButton = document.querySelector<HTMLButtonElement>('button[aria-label="Options"]');
    if (!optionsButton) throw new Error("Options menu trigger did not render");
    await act(async () => optionsButton.click());
    for (let attempt = 0; attempt < 20 && !findButtonContaining("Ask AI"); attempt += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    expect(findButtonContaining("Annotations")).not.toBeUndefined();
    expect(findButtonContaining("Ask AI")).not.toBeUndefined();
    expect(findButtonContaining("Review and finish")).not.toBeUndefined();
    expect(findButton("Close session")).toBeUndefined();
    expect(findButton("Approve")).toBeUndefined();
    expect(findButtonContaining("Edit document")).not.toBeUndefined();

    await act(async () => findButtonContaining("Annotations")?.click());
    expect(document.querySelector('[data-pn-compact-plan-stage="true"]')?.getAttribute("aria-label")).toBe("Annotations");
    expect(document.body.textContent).toContain("No annotations yet");
    const closeAnnotations = document.querySelector<HTMLButtonElement>('button[aria-label="Close Annotations"]');
    if (!closeAnnotations) throw new Error("Compact Annotations close control did not render");
    await act(async () => closeAnnotations.click());
    expect(document.querySelector('[data-pn-compact-plan-stage="true"]')).toBeNull();

    await act(async () => optionsButton.click());
    await act(async () => findButtonContaining("Ask AI")?.click());
    expect(document.querySelector('[data-pn-compact-plan-stage="true"]')?.getAttribute("aria-label")).toBe("Ask AI");
    expect(document.querySelector('textarea[placeholder="Ask about this document..."]')?.getAttribute("data-pn-mobile-editable")).toBe("true");
    const closeAI = document.querySelector<HTMLButtonElement>('button[aria-label="Close Ask AI"]');
    if (!closeAI) throw new Error("Compact Ask AI close control did not render");
    await act(async () => closeAI.click());

    const completion = document.querySelector("[data-pn-compact-plan-completion]");
    expect(completion?.textContent).toContain("Ready to finish?");
    const reviewTrigger = document.querySelector<HTMLButtonElement>("#pn-compact-plan-review-trigger");
    if (!reviewTrigger) throw new Error("End-of-document review trigger did not render");
    await act(async () => reviewTrigger.click());
    expect(document.querySelector('[data-pn-compact-plan-stage="true"]')?.getAttribute("aria-label")).toBe("Review");
    expect(findButton("Close session")).not.toBeUndefined();
    expect(findButton("Approve")).not.toBeUndefined();
    const closeReview = document.querySelector<HTMLButtonElement>('button[aria-label="Close Review"]');
    if (!closeReview) throw new Error("Compact Review close control did not render");
    await act(async () => closeReview.click());

    await act(async () => optionsButton.click());
    await act(async () => findButtonContaining("Edit document")?.click());
    const editControls = document.querySelector("[data-pn-compact-edit-controls]");
    expect(editControls?.textContent).toContain("Editing mobile.md");
    expect(findButton("Saved")).not.toBeUndefined();
    expect(findButton("Done")).not.toBeUndefined();
    expect(document.querySelector("[data-pn-compact-plan-completion]")).toBeNull();
  });

  test("compact review sends the incumbent approval request", async () => {
    configureNotesApps();
    useCompactTouchMedia();
    await mountApp({
      plan: "# Mobile decision\n\nReview this plan.",
      origin: "codex",
      mode: "annotate",
      filePath: "/repo/docs/decision.md",
      gate: true,
      sharingEnabled: false,
      serverConfig: {},
    });

    const reviewTrigger = document.querySelector<HTMLButtonElement>("#pn-compact-plan-review-trigger");
    if (!reviewTrigger) throw new Error("Compact review trigger did not render");
    await act(async () => reviewTrigger.click());
    const approve = findButton("Approve");
    if (!approve) throw new Error("Compact review did not expose Approve");
    requestedRoutes = [];
    await act(async () => {
      approve.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requestedRoutes).toContain("POST /api/approve");
  });

  test("compact folder selection closes the navigator after the async document activation", async () => {
    configureNotesApps();
    useCompactTouchMedia();
    useSingleFileTree();
    await mountApp({
      plan: "",
      origin: "codex",
      mode: "annotate-folder",
      filePath: "/repo",
      projectRoot: "/repo",
      sharingEnabled: false,
      serverConfig: {},
    });

    for (let attempt = 0; attempt < 20 && !findButton("Choose a file"); attempt += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    const chooseFile = findButton("Choose a file");
    if (!chooseFile) throw new Error("Folder arrival did not expose Choose a file");
    await act(async () => chooseFile.click());

    for (let attempt = 0; attempt < 20 && !findButtonContaining("alpha"); attempt += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    const alphaFile = findButtonContaining("alpha");
    if (!alphaFile) throw new Error("Folder tree did not load alpha.md");
    expect(document.querySelector("[data-pn-plan-navigator]")).not.toBeNull();

    let releaseDocumentLoad: (() => void) | undefined;
    documentLoadGate = new Promise<void>((resolve) => {
      releaseDocumentLoad = resolve;
    });
    await act(async () => {
      alphaFile.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const pendingNavigator = document.querySelector<HTMLElement>("[data-pn-plan-navigator]");
    expect(pendingNavigator).not.toBeNull();
    expect(pendingNavigator?.textContent).toContain("Opening alpha.md…");
    expect(alphaFile.disabled).toBe(true);
    expect(alphaFile.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      releaseDocumentLoad?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.querySelector("[data-pn-plan-navigator]")).toBeNull();
    expect(document.body.textContent).toContain("Selected file");
    expect(document.querySelector("[data-pn-compact-document-title]")?.textContent).toBe("alpha.md");
  });
});
