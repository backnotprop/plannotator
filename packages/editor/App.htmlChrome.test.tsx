/**
 * HTML-surface chrome contract (DOM-gated).
 *
 * An HTML surface opens with the floating tools HIDDEN — the page gets the
 * whole viewport — and the header "Hide tools" eye (left of the pen) is what
 * reveals them. Hiding removes ALL floating chrome over the page from the
 * DOM: the sidebar tongue tabs and the comment/attachments cluster, with no
 * residual artifact. The toggle itself lives in the header, so the hidden
 * state (default, or restored from a cookie) always has a way back, and a
 * fresh cookie recording shown tools still wins over the default.
 * Sidebar/panel halves of the persisted state round-trip; the pen reports the
 * armed-by-default Interact/Annotate state.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resetStorageBackend,
  setStorageBackend,
  type StorageBackend,
} from "@plannotator/ui/utils/storage";

const hasDom = typeof document !== "undefined";

if (hasDom) {
  document.cookie = "plannotator-look-feel-announcement-seen=2; path=/";
  document.cookie = "plannotator-announce-tui-herdr-seen=1; path=/";
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = hasDom ? window.matchMedia : undefined;

// SAFETY: implements the MediaQueryList surface the shell hooks consume.
// Coarse-pointer matches put the app in its compact touch layout.
function coarseMatchMedia(query: string): MediaQueryList {
  return {
    matches: query.includes("pointer: coarse"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
}

const RAW_HTML = "<h1>Rendered page</h1><p>Body copy.</p>";

// In-memory storage backend (the codebase-standard persistence-test pattern):
// keeps values across mounts within a test, so a remount simulates the next
// session with the same cookies.
const memory = new Map<string, string>();
const memoryBackend: StorageBackend = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
};

function seedAnnouncementsSeen(): void {
  memory.set("plannotator-look-feel-announcement-seen", "2");
  memory.set("plannotator-announce-tui-herdr-seen", "1");
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

let root: Root | null = null;
let host: HTMLElement | null = null;

const htmlAnnotatePlan = {
  plan: "",
  origin: "codex",
  mode: "annotate",
  filePath: "/tmp/page.html",
  renderAs: "html",
  rawHtml: RAW_HTML,
  sharingEnabled: false,
  serverConfig: {},
};

const annotateFetch: typeof fetch = async (input) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });

  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === "/api/plan") return Response.json(htmlAnnotatePlan);
  if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
  if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({});
};

// A session whose file has a saved previous version: /api/plan carries the
// rendered diff, and the root's /api/doc read (what Refresh performs) carries
// the diff recomputed against the bytes just read.
const DIFF_HTML = "<h1>Rendered <ins>page</ins></h1><p>Body copy.</p>";
const REFRESHED_HTML = "<h1>Rendered page</h1><p>Body copy, edited.</p>";
const REFRESHED_DIFF_HTML = "<h1>Rendered page</h1><p>Body copy<ins>, edited</ins>.</p>";
const versionedPlan = {
  ...htmlAnnotatePlan,
  diffHtml: DIFF_HTML,
  previousPlan: "<h1>Rendered</h1><p>Body copy.</p>",
  versionInfo: { version: 2, totalVersions: 2, project: "test" },
};
const versionedFetch: typeof fetch = async (input) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === "/api/plan") return Response.json(versionedPlan);
  if (url.pathname === "/api/doc" && url.searchParams.get("path") === htmlAnnotatePlan.filePath) {
    return Response.json({
      rawHtml: REFRESHED_HTML,
      renderAs: "html",
      filepath: htmlAnnotatePlan.filePath,
      diffHtml: REFRESHED_DIFF_HTML,
      previousPlan: versionedPlan.previousPlan,
      versionInfo: versionedPlan.versionInfo,
    });
  }
  return annotateFetch(input);
};

// A folder annotate session that happens to be rendering an HTML document.
// Its file browser owns the left sidebar, which is why the sidebar/panel halves
// of the persisted chrome do not apply here — but the eye does.
const folderAnnotatePlan = {
  ...htmlAnnotatePlan,
  mode: "annotate-folder",
  filePath: "/tmp/docs",
};

const folderFetch: typeof fetch = async (input) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(rawUrl, "http://localhost");
  if (url.pathname === "/api/plan") return Response.json(folderAnnotatePlan);
  return annotateFetch(input);
};

function diffToggle(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => /changes vs previous version/.test(button.title));
}

function refreshButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-html-refresh]");
}

function findButtonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.trim() === label);
}

function penToggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-html-annotate-toggle]");
}

function toolsToggle(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-html-tools-toggle]");
}

function floatingCluster(): HTMLElement | null {
  // The full-viewport comment/attachments cluster over the page.
  return document.querySelector<HTMLElement>('[data-print-hide].absolute.top-3.right-3');
}

function sidebarTabs(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-sidebar-tabs="true"]');
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountHtmlAnnotate(fetchImpl: typeof fetch = annotateFetch): Promise<void> {
  globalThis.fetch = fetchImpl;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close;
  // this test double implements those browser-facing members without I/O.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 20 && !penToggle(); attempt += 1) {
    await settle();
  }
  if (!penToggle()) throw new Error("HTML surface did not finish mounting (pen toggle missing)");
}

function armedRing(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-annotate-armed-ring]");
}

/** Compact mounts wait on the armed ring: neither the pen nor the eye toggle
 * exists on the compact touch shell (that absence is what these tests guard). */
async function mountCompactHtmlAnnotate(fetchImpl: typeof fetch = annotateFetch): Promise<void> {
  globalThis.fetch = fetchImpl;
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 20 && !armedRing(); attempt += 1) {
    await settle();
  }
  if (!armedRing()) throw new Error("compact HTML surface did not finish mounting (armed ring missing)");
}

async function openOptionsMenu(): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Options"]');
  if (!trigger) throw new Error("Options menu trigger missing");
  await act(async () => trigger.click());
}

function findMenuItem(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button"))
    .find((button) => button.textContent?.includes(label));
}

async function unmountHtmlAnnotate(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

afterEach(async () => {
  await unmountHtmlAnnotate();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  memory.clear();
  resetStorageBackend();
  if (hasDom) {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    document.body.replaceChildren();
  }
});

afterAll(() => {
  resetStorageBackend();
});

describe.if(hasDom)("HTML annotate chrome (tools toggle + pen toggle)", () => {
  test("tools default HIDDEN: no tongue tabs or cluster, and the eye renders its hidden state", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    expect(sidebarTabs()).toBeNull();
    expect(floatingCluster()).toBeNull();
    // The eye is the way back, and it reports "hidden" from the first paint.
    expect(toolsToggle()).not.toBeNull();
    expect(toolsToggle()!.getAttribute("aria-pressed")).toBe("true");
  });

  test("Show tools brings ALL floating chrome back; Hide removes it again with no residual artifact", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    const toggle = toolsToggle();
    if (!toggle) throw new Error("tools toggle missing");
    await act(async () => toggle.click());

    expect(sidebarTabs()).not.toBeNull();
    expect(floatingCluster()).not.toBeNull();
    expect(toolsToggle()!.getAttribute("aria-pressed")).toBe("false");

    await act(async () => toolsToggle()!.click());
    expect(sidebarTabs()).toBeNull();
    expect(floatingCluster()).toBeNull();
    // No leftover pill/expander: the toggle in the header is the only way back.
    expect(toolsToggle()).not.toBeNull();
    expect(toolsToggle()!.getAttribute("aria-pressed")).toBe("true");
  });

  test("a fresh cookie recording toolsHidden:false still shows the tools (the default never overrides an explicit choice)", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: false, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();

    expect(floatingCluster()).not.toBeNull();
    expect(toolsToggle()!.getAttribute("aria-pressed")).toBe("false");
  });

  test("a cookie recording toolsHidden:true restores hidden, and the header toggle is the way back", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: true, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();

    expect(sidebarTabs()).toBeNull();
    expect(floatingCluster()).toBeNull();
    const toggle = toolsToggle();
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => toggle!.click());
    expect(sidebarTabs()).not.toBeNull();
  });

  test("compact touch layout: the hidden-by-default tools are undoable through the Options menu 'Show tools' action", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    window.matchMedia = coarseMatchMedia as typeof window.matchMedia;
    await mountCompactHtmlAnnotate();

    // Hidden applies on compact too (desktop parity), but compact is not
    // stranded: the desktop-only eye toggle is absent and the menu action is
    // the way back — and it must read "Show tools", not "Hide tools".
    expect(floatingCluster()).toBeNull();
    expect(toolsToggle()).toBeNull();

    await openOptionsMenu();
    const show = findMenuItem("Show tools");
    if (!show) throw new Error('compact menu is missing the "Show tools" action');
    await act(async () => show.click());
    expect(floatingCluster()).not.toBeNull();
  });

  test("compact touch layout: annotate mode is disarmable through the Options menu (no pen, no keyboard needed)", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    window.matchMedia = coarseMatchMedia as typeof window.matchMedia;
    await mountCompactHtmlAnnotate();

    // Armed by default, and the desktop pen is absent on compact — without
    // the menu action every tap annotates and the page is unreachable.
    expect(penToggle()).toBeNull();
    expect(armedRing()).not.toBeNull();

    await openOptionsMenu();
    const interact = findMenuItem("Interact with page");
    if (!interact) throw new Error('compact menu is missing the "Interact with page" action');
    await act(async () => interact.click());
    expect(armedRing()).toBeNull();

    // And back: the same slot re-arms.
    await openOptionsMenu();
    const annotate = findMenuItem("Annotate page");
    if (!annotate) throw new Error('compact menu is missing the "Annotate page" action');
    await act(async () => annotate.click());
    expect(armedRing()).not.toBeNull();
  });

  test("compact touch layout: Refresh from disk is offered through the Options menu (the header refresh is absent)", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    window.matchMedia = coarseMatchMedia as typeof window.matchMedia;
    await mountCompactHtmlAnnotate(versionedFetch);

    // The desktop-only header refresh is not rendered on compact, so the
    // menu action is the only way to re-read the file.
    expect(refreshButton()).toBeNull();

    await openOptionsMenu();
    const refresh = findMenuItem("Refresh from disk");
    if (!refresh) throw new Error('compact menu is missing the "Refresh from disk" action');
    expect(refresh.disabled).toBe(false);
    await act(async () => refresh.click());
    for (let attempt = 0; attempt < 20 && !document.querySelector('iframe[srcdoc*="edited"]'); attempt += 1) {
      await settle();
    }
    // The refreshed bytes reached the viewer.
    expect(document.querySelector<HTMLIFrameElement>("iframe[srcdoc]")?.getAttribute("srcdoc")).toContain("Body copy, edited.");
  });

  test("the restore commit never writes stale pre-restore values to the cookie", async () => {
    // The chrome writer runs in the same commit as the restore effect, before
    // the restored state has landed. If it saved there, a returning user's
    // remembered state would be transiently inverted in the cookie — and a
    // page ending between the two writes would freeze the inversion.
    // Instrument every chrome write: no write may ever carry a state other
    // than the remembered one, because this session never changes any chrome.
    const chromeWrites: string[] = [];
    setStorageBackend({
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        if (key === "plannotator-html-chrome") chromeWrites.push(value);
        memory.set(key, value);
      },
      removeItem: (key) => void memory.delete(key),
    });
    seedAnnouncementsSeen();
    const rememberedState = { toolsHidden: false, sidebarOpen: true, panelOpen: false };
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ ...rememberedState, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();

    // Writes re-stamp savedAt, so compare the semantic fields, not bytes.
    const semantic = (raw: string) => {
      const { toolsHidden, sidebarOpen, panelOpen } = JSON.parse(raw) as Record<string, unknown>;
      return { toolsHidden, sidebarOpen, panelOpen };
    };
    for (const write of chromeWrites) {
      expect(semantic(write)).toEqual(rememberedState);
    }
    expect(semantic(memory.get("plannotator-html-chrome")!)).toEqual(rememberedState);
  });

  test("the sidebar is still reachable by keyboard (Mod+B) while tools are hidden", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: true, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();
    expect(sidebarTabs()).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
    });
    await settle();

    expect(findButtonByText("Contents")).not.toBeUndefined();
  });

  test("the sidebar-open half of the persisted chrome still restores", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ sidebarOpen: true, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate();
    await settle();

    // Open sidebar renders the full tab strip (Contents label), and the
    // collapsed flags are gone.
    expect(findButtonByText("Contents")).not.toBeUndefined();
  });

  test("Refresh keeps the version-diff toggle available (the server recomputes the diff for the root document)", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    // The version-diff toggle lives in the floating cluster over the page,
    // which an HTML surface hides by default — this test is about refresh, so
    // start from a session whose reviewer had the tools showing.
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: false, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate(versionedFetch);
    await settle();

    // The toggle is offered on load, in normal (non-diff) mode.
    expect(diffToggle()).not.toBeUndefined();
    expect(diffToggle()!.title).toBe("Show changes vs previous version");

    // Enter the diff view, then refresh: the view returns to normal mode and
    // the toggle is still there (it used to disappear for the session).
    await act(async () => diffToggle()!.click());
    expect(diffToggle()!.title).toBe("Hide changes vs previous version");

    const refresh = refreshButton();
    if (!refresh) throw new Error("refresh button missing");
    await act(async () => refresh.click());
    for (let attempt = 0; attempt < 20 && refreshButton()?.getAttribute("aria-disabled") !== "false"; attempt += 1) {
      await settle();
    }

    expect(diffToggle()).not.toBeUndefined();
    expect(diffToggle()!.title).toBe("Show changes vs previous version");
    // And the recomputed diff is what a second toggle renders.
    await act(async () => diffToggle()!.click());
    await settle();
    const frame = document.querySelector<HTMLIFrameElement>("iframe[srcdoc]");
    expect(frame?.getAttribute("srcdoc")).toContain("<ins>, edited</ins>");
  });

  test("an Unanchored chip from one refresh clears when the next refresh's restore report is empty", async () => {
    // The bridge answers the parent's post-restore report request with the
    // complete set, empty included (pinned in htmlPinpointProtocol.test);
    // the App replaces its chip set with each report, so a chip from
    // refresh 1 must not survive a refresh 2 on which everything anchors.
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    const draftedFetch: typeof fetch = async (input) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, "http://localhost");
      if (url.pathname === "/api/draft" && (!(input instanceof Request) || input.method === "GET")) {
        return Response.json({
          annotations: [{
            id: "X",
            blockId: "",
            startOffset: 0,
            endOffset: 0,
            type: "COMMENT",
            text: "pinned note",
            originalText: "Body copy.",
            createdA: 1,
            htmlAnchor: { selector: "p", tagName: "p", text: "Body copy." },
          }],
          codeAnnotations: [],
          globalAttachments: [],
        });
      }
      return versionedFetch(input);
    };
    await mountHtmlAnnotate(draftedFetch);
    await settle();
    // The draft arrives behind the "Draft Recovered" dialog; restore it.
    for (let attempt = 0; attempt < 20 && !findButtonByText("Restore"); attempt += 1) {
      await settle();
    }
    const restore = findButtonByText("Restore");
    if (!restore) throw new Error("draft restore dialog missing");
    await act(async () => restore.click());
    await settle();
    // The chip lives on the panel card; the HTML surface opens with the
    // panel collapsed, so open it.
    const showPanel = document.querySelector<HTMLButtonElement>('button[title="Show annotations"]');
    if (showPanel) await act(async () => showPanel.click());
    await settle();
    expect(document.querySelector('[data-annotation-id="X"]')).not.toBeNull();
    const chip = () => document.querySelector('[data-annotation-unanchored]');
    const frame = () => document.querySelector<HTMLIFrameElement>("iframe[srcdoc]");
    const report = async (ids: string[]) => {
      const iframe = frame();
      if (!iframe?.contentWindow) throw new Error("HTML iframe missing");
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: "plannotator-bridge-unanchored", ids },
        }));
      });
    };
    const refresh = async () => {
      const button = refreshButton();
      if (!button) throw new Error("refresh button missing");
      await act(async () => button.click());
      for (let attempt = 0; attempt < 20 && refreshButton()?.getAttribute("aria-disabled") !== "false"; attempt += 1) {
        await settle();
      }
    };
    expect(chip()).toBeNull();

    // Refresh 1: the remounted viewer's bridge reports X unanchored.
    await refresh();
    await report(["X"]);
    expect(chip()).not.toBeNull();

    // Refresh 2: the page anchors everything; the report is the empty set.
    await refresh();
    await report([]);
    expect(chip()).toBeNull();
  });

  test("Mod+Shift+A toggles annotate mode in BOTH directions (the way back in after Esc)", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    const press = async () => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "a", metaKey: true, shiftKey: true, bubbles: true,
        }));
      });
    };

    expect(penToggle()!.getAttribute("aria-pressed")).toBe("true");
    await press();
    expect(penToggle()!.getAttribute("aria-pressed")).toBe("false");
    // The direction Esc cannot provide: the chord re-arms.
    await press();
    expect(penToggle()!.getAttribute("aria-pressed")).toBe("true");
  });

  test("Mod+Shift+X flips the tools, from the parent document and from inside the iframe", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    const pressInParent = async () => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "x", metaKey: true, shiftKey: true, bubbles: true,
        }));
      });
    };
    // What the bridge posts when the same chord is pressed with focus inside
    // the sandboxed page (the parent's listener never sees that keystroke).
    const pressInFrame = async () => {
      const iframe = document.querySelector<HTMLIFrameElement>("iframe[srcdoc]");
      if (!iframe?.contentWindow) throw new Error("HTML iframe missing");
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: "plannotator-bridge-tools-toggle" },
        }));
      });
    };

    expect(floatingCluster()).toBeNull();
    await pressInParent();
    expect(floatingCluster()).not.toBeNull();
    expect(toolsToggle()!.getAttribute("aria-pressed")).toBe("false");

    await pressInFrame();
    expect(floatingCluster()).toBeNull();
    expect(toolsToggle()!.getAttribute("aria-pressed")).toBe("true");
  });

  test("the pen toggle starts ARMED (aria-pressed) on a static HTML session and click flips it to Interact", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    await mountHtmlAnnotate();

    const pen = penToggle();
    if (!pen) throw new Error("pen toggle missing");
    expect(pen.getAttribute("aria-pressed")).toBe("true");

    await act(async () => pen.click());
    expect(penToggle()!.getAttribute("aria-pressed")).toBe("false");

    await act(async () => penToggle()!.click());
    expect(penToggle()!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe.if(hasDom)("HTML chrome in a folder annotate session", () => {
  function persistedChrome(): Record<string, unknown> {
    const raw = memory.get("plannotator-html-chrome");
    if (!raw) throw new Error("no persisted chrome record");
    const { toolsHidden, sidebarOpen, panelOpen } = JSON.parse(raw) as Record<string, unknown>;
    return { toolsHidden, sidebarOpen, panelOpen };
  }

  test("a saved 'tools shown' record is honoured (the flipped default is not permanent here)", async () => {
    // The whole chrome restore used to be suppressed in folder sessions, so
    // the eye could never remember anything: every folder session opened with
    // the tools hidden no matter how many times the reviewer showed them.
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: false, sidebarOpen: false, panelOpen: false, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate(folderFetch);
    await settle();

    expect(floatingCluster()).not.toBeNull();
    expect(toolsToggle()!.getAttribute("aria-pressed")).toBe("false");
  });

  test("the eye persists, and a folder session never records its own sidebar/panel state", async () => {
    setStorageBackend(memoryBackend);
    seedAnnouncementsSeen();
    memory.set(
      "plannotator-html-chrome",
      JSON.stringify({ toolsHidden: false, sidebarOpen: true, panelOpen: true, savedAt: Date.now() }),
    );
    await mountHtmlAnnotate(folderFetch);
    await settle();

    await act(async () => toolsToggle()!.click());
    await settle();

    // The eye's own half is recorded; the two halves the folder file browser
    // owns keep whatever the last ordinary HTML session left.
    expect(persistedChrome()).toEqual({ toolsHidden: true, sidebarOpen: true, panelOpen: true });
  });
});
