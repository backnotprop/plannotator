#!/usr/bin/env bun
/**
 * Ask AI against a REAL Claude Code session, with this script as the Inbox
 * window. The first real agent test of Ask AI (step 3 of the build plan). It
 * needs an interactive Claude Code 2.1.287+ session: `claude -p` runs no mod,
 * so nothing would ever answer. It logs how long a first question took, and
 * exits 1 when `--expect` is not what happened.
 *
 * One sandbox, from the repo root, for every run below:
 *
 *   export SBX=$(mktemp -d /tmp/plannotator-ask-real.XXXXXX)
 *   export PLANNOTATOR_DATA_DIR=$SBX/data
 *   export PLANNOTATOR_INBOX_ASK_AI=1
 *   export PLANNOTATOR_BROWSER=/usr/bin/true
 *   export PLANNOTATOR_INBOX_CONNECT=0
 *   export PLANNOTATOR_UPDATE_CHECK=0
 *   bun run --cwd apps/review build && bun run build:hook && bun run build:opencode
 *   mkdir -p "$SBX/bin" "$SBX/project"
 *   bun build apps/hook/server/index.ts --compile --no-compile-autoload-bunfig \
 *     --define '__CLI_VERSION__="0.0.0-dev"' --outfile "$SBX/bin/plannotator"
 *   export PATH="$SBX/bin:$PATH"
 *   plannotator inbox --background
 *
 * Then, from "$SBX/project", with those variables set, in a terminal you can
 * type into (the session's own PLANNOTATOR_DATA_DIR is what ties it to this
 * Inbox; a marketplace copy of the plugin in the same session would also poll):
 *
 *   claude --plugin-dir <repo>/apps/hook
 *   > Send one short message to the Plannotator Inbox saying hello.
 *
 * Each case runs from the repo root, with the same variables set. The sandbox's
 * one thread is found by itself; with more, pass `--thread <id>`.
 *
 *   first question, session idle
 *     bun tests/manual/inbox-ask-claude.ts --expect answered
 *     Claude Code answers in the session as a plugin turn, in plain text, and
 *     does not call the Inbox tool. `first_question_ms` is the delay to report.
 *
 *   busy: first tell Claude "Run sleep 60 in the shell", and while that runs:
 *     bun tests/manual/inbox-ask-claude.ts --expect agent_busy
 *     bun tests/manual/inbox-ask-claude.ts --retry-busy --expect answered
 *     Nothing enters the running turn. The second run asks once a second, and
 *     should go in within a second or two of the turn ending.
 *
 *   take-over: ask something long, and type into the session while it answers:
 *     bun tests/manual/inbox-ask-claude.ts --question "Explain this project's README line by line." --expect taken_over
 *     The words so far are saved. Your message runs. Nothing is sent twice.
 *
 *   gone: the same question, and quit Claude Code (/exit) while it answers:
 *     bun tests/manual/inbox-ask-claude.ts --question "Explain this project's README line by line." --expect gone
 *     Ends in a few seconds with the words so far, or at about 30 s if the
 *     process stopped hard. Start the session again with `claude --continue`.
 *
 *   two processes: `claude --continue` in a second terminal (same variables),
 *   and type one short message there so the lease moves to it. Wait 25 s: the
 *   first process reads the lease every 5 s, and a client left from an earlier
 *   case can sit in a poll for 15 s more. Then:
 *     bun tests/manual/inbox-ask-claude.ts --expect answered
 *     The question runs in the second terminal. Asked sooner, it can run in the
 *     first terminal (the first 5 s), or end `gone` with nothing submitted, and
 *     a retry reaches the second.
 *     Then ask a long question, and while the terminal answering it runs, type
 *     into the other one: the answer still ends and is saved.
 *
 *   off: stop the Inbox, unset PLANNOTATOR_INBOX_ASK_AI, start it again:
 *     plannotator inbox stop
 *     unset PLANNOTATOR_INBOX_ASK_AI
 *     plannotator inbox --background
 *     bun tests/manual/inbox-ask-claude.ts --expect off
 *     Claude Code does nothing at all. To check, start it with
 *     PLANNOTATOR_MOD_DEBUG=1 set: "$PLANNOTATOR_DATA_DIR/claude-code-mod/debug.log"
 *     has no line that says "Ask AI client" or "bridge http".
 *
 * Afterwards: `plannotator inbox stop`, quit Claude Code, `rm -rf "$SBX"`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseInboxRegistry } from "../../packages/shared/inbox/connection";
import { aiSession, fromWindow, postAsk, readAsk, runQuery, type AskAnswer } from "../helpers/inbox-ask-window";
import { refuseRealDataDir } from "../helpers/real-data-dir";

/** The owner's own Inbox and trials: never asked, whatever the registry says. */
const OFF_LIMITS_PORTS: readonly number[] = [59812, 59830, 8787];

const { values } = parseArgs({
  options: {
    thread: { type: "string" },
    question: { type: "string", default: "In one sentence, what is this session working on?" },
    expect: { type: "string" },
    "retry-busy": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function target() {
  const dataDir = refuseRealDataDir(process.env.PLANNOTATOR_DATA_DIR, "tests/manual/inbox-ask-claude.ts");
  const path = join(dataDir, "inbox", "inbox.json");
  const registry = existsSync(path) ? parseInboxRegistry(readFileSync(path, "utf8")) : null;
  if (!registry) fail(`No Inbox registry at ${path}. Start the sandbox's Inbox first.`);
  if (OFF_LIMITS_PORTS.includes(registry.port)) fail(`Port ${registry.port} is not the sandbox's Inbox.`);
  return registry;
}

/** The thread ids anywhere in the list the window reads. */
function threadIds(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) threadIds(item, found);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.thread_id === "string") found.add(record.thread_id);
    for (const item of Object.values(record)) threadIds(item, found);
  }
  return found;
}

async function theThread(inbox: ReturnType<typeof target>): Promise<string> {
  if (values.thread) return values.thread;
  const ids = [...threadIds(await (await fromWindow(inbox, "/api/inbox/threads")).json())];
  if (ids.length === 1) return ids[0]!;
  fail(ids.length === 0 ? "No thread yet: have the session send a message to the Inbox." : `Several threads, pass --thread with one of: ${ids.join(" ")}`);
}

const inbox = target();
const threadId = await theThread(inbox);
const question = values.question!;
const turnId = `real-${Date.now()}`;
const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);

let outcome = "no_answer";
let firstQuestionMs: number | null = null;
let firstWordMs: number | null = null;
while (true) {
  const posted = await postAsk(inbox, threadId, turnId, question);
  console.log(`POST /ask ${posted.status} at ${elapsed()} ms`);
  if (posted.status === 404) {
    outcome = "off";
    break;
  }
  const body = (await posted.json()) as AskAnswer & { code?: string };
  if (posted.status !== 200 || !body.provider_id) {
    outcome = body.code ?? body.reason ?? `http_${posted.status}`;
    break;
  }
  // What a person waits through: the agent told, connected, and its first status in.
  firstQuestionMs ??= elapsed();
  const query = runQuery(inbox, await aiSession(inbox, body.provider_id, threadId, "Real Claude Code"), question);
  const words = setInterval(() => {
    if (firstWordMs === null && query.messages.some((message) => message.delta)) firstWordMs = elapsed();
  }, 20);
  await query.finished;
  clearInterval(words);
  const codes = query.messages.flatMap((message) => (message.code ? [message.code] : []));
  console.log(`query ended at ${elapsed()} ms, codes ${JSON.stringify(codes)}`);
  if (codes.includes("agent_busy")) {
    if (values["retry-busy"]) {
      await Bun.sleep(1_000);
      continue;
    }
    outcome = "agent_busy";
    break;
  }
  const turn = (await readAsk(inbox, threadId)).conversation?.turns.find((candidate) => candidate.id === turnId);
  outcome = turn?.failure ?? (turn?.stopped ? "stopped" : turn?.answer ? "answered" : "no_answer");
  console.log(`saved ${JSON.stringify({ answer: turn?.answer?.slice(0, 200), failure: turn?.failure, stopped: turn?.stopped })}`);
  break;
}

console.log(JSON.stringify({ outcome, first_question_ms: firstQuestionMs, first_word_ms: firstWordMs, total_ms: elapsed() }));
if (values.expect && values.expect !== outcome) {
  console.error(`Expected ${values.expect}, got ${outcome}.`);
  process.exit(1);
}
