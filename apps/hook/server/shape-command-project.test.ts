/**
 * `plannotator shape update` when the working folder cannot be read as a project (unreadable, or `/`): the agent
 * gets one `project_unresolved` line and exit 1, never an uncaught InboxError and its stack trace. What regresses:
 * the project rule's throw escapes `runShapeCommand`. In process, with a stand-in project rule; no Inbox, no git,
 * nothing outside a temp folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { createShapeStore } from "@plannotator/shared/shape/store";
import { runShapeCommand, shapeCommandFolder } from "./shape-command";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an unreadable working folder refuses update in one line", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shape-cli-project-")));
  roots.push(root);
  const project = join(root, "kettle");
  mkdirSync(project);
  writeFileSync(join(project, "board.json"), JSON.stringify({ title: "Kettle", claim: "Built.", views: { know: "Once." } }));
  const out: string[] = [];
  const err: string[] = [];
  const code = await runShapeCommand(["update", "--file", "board.json"], {
    dataDir: join(root, "data"),
    cwd: project,
    env: {},
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    projectRootOf: async () => {
      throw new InboxError("validation_error", "project_path: no such folder.", { field: "project_path" });
    },
  });
  expect(code).toBe(1);
  expect(err).toEqual([`project_unresolved: could not use ${project} as the project: no such folder. Pass --project <folder>.`]);
  expect(out).toEqual([]);
});

/**
 * The help says "run `plannotator shape update` from the project's folder". The folder the command runs in
 * decides the project, even inside an agent session whose own folder is another repository; the session's
 * folder is used only when the shell's folder gives none. What regresses: a board made from a scratch or PR
 * folder is filed under the session's repository, and its file links open that repository's files.
 */
describe("which folder a board is filed under", () => {
  const setup = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "shape-cli-where-")));
    roots.push(root);
    const session = join(root, "session-repo");
    const scratch = join(root, "pr-scratch");
    const home = join(root, "home");
    for (const dir of [session, scratch, home]) mkdirSync(dir);
    const file = join(root, "board.json");
    writeFileSync(file, JSON.stringify({ title: "Kettle", claim: "Built.", views: { picture: { html: '<p data-mark="p">One</p>' } } }));
    const dataDir = join(root, "data");
    const write = async (cwd: string, ...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runShapeCommand(["update", "--file", file, ...argv], {
        dataDir,
        cwd,
        home,
        env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses_abc", PLANNOTATOR_SESSION_PROJECT: `claude-code:ses_abc:${session}` },
        stdout: (t) => void out.push(t),
        stderr: (t) => void err.push(t),
        projectRootOf: async (folder) => ({ root: folder, name: basename(folder) }),
      });
      expect(err).toEqual([]);
      expect(code).toBe(0);
      const { id } = JSON.parse(out.join("\n")) as { id: string };
      return createShapeStore({ dataDir }).get(id)!.project.root;
    };
    return { root, session, scratch, home, write };
  };

  test("the folder the command runs in, not the session's folder", async () => {
    const w = setup();
    expect(await w.write(w.scratch)).toBe(w.scratch);
  });

  test("the session's folder when the shell's folder gives none: the home folder, or a folder that is gone", async () => {
    const w = setup();
    expect(await w.write(w.home)).toBe(w.session);
    expect(await w.write(join(w.root, "gone"))).toBe(w.session);
  });

  test("--project wins wherever the shell is", async () => {
    const w = setup();
    expect(await w.write(w.home, "--project", w.scratch)).toBe(w.scratch);
    expect(await w.write(w.scratch, "--project", w.session)).toBe(w.session);
  });
});

/**
 * The real CLI's folder (`shapeCommandFolder`, what index.ts passes). A deleted folder makes `process.cwd()`
 * throw, which killed the command with a stack trace before it could fall back to the session's folder.
 */
describe("the folder the CLI runs in, when it was deleted", () => {
  const gone = () => {
    throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), { code: "ENOENT" });
  };

  test("the shell's PWD stands in for a folder that is gone, and nothing throws", () => {
    expect(shapeCommandFolder({ PWD: "/work/pr-scratch" }, gone)).toBe("/work/pr-scratch");
    expect(shapeCommandFolder({}, gone)).toBeNull();
    expect(shapeCommandFolder({ PWD: "relative" }, gone)).toBeNull();
    expect(shapeCommandFolder({ PLANNOTATOR_CWD: "/named", PWD: "/work" }, gone)).toBe("/named");
    expect(shapeCommandFolder({ PWD: "/work" }, () => "/here")).toBe("/here");
  });

  test("with no folder at all, a board still goes to the session's folder, and a relative --file is refused in one line", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "shape-cli-gone-")));
    roots.push(root);
    const session = join(root, "session-repo");
    mkdirSync(session);
    const file = join(root, "board.json");
    writeFileSync(file, JSON.stringify({ title: "Kettle", claim: "Built.", views: { picture: { html: '<p data-mark="p">One</p>' } } }));
    const dataDir = join(root, "data");
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runShapeCommand(["update", ...argv], {
        dataDir,
        cwd: null,
        home: join(root, "home"),
        env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses_abc", PLANNOTATOR_SESSION_PROJECT: `claude-code:ses_abc:${session}` },
        stdout: (t) => void out.push(t),
        stderr: (t) => void err.push(t),
        projectRootOf: async (folder) => ({ root: folder, name: basename(folder) }),
      });
      return { code, out, err };
    };
    const made = await run("--file", file);
    expect(made.err).toEqual([]);
    expect(made.code).toBe(0);
    expect(createShapeStore({ dataDir }).get((JSON.parse(made.out.join("\n")) as { id: string }).id)!.project.root).toBe(session);
    const relative = await run("--file", "board.json");
    expect(relative.code).toBe(1);
    expect(relative.err).toEqual(["invalid: the folder this command runs in is gone: pass --file as an absolute path."]);
  });
});
