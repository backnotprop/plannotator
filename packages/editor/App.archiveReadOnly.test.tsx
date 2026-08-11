import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const hasDom = typeof document !== "undefined";

if (hasDom) {
  document.cookie = "plannotator-look-feel-announcement-seen=2; path=/";
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

const storageModule = hasDom ? await import("@plannotator/ui/utils/storage") : null;
const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

interface PlanResponse {
  readonly plan: string;
  readonly origin: "codex";
  readonly mode: "archive" | "annotate";
  readonly filePath?: string;
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

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);
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
      return Response.json({ available: false, providers: [] });
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
  noteSettings.clear();
  storageModule?.resetStorageBackend();
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
});
