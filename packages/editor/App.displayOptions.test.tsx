/**
 * The markdown selection mode from config.json (`displayOptions.inputMethod`).
 *
 * The App takes its first selection mode from the cookie at mount, and
 * configStore.init() only runs once /api/plan answers, so a config.json value
 * has to reach the toolstrip after mount. Guards: a browser with no cookie
 * opens in the mode config.json names, and a switch on the toolstrip is
 * written back to config.json.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const hasDom = typeof document !== "undefined";

const storageModule = hasDom ? await import("@plannotator/ui/utils/storage") : null;
const configModule = hasDom ? await import("@plannotator/ui/config") : null;
const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const INPUT_METHOD_KEY = "plannotator-input-method";

const memory = new Map<string, string>();
const memoryBackend = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
};

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
let configPosts: Record<string, unknown>[] = [];

function stubFetch(serverConfig: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") {
      return Response.json({ plan: "# Session document\n\nA paragraph to review.", origin: "codex", sharingEnabled: false, serverConfig });
    }
    if (url.pathname === "/api/config" && init?.method === "POST") {
      configPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({});
  };
}

async function mountApp(serverConfig: Record<string, unknown>): Promise<void> {
  globalThis.fetch = stubFetch(serverConfig);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 20 && !document.body.textContent?.includes("Session document"); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

async function unmountApp(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
}

/** The toolstrip's input-method button (its label is drawn twice: the visible one and the one it measures). */
function toolstripButton(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"))
    .find((button) => button.textContent?.trim().startsWith(label));
  if (!match) throw new Error(`Missing ${label} button`);
  return match;
}

describe.if(hasDom)("selection mode from config.json", () => {
  beforeEach(() => {
    memory.clear();
    configPosts = [];
    storageModule?.setStorageBackend(memoryBackend);
    // Past the first-run Grid/Clean chooser, so the toolstrip is reachable.
    memory.set("plannotator-plan-look-v2", "resolved");
    configModule?.configStore.loadFromBackend();
  });

  afterEach(async () => {
    await unmountApp();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    storageModule?.resetStorageBackend();
    memory.clear();
  });

  test("no cookie, config.json says Pinpoint: the toolstrip opens in Pinpoint and the cookie follows", async () => {
    await mountApp({ displayOptions: { inputMethod: "pinpoint" } });
    expect(toolstripButton("Pinpoint").getAttribute("aria-pressed")).toBe("true");
    expect(toolstripButton("Select").getAttribute("aria-pressed")).toBe("false");
    expect(memory.get(INPUT_METHOD_KEY)).toBe("pinpoint");
  });

  test("a switch on the toolstrip is written back to config.json", async () => {
    await mountApp({ displayOptions: { inputMethod: "pinpoint" } });
    await act(async () => toolstripButton("Select").click());
    expect(toolstripButton("Select").getAttribute("aria-pressed")).toBe("true");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(configPosts).toContainEqual({ displayOptions: { inputMethod: "drag" } });
  });
});
