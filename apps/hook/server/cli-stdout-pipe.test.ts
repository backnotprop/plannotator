import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_CARD_ACTION_ON, INBOX_CARD_TITLE_MAX } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { FIXTURE_V1_PR } from "@plannotator/shared/guide-format-fixtures";
import SHAPE_KIT from "@plannotator/core/shape-kit.mjs" with { type: "text" };
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const PIPE_CAPACITY = 65_536;

const slowReader = (seconds: number) => `{ i=0; while [ ! -e "$RC" ] && [ "$i" -lt ${seconds * 10} ]; do sleep 0.1; i=$((i+1)); done; cat >"$OUT"; }`;
const SLOW_READER = slowReader(4);
const READER_THAT_LEAVES = "sleep 2";
const SOCKET_PARENT = `
import socket, subprocess, sys
parent, child = socket.socketpair()
child.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
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
const SOCKET_HOLDS = 16_384;

const agents = stubbedAgentClis();

describe.skipIf(process.platform === "win32")("CLI output through a pipe", () => {
  let root = "";
  let stubbed: string[] = [];
  let env: Record<string, string | undefined> = {};
  const inRoot = (name: string) => join(root, name);
  const cli = (...argv: string[]) => [process.execPath, "run", join(import.meta.dir, "index.ts"), ...argv];

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

  const readThroughSocket = async (argv: string[], out: string, options: { cwd?: string; env?: Record<string, string> } = {}) => {
    const proc = Bun.spawn([PYTHON!, "-I", "-c", SOCKET_PARENT, inRoot(out), ...cli(...argv)], { cwd: options.cwd ?? root, env: { ...env, ...options.env }, stdout: "ignore", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { stderr, code: String(code) };
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cli-stdout-pipe-")));
    stubbed = stubHookDistHtml();
    writeFileSync(inRoot("config.json"), JSON.stringify({ inboxBoard: true, inboxSteps: true, inboxCodeReview: true }));
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

  describe("shape kit", () => {
    test.skipIf(!PYTHON)("a socket reading at once gets every byte, and the exit code stays 0", async () => {
      const dataDir = inRoot("shape-data");
      mkdirSync(dataDir);
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxShape: true }));
      const kit = Buffer.from(SHAPE_KIT);
      expect(kit.length, "The kit now fits in the socket, so this test no longer sees a cut: make the socket smaller").toBeGreaterThan(SOCKET_HOLDS);

      const { code, stderr } = await readThroughSocket(["shape", "kit"], "out-kit", { env: { PLANNOTATOR_DATA_DIR: dataDir } });

      const received = readFileSync(inRoot("out-kit"));
      expect(received.length, stderr).toBe(kit.length);
      expect(received.equals(kit)).toBe(true);
      expect(code).toBe("0");
    }, 30_000);
  });

  describe.if(INBOX_CARD_ACTION_ON)("lists from a sandbox Inbox", () => {
    const BIGGER_THAN_ANY_BUFFER = 300_000;
    const CARDS = 1_600;
    const PROJECTS = 800;
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

    const readAllWays = async (argv: string[]) => {
      const ways = [
        { reader: "slow", run: () => pipeInto(argv, slowReader(2), { cwd: project, id: "-slow" }), out: "out-slow" },
        { reader: "keeping up", run: () => pipeInto(argv, `cat >"$OUT"`, { cwd: project, id: "-up" }), out: "out-up" },
        ...(PYTHON ? [{ reader: "socket", run: () => readThroughSocket(argv, "out-socket", { cwd: project }), out: "out-socket" }] : []),
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
      await expectWholeEveryWay(["inbox", "projects", "--json"], (text) => parsed<{ projects: unknown[] }>(text)?.projects.length === PROJECTS + 1);
    }, 30_000);
  });
});
