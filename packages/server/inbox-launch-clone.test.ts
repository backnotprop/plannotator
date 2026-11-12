import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";
import { classifyGitFailure, cloneTarget, defaultCloneFolder, originKeyOf, parseGitProgress, runGitClone } from "./inbox-launch-clone";
import { folderIdentity } from "./inbox-home-folders";
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

describe("git asks nothing, in words the lines can read", () => {
  function recordingGit(silent = false) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-clone-env-")));
    restore.push(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), silent ? "#!/bin/sh\nexec sleep 30\n" : `#!/bin/sh\nenv > ${root}/env\nprintf '%s\\n' "$@" > ${root}/args\necho 'fatal: repository not found' >&2\nexit 128\n`);
    chmodSync(join(bin, "git"), 0o755);
    return { root, bin };
  }

  test("a clone runs with no terminal prompt, no askpass, no credential window, ssh in batch mode, English words, and no other repo's GIT_DIR", async () => {
    const { root, bin } = recordingGit();
    const base = { HOME: root, PATH: `${bin}:/usr/bin:/bin`, LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", GIT_DIR: "/elsewhere/.git", GIT_INDEX_FILE: "/elsewhere/index", GIT_ASKPASS: "/usr/bin/ask" };
    const result = await runGitClone({ url: "https://github.com/acme/x.git", folder: join(root, "x"), env: base }).done;
    expect(result).toMatchObject({ ok: false, error: "not_found" });
    const env = Object.fromEntries(readFileSync(join(root, "env"), "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never", GIT_ASKPASS: "", LC_ALL: "C" });
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    const args = readFileSync(join(root, "args"), "utf8").trim().split("\n");
    expect(args).toContain("credential.interactive=false");
    expect(args.slice(-3)).toEqual(["--", "https://github.com/acme/x.git", join(root, "x")]);
  });

  test("a clone that writes nothing for too long (a prompt no one sees, a stalled transfer) ends, said as the network's", async () => {
    const { root, bin } = recordingGit(true);
    const result = await runGitClone({ url: "https://github.com/acme/x.git", folder: join(root, "x"), env: { HOME: root, PATH: `${bin}:/usr/bin:/bin` }, idleMs: 300 }).done;
    expect(result).toMatchObject({ ok: false, error: "network", cancelled: false });
  });
});

const gitBase = (home: string) => ({ HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });

function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

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

function world(options: { slowGit?: boolean; holdLogin?: boolean } = {}) {
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
  let path = env.PATH;
  if (options.slowGit) {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const real = Bun.which("git")!;
    writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 20\nexec ${real} "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    path = `${bin}:${path}`;
  }
  const login = { ...env, PATH: path, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${fixtures}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/" };
  let loginReads = 0;
  let releaseLogin!: () => void;
  const loginGate = new Promise<void>((r) => (releaseLogin = r));
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
    loginEnv: async () => {
      if (options.holdLogin && ++loginReads > 1) await loginGate;
      return login;
    },
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
  const runState = (id: string) => (void run(id).then((r) => (runs[id] = r?.state)), runs[id]);
  const post = (id: string, action: string) =>
    launch.route(
      new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv" }) }),
      `/api/inbox/launch/${id}/${action}`,
      "local",
    );
  const get = (path: string) => launch.route(new Request(`http://127.0.0.1${path}`, { headers: { "Sec-Fetch-Site": "same-origin" } }), new URL(`http://x${path}`).pathname, "local");
  return { root, home, store, fake, launch, send, record, run, runState, post, get, changes, releaseLogin };
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

  test("E7, E5 on the sweep: a failed or cancelled clone stays so on every tick (its own first message is no reply); a reply written after clones again", { timeout: 30_000 }, async () => {
    const w = world();
    const root = await w.send("https://github.com/acme/nope", "~/code/nope");
    await until(() => w.record(root.id).clone?.state === "failed");
    const ended = w.record(root.id).clone!.ended_at;
    expect(ended).toBeTruthy();
    for (let i = 0; i < 5; i++) {
      w.launch.sweep(true);
      await Bun.sleep(150);
    }
    expect(w.record(root.id).clone).toMatchObject({ state: "failed", ended_at: ended });
    expect(existsSync(join(w.home, "code", "nope"))).toBe(false);
    await Bun.sleep(5);
    w.store.sendReply(root.id, { words: "Try the other remote.", idempotency_key: "reply-1" });
    w.launch.sweep(true);
    await until(() => w.record(root.id).clone?.state === "failed" && w.record(root.id).clone!.ended_at! > ended!);
    const again = w.record(root.id).clone!.ended_at;
    for (let i = 0; i < 3; i++) {
      w.launch.sweep(true);
      await Bun.sleep(150);
    }
    expect(w.record(root.id).clone!.ended_at).toBe(again);
  });

  test("E7: Cancel or Delete in the first moments (the start's shell read still under way) holds: git never runs, nothing is left", { timeout: 30_000 }, async () => {
    const w = world({ holdLogin: true });
    const cancelled = await w.send("https://github.com/acme/billing-api", "~/code/billing-api");
    expect((await w.run(cancelled.id))?.state).toBe("cloning");
    const answer = await w.post(w.record(cancelled.id).id, "stop");
    expect(answer!.status).toBe(200);
    expect(((await answer!.json()) as { run: { state: string } }).run.state).toBe("clone_cancelled");
    expect(existsSync(join(w.home, "code", "billing-api"))).toBe(false);

    const d = world({ holdLogin: true });
    const deleted = await d.send("https://github.com/acme/hooked", "~/code/hooked");
    expect((await d.post(d.record(deleted.id).id, "delete"))!.status).toBe(200);
    expect(d.record(deleted.id).deleted_at).toBeTruthy();
    w.releaseLogin();
    d.releaseLogin();
    await Bun.sleep(1500);
    expect(existsSync(join(w.home, "code", "billing-api"))).toBe(false);
    expect(existsSync(join(d.home, "code", "hooked"))).toBe(false);
    expect(w.record(cancelled.id).clone?.state).toBe("cancelled");
    expect([...w.fake.calls, ...d.fake.calls].filter((call) => call.startsWith("start"))).toEqual([]);
  });

  test("two Sends of one URL to one new folder: one clones there, the other is refused; two gits never share a folder", async () => {
    const w = world();
    const both = await Promise.allSettled([w.send("https://github.com/acme/billing-api", "~/code/billing-api"), w.send("https://github.com/acme/billing-api", "~/code/billing-api")]);
    const sent = both.filter((r) => r.status === "fulfilled");
    const refused = both.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(sent).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: "folder_unavailable" });
    const root = (sent[0] as PromiseFulfilledResult<{ id: string }>).value;
    await until(() => w.record(root.id).clone?.state === "done");
    expect(existsSync(join(w.home, "code", "billing-api", "README.md"))).toBe(true);
  });

  test("a failed clone forgets its folder's identity: a folder the person makes at that path later is never removed, by Try again or Cancel", async () => {
    const w = world();
    const root = await w.send("https://github.com/acme/nope", "~/code/nope");
    await until(() => w.record(root.id).clone?.state === "failed");
    expect(w.record(root.id).made_folder).toBeUndefined();
    expect(w.record(root.id).made_inode).toBeUndefined();
    mkdirSync(join(w.home, "code", "nope"));
    writeFileSync(join(w.home, "code", "nope", "notes.md"), "mine");
    expect((await w.post(w.record(root.id).id, "retry"))!.status).toBe(200);
    await until(() => w.record(root.id).clone?.state === "failed" && !!w.record(root.id).clone!.ended_at);
    expect(readFileSync(join(w.home, "code", "nope", "notes.md"), "utf8")).toBe("mine");
  });

  test.skipIf((folderIdentity(tmpdir()) ?? "").split(":").length < 3)("an inode number that came back with another birth time is not the folder the Inbox made", async () => {
    const w = world({ slowGit: true });
    const root = await w.send("https://github.com/acme/billing-api", "~/code/billing-api");
    await until(() => w.runState(root.id) === "cloning");
    const [dev, ino] = folderIdentity(join(w.home, "code", "billing-api"))!.split(":");
    writeFileSync(join(w.home, "code", "billing-api", "notes.md"), "mine");
    w.store.settleLaunch(root.id, { clone: w.record(root.id).clone!, made_inode: `${dev}:${ino}:1` });
    expect((await w.post(w.record(root.id).id, "stop"))!.status).toBe(200);
    await until(() => w.record(root.id).clone?.state === "cancelled");
    expect(readFileSync(join(w.home, "code", "billing-api", "notes.md"), "utf8")).toBe("mine");
  });

  test("never a URL that isn't an https or ssh repo, or a branch that reads as an option", () => {
    const w = world();
    for (const clone of [{ url: "file:///etc" }, { url: "--upload-pack=x" }, { url: "https://github.com/acme/x", branch: "--upload-pack=x" }, { url: "ext::sh -c x" }]) {
      expect(() => w.launch.target({ launch: { agent: FAKE, folder: "~/code/x", clone } })).toThrow("to.launch.clone");
    }
  });
});
