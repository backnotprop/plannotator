/**
 * Scratch folders (launch PR 3), on a real launch module over a temp data dir and a temp home. What each
 * test guards: Settings → Agents' "Scratch folders" saves only a full path (`~/` is the home; empty is the
 * default), never from the tailnet; and the trust-once row reads Claude Code's own trust record, where a
 * trusted folder above the root counts and the root's own untrusted entry does not.
 * Making, naming and removing the folders runs end to end in tests/e2e/inbox-launch-scratch.spec.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";
import { claudeTrustsFolder, createAgentEnvironmentFor } from "./inbox-agents";

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
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-scratch-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, fullPermissions: false } }));
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
  // A refusal the route throws (InboxError) is answered by the Inbox's error table; here its code is enough.
  const post = async (body: Record<string, unknown>, via = "local") => {
    const response = await launch.route(
      new Request("http://127.0.0.1:4000/api/inbox/launch/settings", { method: "POST", headers: { host: "127.0.0.1:4000", "content-type": "application/json" }, body: JSON.stringify({ serverSession: "srv", ...body }) }),
      "/api/inbox/launch/settings",
      via,
    ).catch((error: { code?: string }) => Response.json({ code: error.code }, { status: 422 }));
    return { status: response!.status, body: (await response!.json()) as { launch?: Record<string, unknown>; code?: string } };
  };
  const saved = () => (JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { inboxLaunch: Record<string, unknown> }).inboxLaunch;
  return { post, saved, dataDir, home };
}

describe("Settings → Agents: Scratch folders", () => {
  test("a full path or ~/ is saved and used; empty goes back to the default; the switch beside it is kept", async () => {
    const { post, saved, dataDir, home } = setup();
    expect((await post({ scratch_dir: "~/work/scratch" })).body.launch).toMatchObject({ scratch_dir: join(home, "work", "scratch"), scratch_default: false });
    expect(saved()).toEqual({ enabled: true, fullPermissions: false, scratchDir: join(home, "work", "scratch") });
    expect((await post({ scratch_dir: "  " })).body.launch).toMatchObject({ scratch_dir: join(dataDir, "scratch"), scratch_default: true });
    expect(saved()).toEqual({ enabled: true, fullPermissions: false });
  });

  test("a relative path, / or a non-string is refused and nothing changes; never from the tailnet", async () => {
    const { post, saved } = setup();
    for (const scratch_dir of ["scratch", "/", 7]) expect(await post({ scratch_dir })).toMatchObject({ status: 422, body: { code: "validation_error" } });
    expect(await post({ scratch_dir: "/tmp/x" }, "tailnet")).toMatchObject({ status: 403, body: { code: "owner_only" } });
    expect(saved()).toEqual({ enabled: true, fullPermissions: false });
  });
});

describe("claudeTrustsFolder", () => {
  const env = (home: string) => createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env: {} });

  test("a trusted folder above counts, an untrusted entry of the folder itself does not, and an unreadable file is not trust", () => {
    const home = mkdtempSync(join(tmpdir(), "plannotator-trust-"));
    restore.push(() => rmSync(home, { recursive: true, force: true }));
    expect(claudeTrustsFolder(env(home), "/work/scratch")).toBe(false);
    writeFileSync(join(home, ".claude.json"), "{ not json");
    expect(claudeTrustsFolder(env(home), "/work/scratch")).toBe(false);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { "/work/scratch": { hasTrustDialogAccepted: false }, "/elsewhere": { hasTrustDialogAccepted: true } } }));
    expect(claudeTrustsFolder(env(home), "/work/scratch")).toBe(false);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { "/work/scratch": { hasTrustDialogAccepted: false }, "/work": { hasTrustDialogAccepted: true } } }));
    expect(claudeTrustsFolder(env(home), "/work/scratch")).toBe(true);
    expect(claudeTrustsFolder(env(home), "/workshop")).toBe(false);
  });

  test("a git repository under a trusted folder is not covered: only its own entry counts (a scratch folder the agent made a repository)", () => {
    const home = mkdtempSync(join(tmpdir(), "plannotator-trust-repo-"));
    restore.push(() => rmSync(home, { recursive: true, force: true }));
    const root = join(home, "scratch");
    const repo = join(root, "notes");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(root, "plain"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
    expect(claudeTrustsFolder(env(home), join(root, "plain"))).toBe(true);
    expect(claudeTrustsFolder(env(home), repo)).toBe(false);
    expect(claudeTrustsFolder(env(home), join(repo, "src"))).toBe(false);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true }, [repo]: { hasTrustDialogAccepted: true } } }));
    expect(claudeTrustsFolder(env(home), join(repo, "src"))).toBe(true);
  });
});
