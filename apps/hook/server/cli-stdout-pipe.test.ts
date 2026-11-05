/**
 * CLI output bigger than a pipe holds, read by something slow the way an
 * agent's shell tool reads it: the CLI has to wait for the reader.
 *
 * What goes wrong when it does not, by the Bun that runs the CLI:
 *  - `process.stdout.write` then `process.exit` (`guide export --out -`): every
 *    Bun tried (1.3.14, 1.4.4) loses what the pipe has not taken yet, on macOS
 *    and Linux.
 *  - `console.log` (`inbox --help`): Bun 1.3.14 drops what the pipe will not
 *    take once anything has read `process.stdout`, waiting or not. Bun 1.4.4
 *    loses nothing this way.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_V1_PR } from "@plannotator/shared/guide-format-fixtures";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

/** What a macOS or Linux pipe holds before a writer has to wait. */
const PIPE_CAPACITY = 65_536;

// Hold off reading until the CLI exits (a CLI that does not wait for the reader)
// or 4 s pass (one that does, stuck on the full pipe; also the time it gets to
// start). A slow machine can only hide the bug, never fail a fix.
const SLOW_READER = `{ i=0; while [ ! -e "$RC" ] && [ "$i" -lt 40 ]; do sleep 0.1; i=$((i+1)); done; cat >"$OUT"; }`;
// Leaves while the CLI is stuck on the full pipe: a CLI that hung on this would run into the test's timeout.
const READER_THAT_LEAVES = "sleep 2";

// Sh runs the pipeline: Windows has no such pipe to test here.
describe.skipIf(process.platform === "win32")("CLI output through a pipe", () => {
  let root = "";
  let stubbed: string[] = [];
  let env: Record<string, string | undefined> = {};
  const inRoot = (name: string) => join(root, name);
  const cli = (...argv: string[]) => [process.execPath, "run", join(import.meta.dir, "index.ts"), ...argv];

  /** Run the CLI's stdout into `reader`; what the reader kept is in `out`, the CLI's own exit code in `code`. */
  const pipeInto = async (argv: string[], reader: string) => {
    rmSync(inRoot("rc"), { force: true });
    rmSync(inRoot("out"), { force: true });
    const proc = Bun.spawn(["sh", "-c", `{ "$@"; echo $? >"$RC"; } | ${reader}`, "sh", ...cli(...argv)], { cwd: root, env, stdout: "ignore", stderr: "pipe" });
    const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, code: readFileSync(inRoot("rc"), "utf8").trim() };
  };

  /** The output every reader should get: the CLI writing to `file`, which never pushes back. */
  const runToFile = (argv: string[], file: string) => {
    const proc = Bun.spawnSync(cli(...argv), { cwd: root, env, stdout: Bun.file(file), stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${proc.stderr.toString()}`);
    const whole = readFileSync(file);
    if (whole.length <= PIPE_CAPACITY) throw new Error(`${argv.join(" ")} now fits in a pipe, so this test no longer sees a cut: make the output bigger`);
    return whole;
  };

  const expectSlowReaderGetsAll = async (argv: string[], whole: Buffer) => {
    const { code, stderr } = await pipeInto(argv, SLOW_READER);
    const received = readFileSync(inRoot("out"));
    expect(received.length, stderr).toBe(whole.length);
    expect(received.equals(whole)).toBe(true);
    expect(code).toBe("0");
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cli-stdout-pipe-")));
    stubbed = stubHookDistHtml();
    // Board, steps and code review on: the biggest `inbox --help`.
    writeFileSync(inRoot("config.json"), JSON.stringify({ inboxBoard: true, inboxSteps: true, inboxCodeReview: true }));
    // A Guided Review whose diff alone is bigger than a pipe.
    const patch = `${FIXTURE_V1_PR.review!.rawPatch}${`\n+${"x".repeat(200)}`.repeat(1_000)}`;
    writeFileSync(inRoot("big.json"), JSON.stringify({ ...FIXTURE_V1_PR, review: { ...FIXTURE_V1_PR.review, rawPatch: patch } }));
    env = {
      ...process.env,
      RC: inRoot("rc"),
      OUT: inRoot("out"),
      PLANNOTATOR_DATA_DIR: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_INBOX_NOTES: "0",
      PLANNOTATOR_TEST_SANDBOX: "1",
      NO_ANON_PING: "1",
    };
  });

  afterAll(() => {
    removeStubbedHtml(stubbed);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  describe("inbox --help", () => {
    const help = ["inbox", "--help"];

    test("a slow reader gets every byte, and the exit code stays 0", async () => {
      await expectSlowReaderGetsAll(help, runToFile(help, inRoot("help-whole")));
    }, 30_000);

    test("a reader that leaves without reading ends the CLI with exit code 0", async () => {
      const { code, stderr } = await pipeInto(help, READER_THAT_LEAVES);
      expect(code, stderr).toBe("0");
    }, 30_000);
  });

  describe("guide export --out -", () => {
    const exportToStdout = () => ["guide", "export", "--snapshot", inRoot("big.json"), "--out", "-"];

    test("a slow reader gets every byte, and the exit code stays 0", async () => {
      await expectSlowReaderGetsAll(exportToStdout(), runToFile(exportToStdout(), inRoot("export-whole")));
    }, 30_000);

    test("a reader that leaves without reading ends the CLI with exit code 0", async () => {
      const { code, stderr } = await pipeInto(exportToStdout(), READER_THAT_LEAVES);
      expect(code, stderr).toBe("0");
    }, 30_000);

    test("a failed export still exits nonzero through a pipe", async () => {
      const { code, stderr } = await pipeInto(["guide", "export", "--snapshot", inRoot("missing.json"), "--out", "-"], `cat >"$OUT"`);
      expect(code, stderr).not.toBe("0");
      expect(readFileSync(inRoot("out")).length).toBe(0);
    }, 30_000);
  });
});
