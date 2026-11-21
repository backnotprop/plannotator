/**
 * A fake `qwen` CLI for Ask AI tests that put `dir` on PATH (or pass the
 * script path as the executable). It never runs Qwen Code.
 *
 * Every run appends one JSON line to `log`: its argv, the prompt it read from
 * stdin, its cwd, $QWEN_HOME, Plannotator's switches, its pid and when it started (`at`, ms). What it does next comes from the
 * file `mode` in `dir` (read at each run, so a test can change it between
 * questions):
 *
 * - `answer` (default): an init line, two text deltas, the assistant line and
 *   a result line, the stream-json shape `qwen -o stream-json
 *   --include-partial-messages` writes. The answer is "pong".
 * - `wall-time`: a line on stderr, then exit 55 (qwen's `--max-wall-time`).
 * - `silent`: exit 1 with no output.
 * - `no-session`: every run prints "No saved session found" on stderr and
 *   exits 1, whatever its flags.
 * - `hang`: the init line, then waits (for abort tests).
 * - `linger`: the answer, then stays running for 30 s (a qwen that has not
 *   exited after its result line).
 * - `resume-fails`: a `--resume` run prints "No saved session found" on
 *   stderr and exits 1 (Qwen with chat recording off); any other run answers.
 * - `resume-startup-fails`: a `--resume` run prints a sign-in error on stderr
 *   and exits 1 (any startup failure other than a missing session).
 *
 * The script runs under the current Bun (process.execPath), so the test PATH
 * does not need node.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeQwen {
  /** The `qwen` launcher to put on PATH or pass as the executable path. */
  bin: string;
  /** One JSON line per run: `{ args, stdin, cwd, qwenHome, switches, pid, at }`. */
  log: string;
  /** Write the mode the next run uses. */
  setMode(mode: "answer" | "wall-time" | "silent" | "no-session" | "hang" | "linger" | "resume-fails" | "resume-startup-fails"): void;
  /** The fake's script path; its runs carry it in their command line. */
  script: string;
}

export interface FakeQwenRun {
  args: string[];
  stdin: string;
  cwd: string;
  qwenHome: string | null;
  /** Plannotator's integration switches in the run's env (ask-ai-env.ts). */
  switches: Record<string, string | null>;
  pid: number;
  at: number;
}

export function fakeQwenCli(dir: string): FakeQwen {
  const log = join(dir, "qwen-runs.jsonl");
  const modeFile = join(dir, "qwen-mode");
  const script = join(dir, "fake-qwen.mjs");
  writeFileSync(
    script,
    `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({
    args,
    stdin: Buffer.concat(chunks).toString("utf8"),
    cwd: process.cwd(),
    qwenHome: process.env.QWEN_HOME ?? null,
    switches: {
      PLANNOTATOR_ASK_AI_CHILD: process.env.PLANNOTATOR_ASK_AI_CHILD ?? null,
      PLANNOTATOR_INBOX_TOOL: process.env.PLANNOTATOR_INBOX_TOOL ?? null,
      PLANNOTATOR_AGENT_TOOL: process.env.PLANNOTATOR_AGENT_TOOL ?? null,
    },
    pid: process.pid,
    at: Date.now(),
  }) + "\\n");
  const mode = existsSync(${JSON.stringify(modeFile)}) ? readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() : "answer";
  const out = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
  const at = args.indexOf("--session-id") >= 0 ? args.indexOf("--session-id") : args.indexOf("--resume");
  const session_id = args[at + 1];
  if (mode === "silent") process.exit(1);
  if (mode === "no-session") {
    process.stderr.write("No saved session found with ID " + session_id + ".\\n");
    process.exit(1);
  }
  if (mode === "resume-fails" && args.includes("--resume")) {
    process.stderr.write("No saved session found with ID " + session_id + ".\\n");
    process.exit(1);
  }
  if (mode === "resume-startup-fails" && args.includes("--resume")) {
    process.stderr.write("Error: authentication failed, sign in again with qwen auth.\\n");
    process.exit(1);
  }
  if (mode === "wall-time") {
    process.stderr.write("Run exceeded --max-wall-time\\n");
    process.exit(55);
  }
  out({ type: "system", subtype: "init", session_id, model: "qwen-fake", qwen_code_version: "0.99.0" });
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: "stream_event", session_id, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "po" } } });
  out({ type: "stream_event", session_id, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ng" } } });
  out({ type: "assistant", session_id, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "pong" }] } });
  out({ type: "result", subtype: "success", session_id, is_error: false, result: "pong", num_turns: 1 });
  if (mode === "linger") setTimeout(() => process.exit(0), 30000);
});
`,
  );
  const bin = join(dir, "qwen");
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(bin, 0o755);
  return {
    bin,
    log,
    script,
    setMode: (mode) => writeFileSync(modeFile, mode),
  };
}

/** The runs the fake has logged so far. */
export function fakeQwenRuns(log: string): FakeQwenRun[] {
  let text = "";
  try {
    text = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeQwenRun);
}
