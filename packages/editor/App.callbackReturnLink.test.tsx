/**
 * A shared plan with a bot callback: the way back after the decision (DOM-gated).
 *
 * The bot's 2xx answer may name `return_url`. The done screen then shows ONE
 * link the person clicks, "Back to <host>", in the same tab. The page never
 * moves by itself (anyone can build a share link with their own bot address,
 * so an automatic jump after a real-looking "Plan Approved" could land a
 * person anywhere). No address, a refused one, or a failed send: no link.
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

const PLAN = "# Move the billing job\n\nCharlie Dunn runs it nightly; Ada Novak reviews.\n";
const BOT = "https://bot.example.test/plannotator-cb";

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
let botCalls = 0;

/** No Plannotator server (a share page); the bot answers `botAnswer`. */
function shareFetch(botAnswer: () => Response): typeof fetch {
  return async (input) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl === BOT) { botCalls += 1; return botAnswer(); }
    if (rawUrl.startsWith("https://api.github.com/")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname.startsWith("/api/")) return new Response(null, { status: 404 });
    return Response.json({});
  };
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function approveButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[title="Approve design and notify bot"]');
}

function feedbackButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[title="Send feedback to bot"]');
}

async function mountShare(botAnswer: () => Response): Promise<void> {
  const { generateShareUrl } = await import("@plannotator/ui/utils/sharing");
  const url = await generateShareUrl(PLAN, [], undefined, "http://localhost");
  window.location.hash = `${new URL(url!).hash}?cb=${encodeURIComponent(BOT)}&ct=tok-test`;
  botCalls = 0;
  globalThis.fetch = shareFetch(botAnswer);
  // SAFETY: the App only uses EventSource's constructor, handlers, and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root?.render(<App />); });
  for (let attempt = 0; attempt < 60 && !(approveButton() && !approveButton()!.disabled); attempt += 1) {
    await settle();
  }
  expect(approveButton()?.disabled).toBe(false);
}

async function click(button: HTMLButtonElement | null): Promise<void> {
  expect(button).not.toBeNull();
  await act(async () => { button!.click(); });
  for (let attempt = 0; attempt < 30 && botCalls === 0; attempt += 1) await settle();
  for (let attempt = 0; attempt < 10; attempt += 1) await settle();
}

function doneScreen(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-completion-state]");
}

function doneLinks(): HTMLAnchorElement[] {
  return [...(doneScreen()?.querySelectorAll<HTMLAnchorElement>("a[data-completion-link]") ?? [])];
}

const answer = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

const describeDom = hasDom ? describe : describe.skip;

describeDom("shared plan with a bot callback: the way back", () => {
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

  test("Approve: the done screen shows one same-tab link named by its host, and the page stays put", async () => {
    await mountShare(answer({ return_url: "https://github.com/owner/repo/issues/42" }));
    const before = window.location.href;
    await click(approveButton());

    expect(doneScreen()?.getAttribute("data-completion-state")).toBe("approved");
    const links = doneLinks();
    expect(links.map((a) => a.textContent)).toEqual(["Back to github.com"]);
    expect(links[0].getAttribute("href")).toBe("https://github.com/owner/repo/issues/42");
    expect(links[0].hasAttribute("target")).toBe(false);
    expect(links[0].getAttribute("rel")).toContain("noreferrer");
    expect(links[0].getAttribute("rel")).toContain("noopener");

    // Longer than the 1.5 s the first version of this change waited before moving.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1800)); });
    expect(window.location.href).toBe(before);
    expect(doneLinks()).toHaveLength(1);
  });

  test("Send Feedback: the done screen shows the same link", async () => {
    await mountShare(answer({ return_url: "https://dev.azure.com/org/project/_workitems/edit/7" }));
    await click(feedbackButton());

    expect(doneScreen()?.getAttribute("data-completion-state")).toBe("denied");
    expect(doneLinks().map((a) => a.textContent)).toEqual(["Back to dev.azure.com"]);
  });

  test("no address, or one the check refuses: the done screen has no link", async () => {
    for (const body of [{}, { return_url: "javascript:alert(1)" }, { return_url: "https://user:pass@github.com/x" }]) {
      await mountShare(answer(body));
      await click(approveButton());
      expect(doneScreen()?.getAttribute("data-completion-state")).toBe("approved");
      expect(doneLinks()).toHaveLength(0);
      await act(async () => { root?.unmount(); });
      root = null;
      host?.remove();
      host = null;
    }
  });

  test("a failed send shows no done screen and no link, even when the answer names one", async () => {
    await mountShare(answer({ return_url: "https://github.com/owner/repo/issues/42" }, 500));
    await click(approveButton());
    expect(botCalls).toBe(1);
    expect(doneScreen()).toBeNull();
    expect(document.querySelector('a[href="https://github.com/owner/repo/issues/42"]')).toBeNull();
  });
});
