/**
 * What Settings → Agents learns of T3 Code (`InboxAgentsModel.t3`): nothing
 * when T3 is not on this computer, found by its home or command on Windows
 * too (where its `t3` command is never used), open or closed, and the saved
 * sign-ins as the T3 wake knows them, one T3 refused included. The status
 * never carries a token or a URL.
 *
 * A fake T3 home (tests/helpers/fake-t3.ts) and a scripted T3 MCP, with a
 * store in a temp folder. No Inbox server and no T3 run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { T3Credentials } from "@plannotator/t3-code/auth";
import { createFakeAgents } from "../../tests/helpers/fake-agents";
import { makeFakeT3Home, t3ScopeOf } from "../../tests/helpers/fake-t3";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { createT3Local } from "./inbox-t3-local";
import { t3SettingsStatus } from "./inbox-t3-settings";
import { createInboxT3Wake } from "./inbox-t3-wake";

const THREAD = "mcp:9843db4f-69c2-4891-9a2b-de6f0afaed58";
const ENDPOINT = new URL("http://127.0.0.1:9/mcp");
const TOKEN = "t3-secret-token";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

function world(options: { platform?: NodeJS.Platform; refuse?: boolean } = {}) {
  const agents = createFakeAgents("plannotator-t3-settings-");
  cleanup.push(() => agents.remove());
  const dataDir = join(agents.root, "data");
  const store = InboxStore.open(join(dataDir, "inbox"));
  const environment = createAgentEnvironmentFor({ platform: options.platform ?? "darwin", homeDir: agents.home, env: { ...agents.env, PLANNOTATOR_TEST_SANDBOX: "1" } });
  const local = createT3Local({ environment });
  const wake = createInboxT3Wake({
    store,
    dataDir,
    commandOf: () => {
      throw new Error("no reply is sent here");
    },
    local,
    log: () => {},
    connect: async () => ({
      async call() {
        throw new Error(options.refuse ? "T3 t3_thread_read: 401 Unauthorized" : "T3 t3_thread_read: The thread was not found.");
      },
    }),
  });
  cleanup.push(() => (wake.stop(), local.stop()));
  const login = (access?: "read-only" | "full-access") =>
    new T3Credentials(dataDir, ENDPOINT).save({ endpoint: ENDPOINT.href, epoch: "e1", tokens: { access_token: TOKEN, token_type: "Bearer", ...(access ? { scope: t3ScopeOf(access) } : {}) } });
  const status = () => t3SettingsStatus(environment, local, wake);
  return { agents, environment, local, wake, login, status };
}

describe("T3 Code in Settings → Agents", () => {
  test("not on this computer: no status, so no group", async () => {
    const w = world();
    expect(await w.status()).toBeNull();
  });

  test("its command here: replies go in by it, open or closed as its runtime file says", async () => {
    const w = world();
    const t3 = makeFakeT3Home(w.agents.home, {});
    expect(await w.status()).toEqual({ local: true, open: true, sign_in: "none" });
    t3.setState("down");
    expect(await w.status()).toEqual({ local: true, open: false, sign_in: "none" });
  });

  test("T3's home with no command, or on Windows: found, but its command is never the way", async () => {
    const w = world();
    mkdirSync(join(w.agents.home, ".t3", "userdata"), { recursive: true });
    expect(await w.status()).toEqual({ local: false, open: false, sign_in: "none" });
    const windows = world({ platform: "win32" });
    makeFakeT3Home(windows.agents.home, {});
    expect(await windows.status()).toEqual({ local: false, open: false, sign_in: "none" });
  });

  test("the saved sign-ins: none, one that sends, Read only, and one T3 refused; never the token or its URL", async () => {
    const w = world();
    mkdirSync(join(w.agents.home, ".t3"), { recursive: true });
    w.login("full-access");
    const ok = await w.status();
    expect(ok?.sign_in).toBe("ok");
    expect(JSON.stringify(ok)).not.toContain(TOKEN);
    expect(JSON.stringify(ok)).not.toContain(ENDPOINT.host);
    w.login("read-only");
    expect((await w.status())?.sign_in).toBe("read_only");
    rmSync(join(new T3Credentials(join(w.agents.root, "data"), ENDPOINT).path), { force: true });
    expect((await w.status())?.sign_in).toBe("none");

    const refused = world({ refuse: true });
    mkdirSync(join(refused.agents.home, ".t3"), { recursive: true });
    refused.login();
    expect((await refused.status())?.sign_in).toBe("ok");
    expect(await refused.wake.wakes("t3", THREAD)).toBe(false);
    expect((await refused.status())?.sign_in).toBe("ran_out");
  });
});
