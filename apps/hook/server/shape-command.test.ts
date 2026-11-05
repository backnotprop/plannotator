/**
 * `plannotator shape …` in process: what an agent sees from each command.
 * Every run gets its own data dir and project folder under the OS temp
 * folder, and a stand-in for the project rule (no git). Nothing here reads
 * the person's data, environment or Inbox.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { checkShapeBoard } from "@plannotator/core/shape";
import { parseShapeCommand, runShapeCommand, SHAPE_COMMAND_USAGE } from "./shape-command";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world(env: Record<string, string | undefined> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shape-cli-")));
  roots.push(root);
  const dataDir = join(root, "data");
  const project = join(root, "kettle");
  mkdirSync(project, { recursive: true });
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runShapeCommand(argv, {
      dataDir,
      cwd: project,
      env,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      projectRootOf: async (folder) => ({ root: folder, name: basename(folder) }),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const board = (name: string, words: string) => {
    const path = join(project, name);
    writeFileSync(
      path,
      JSON.stringify({
        title: "The kettle whistles once",
        claim: "Built. Nothing waits on you.",
        views: { picture: { html: `<p data-mark="p-whistle">${words}</p>` } },
      }),
    );
    return name;
  };
  return { run, board, project };
}

describe("shape update", () => {
  test("creates a shape, then adds versions only from the latest base", async () => {
    const w = world();
    const first = await w.run("update", "--file", w.board("b1.json", "whistles once"));
    expect(first.code).toBe(0);
    const { id, v, created } = JSON.parse(first.out);
    expect([v, created]).toEqual([1, true]);

    const noBase = await w.run("update", "--file", w.board("b2.json", "whistles twice"), "--id", id);
    expect(noBase.code).toBe(1);
    expect(noBase.err).toStartWith("base_required:");

    const second = await w.run("update", "--file", "b2.json", "--id", id, "--base", "1");
    expect(second.code).toBe(0);
    expect(JSON.parse(second.out)).toMatchObject({ id, v: 2, created: false, changed: ["Picture: 1 changed"] });

    const stale = await w.run("update", "--file", w.board("b3.json", "whistles thrice"), "--id", id, "--base", "1");
    expect(stale.code).toBe(1);
    expect(stale.err).toStartWith("stale_base:");
    // The latest version comes back, so the agent can fold its change into it.
    expect(JSON.parse(stale.out).latest.n).toBe(2);
  });

  test("an invalid board is refused with every problem by field", async () => {
    const w = world();
    writeFileSync(join(w.project, "bad.json"), JSON.stringify({ title: "", claim: "c", views: { how: { html: "<script>x</script>" } } }));
    const result = await w.run("update", "--file", "bad.json");
    expect(result.code).toBe(1);
    expect(result.err).toContain("- title: is empty");
    expect(result.err).toContain("- views.how.html: <script> is not allowed");
  });
});

describe("shape read", () => {
  test("--notes hands over the notes waiting for the agent once", async () => {
    const w = world();
    const { id } = JSON.parse((await w.run("update", "--file", w.board("b.json", "whistles once"))).out);
    const { createShapeStore } = await import("@plannotator/shared/shape/store");
    // The person's Change it, as the board would post it.
    const dataDir = join(w.project, "..", "data");
    createShapeStore({ dataDir }).addNote(id, { kind: "change", v: 1, view: "picture", part: "p-whistle", text: "Twice" });

    const read = JSON.parse((await w.run("read", id, "--notes")).out);
    expect(read.version.n).toBe(1);
    expect(read.notes.map((n: { text: string }) => n.text)).toEqual(["Twice"]);
    expect(JSON.parse((await w.run("read", id, "--notes")).out).notes).toEqual([]);
  });

  test("notes whose hand-over fails (a closed pipe) still wait for the next read", async () => {
    const w = world();
    const { id } = JSON.parse((await w.run("update", "--file", w.board("b.json", "whistles once"))).out);
    const { createShapeStore } = await import("@plannotator/shared/shape/store");
    const dataDir = join(w.project, "..", "data");
    createShapeStore({ dataDir }).addNote(id, { kind: "change", v: 1, view: "picture", part: "p-whistle", text: "Twice" });

    const err: string[] = [];
    const broken = await runShapeCommand(["read", id, "--notes"], {
      dataDir,
      cwd: w.project,
      env: {},
      stdout: () => Promise.reject(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
      stderr: (t) => err.push(t),
      projectRootOf: async (folder) => ({ root: folder, name: basename(folder) }),
    });
    expect(broken).toBe(1);
    expect(err.join()).toStartWith("output_failed:");
    expect(JSON.parse((await w.run("read", id, "--notes")).out).notes.map((n: { text: string }) => n.text)).toEqual(["Twice"]);
    expect(JSON.parse((await w.run("read", id, "--notes")).out).notes).toEqual([]);
  });

  test("with no id, a session reads its own newest shape, not another session's", async () => {
    const mine = world({ PI_SESSION_ID: "sess-mine" });
    const { id: own } = JSON.parse((await mine.run("update", "--file", mine.board("a.json", "mine"))).out);
    // Same data dir and folder, another session draws a newer shape.
    const other = await runShapeCommand(["update", "--file", "a.json"], {
      dataDir: join(mine.project, "..", "data"),
      cwd: mine.project,
      env: { PI_SESSION_ID: "sess-other" },
      stdout: () => {},
      stderr: () => {},
      projectRootOf: async (folder) => ({ root: folder, name: basename(folder) }),
    });
    expect(other).toBe(0);
    expect(JSON.parse((await mine.run("read")).out).shape.id).toBe(own);
  });
});

describe("shape answer", () => {
  test("the agent answers the person's Ask; the board's chat has it under the question, from that session", async () => {
    const w = world({ PI_SESSION_ID: "sess-mine" });
    const { id } = JSON.parse((await w.run("update", "--file", w.board("b.json", "whistles once"))).out);
    const { createShapeStore } = await import("@plannotator/shared/shape/store");
    const dataDir = join(w.project, "..", "data");
    const person = createShapeStore({ dataDir });
    person.addNote(id, { kind: "ask", v: 1, text: "Why once?" });
    const [ask] = JSON.parse((await w.run("read", id, "--notes")).out).notes;
    expect(ask.kind).toBe("ask");

    expect((await w.run("answer", id, "--re", ask.id, "--text", "So it never nags.")).code).toBe(0);
    const answer = person.notes(id).find((n) => n.kind === "answer");
    expect(answer).toMatchObject({ re: ask.id, text: "So it never nags.", from: { host: "pi", id: "sess-mine" } });
    // An answer needs the Ask's id and words.
    expect((await w.run("answer", id, "--text", "x")).code).toBe(2);
  });
});

describe("shape done and drawing", () => {
  test("a finished shape refuses drawing and new versions", async () => {
    const w = world();
    const { id } = JSON.parse((await w.run("update", "--file", w.board("b.json", "x"))).out);
    expect((await w.run("done", id)).code).toBe(0);
    expect((await w.run("drawing", id)).err).toStartWith("finished:");
    expect((await w.run("update", "--file", "b.json", "--id", id, "--base", "1")).err).toStartWith("finished:");
    expect((await w.run("list")).out).toContain("No active shapes");
    expect((await w.run("list", "--all")).out).toContain(`${id}  v1`);
  });
});

describe("parseShapeCommand", () => {
  test("a flag another command owns is refused, not ignored", () => {
    expect(parseShapeCommand(["read", "--base", "2"])).toMatchObject({ ok: false });
    expect(parseShapeCommand(["update", "--id", "shp_x"])).toMatchObject({ ok: false, error: "shape update needs --file <board.json>." });
    expect(parseShapeCommand(["update", "--file", "b.json", "--thread", "not-a-message"])).toMatchObject({ ok: false });
  });

  test("--through takes a message id, as --thread does", () => {
    expect(parseShapeCommand(["update", "--file", "b.json", "--through", "../../x"])).toMatchObject({ ok: false, error: "--through takes an Inbox message id (msg_…)." });
    expect(parseShapeCommand(["update", "--file", "b.json", "--through", "msg_01JC0000000000000000000000"])).toMatchObject({ ok: true });
  });
});

describe("shape --help", () => {
  // What regresses: the format or the validator changes and the help's example (the one an agent copies with no
  // thread and no /shape skill) stops being a board the store takes.
  test("its JSON example is a board the store accepts", () => {
    const json = SHAPE_COMMAND_USAGE.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(json).toBeDefined();
    const checked = checkShapeBoard(JSON.parse(json!));
    expect(checked.ok ? [] : checked.errors).toEqual([]);
  });
});

describe("the Shape switch, through the entrypoint", () => {
  test("update tells the agent how the board will behave, and stores it either way", async () => {
    const { run, board } = world();
    const r = await run("update", "--file", board("kettle.json", "whistles"));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.v).toBe(1);
    expect(out.notes.join()).toContain("no width and height");
  });

  test("a board that writes Requirements is refused, and the refusal says where the words go", async () => {
    const { run, project } = world();
    writeFileSync(join(project, "old.json"), JSON.stringify({ title: "T", claim: "C", views: { reqs: { groups: [] } } }));
    const r = await run("update", "--file", "old.json");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("views.know");
  });

  // Guards the gate in apps/hook/server/index.ts: while the person has not turned Shape on (config.json
  // `inboxShape` unset or false), every `plannotator shape …` (its --help too) prints only the one line that
  // says it is off and exits 1, and nothing is written. On, the same calls work.
  test("off: one line and exit 1, help included, nothing stored; on: help and update work", async () => {
    const { removeStubbedHtml, stubHookDistHtml } = await import("../../../tests/helpers/hook-dist-stub");
    const { existsSync, readdirSync } = await import("node:fs");
    const { NO_BROWSER } = await import("../../../tests/helpers/no-browser");
    const { SHAPE_OFF_TEXT } = await import("./shape-command");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "shape-cli-gate-")));
    roots.push(root);
    const dataDir = join(root, "data");
    const project = join(root, "kettle");
    mkdirSync(join(dataDir), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(root, "board.json"), JSON.stringify({ title: "Kettle", claim: "Built.", views: { picture: { html: "<p>One whistle</p>" } } }));
    const stubbed = stubHookDistHtml();
    const entry = join(import.meta.dir, "index.ts");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER: "1",
      NO_ANON_PING: "1",
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_TEST_SANDBOX: "1",
    };
    const run = async (...argv: string[]) => {
      const proc = Bun.spawn(["bun", "run", entry, "shape", ...argv], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    try {
      for (const config of [null, { inboxShape: false }]) {
        if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
        for (const argv of [["--help"], ["update", "--file", join(root, "board.json"), "--project", project], ["list"]]) {
          const r = await run(...argv);
          expect(r.code).toBe(1);
          expect(r.stdout).toBe("");
          expect(r.stderr).toBe(`${SHAPE_OFF_TEXT}\n`);
        }
        expect(existsSync(join(dataDir, "shapes")) ? readdirSync(join(dataDir, "shapes")) : []).toEqual([]);
        // Off, the kit is one more command that does not exist: nothing teaches the feature.
        const kit = await run("kit");
        expect(kit.code).toBe(1);
        expect(kit.stdout).toBe("");
        expect(kit.stderr).toBe(`${SHAPE_OFF_TEXT}\n`);
      }
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxShape: true }));
      const help = await run("--help");
      expect(help.code, help.stderr).toBe(0);
      // On, --help is the whole guide (welcome, commands, drawing); off (above) it is only SHAPE_OFF_TEXT.
      expect(`${help.stdout}${help.stderr}`).toContain(SHAPE_COMMAND_USAGE);
      const made = await run("update", "--file", join(root, "board.json"), "--project", project);
      expect(made.code, made.stderr).toBe(0);
      expect(JSON.parse(made.stdout).v).toBe(1);
    } finally {
      removeStubbedHtml(stubbed);
    }
  }, 60_000);

  /** The CLI from source in a fresh data dir under the OS temp folder (never the person's), with hook pages stubbed. */
  async function cli() {
    const { removeStubbedHtml, stubHookDistHtml } = await import("../../../tests/helpers/hook-dist-stub");
    const { NO_BROWSER } = await import("../../../tests/helpers/no-browser");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "shape-cli-switch-")));
    roots.push(root);
    const dataDir = join(root, "data");
    const project = join(root, "kettle");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    const stubbed = stubHookDistHtml();
    const entry = join(import.meta.dir, "index.ts");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER: "1",
      NO_ANON_PING: "1",
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_INBOX_NOTES: "0",
      PLANNOTATOR_TEST_SANDBOX: "1",
    };
    const run = async (...argv: string[]) => {
      const proc = Bun.spawn(["bun", "run", entry, "shape", ...argv], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    const config = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    return { dataDir, run, config, done: () => removeStubbedHtml(stubbed) };
  }

  // `plannotator shape on|off` is the person's switch from a terminal: it must work while Shape is off (the only
  // shape commands that do), flip what --help shows, be harmless twice, and keep the rest of config.json.
  test("on and off work from the off state and decide what --help shows; on twice is harmless", async () => {
    const { SHAPE_OFF_TEXT } = await import("./shape-command");
    const c = await cli();
    try {
      writeFileSync(join(c.dataDir, "config.json"), JSON.stringify({ inboxBoard: true }));
      // Off (unset): off works and says so; `on --help` is still gated.
      expect(await c.run("off")).toEqual({ stdout: "Shape is off.\n", stderr: "", code: 0 });
      expect(c.config()).toEqual({ inboxBoard: true, inboxShape: false });
      expect(await c.run("on", "--help")).toEqual({ stdout: "", stderr: `${SHAPE_OFF_TEXT}\n`, code: 1 });
      // on, from off, twice.
      for (let i = 0; i < 2; i++) {
        expect(await c.run("on")).toEqual({ stdout: "Shape is on.\n", stderr: "", code: 0 });
        expect(c.config()).toEqual({ inboxBoard: true, inboxShape: true });
      }
      const help = await c.run("--help");
      expect(help.code, help.stderr).toBe(0);
      expect(`${help.stdout}${help.stderr}`).toContain(SHAPE_COMMAND_USAGE);
      // off again: --help is only the off line, and the off line names the way back.
      expect(await c.run("off")).toEqual({ stdout: "Shape is off.\n", stderr: "", code: 0 });
      expect(await c.run("--help")).toEqual({ stdout: "", stderr: `${SHAPE_OFF_TEXT}\n`, code: 1 });
      expect(SHAPE_OFF_TEXT).toContain("`plannotator shape on`");
      // Extra words are refused without a word of the guide, and change nothing.
      const extra = await c.run("on", "now");
      expect(extra.code).toBe(2);
      expect(extra.stdout).toBe("");
      expect(extra.stderr).not.toContain("Usage:");
      expect(c.config().inboxShape).toBe(false);
    } finally {
      c.done();
    }
  }, 60_000);

  // A config.json that is not valid JSON is never written over, so the switch did not move: say so and exit 1,
  // never "Shape is off." (which off would otherwise read back from the unreadable file).
  test("on and off with a config.json that cannot be saved: an error, exit 1, the file untouched", async () => {
    const c = await cli();
    try {
      const path = join(c.dataDir, "config.json");
      writeFileSync(path, "{ not json");
      for (const which of ["on", "off"]) {
        const r = await c.run(which);
        expect({ which, code: r.code, stdout: r.stdout }).toEqual({ which, code: 1, stdout: "" });
        expect(r.stderr).toContain("config_not_saved: ");
        expect(readFileSync(path, "utf8")).toBe("{ not json");
      }
    } finally {
      c.done();
    }
  }, 60_000);

  test("on and off set the very switch the Inbox's Settings reads (and the other way round)", async () => {
    const { SHAPE_OFF_TEXT } = await import("./shape-command");
    const { startInboxServer } = await import("@plannotator/server/inbox");
    const c = await cli();
    const saved = process.env.PLANNOTATOR_DATA_DIR;
    // The Inbox reads config.json through the env, like the CLI child.
    process.env.PLANNOTATOR_DATA_DIR = c.dataDir;
    const inbox = await startInboxServer({ dataDir: c.dataDir, phones: false });
    try {
      const base = `http://127.0.0.1:${inbox.port}`;
      // Off, the settings read leaves Shape out (held until the next big release, inbox.ts heldSwitch): absent reads as off.
      const settingsShape = async () => ((await (await fetch(`${base}/api/inbox/settings`)).json()) as { shape?: { on: boolean } }).shape?.on === true;
      expect(await settingsShape()).toBe(false);
      expect((await c.run("on")).code).toBe(0);
      expect(await settingsShape()).toBe(true);
      expect((await fetch(`${base}/api/shapes`)).status).toBe(200);
      expect((await c.run("off")).code).toBe(0);
      expect(await settingsShape()).toBe(false);
      expect((await fetch(`${base}/api/shapes`)).status).toBe(404);
      // The Settings switch, and the CLI's gate follows it.
      const set = (on: boolean) =>
        fetch(`${base}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shape: { on } }) });
      expect((await set(true)).status).toBe(200);
      expect((await c.run("--help")).stdout).toContain(SHAPE_COMMAND_USAGE);
      expect((await set(false)).status).toBe(200);
      expect((await c.run("--help")).stderr).toBe(`${SHAPE_OFF_TEXT}\n`);
    } finally {
      inbox.stop();
      process.env.PLANNOTATOR_DATA_DIR = saved;
      c.done();
    }
  }, 60_000);
});
