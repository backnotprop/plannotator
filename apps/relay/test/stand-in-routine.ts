import { appendFileSync, readFileSync } from "node:fs";

const [payloadFile, transcript] = process.argv.slice(2) as [string, string];
const payload = JSON.parse(readFileSync(payloadFile, "utf8")) as { thread: { id: string }; messages: { id: string; body: string }[] };

const call = (action: string, args?: Record<string, unknown>) => {
  const run = Bun.spawnSync(["plannotator", "inbox", "call", action, ...(args ? [JSON.stringify(args)] : [])], { env: process.env });
  appendFileSync(transcript, `${JSON.stringify({ action, code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() })}\n`);
  return run;
};

call("whoami");
const read = call("read_thread", { thread_id: payload.thread.id });
const latest = payload.messages[payload.messages.length - 1]!;
const saw = read.stdout.toString().includes(latest.body) ? "I read your reply in the thread" : "I could not read the thread";
call("send_message", { reply_to: latest.id, body: `${saw}. Fixed: the retry worker now waits for the test clock. All 14 retry tests pass.` });
