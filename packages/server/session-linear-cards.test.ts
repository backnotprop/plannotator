/**
 * Linear hover cards on the Bun plan and annotate servers (`createSessionRefCards` in ref-cards.ts): a Linear
 * issue link on `GET /api/ref` is read from Linear with the Inbox's key. What can regress: a session server that
 * answers no Linear link, the key saved in Settings losing to `LINEAR_API_KEY`, a request to Linear without a key,
 * and Linear read in remote mode. `LINEAR_API_KEY` alone is inbox-linear-key.test.ts's. Linear is a stub of `fetch`,
 * no network. Every test runs under a temp PLANNOTATOR_DATA_DIR.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
type Kind = "plan" | "annotate";

/** A port nothing listens on right now (remote mode binds a fixed port). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

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
let host = "";
/** The `authorization` header of every request that reached Linear. */
let linearKeys: string[] = [];

afterEach(() => {
  server?.stop();
  server = null;
  globalThis.fetch = realFetch;
  environment.restore();
});

async function setUp(kind: Kind, mode: { savedKey?: string; envKey?: string; remote?: boolean } = {}): Promise<string> {
  environment.reset();
  linearKeys = [];
  const dataDir = join(environment.makeTempDir(), "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_INBOX_CONNECT = "0";
  process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
  process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
  process.env.PLANNOTATOR_REMOTE = mode.remote ? "1" : "0";
  if (mode.remote) process.env.PLANNOTATOR_PORT = String(await freePort());
  if (mode.envKey) process.env.LINEAR_API_KEY = mode.envKey;
  if (mode.savedKey) {
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, LINEAR_KEY_FILE), `${mode.savedKey}\n`);
  }
  // Linear is the stub; every other request (this test's own, to the server under test) goes out as it is.
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== LINEAR_API_URL) return realFetch(input, init);
    linearKeys.push((init?.headers as Record<string, string>).authorization ?? "");
    return Promise.resolve(Response.json(ISSUE));
  }) as typeof fetch;
  const root = environment.makeTempDir();
  const docPath = join(root, "notes.md");
  writeFileSync(docPath, `# Notes\n\nSee ${LINK}\n`);
  if (kind === "plan") server = await startPlannotatorServer({ plan: `# Plan\n\nSee ${LINK}`, origin: "claude-code", htmlContent: HTML });
  else server = await startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent: HTML, mode: "annotate" });
  // Remote mode binds every interface: talk to it over loopback.
  host = `127.0.0.1:${new URL(server.url).port}`;
  const first = (await (await realFetch(`http://${host}/api/plan`)).json()) as { serverSession?: unknown };
  return typeof first.serverSession === "string" ? first.serverSession : "";
}

const card = () => realFetch(`http://${host}/api/ref?url=${encodeURIComponent(LINK)}`);

describe("bun: GET /api/ref for a Linear issue link", () => {
  for (const kind of ["plan", "annotate"] as const) {
    test(`${kind}: answers the card, read from Linear with the key saved in Settings before LINEAR_API_KEY`, async () => {
      const serverSession = await setUp(kind, { savedKey: "lin_api_saved_0000", envKey: "lin_api_env_0000" });
      const res = await card();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        serverSession,
        data: { platform: "linear", repo: "ENG", number: 123, title: "Retry webhook deliveries", linear: { identifier: "ENG-123", stateName: "In Review" } },
      });
      expect(linearKeys).toEqual(["lin_api_saved_0000"]);
      // A second hover is the server's cache: Linear is not asked again.
      expect((await card()).status).toBe(200);
      expect(linearKeys).toHaveLength(1);
    });

    test(`${kind}: without a key the card is signed out, and Linear is asked nothing`, async () => {
      await setUp(kind);
      expect(await (await card()).json()).toMatchObject({ ok: false, error: "signed_out" });
      expect(linearKeys).toHaveLength(0);
    });

    test(`${kind}: remote mode turns it off, and Linear is asked nothing`, async () => {
      await setUp(kind, { savedKey: "lin_api_saved_0000", remote: true });
      const off = await card();
      expect(off.status).toBe(404);
      expect(((await off.json()) as { code?: string }).code).toBe("ref_cards_disabled");
      expect(linearKeys).toHaveLength(0);
    });
  }
});
