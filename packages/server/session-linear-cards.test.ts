/**
 * Linear hover cards on the Bun plan and annotate servers (`createRefCardsWithLinear` in ref-cards.ts). What can
 * regress: a plan or annotate server that answers no Linear issue link on `GET /api/ref`, or one that reads another
 * key than the Inbox's (the key saved in its Settings under this session's data dir, before `LINEAR_API_KEY`). The
 * route's guards are ref-card-route.scenarios.ts's; the Linear reader's cache and errors are
 * inbox-linear-cards.test.ts's.
 *
 * Linear is a stub of `fetch`, no network. The servers start without a `refRunner` (one turns Linear off), so ask
 * only a Linear link here: a forge link would run the real gh. Every test runs under a temp PLANNOTATOR_DATA_DIR.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { startAnnotateServer } from "./annotate";
import { startPlannotatorServer } from "./index";
import { LINEAR_API_URL } from "./inbox-linear-cards";
import { LINEAR_KEY_FILE } from "./inbox-linear-key";

const HTML = "<!doctype html><html><body>session-linear-cards-app</body></html>";
const LINK = "https://linear.app/acme/issue/ENG-123/retry-webhook-deliveries";
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

afterEach(() => {
  server?.stop();
  server = null;
  globalThis.fetch = realFetch;
  environment.restore();
});

describe("bun: GET /api/ref for a Linear issue link", () => {
  for (const kind of ["plan", "annotate"] as const) {
    test(`${kind}: answers the card, read from Linear with the key saved in Settings before LINEAR_API_KEY`, async () => {
      environment.reset();
      const dataDir = join(environment.makeTempDir(), "data");
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
      process.env.PLANNOTATOR_AI = "disabled";
      process.env.PLANNOTATOR_INBOX_CONNECT = "0";
      process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
      process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
      process.env.PLANNOTATOR_REMOTE = "0";
      process.env.LINEAR_API_KEY = "lin_api_env_0000";
      mkdirSync(join(dataDir, "inbox"), { recursive: true });
      writeFileSync(join(dataDir, LINEAR_KEY_FILE), "lin_api_saved_0000\n");
      // Linear is the stub; every other request (this test's own, to the server under test) goes out as it is.
      const linearKeys: string[] = [];
      globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input) !== LINEAR_API_URL) return realFetch(input, init);
        linearKeys.push((init?.headers as Record<string, string>).authorization ?? "");
        return Promise.resolve(Response.json(ISSUE));
      }) as typeof fetch;
      const docPath = join(environment.makeTempDir(), "notes.md");
      writeFileSync(docPath, `# Notes\n\nSee ${LINK}\n`);
      server =
        kind === "plan"
          ? await startPlannotatorServer({ plan: `# Plan\n\nSee ${LINK}`, origin: "claude-code", htmlContent: HTML })
          : await startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent: HTML, mode: "annotate" });

      const res = await realFetch(`http://127.0.0.1:${new URL(server.url).port}/api/ref?url=${encodeURIComponent(LINK)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        data: { platform: "linear", repo: "ENG", number: 123, title: "Retry webhook deliveries", linear: { identifier: "ENG-123", stateName: "In Review" } },
      });
      expect(linearKeys).toEqual(["lin_api_saved_0000"]);
    });
  }
});
