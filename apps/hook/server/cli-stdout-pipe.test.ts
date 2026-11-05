/**
 * CLI output bigger than a pipe or socket holds, read the ways an agent's shell
 * tool reads it: the CLI has to wait for the reader. Run through the real entry.
 *
 * What goes wrong when it does not, by the Bun that runs the CLI:
 *  - `process.stdout.write` then `process.exit` (`guide export --out -`, `card`,
 *    `inbox projects`): every Bun tried (1.3.14, 1.4.4) loses what the pipe or
 *    socket has not taken yet, on macOS and Linux, even with a reader keeping up.
 *  - `console.log` (`inbox --help`): Bun 1.3.14 drops what the pipe will not
 *    take once anything has read `process.stdout`, waiting or not. Bun 1.4.4
 *    loses nothing this way.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_CARD_ACTION_ON, INBOX_CARD_TITLE_MAX } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { FIXTURE_V1_PR } from "@plannotator/shared/guide-format-fixtures";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

/** What a macOS or Linux pipe holds before a writer has to wait. */
const PIPE_CAPACITY = 65_536;

// Hold off reading until the CLI exits (a CLI that does not wait for the reader)
// or 4 s pass (one that does, stuck on the full pipe; also the time it gets to
// start). A slow machine can only hide the bug, never fail a fix.
const slowReader = (seconds: number) => `{ i=0; while [ ! -e "$RC" ] && [ "$i" -lt ${seconds * 10} ]; do sleep 0.1; i=$((i+1)); done; cat >"$OUT"; }`;
const SLOW_READER = slowReader(4);
// Leaves while the CLI is stuck on the full pipe: a CLI that hung on this would run into the test's timeout.
const READER_THAT_LEAVES = "sleep 2";
// A parent reading at once from a plain socketpair (argv: out file, then the command), the kind of stdout a parent
// on libuv hands its child. Bun.spawn's own socket holds far more, so it would hide the cut.
const SOCKET_PARENT = `
import socket, subprocess, sys
parent, child = socket.socketpair()
proc = subprocess.Popen(sys.argv[2:], stdout=child.fileno())
child.close()
with open(sys.argv[1], "wb") as out:
    while True:
        chunk = parent.recv(65536)
        if not chunk:
            break
        out.write(chunk)
sys.exit(proc.wait())
`;
const PYTHON = Bun.which("python3");

const agents = stubbedAgentClis();

// Sh runs the pipeline: Windows has no such pipe to test here.
describe.skipIf(process.platform === "win32")("CLI output through a pipe", () => {
  let root = "";
  let stubbed: string[] = [];
  let env: Record<string, string | undefined> = {};
  const inRoot = (name: string) => join(root, name);
  const cli = (...argv: string[]) => [process.execPath, "run", join(import.meta.dir, "index.ts"), ...argv];

  /** Run the CLI's stdout into `reader`; what the reader kept is in `out<id>`, the CLI's own exit code in `code`. */
  const pipeInto = async (argv: string[], reader: string, options: { cwd?: string; id?: string } = {}) => {
    const rc = inRoot(`rc${options.id ?? ""}`);
    rmSync(rc, { force: true });
    rmSync(inRoot(`out${options.id ?? ""}`), { force: true });
    const proc = Bun.spawn(["sh", "-c", `{ "$@"; echo $? >"$RC"; } | ${reader}`, "sh", ...cli(...argv)], {
      cwd: options.cwd ?? root,
      env: { ...env, RC: rc, OUT: inRoot(`out${options.id ?? ""}`) },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, code: readFileSync(rc, "utf8").trim() };
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
      ...agents.env,
      PLANNOTATOR_DATA_DIR: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_INBOX_NOTES: "0",
      PLANNOTATOR_TEST_SANDBOX: "1",
      NO_ANON_PING: "1",
      // An agent session running this test names its own project: `card` would read that one, not the cwd's.
      PLANNOTATOR_SESSION_PROJECT: undefined,
      PLANNOTATOR_SESSION_TAG: undefined,
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

  // A sandbox Board in this process's own Inbox (temp data dir, nothing to signal), read by the real CLI.
  describe.if(INBOX_CARD_ACTION_ON)("lists from a sandbox Inbox", () => {
    /** Past what any pipe or socket here holds (macOS and Linux), the point of these lists. */
    const BIGGER_THAN_ANY_BUFFER = 300_000;
    const CARDS = 1_600;
    const PROJECTS = 800;
    /** Long titles and folders, so that few rows are enough and the Board seeds in moments. */
    const LONG = "x".repeat(300);
    let server: InboxServer;
    let project = "";
    let savedDataDir: string | undefined;

    beforeAll(async () => {
      savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
      process.env.PLANNOTATOR_DATA_DIR = root;
      project = inRoot("app");
      mkdirSync(project);
      server = await startInboxServer({ dataDir: root, phones: false, board: true });
      // A folder gets its project the way it always does, by a message.
      const sent = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { project_path: project, agent_session: "ses_seed", body: "seed" } } }),
      });
      await sent.text();
      const { id } = server.store.projectByRoot(project)!;
      for (let n = 0; n < CARDS; n++) server.store.createCard({ project_id: id, by: { kind: "person" }, title: `Pipe card ${n} `.padEnd(INBOX_CARD_TITLE_MAX, "x") });
      for (let n = 0; n < PROJECTS; n++) server.store.ensureProject({ name: `folder-${n}`, root: inRoot(`${LONG}/folder-${n}`) });
    });

    afterAll(() => {
      server?.stop();
      if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
    });

    const parsed = <T,>(text: string): T | null => {
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    };

    /** Every reader at once; each one's text and the CLI's exit code. */
    const readAllWays = async (argv: string[]) => {
      const ways = [
        { reader: "slow", run: () => pipeInto(argv, slowReader(2), { cwd: project, id: "-slow" }), out: "out-slow" },
        { reader: "keeping up", run: () => pipeInto(argv, `cat >"$OUT"`, { cwd: project, id: "-up" }), out: "out-up" },
        ...(PYTHON
          ? [
              {
                reader: "socket",
                run: async () => {
                  const proc = Bun.spawn([PYTHON, "-I", "-c", SOCKET_PARENT, inRoot("out-socket"), ...cli(...argv)], { cwd: project, env, stdout: "ignore", stderr: "pipe" });
                  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
                  return { stderr, code: String(code) };
                },
                out: "out-socket",
              },
            ]
          : []),
      ];
      return Promise.all(
        ways.map(async ({ reader, run, out }) => {
          const { code, stderr } = await run();
          const bytes = readFileSync(inRoot(out));
          return { reader, code, stderr, bytes: bytes.length, text: bytes.toString("utf8") };
        }),
      );
    };

    const expectWholeEveryWay = async (argv: string[], isWhole: (text: string) => boolean) => {
      const results = await readAllWays(argv);
      // Which readers lost what, in one failure.
      expect(results.map(({ reader, code, stderr, bytes, text }) => `${reader}: ${isWhole(text) ? "whole" : `${bytes} bytes ${stderr}`}, exit ${code}`)).toEqual(results.map(({ reader }) => `${reader}: whole, exit 0`));
      for (const { reader, bytes } of results) expect(bytes, `${reader}: too small to see a cut, make the list bigger`).toBeGreaterThan(BIGGER_THAN_ANY_BUFFER);
    };

    test("card list, text", async () => {
      await expectWholeEveryWay(["card", "list", "--anyone", "--all"], (text) => (text.match(/Pipe card \d+/g) ?? []).length === CARDS);
    }, 30_000);

    test("card list --json", async () => {
      await expectWholeEveryWay(["card", "list", "--anyone", "--all", "--json"], (text) => parsed<{ cards: unknown[] }>(text)?.cards.length === CARDS);
    }, 30_000);

    test("inbox projects --json", async () => {
      // The list holds the app project too.
      await expectWholeEveryWay(["inbox", "projects", "--json"], (text) => parsed<{ projects: unknown[] }>(text)?.projects.length === PROJECTS + 1);
    }, 30_000);
  });
});
