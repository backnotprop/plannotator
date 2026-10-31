/**
 * Puts a fake OpenCode 1.18.23 on a test's PATH (fake-opencode.cjs: `--version`,
 * `serve` with the session, prompt, event and permission routes the Inbox's
 * OpenCode host uses, `session delete`, and an agent that answers through the
 * Inbox as Plannotator's plugin does).
 *
 * Node-safe (the Playwright specs import it under node): the fake runs on this
 * process's own executable. Every fake server and the child it starts are
 * recorded; `stopAll` signals only recorded pids whose command line is still
 * this fake's.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "fake-opencode.cjs");

/** One permission prompt a turn plays, as OpenCode 1.18's `permission.asked` carries it (less the ids). */
export interface FakeOpenCodePrompt {
  permission: string;
  patterns?: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
}

export interface FakeOpenCodeConfig {
  /** `opencode --version` (default 1.18.23). */
  version?: string;
  /** How long a turn takes before the answer (ms, default 400). */
  workMs?: number;
  /** Keep the turn running until cleared. */
  hold?: boolean;
  /** The answer's first words. */
  answer?: string;
  /** Permission prompts each turn plays, in order, each waited on. */
  prompts?: FakeOpenCodePrompt[];
  /** The person answers each prompt in `opencode attach` (the fake replies "once" itself). */
  localAnswer?: boolean;
  /** `serve` exits at once with an error. */
  failServe?: boolean;
  /** `serve` waits this long before it listens. */
  serveDelayMs?: number;
  /** The server takes any request, with or without the password (one started without a password). */
  acceptAnyAuth?: boolean;
  /** A turn's prompts come from a child session (the task tool's subagent), `parentID` the session. */
  subagent?: boolean;
  /** The child session is announced with `session.created` (else the host must look it up). */
  announceChild?: boolean;
  /** A turn's prompts are asked at once (parallel tool calls). */
  parallel?: boolean;
  /** That many permission reply calls answer 500. */
  failReplies?: number;
  /** Until then (epoch ms) the event streams end and every route answers 503. */
  outageUntil?: number;
  /** The outage only in these servers (pids); absent: in every one. */
  outagePids?: number[];
}

export interface FakeOpenCodeCall {
  argv: string[];
  cwd: string;
  env: string[];
  values: Record<string, string>;
  passwordSet: boolean;
  pid: number;
  at: number;
}

export interface FakeOpenCode {
  state: string;
  configure(patch: FakeOpenCodeConfig): void;
  calls(): FakeOpenCodeCall[];
  /** The `serve` calls only. */
  serves(): FakeOpenCodeCall[];
  /** Each turn a session took: its text and the server that took it. */
  prompts(): { session: string; text: string; server: number }[];
  /** Each permission reply a server got. */
  replies(): { session: string; request: string; permission: string; reply: string; message?: string | null; local?: boolean; cascade?: boolean }[];
  /** The reply calls that answered 500 (`failReplies`), by request id. */
  failedReplies(): string[];
  /** The sessions OpenCode keeps (its database). */
  sessions(): { id: string; directory: string; title: string | null; permission: unknown; parentID?: string }[];
  /** The sessions a turn was aborted in. */
  aborts(): string[];
  /** Every server and child pid recorded, with whether it is still running. */
  processes(): { pid: number; kind: "server" | "child"; alive: boolean }[];
  /** The child a server started (its stand-in shell command), and whether it still runs. */
  childOf(server: number): { pid: number; alive: boolean } | null;
  /** SIGKILL every fake server and child still running; returns how many. */
  stopAll(): number;
}

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A pid still running this fake (never a reused pid of another program). */
function runningFake(pid: number): boolean {
  const command = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return command.includes(SCRIPT) || command.includes("fake-opencode-child");
}

export function installFakeOpenCode(input: { bin: string; state: string; config?: FakeOpenCodeConfig }): FakeOpenCode {
  const { bin, state } = input;
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "config.json"), JSON.stringify(input.config ?? {}));
  const opencode = join(bin, "opencode");
  const install = () => {
    writeFileSync(opencode, `#!/bin/sh\nFAKE_OPENCODE_STATE=${q(state)} exec ${q(process.execPath)} ${q(SCRIPT)} "$@"\n`);
    chmodSync(opencode, 0o755);
  };
  install();
  const lines = <T>(file: string): T[] =>
    existsSync(join(state, file))
      ? readFileSync(join(state, file), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as T)
      : [];
  const rows = (file: string) => (existsSync(join(state, file)) ? readFileSync(join(state, file), "utf8").split("\n").filter(Boolean).map((line) => line.split(" ").map(Number)) : []);
  const pids = (file: string) => [...new Set(rows(file).map((row) => row[0]!))];
  const readConfig = (): FakeOpenCodeConfig => JSON.parse(readFileSync(join(state, "config.json"), "utf8")) as FakeOpenCodeConfig;
  const processes = () => [
    ...pids("pids.log").map((pid) => ({ pid, kind: "server" as const, alive: runningFake(pid) })),
    ...pids("children.log").map((pid) => ({ pid, kind: "child" as const, alive: runningFake(pid) })),
  ];
  return {
    state,
    configure(patch) {
      writeFileSync(join(state, "config.json"), JSON.stringify({ ...readConfig(), ...patch }));
      // A new version is a new program on disk (the Inbox keeps a --version answer per file), as an update would be.
      if (patch.version !== undefined) {
        rmSync(opencode, { force: true });
        install();
      }
    },
    calls: () => lines<FakeOpenCodeCall>("calls.jsonl"),
    serves: () => lines<FakeOpenCodeCall>("calls.jsonl").filter((c) => c.argv[0] === "serve"),
    prompts: () => lines("prompts.jsonl"),
    replies: () => lines("replies.jsonl"),
    sessions() {
      const dir = join(state, "sessions");
      return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8"))) : [];
    },
    aborts: () => (existsSync(join(state, "aborts.log")) ? readFileSync(join(state, "aborts.log"), "utf8").split("\n").filter(Boolean) : []),
    failedReplies: () => (existsSync(join(state, "replies-failed.log")) ? readFileSync(join(state, "replies-failed.log"), "utf8").split("\n").filter(Boolean) : []),
    processes,
    childOf(server) {
      const pid = rows("children.log").find((row) => row[1] === server)?.[0];
      return pid === undefined ? null : { pid, alive: runningFake(pid) };
    },
    stopAll() {
      let stopped = 0;
      for (const { pid, alive } of processes()) {
        if (!alive) continue;
        try {
          process.kill(pid, "SIGKILL");
          stopped++;
        } catch {
          // Gone between the check and the signal.
        }
      }
      return stopped;
    },
  };
}
