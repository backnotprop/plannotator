/**
 * "Another folder on <machine>…": a Send's `to.launch.folder`, on a real launch module over a temp data dir and a temp
 * home. What each test guards: a typed folder that would put an agent somewhere the folder listing never offers is
 * refused before anything is checked or written (`prepare` throws, so no thread, project or start): a hidden folder
 * reached by a backslash, a NUL, or a link in home that lands in one; and home itself, where an agent would reach
 * every folder under it, hidden ones too. The listing's own rules are in inbox-home-folders.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";
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
      expect([folder, await send(folder)]).toEqual([folder, { code: "validation_error", message: "Pick a folder by its full path. Nothing was sent." }]);
    }
    expect(resolvedCount()).toBe(0);
    expect(store.listProjects()).toEqual([]);
  });

  test("a link in home that lands in a hidden folder is a hidden folder", async () => {
    const { send, resolvedCount } = setup();
    expect(await send("~/code/sshlink")).toEqual({ code: "validation_error", message: "Hidden folders can't be picked. Nothing was sent." });
    expect(resolvedCount()).toBe(0);
  });

  test("a folder that isn't there under a hidden folder or a system one answers as that folder, not as missing", async () => {
    const { send, resolvedCount } = setup();
    expect(await send("~/code/sshlink/nope")).toEqual({ code: "validation_error", message: "Hidden folders can't be picked. Nothing was sent." });
    // The temp folder is a system folder (macOS's /private, Linux's /tmp): a link there is one too.
    expect(await send("~/outlink/nope")).toEqual({ code: "validation_error", message: "System folders can't be picked. Nothing was sent." });
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

/**
 * Create a folder (approval "launch-create-clone", decision 1a): `to.launch: { folder, create: true }` makes only the
 * last folder, after every check, and only in a folder that is there and can be written. A thread that is never
 * written takes the folder away again while it is empty; a folder that is there by now is started in as it is.
 */
describe("to.launch.folder with create", () => {
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  function world() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-create-")));
    restore.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    const home = join(root, "home");
    for (const dir of ["code/web-app", "Documents/Archive"]) mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, "code", "roadmap"), "a file");
    chmodSync(join(home, "Documents", "Archive"), 0o555);
    restore.push(() => chmodSync(join(home, "Documents", "Archive"), 0o755));
    mkdirSync(dataDir, { recursive: true });
    setEnv("PLANNOTATOR_DATA_DIR", dataDir);
    setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
    const store = InboxStore.open(dataDir);
    const fake = fakeLaunchHost();
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
      hosts: () => [fake.host],
    });
    restore.push(() => launch.stop());
    const prepare = async (folder: string, create = true) => {
      const target = launch.target({ launch: { agent: FAKE, folder, ...(create ? { create: true } : {}) } })!;
      return launch.prepare(target, { name: "x", body: "x", resolveProject: async (path) => store.ensureProject({ name: path.split("/").pop()!, root: path }) });
    };
    const refusal = async (folder: string) => {
      try {
        await prepare(folder);
        return { code: "sent", message: "" };
      } catch (error) {
        const { code, message } = error as { code?: string; message: string };
        return { code: code ?? "thrown", message };
      }
    };
    return { home, store, launch, prepare, refusal, fake };
  }

  test("makes the last folder and starts there; the record says it made it", async () => {
    const { home, prepare } = world();
    const made = await prepare("~/code/pricing-page");
    expect(made.launch.folder).toBe(join(home, "code", "pricing-page"));
    expect(made.launch.made_folder).toBe(true);
    expect(existsSync(join(home, "code", "pricing-page"))).toBe(true);
    expect(made.project.root).toBe(join(home, "code", "pricing-page"));
  });

  test("q-d2512542: Create + Send starts straight away: the empty folder it made is trusted as by hand, with no Trust folder step; one with anything in it by then is not", async () => {
    const { home, launch, prepare, store, fake } = world();
    // Claude Code trusts nothing here yet, and refuses an untrusted folder until the trust is saved (by the host's offer).
    const accepted: string[] = [];
    fake.faults.trusted = () => false;
    fake.faults.untrusted = true;
    fake.host.trustOffer = (target) => ({
      folder: target.folder,
      read: () => ({ warning: null, facts: [], warns: false }),
      accept: async () => {
        accepted.push(target.folder);
        fake.faults.untrusted = false;
      },
    });
    const send = async (folder: string, key: string, before?: () => void) => {
      const made = await prepare(folder);
      before?.();
      const root = store.startPersonThread({ project_id: made.project.id, body: "x", to: made.to, idempotency_key: key, thread_name: key, launch: made.launch }).message;
      launch.begin(root);
      return root;
    };
    const fresh = await send("~/code/pricing-page", "fresh");
    for (let i = 0; i < 200 && !store.message(fresh.id)!.launch!.session_ref && !store.message(fresh.id)!.launch!.error; i++) await Bun.sleep(10);
    expect(store.message(fresh.id)!.launch!.error ?? null).toBeNull();
    expect(store.message(fresh.id)!.launch!.session_ref).toBeTruthy();
    expect(accepted).toEqual([join(home, "code", "pricing-page")]);

    // Something was put in it before the start: the person reads and trusts it, as any other folder (E8, Trust folder).
    fake.faults.untrusted = true;
    const filled = await send("~/code/pricing-notes", "filled", () => writeFileSync(join(home, "code", "pricing-notes", "notes.md"), "x"));
    for (let i = 0; i < 200 && !store.message(filled.id)!.launch!.error && !store.message(filled.id)!.launch!.session_ref; i++) await Bun.sleep(10);
    expect(store.message(filled.id)!.launch!.error?.code).toBe("untrusted");
    expect(accepted).toEqual([join(home, "code", "pricing-page")]);
  });

  test("without create, a folder that isn't there is still folder_missing and nothing is made", async () => {
    const { home, prepare } = world();
    await expect(prepare("~/code/pricing-page", false)).rejects.toMatchObject({ code: "folder_missing" });
    expect(existsSync(join(home, "code", "pricing-page"))).toBe(false);
  });

  test("only the last folder: two missing levels, a file's name, a bad name are refused, and nothing is made", async () => {
    const { home, refusal, store } = world();
    expect(await refusal("~/code/new-client/site")).toEqual({ code: "folder_missing", message: "There's no ~/code/new-client. Only the last folder in a path can be made. Nothing was sent." });
    expect(await refusal("~/code/roadmap")).toEqual({ code: "folder_unavailable", message: "There's already a file named roadmap. Pick another name. Nothing was sent." });
    expect((await refusal("~/code/a:b")).code).toBe("validation_error");
    expect(existsSync(join(home, "code", "new-client"))).toBe(false);
    expect(store.listProjects()).toEqual([]);
  });

  test.skipIf(asRoot)("never in a folder that can't be written", async () => {
    const { home, refusal } = world();
    expect(await refusal("~/Documents/Archive/q3")).toEqual({ code: "folder_unavailable", message: "Can't make a folder in ~/Documents/Archive: no permission. Nothing was sent." });
    expect(existsSync(join(home, "Documents", "Archive", "q3"))).toBe(false);
  });

  test("a folder that is there by now is started in as it is, and never marked made", async () => {
    const { home, prepare } = world();
    const there = await prepare("~/code/web-app");
    expect(there.launch.folder).toBe(join(home, "code", "web-app"));
    expect(there.launch.made_folder).toBeUndefined();
  });

  test("a thread never written takes the made folder away while it is empty; anything put in it keeps it", async () => {
    const { home, launch, prepare, store } = world();
    const first = await prepare("~/code/pricing-page");
    launch.abandon(first.launch, first.project);
    expect(existsSync(join(home, "code", "pricing-page"))).toBe(false);
    expect(store.listProjects()).toEqual([]);
    const second = await prepare("~/code/landing");
    writeFileSync(join(home, "code", "landing", "notes.md"), "kept");
    launch.abandon(second.launch, second.project);
    expect(existsSync(join(home, "code", "landing", "notes.md"))).toBe(true);
  });
});

/**
 * A folder on another drive (approval "inbox-launch-any-folder"): a Send may start in any folder but a system or hidden
 * one, a drive's own root too; never in the folder drives are mounted in. A drive that doesn't answer is given up after
 * the read's timeout and said by name, and never holds the Inbox: the next read of it answers at once. The temp folder
 * is a system folder here, so the test names its own disk (`folderPlaces`).
 */
describe("to.launch.folder on another drive", () => {
  function drives() {
    const disk = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-drive-")));
    restore.push(() => rmSync(disk, { recursive: true, force: true }));
    const dataDir = join(disk, "data");
    const home = join(disk, "Users", "me");
    const volumes = join(disk, "Volumes");
    for (const dir of [join(home, "code"), join(volumes, "Studio SSD", "footage"), join(volumes, "Backup", "jobs"), dataDir]) mkdirSync(dir, { recursive: true });
    setEnv("PLANNOTATOR_DATA_DIR", dataDir);
    setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
    // Backup stands in for a network drive that stopped answering: its reads never finish.
    setEnv("PLANNOTATOR_TEST_DRIVES", JSON.stringify({ slow: [join(volumes, "Backup")] }));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
    const store = InboxStore.open(dataDir);
    const fake = fakeLaunchHost();
    const chosen: (string | null)[] = [];
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
      readBody: async (req) => (await req.json().catch(() => ({}))) as Record<string, unknown>,
      json: (body, status = 200) => Response.json(body, { status }),
      onChange: () => {},
      selfCommand: ["plannotator"],
      hosts: () => [fake.host],
      folderPlaces: { system: [join(disk, "System")], open: [], containers: ["/", volumes, join(disk, "Users")] },
      folderReadTimeoutMs: 700,
      chooseFolder: async () => chosen.shift() ?? null,
    });
    restore.push(() => launch.stop());
    const prepare = (folder: string) => {
      const target = launch.target({ launch: { agent: FAKE, folder } })!;
      return launch.prepare(target, { name: "x", body: "x", resolveProject: async (path) => store.ensureProject({ name: path.split("/").pop()!, root: path }) });
    };
    const list = (path: string) =>
      launch.route(new Request(`http://localhost/api/inbox/launch/folders?path=${encodeURIComponent(path)}`, { headers: { "sec-fetch-site": "same-origin" } }), "/api/inbox/launch/folders", "local", null);
    return { volumes, prepare, list, launch, chosen };
  }

  test("starts in a folder on a drive, and in the drive's own root", async () => {
    const { volumes, prepare } = drives();
    expect((await prepare(join(volumes, "Studio SSD", "footage"))).launch.folder).toBe(join(volumes, "Studio SSD", "footage"));
    expect((await prepare(join(volumes, "Studio SSD"))).project.root).toBe(join(volumes, "Studio SSD"));
  });

  test("never in the folder the drives are mounted in", async () => {
    const { volumes, prepare } = drives();
    await expect(prepare(volumes)).rejects.toMatchObject({ code: "validation_error", message: `Pick a folder inside ${volumes}. Nothing was sent.` });
  });

  test("a drive that doesn't answer is given up and said by name; the next read of it answers at once", async () => {
    const { volumes, prepare, list } = drives();
    const started = Date.now();
    await expect(prepare(join(volumes, "Backup", "jobs"))).rejects.toMatchObject({ code: "folder_unavailable", message: "Backup isn't responding. Nothing was sent." });
    expect(Date.now() - started).toBeLessThan(2500);
    const again = Date.now();
    const answer = (await list(join(volumes, "Backup", "jobs")))!;
    expect(Date.now() - again).toBeLessThan(300);
    expect([answer.status, await answer.json()]).toEqual([504, { error: "Backup isn't responding.", code: "folder_slow", drive: "Backup" }]);
    // Another drive still reads.
    expect(await (await list(`${join(volumes, "Studio SSD")}/`))!.json()).toMatchObject({ exists: true, folders: ["footage"] });
  });

  test("Choose in Finder: this computer's own window only; the folder picked, or cancelled", async () => {
    const { launch, chosen } = drives();
    const ask = (via: string, door: { platform: string; window: boolean } | null = null, site = "same-origin") =>
      launch.route(new Request("http://localhost/api/inbox/launch/choose-folder", { method: "POST", headers: { "sec-fetch-site": site }, body: "{}" }), "/api/inbox/launch/choose-folder", via, door);
    expect((await ask("tailnet"))!.status).toBe(403);
    expect((await ask("local", { platform: "darwin", window: true }))!.status).toBe(403);
    expect((await ask("local", null, "none"))!.status).toBe(403);
    chosen.push("/Volumes/Studio SSD/footage/");
    expect(await (await ask("local"))!.json()).toEqual({ path: "/Volumes/Studio SSD/footage/" });
    expect(await (await ask("local"))!.json()).toEqual({ cancelled: true });
  });
});
