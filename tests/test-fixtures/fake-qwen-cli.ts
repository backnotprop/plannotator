import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeQwen {
  bin: string;
  log: string;
  setMode(mode: "answer" | "wall-time" | "silent" | "no-session" | "hang" | "linger" | "resume-fails" | "resume-startup-fails"): void;
  script: string;
}

export interface FakeQwenRun {
  args: string[];
  stdin: string;
  cwd: string;
  qwenHome: string | null;
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
