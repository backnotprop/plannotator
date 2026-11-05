/**
 * `plannotator inbox --help` read through a pipe by something slow, the way an
 * agent's shell tool reads it. The guide (Board, steps and code review on) is
 * bigger than a pipe holds, so the CLI has to wait for the reader.
 *
 * What goes wrong when it does not, by the Bun that runs the CLI:
 *  - `process.stdout.write` then `process.exit`: every Bun tried (1.3.14, 1.4.4)
 *    loses what the pipe has not taken yet, on macOS and Linux.
 *  - `console.log`: Bun 1.3.14 drops what the pipe will not take once anything
 *    has read `process.stdout`, waiting or not. Bun 1.4.4 loses nothing this way.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

/** What a macOS or Linux pipe holds before a writer has to wait. */
const PIPE_CAPACITY = 65_536;

// Sh runs the pipeline: Windows has no such pipe to test here.
describe.skipIf(process.platform === "win32")("inbox --help through a pipe", () => {
  let root = "";
  let stubbed: string[] = [];
  let env: Record<string, string | undefined> = {};
  const whole = () => join(root, "whole");
  const out = () => join(root, "out");
  const rc = () => join(root, "rc");

  /** Run the CLI's stdout into `reader`; the CLI's own exit code lands in the rc file. */
  const pipeInto = async (reader: string) => {
    rmSync(rc(), { force: true });
    const proc = Bun.spawn(["sh", "-c", `{ "$BUN" run "$ENTRY" inbox --help; echo $? >"$RC"; } | ${reader}`], {
      cwd: root,
      env,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, code: readFileSync(rc(), "utf8").trim() };
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-help-pipe-")));
    stubbed = stubHookDistHtml();
    writeFileSync(join(root, "config.json"), JSON.stringify({ inboxBoard: true, inboxSteps: true, inboxCodeReview: true }));
    env = {
      ...process.env,
      // The Bun running this test, so a run under another Bun proves that one.
      BUN: process.execPath,
      ENTRY: join(import.meta.dir, "index.ts"),
      RC: rc(),
      OUT: out(),
      PLANNOTATOR_DATA_DIR: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_INBOX_NOTES: "0",
      PLANNOTATOR_TEST_SANDBOX: "1",
      NO_ANON_PING: "1",
    };
    // The same command into a file, which never pushes back: the bytes every reader should get.
    const proc = Bun.spawnSync([process.execPath, "run", env.ENTRY!, "inbox", "--help"], { cwd: root, env, stdout: Bun.file(whole()), stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`inbox --help failed: ${proc.stderr.toString()}`);
  });

  afterAll(() => {
    removeStubbedHtml(stubbed);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a slow reader gets every byte, and the exit code stays 0", async () => {
    const expected = readFileSync(whole());
    expect(expected.length, "The guide now fits in a pipe, so this test no longer sees a cut: make the output bigger").toBeGreaterThan(PIPE_CAPACITY);

    // Hold off reading until the CLI exits (a CLI that does not wait for the
    // reader) or 4 s pass (one that does, stuck on the full pipe; also the time
    // it gets to start). A slow machine can only hide the bug, never fail a fix.
    const { code, stderr } = await pipeInto(`{ i=0; while [ ! -e "$RC" ] && [ "$i" -lt 40 ]; do sleep 0.1; i=$((i+1)); done; cat >"$OUT"; }`);

    const received = readFileSync(out());
    expect(received.length, stderr).toBe(expected.length);
    expect(received.equals(expected)).toBe(true);
    expect(code).toBe("0");
  }, 30_000);

  test("a reader that leaves without reading ends the CLI with exit code 0", async () => {
    // Leaves while the CLI is stuck on the full pipe: a CLI that hung on this would run into the test's timeout.
    const { code, stderr } = await pipeInto("sleep 2");

    expect(code, stderr).toBe("0");
  }, 30_000);
});
