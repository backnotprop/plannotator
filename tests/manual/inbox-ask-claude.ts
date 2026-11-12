#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseInboxRegistry } from "../../packages/shared/inbox/connection";
import { aiSession, fromWindow, postAsk, readAsk, runQuery, type AskAnswer } from "../helpers/inbox-ask-window";
import { refuseRealDataDir } from "../helpers/real-data-dir";

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
