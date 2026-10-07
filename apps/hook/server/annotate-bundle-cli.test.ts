/**
 * `plannotator annotate a.md b.html ...` (several existing file paths) opens
 * ONE review of all of them, run as the real process: the server runs in
 * `annotate-bundle` mode with the files in the typed order, one decision
 * settles it, and the host result record names each file with its comment
 * count. Mixed arguments keep the #1483 errors (with the bundle hint), and a
 * strict gate takes only a single target or only file paths.
 *
 * Every run uses a temp PLANNOTATOR_DATA_DIR and cwd; nothing touches the
 * real ~/.plannotator.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ANNOTATE_BUNDLE_HINT } from "@plannotator/shared/annotate-target";

const entry = resolve(import.meta.dir, "index.ts");
const distDir = resolve(import.meta.dir, "../dist");
let stubs: string[] = [];
let root = "";

beforeAll(() => {
  // The CLI imports the built HTML; API-only tests need just a stub.
  stubs = ["index.html", "review.html", "inbox.html"].map((name) => join(distDir, name)).filter((path) => !existsSync(path));
  mkdirSync(distDir, { recursive: true });
  for (const path of stubs) writeFileSync(path, "<!doctype html><title>test</title>");
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-annotate-bundle-cli-")));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "spec.md"), "# Spec\n\nBody\n");
  writeFileSync(join(root, "docs", "mock.html"), "<!doctype html><h1>Mock</h1>");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  writeFileSync(join(root, "image.png"), "not really a png");
});
afterAll(() => {
  for (const path of stubs) rmSync(path, { force: true });
  rmSync(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PLANNOTATOR_CWD: root,
    PLANNOTATOR_DATA_DIR: join(root, "data"),
    PLANNOTATOR_PORT: "0",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_AI: "disabled",
    PLANNOTATOR_SHARE: "disabled",
    PLANNOTATOR_FEEDBACK_HISTORY: "0",
    PLANNOTATOR_ANNOTATE_HISTORY: "0",
    ...extra,
  };
}

function runSync(args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", entry, "annotate", ...args], {
    cwd: root,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function waitFor<T>(read: () => T | null | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

/** Start the CLI the way the Claude Code mod does: a ready file and a host result file. */
function start(args: string[], launch: string) {
  const dir = join(root, "data", "claude-code-mod", "session-1", launch);
  mkdirSync(dir, { recursive: true });
  const ready = join(dir, "ready");
  const resultPath = join(dir, "result.json");
  const proc = Bun.spawn([process.execPath, "run", entry, "annotate", ...args], {
    cwd: root,
    env: env({ PLANNOTATOR_READY_FILE: ready, PLANNOTATOR_HOST_RESULT_FILE: resultPath }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const base = async () => {
    const line = await waitFor(() => (existsSync(ready) ? readFileSync(ready, "utf8").split("\n")[0] : null));
    return `http://localhost:${(JSON.parse(line) as { port: number }).port}`;
  };
  return { proc, base, resultPath };
}

const comment = (id: string, documentPath: string) => ({
  id,
  blockId: "",
  startOffset: 0,
  endOffset: 4,
  type: "COMMENT",
  text: id,
  originalText: "Body",
  createdA: 1,
  documentPath,
});

describe("annotate with several file paths", () => {
  test("opens one review in the typed order and settles it with one decision naming every file", async () => {
    const spec = join(root, "spec.md");
    const mock = join(root, "docs", "mock.html");
    const { proc, base, resultPath } = start(["docs/mock.html", "spec.md", "./docs/mock.html"], "bundle-1");
    const url = await base();

    const plan = await (await fetch(`${url}/api/plan`)).json();
    expect(plan.mode).toBe("annotate-bundle");
    // Typed order; the duplicate of mock.html is dropped.
    expect(plan.bundle).toEqual([
      { path: mock, renderAs: "html" },
      { path: spec, renderAs: "markdown" },
    ]);

    const feedback = "## spec.md\n\nTighten the intro.";
    const sent = await fetch(`${url}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback, annotations: [comment("a", spec), comment("b", spec)] }),
    });
    expect(sent.ok).toBe(true);
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("Tighten the intro.");

    const record = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(record.decision).toBe("annotated");
    expect(record.annotationCount).toBe(2);
    expect(record.documents).toEqual([
      { path: mock, annotationCount: 0 },
      { path: spec, annotationCount: 2 },
    ]);
    // The agent's message names every file of the review.
    expect(record.message).toContain(mock);
    expect(record.message).toContain(spec);
  }, 30_000);

  test("a strict gate opens several files as one review and approves them all", async () => {
    const { proc, base } = start(["spec.md", "notes.md", "--gate", "--json", "--require-approval"], "bundle-2");
    const url = await base();
    expect((await (await fetch(`${url}/api/plan`)).json()).mode).toBe("annotate-bundle");
    const approved = await fetch(`${url}/api/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(approved.ok).toBe(true);
    expect(await proc.exited).toBe(0);
    expect(JSON.parse((await new Response(proc.stdout).text()).trim()).decision).toBe("approved");
  }, 30_000);

  test("an unsupported file among them is a startup error naming it", () => {
    const result = runSync(["spec.md", "image.png"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(join(root, "image.png"));
    // Under a strict gate the same misconfiguration is exit 2, never a rejection.
    expect(runSync(["spec.md", "image.png", "--gate", "--json", "--require-approval"]).exitCode).toBe(2);
  });

  test("a folder among the paths keeps the ambiguity error, now with the hint", () => {
    const result = runSync(["spec.md", "docs/"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Ambiguous annotate arguments");
    expect(result.stderr).toContain(ANNOTATE_BUNDLE_HINT);
  });

  test("a strict gate refuses extra words instead of ignoring them, without resolving the first", () => {
    const result = runSync(["spec.md", "please", "--gate", "--json", "--result-file", "out.json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("A strict annotate gate takes one target");
    // Refused by probe alone: the first argument is not opened or reported.
    expect(result.stderr).not.toContain("Resolved:");
    expect(result.stdout).toBe("");
  });

  // The failure: `annotate a.md typo.md` opened a.md alone (exit 0) while the
  // agent was told both files were open.
  test("a list of file paths with a missing one opens nothing and names it", () => {
    const result = runSync(["spec.md", "typo.md"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("File not found: typo.md");
    expect(runSync(["spec.md", "typo.md", "--gate", "--json", "--require-approval"]).exitCode).toBe(2);
  });

  // The failure (#1718 re-review): an existing directory beside a file read
  // as "File not found: ."; a stray `.` / `..` must keep opening the file.
  test("a stray . or .. beside a file opens the file, never 'not found'", async () => {
    for (const [args, launch] of [[[".", "spec.md"], "dot"], [["spec.md", ".."], "dotdot"]] as const) {
      const { proc, base } = start([...args], `bundle-${launch}`);
      const url = await base();
      const plan = await (await fetch(`${url}/api/plan`)).json();
      expect(plan.mode).toBe("annotate");
      expect(plan.filePath).toBe(join(root, "spec.md"));
      await fetch(`${url}/api/exit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await proc.exited;
      expect(await new Response(proc.stderr).text()).not.toContain("not found");
    }
  }, 60_000);

  test("the same file named twice opens that one file, as on the other hosts", async () => {
    const { proc, base } = start(["spec.md", "./spec.md"], "bundle-3");
    const url = await base();
    const plan = await (await fetch(`${url}/api/plan`)).json();
    expect(plan.mode).toBe("annotate");
    expect(plan.filePath).toBe(join(root, "spec.md"));
    await fetch(`${url}/api/exit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await proc.exited;
  }, 30_000);
});
