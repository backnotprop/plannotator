/**
 * Hover cards for issue / PR / MR links in a plan document (ui RefHoverCard,
 * the app's transport over GET /api/ref).
 *
 * Failures to catch: the plan app never asking for a card (no transport, or
 * the hover region not attached because the app's root was behind its loading
 * state at first render); a card that shows a loading or failure state to a
 * person without gh / glab (plan review must look exactly as before then); a
 * request made before anyone hovers; a route the server does not serve (an
 * older server, a remote session) being asked again on every hover.
 *
 * Run with DOM_TESTS=1.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ForgeRefCardResult } from "@plannotator/core/forge-ref-card";

const hasDom = typeof document !== "undefined";

if (hasDom) {
  document.cookie = "plannotator-look-feel-announcement-seen=2; path=/";
  document.cookie = "plannotator-announce-tui-herdr-seen=1; path=/";
  document.cookie = "plannotator-vim-mode-announcement-seen=2; path=/";
  document.cookie = "plannotator-plan-ai-announcement-seen=1; path=/";
}

const appModule = hasDom ? await import("./App") : null;
const App = appModule?.default as typeof import("./App")["default"];
const refCardModule = hasDom ? await import("@plannotator/ui/utils/refCard") : null;
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

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

const ISSUE_URL = "https://github.com/acme/widgets/issues/12";

const CARD: ForgeRefCardResult = {
  ok: true,
  fetchedAt: 0,
  data: {
    platform: "github",
    kind: "issue",
    repo: "acme/widgets",
    number: 12,
    url: ISSUE_URL,
    title: "Widgets wobble on Tuesdays",
    state: "open",
    author: { login: "ada", avatarUrl: null },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    closedAt: null,
    labels: [],
    assignees: [],
    comments: 0,
    body: "",
    bodyCut: false,
    lastComment: null,
    linked: [],
  },
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let refRequests: string[] = [];

/** The `/api/ref` answer under test: a card, a quiet failure, or the route absent. */
type RefAnswer = "card" | "cli_missing" | "absent";

function responder(refAnswer: RefAnswer): typeof fetch {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl.startsWith("https://")) return new Response(null, { status: 404 });
    const url = new URL(rawUrl, "http://localhost");
    if (url.pathname === "/api/plan") {
      return Response.json({
        plan: "# Ship the widget\n\nThis fixes #12 before the release.",
        origin: "claude-code",
        repoInfo: { display: "acme/widgets", branch: "main", host: "github.com" },
        sharingEnabled: false,
        serverSession: "session-1",
        serverConfig: {},
      });
    }
    if (url.pathname === "/api/ref") {
      refRequests.push(url.searchParams.get("url") ?? "");
      if (refAnswer === "absent") return Response.json({ error: "Not found" }, { status: 404 });
      if (refAnswer === "cli_missing") return Response.json({ serverSession: "session-1", ok: false, error: "cli_missing", fetchedAt: 0 });
      return Response.json({ serverSession: "session-1", ...CARD });
    }
    if (url.pathname === "/api/ai/capabilities") return Response.json({ available: false, providers: [] });
    if (url.pathname === "/api/draft") return Response.json({ error: "Not found" }, { status: 404 });
    void init;
    return Response.json({});
  };
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mountApp(refAnswer: RefAnswer): Promise<HTMLAnchorElement> {
  refRequests = [];
  globalThis.fetch = responder(refAnswer);
  // SAFETY: the App only uses EventSource's constructor, handlers and close.
  globalThis.EventSource = SilentEventSource as unknown as typeof EventSource;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<App />);
  });
  for (let attempt = 0; attempt < 40 && !document.querySelector(`a[href="${ISSUE_URL}"]`); attempt += 1) await settle();
  const link = document.querySelector<HTMLAnchorElement>(`a[href="${ISSUE_URL}"]`);
  if (!link) throw new Error("the plan's #12 did not link into the repo");
  return link;
}

/** Rest the pointer on the link past the card's 400 ms delay, then let the answer land. */
async function hover(link: HTMLAnchorElement): Promise<void> {
  await act(async () => {
    link.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  });
  await settle(450);
  await settle(20);
}

async function leave(link: HTMLAnchorElement): Promise<void> {
  await act(async () => {
    link.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
  });
  await settle(300);
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  refCardModule?.setRefCardTransport(null);
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)("plan review: hover cards for #refs", () => {
  test("a #12 in the plan shows its card once the pointer rests on it, and nothing is asked before", async () => {
    const link = await mountApp("card");
    expect(refRequests).toEqual([]);
    await hover(link);
    expect(refRequests).toEqual([ISSUE_URL]);
    const card = document.querySelector<HTMLElement>("[data-ref-card]");
    expect(card?.textContent).toContain("Widgets wobble on Tuesdays");
    expect(card?.getAttribute("aria-label")).toContain("#12");
  });

  test("no gh on this computer: no card at all, no loading state, and the link is the plain link it was", async () => {
    const link = await mountApp("cli_missing");
    await act(async () => {
      link.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    });
    await settle(450);
    // Never a skeleton while the answer is on its way.
    expect(document.querySelector("[data-ref-card]")).toBeNull();
    await settle(20);
    expect(refRequests).toEqual([ISSUE_URL]);
    expect(document.querySelector("[data-ref-card]")).toBeNull();
    expect(link.getAttribute("href")).toBe(ISSUE_URL);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  test("a server without the route (older, or a remote session) is asked once, then never again", async () => {
    const link = await mountApp("absent");
    await hover(link);
    await leave(link);
    expect(refRequests).toHaveLength(1);
    expect(document.querySelector("[data-ref-card]")).toBeNull();
    await hover(link);
    expect(refRequests).toHaveLength(1);
    expect(document.querySelector("[data-ref-card]")).toBeNull();
  });
});
