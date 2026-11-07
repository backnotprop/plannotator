/**
 * `plannotator shape update` when the working folder cannot be read as a project (unreadable, or `/`): the agent
 * gets one `project_unresolved` line and exit 1, never an uncaught InboxError and its stack trace. What regresses:
 * the project rule's throw escapes `runShapeCommand`. In process, with a stand-in project rule; no Inbox, no git,
 * nothing outside a temp folder.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { runShapeCommand } from "./shape-command";

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
