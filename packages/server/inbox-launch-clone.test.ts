/**
 * Clone from a git URL (approval "launch-create-clone", C1-C17, E1-E11). Each test guards a behaviour the person
 * relies on: where a clone goes with no setting, that nothing is ever overwritten, that git's failures read as the four
 * causes the line names, and, on the real launch module with the fake agent and a local bare repo (git's own
 * `url.<base>.insteadOf`, so no network and no real remote is ever reached), that the Send clones into the folder it
 * names and then starts, that a failure keeps the message and Try again clones again, that Cancel leaves nothing on the
 * machine, and that a repo bringing hooks waits for the person's trust while a plain one starts without asking.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";
import { classifyGitFailure, cloneTarget, defaultCloneFolder, originKeyOf, parseGitProgress } from "./inbox-launch-clone";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";

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

describe("where a clone goes, and what git's failures mean", () => {
  const isFolder = (folders: string[]) => (path: string) => folders.includes(path);
  test("C1, C1b, C1c: the last clone folder here, else where most projects live, else home", () => {
    const home = "/Users/me";
    const roots = ["/Users/me/work/shop-web", "/Users/me/work/shop-api", "/Users/me/code/web-app", "/Users/me/work/admin"];
    expect(defaultCloneFolder({ home, last: null, projectRoots: roots, isFolder: isFolder(["/Users/me/work", "/Users/me/code"]) })).toBe("/Users/me/work");
    expect(defaultCloneFolder({ home, last: "/Users/me/Documents/Client Work", projectRoots: roots, isFolder: isFolder(["/Users/me/work", "/Users/me/Documents/Client Work"]) })).toBe("/Users/me/Documents/Client Work");
    // A last folder that is gone, or outside home, or hidden, is no default.
    expect(defaultCloneFolder({ home, last: "/Users/me/gone", projectRoots: [], isFolder: isFolder([]) })).toBe(home);
    expect(defaultCloneFolder({ home, last: "/tmp/x", projectRoots: [], isFolder: isFolder(["/tmp/x"]) })).toBe(home);
    expect(defaultCloneFolder({ home, last: null, projectRoots: ["/Users/me/.cache/x", "/elsewhere/y"], isFolder: isFolder(["/Users/me/.cache", "/elsewhere"]) })).toBe(home);
  });

  test("C9, C10: the same repo there is already cloned; another folder of that name gets -2, -3; nothing is overwritten", () => {
    const there: Record<string, string | null> = { "/c/web": "github.com/other/web", "/c/web-2": null, "/c/api-gateway": "github.com/acme/api-gateway" };
    const exists = (p: string) => p in there;
    const originOf = (p: string) => there[p] ?? null;
    expect(cloneTarget({ into: "/c", repo: "web", key: "github.com/acme/web", exists, originOf })).toEqual({ path: "/c/web-3", name: "web-3", state: "clone", taken: "/c/web" });
    expect(cloneTarget({ into: "/c", repo: "api-gateway", key: "github.com/acme/api-gateway", exists, originOf })).toEqual({ path: "/c/api-gateway", name: "api-gateway", state: "already", taken: null });
    expect(cloneTarget({ into: "/c", repo: "billing-api", key: "github.com/acme/billing-api", exists, originOf })).toEqual({ path: "/c/billing-api", name: "billing-api", state: "clone", taken: null });
  });

  test("E4, E5, E6: git's words read as sign-in, no such repo, network, or failed", () => {
    expect(classifyGitFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("auth");
    expect(classifyGitFailure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe("auth");
    expect(classifyGitFailure("ERROR: Repository not found.\nfatal: Could not read from remote repository.")).toBe("not_found");
    expect(classifyGitFailure("fatal: '/x/y.git' does not appear to be a git repository")).toBe("not_found");
    expect(classifyGitFailure("fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com")).toBe("network");
    expect(classifyGitFailure("ssh: connect to host github.com port 22: Connection timed out")).toBe("network");
    expect(classifyGitFailure("fatal: early EOF")).toBe("failed");
  });

  test("E2: git's progress reads as one percent that only grows", () => {
    expect(parseGitProgress("Receiving objects:  50% (5/10), 1.00 MiB | 2.00 MiB/s\r")).toBe(45);
    expect(parseGitProgress("Receiving objects: 100% (10/10), done.\nResolving deltas:  40% (4/10)\r")).toBe(94);
    expect(parseGitProgress("Cloning into 'x'...")).toBeNull();
  });
});

// ── On the real launch module, with a local bare repo ──

const gitBase = (home: string) => ({ HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });

function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

/** A bare repo at `<fixtures>/<slug>.git` with one commit (and, with `hooks`, a `.claude/settings.json` that runs one). */
function bareRepo(fixtures: string, slug: string, env: Record<string, string>, extra: Record<string, string> = {}) {
  const work = mkdtempSync(join(tmpdir(), "plannotator-clone-work-"));
  restore.push(() => rmSync(work, { recursive: true, force: true }));
  git(work, env, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "# repo\n");
  for (const [name, text] of Object.entries(extra)) {
    mkdirSync(join(work, name, ".."), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  git(work, env, "add", "-A");
  git(work, env, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first");
  const bare = join(fixtures, `${slug}.git`);
  mkdirSync(join(bare, ".."), { recursive: true });
  git(fixtures, env, "clone", "-q", "--bare", work, bare);
}

function world(options: { slowGit?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-clone-")));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const fixtures = join(root, "fixtures");
  for (const dir of [dataDir, join(home, "code", "web"), fixtures]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const env = gitBase(home);
  bareRepo(fixtures, "acme/billing-api", env);
  bareRepo(fixtures, "acme/hooked", env, { ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo hi" }] }] } }) });
  // A git that waits first, so a Cancel lands during the clone.
  let path = env.PATH;
  if (options.slowGit) {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const real = Bun.which("git")!;
    writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 20\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    path = `${bin}:${path}`;
  }
  // https://github.com/<slug> is the bare repo on disk: git's own rewrite, so nothing leaves this machine.
  const login = { ...env, PATH: path, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${fixtures}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/" };
  const store = InboxStore.open(dataDir);
  const fake = fakeLaunchHost();
  const changes = { n: 0 };
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    loginEnv: async () => login,
    ownEnv: () => login,
    installDirs: [],
    displayFolder: (p) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => changes.n++,
    selfCommand: ["plannotator"],
    hosts: () => [fake.host],
  });
  restore.push(() => launch.stop());
  let n = 0;
  const send = async (url: string, folder: string, branch?: string) => {
    const target = launch.target({ launch: { agent: FAKE, folder, clone: { url, ...(branch ? { branch } : {}) } } })!;
    const prepared = await launch.prepare(target, { name: "Cent drift", body: "Find the cent drift.", resolveProject: async (p) => store.ensureProject({ name: p.split("/").pop()!, root: p }) });
    const rootMessage = store.startPersonThread({ project_id: prepared.project.id, body: "Find the cent drift.", to: prepared.to, idempotency_key: `send-${++n}`, thread_name: `Cent drift ${n}`, launch: prepared.launch }).message;
    launch.begin(rootMessage);
    return rootMessage;
  };
  const record = (id: string) => store.message(id)!.launch!;
  const run = (id: string) => launch.runOf(id);
  const runs: Record<string, string | undefined> = {};
  /** For `until`: the line's state, read in the background. */
  const runState = (id: string) => (void run(id).then((r) => (runs[id] = r?.state)), runs[id]);
  const post = (id: string, action: string) =>
    launch.route(
      new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv" }) }),
      `/api/inbox/launch/${id}/${action}`,
      "local",
    );
  const get = (path: string) => launch.route(new Request(`http://127.0.0.1${path}`, { headers: { "Sec-Fetch-Site": "same-origin" } }), new URL(`http://x${path}`).pathname, "local");
  return { root, home, store, fake, launch, send, record, run, runState, post, get, changes };
}

async function until(check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(20);
  expect(check()).toBe(true);
}

describe("a Send that clones", () => {
  test("E1, E3: clones into the folder named, then starts there; the next clone defaults to that folder (C1c)", async () => {
    const w = world();
    const root = await w.send("https://github.com/acme/billing-api", "~/code/billing-api");
    expect(w.record(root.id).clone).toMatchObject({ url: "https://github.com/acme/billing-api.git", slug: "acme/billing-api", state: "cloning" });
    await until(() => w.record(root.id).clone?.state === "done" && w.fake.calls.length > 0);
    expect(existsSync(join(w.home, "code", "billing-api", "README.md"))).toBe(true);
    expect(originKeyOf(join(w.home, "code", "billing-api"))).toBe("github.com/acme/billing-api");
    expect(w.fake.calls).toEqual(["start Cent drift 1"]);
    const block = await w.launch.composeBlock();
    expect(block!.clone).toEqual({ into: join(w.home, "code") });
  });

  test("C9: where the same repo is already, the target says so, and a Send starts there without cloning", async () => {
    const w = world();
    const first = await w.send("https://github.com/acme/billing-api", "~/code/billing-api");
    await until(() => w.record(first.id).clone?.state === "done");
    const answer = (await (await w.get(`/api/inbox/launch/clone?url=${encodeURIComponent("git@github.com:acme/billing-api.git")}&into=~/code`))!.json()) as Record<string, unknown>;
    expect(answer).toEqual({ into: "~/code", path: "~/code/billing-api", name: "billing-api", state: "already", taken: null, writable: true });
    const again = await w.send("https://github.com/acme/billing-api", "~/code/billing-api");
    expect(w.record(again.id).clone).toBeUndefined();
  });

  test("C10, E11: a name another folder has: the target is -2, and a name taken since the pick moves on and says so", async () => {
    const w = world();
    const answer = (await (await w.get(`/api/inbox/launch/clone?url=${encodeURIComponent("https://github.com/acme/web")}&into=~/code`))!.json()) as Record<string, unknown>;
    expect(answer).toMatchObject({ path: "~/code/web-2", state: "clone", taken: "~/code/web" });
    // The person picked ~/code/billing-api; something took the name before Send.
    mkdirSync(join(w.home, "code", "billing-api"));
    const root = await w.send("https://github.com/acme/billing-api", "~/code/billing-api");
    expect(w.record(root.id).folder).toBe(join(w.home, "code", "billing-api-2"));
    expect(w.record(root.id).clone?.renamed_from).toBe("~/code/billing-api");
    await until(() => w.record(root.id).clone?.state === "done");
    expect(readdirSync(join(w.home, "code", "billing-api"))).toEqual([]);
  });

  test("E5: no such repo: the message is kept, the line says why, and Try again clones again", async () => {
    const w = world();
    const root = await w.send("https://github.com/acme/nope", "~/code/nope");
    await until(() => w.record(root.id).clone?.state === "failed");
    expect(await w.run(root.id)).toMatchObject({ state: "clone_failed", clone: { error: "not_found", host: "github.com", slug: "acme/nope" } });
    expect(w.fake.calls).toEqual([]);
    // Nothing is left behind: the folder the Send made goes with the failure, and Try again makes it again.
    expect(existsSync(join(w.home, "code", "nope"))).toBe(false);
    const retried = await w.post(w.record(root.id).id, "retry");
    expect(retried!.status).toBe(200);
    await until(() => w.record(root.id).clone?.state === "failed");
  });

  test("E7: Cancel during the clone stops git and removes the partly cloned folder; nothing starts", { timeout: 30_000 }, async () => {
    const w = world({ slowGit: true });
    const root = await w.send("https://github.com/acme/billing-api", "~/code/billing-api");
    await until(() => w.runState(root.id) === "cloning");
    expect(existsSync(join(w.home, "code", "billing-api"))).toBe(true);
    const answer = await w.post(w.record(root.id).id, "stop");
    expect(answer!.status).toBe(200);
    await until(() => w.record(root.id).clone?.state === "cancelled");
    expect(existsSync(join(w.home, "code", "billing-api"))).toBe(false);
    expect((await w.run(root.id))?.state).toBe("clone_cancelled");
    expect(w.fake.calls).toEqual([]);
  });

  test("E10, decision 4a: a repo that brings hooks waits for trust; a plain one is trusted and starts without asking", async () => {
    const w = world();
    const accepted: string[] = [];
    w.fake.faults.trusted = () => false;
    w.fake.faults.untrusted = true;
    // The offer reads the clone's own files, as Claude Code's does.
    w.fake.host.trustOffer = (target) => ({
      folder: target.folder,
      read: () => (existsSync(join(target.folder, ".claude", "settings.json")) ? { warning: "This folder has 1 hook that will run once you trust it.", facts: ["Runs 1 hook"], warns: true } : { warning: null, facts: [], warns: false }),
      accept: async () => {
        accepted.push(target.folder);
        w.fake.faults.untrusted = false;
      },
    });
    const hooked = await w.send("https://github.com/acme/hooked", "~/code/hooked");
    await until(() => w.record(hooked.id).clone?.state === "done" && !!w.record(hooked.id).error);
    expect(w.record(hooked.id).clone?.brings).toEqual(["hooks"]);
    expect(accepted).toEqual([]);
    expect(await w.run(hooked.id)).toMatchObject({ state: "failed", untrusted: true, clone: { brings: ["hooks"] } });

    const plain = await w.send("https://github.com/acme/billing-api", "~/code/billing-api");
    await until(() => w.record(plain.id).clone?.state === "done" && w.fake.calls.some((c) => c.startsWith("start")) && !w.record(plain.id).error && !!w.record(plain.id).session_ref);
    expect(accepted).toEqual([join(w.home, "code", "billing-api")]);
  });

  test("never a URL that isn't an https or ssh repo, or a branch that reads as an option", () => {
    const w = world();
    for (const clone of [{ url: "file:///etc" }, { url: "--upload-pack=x" }, { url: "https://github.com/acme/x", branch: "--upload-pack=x" }, { url: "ext::sh -c x" }]) {
      expect(() => w.launch.target({ launch: { agent: FAKE, folder: "~/code/x", clone } })).toThrow("to.launch.clone");
    }
  });
});
