/**
 * Linear hover cards behind `GET /api/ref` on the plan, annotate and review servers (`withSessionLinearCards`,
 * packages/shared/linear-cards.ts). Shared by the Bun suite (session-linear-cards.test.ts) and the Pi mirror
 * (apps/pi-extension/server/session-linear-cards.test.ts), so both runtimes answer the same scenarios.
 *
 * What can regress: a server that answers no Linear issue link; one that reads another key than the Inbox's (the key
 * saved in its Settings under this session's data dir, before `LINEAR_API_KEY`); the key sent anywhere but
 * api.linear.app, through a redirect, or back to the page; a request to Linear with no key (the link must stay a
 * plain link, quietly); and Linear read in remote mode, where the route is off. The route's other guards are
 * ref-card-route.scenarios.ts's; the Linear reader's cache and errors are inbox-linear-cards.test.ts's.
 *
 * Linear is a stub of `fetch`, no network. The servers start without a `refRunner` (one turns Linear off), so only
 * Linear links are asked here: a forge link would run the real gh. Every test runs under a temp PLANNOTATOR_DATA_DIR.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { LINEAR_API_URL, LINEAR_KEY_FILE } from "@plannotator/shared/linear-cards";

export type SessionLinearCardsKind = "plan" | "annotate" | "review";

export type StartSessionLinearCardsServer = (
  kind: SessionLinearCardsKind,
  options: { root: string; docPath: string; htmlContent: string; plan: string },
) => Promise<{ url: string; stop: () => void }>;

const HTML = "<!doctype html><html><body>session-linear-cards-app</body></html>";
const LINK = "https://linear.app/acme/issue/ENG-123/retry-webhook-deliveries";
const SAVED_KEY = "lin_api_saved_0000";
const ENV_KEY = "lin_api_env_0000";
const ISSUE = {
  data: {
    issue: {
      identifier: "ENG-123",
      number: 123,
      title: "Retry webhook deliveries",
      url: LINK,
      state: { name: "In Review", type: "started", color: "#0F783C" },
      team: { key: "ENG", name: "Engineering" },
    },
  },
};

/** A port nothing listens on right now (remote mode binds a fixed port). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export function defineSessionLinearCardsScenarios(runtime: string, start: StartSessionLinearCardsServer): void {
  const environment = createTestEnvironment(
    [
      "PLANNOTATOR_PORT",
      "PLANNOTATOR_REMOTE",
      "PLANNOTATOR_DATA_DIR",
      "PLANNOTATOR_BROWSER",
      "PLANNOTATOR_AI",
      "PLANNOTATOR_INBOX_CONNECT",
      "PLANNOTATOR_FEEDBACK_HISTORY",
      "PLANNOTATOR_ANNOTATE_HISTORY",
      "PLANNOTATOR_ALLOWED_HOSTS",
      "PLANNOTATOR_URL_HOST",
      "SSH_TTY",
      "SSH_CONNECTION",
      "LINEAR_API_KEY",
    ],
    "plannotator-session-linear-cards-",
  );

  const realFetch = globalThis.fetch;
  let server: { url: string; stop: () => void } | null = null;
  /** Every request that left for somewhere other than the server under test. */
  let outbound: { url: string; init?: RequestInit }[] = [];
  let base = "";

  afterEach(() => {
    server?.stop();
    server = null;
    globalThis.fetch = realFetch;
    environment.restore();
  });

  async function setUp(kind: SessionLinearCardsKind, mode: { savedKey?: boolean; envKey?: boolean; remote?: boolean }): Promise<void> {
    environment.reset();
    outbound = [];
    base = "";
    const dataDir = join(environment.makeTempDir(), "data");
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
    process.env.PLANNOTATOR_AI = "disabled";
    process.env.PLANNOTATOR_INBOX_CONNECT = "0";
    process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
    process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
    process.env.PLANNOTATOR_REMOTE = mode.remote ? "1" : "0";
    if (mode.remote) process.env.PLANNOTATOR_PORT = String(await freePort());
    if (mode.envKey) process.env.LINEAR_API_KEY = ENV_KEY;
    if (mode.savedKey) {
      mkdirSync(join(dataDir, "inbox"), { recursive: true });
      writeFileSync(join(dataDir, LINEAR_KEY_FILE), `${SAVED_KEY}\n`);
    }
    // Linear is the stub; this test's own requests to the server under test go out as they are.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (base && url.startsWith(base)) return realFetch(input, init);
      outbound.push({ url, init });
      if (url === LINEAR_API_URL) return Promise.resolve(Response.json(ISSUE));
      return Promise.resolve(new Response("not here", { status: 404 }));
    }) as typeof fetch;
    const root = environment.makeTempDir();
    const docPath = join(root, "notes.md");
    writeFileSync(docPath, `# Notes\n\nSee ${LINK}\n`);
    server = await start(kind, { root, docPath, htmlContent: HTML, plan: `# Plan\n\nSee ${LINK}` });
    // Remote mode binds every interface: talk to it over loopback.
    base = `http://127.0.0.1:${new URL(server.url).port}`;
  }

  const ask = async () => {
    const res = await realFetch(`${base}/api/ref?url=${encodeURIComponent(LINK)}`);
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
  };

  describe(`${runtime}: GET /api/ref for a Linear issue link`, () => {
    for (const kind of ["plan", "annotate", "review"] as const) {
      test(`${kind}: answers Linear's card, read with the key saved in Settings before LINEAR_API_KEY, sent only to api.linear.app`, async () => {
        await setUp(kind, { savedKey: true, envKey: true });
        const answer = await ask();
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({
          ok: true,
          data: { platform: "linear", repo: "ENG", number: 123, title: "Retry webhook deliveries", linear: { identifier: "ENG-123", stateName: "In Review" } },
        });
        expect(outbound.map((r) => r.url)).toEqual([LINEAR_API_URL]);
        const sent = outbound[0]!.init!;
        expect(sent.method).toBe("POST");
        expect(sent.redirect).toBe("error");
        expect((sent.headers as Record<string, string>).authorization).toBe(SAVED_KEY);
        // The key never reaches the page.
        expect(answer.text).not.toContain(SAVED_KEY);
        expect(answer.text).not.toContain(ENV_KEY);
      });

      test(`${kind}: LINEAR_API_KEY alone is used when nothing is saved`, async () => {
        await setUp(kind, { envKey: true });
        expect((await ask()).body).toMatchObject({ ok: true, data: { platform: "linear" } });
        expect(outbound.map((r) => (r.init?.headers as Record<string, string>).authorization)).toEqual([ENV_KEY]);
      });

      test(`${kind}: no Linear key: answers signed_out (the page keeps a plain link) and asks Linear nothing`, async () => {
        await setUp(kind, {});
        const answer = await ask();
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ ok: false, error: "signed_out" });
        expect(outbound).toEqual([]);
      });

      test(`${kind}: remote mode turns it off, and Linear is not asked even with a key`, async () => {
        await setUp(kind, { savedKey: true, remote: true });
        const answer = await ask();
        expect(answer.status).toBe(404);
        expect(answer.body.code).toBe("ref_cards_disabled");
        expect(outbound).toEqual([]);
      });
    }
  });
}
