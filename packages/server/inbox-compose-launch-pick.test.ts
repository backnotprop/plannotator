/**
 * The folder picked in To (`?trust_agent=&trust_project=` on GET /api/inbox/sessions) reaches the launch block only
 * for the owner's own same-site window: its files are read (Trust and start's facts, OpenCode's project config for
 * its default's name). Another site's page, or the device door, gets the launch block with no folder, so no file of
 * that folder is read. On the compose route itself, with a stand-in launch block; no Inbox is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxCompose } from "./inbox-compose";
import { createInboxLiveSessions } from "./inbox-sessions";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string) {
  const before = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-compose-pick-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  setEnv("PLANNOTATOR_RELAY_URL", "http://127.0.0.1:9");
  const store = InboxStore.open(dataDir);
  const live = createInboxLiveSessions({ store, serverSession: "srv", resolveRoot: async (path) => path });
  const asked: unknown[] = [];
  const launch = {
    enabled: () => true,
    // Every argument, so a folder passed any other way is seen too.
    composeBlock: async (...args: unknown[]) => {
      asked.push(args);
      return { agents: [], projects: [], drives: [] };
    },
  };
  const compose = createInboxCompose({
    store,
    serverSession: "srv",
    live,
    resolveProject: async () => {
      throw new Error("never reached");
    },
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    launch: launch as unknown as NonNullable<Parameters<typeof createInboxCompose>[0]["launch"]>,
  });
  /** GET the sessions with a folder picked in To, as `headers` say, from the owner (or not). */
  const sessions = async (headers: Record<string, string>, owner: boolean) => {
    const url = new URL("http://127.0.0.1:4000/api/inbox/sessions?trust_agent=opencode&trust_project=prj_harbor");
    await compose.route(new Request(url, { headers: { host: "127.0.0.1:4000", ...headers } }), url, owner, null);
    return asked.at(-1);
  };
  return { sessions };
}

describe("the folder picked in To is honoured only for the owner's own window", () => {
  test("the owner's same-site window: the folder goes to the launch block", async () => {
    const t = setup();
    const pick = [{ pick: { agent: "opencode", project: "prj_harbor" } }];
    expect(await t.sessions({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4000" }, true)).toEqual(pick);
    // A non-browser client of the owner (no Origin, no Sec-Fetch-Site), as on main.
    expect(await t.sessions({}, true)).toEqual(pick);
  });

  test("another site's page, by Sec-Fetch-Site or by Origin, and the device door: no folder, so none of its files is read", async () => {
    const t = setup();
    for (const [headers, owner] of [
      [{ "sec-fetch-site": "cross-site", origin: "https://evil.example" }, true],
      [{ "sec-fetch-site": "same-site", origin: "http://127.0.0.1:5173" }, true],
      [{ origin: "https://evil.example" }, true],
      [{ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4000" }, false],
    ] as const) {
      const args = await t.sessions(headers, owner);
      expect({ headers, owner, args }).toEqual({ headers, owner, args: [null] });
    }
  });
});
