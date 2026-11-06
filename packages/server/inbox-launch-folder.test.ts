/**
 * "Another folder on <machine>…": a Send's `to.launch.folder`, on a real launch module over a temp data dir and a temp
 * home. What each test guards: a typed folder that would put an agent somewhere the folder listing never offers is
 * refused before anything is checked or written (`prepare` throws, so no thread, project or start): a hidden folder
 * reached by a backslash, a NUL, or a link in home that lands in one; and home itself, where an agent would reach
 * every folder under it, hidden ones too. The listing's own rules are in inbox-home-folders.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";

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
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-folder-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  for (const dir of [".ssh", ".claude", "x", "code/billing-api"]) mkdirSync(join(home, dir), { recursive: true });
  symlinkSync(join(home, ".ssh"), join(home, "code", "sshlink"));
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  symlinkSync(join(root, "elsewhere"), join(home, "outlink"));
  symlinkSync(home, join(home, "code", "homelink"));
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const store = InboxStore.open(dataDir);
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    loginEnv: async () => ({ HOME: home, PATH: "" }),
    ownEnv: () => ({ HOME: home }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
  });
  restore.push(() => launch.stop());
  let resolved = 0;
  /** A Send's `to.launch.folder` through `target` and `prepare`, as compose runs them: the refusal's code and words. */
  const send = async (folder: string) => {
    try {
      const target = launch.target({ launch: { agent: "claude-code", folder } })!;
      await launch.prepare(target, {
        name: "x",
        body: "x",
        resolveProject: async () => {
          resolved += 1;
          throw new Error("no project is made for a refused folder");
        },
      });
      return { code: "sent", message: "" };
    } catch (error) {
      const { code, message } = error as { code?: string; message: string };
      return { code: code ?? "thrown", message };
    }
  };
  return { send, store, resolvedCount: () => resolved };
}

describe("to.launch.folder: never somewhere the listing doesn't offer", () => {
  test("a backslash or a NUL is refused before the folder is read: ~/\\.ssh, ~/x\\..\\.ssh, ~/x\\..\\.claude", async () => {
    const { send, store, resolvedCount } = setup();
    for (const folder of ["~/\\.ssh", "~/x\\..\\.ssh", "~/x\\..\\.claude", "~/x\0"]) {
      expect([folder, await send(folder)]).toEqual([folder, { code: "validation_error", message: "Pick a folder inside the home folder. Nothing was sent." }]);
    }
    expect(resolvedCount()).toBe(0);
    expect(store.listProjects()).toEqual([]);
  });

  test("a link in home that lands in a hidden folder is a hidden folder", async () => {
    const { send, resolvedCount } = setup();
    expect(await send("~/code/sshlink")).toEqual({ code: "validation_error", message: "Hidden folders can't be picked. Nothing was sent." });
    expect(resolvedCount()).toBe(0);
  });

  test("a folder that isn't there under a hidden folder or outside home answers as that folder, not as missing", async () => {
    const { send, resolvedCount } = setup();
    expect(await send("~/code/sshlink/nope")).toEqual({ code: "validation_error", message: "Hidden folders can't be picked. Nothing was sent." });
    expect(await send("~/outlink/nope")).toEqual({ code: "validation_error", message: "Pick a folder inside the home folder. Nothing was sent." });
    // Under a plain folder: just missing.
    expect((await send("~/code/nope")).code).toBe("folder_missing");
    expect(resolvedCount()).toBe(0);
  });

  test("home itself is refused, however it is typed (a link back to it too)", async () => {
    const { send, resolvedCount } = setup();
    for (const folder of ["~", "~/", "", "~//", "~/code/homelink"]) {
      expect([folder, await send(folder)]).toEqual([folder, { code: "validation_error", message: "Pick a folder inside the home folder. Nothing was sent." }]);
    }
    expect(resolvedCount()).toBe(0);
  });
});
