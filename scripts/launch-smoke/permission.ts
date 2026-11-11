/**
 * Launch PR 2, the real-CLI smoke for permission prompts answered in the Inbox.
 * Manual, NEVER in CI: it starts a real Claude Code session. Run by hand:
 *
 *   bun scripts/launch-smoke/permission.ts <scratch dir under .ops/work/launch-pr2-smoke/> <plannotator binary built from this branch>
 *
 * The binary is the permission hook's command (`<binary> inbox permission-hook`
 * in the launch's settings file): this process hosts the Inbox from source,
 * and its own argv is this script.
 *
 * Manual permission mode: the person's own default mode may approve a command
 * by itself (`auto`), so no prompt would show. A `claude` wrapper first on the
 * PATH adds `--permission-mode default` to the `--bg` call alone; every other
 * call passes through unchanged.
 *
 * What it proves, through the real Inbox endpoints as the window uses them:
 *  - The session's first Bash call asks in the launch thread (a `perm:` author),
 *    the run line reads `waiting_answer`, and Claude's own list says the
 *    session waits. Allow once: the command runs.
 *  - The second asks again. Deny with a reason: the command never runs, the
 *    transcript carries the deny message, and the agent goes on and answers.
 *  - The questions never reach the session's own poll; the agent answers once.
 *
 * Isolation: a test Inbox in this process on <scratch>/data with its own
 * config.json, never the person's Inbox or ~/.plannotator; a stand-in login
 * shell with a clean env. Claude's own login lives under the real HOME, so
 * HOME stays real for `claude` (nothing is written to ~/.claude but the
 * session's transcript). Teardown deletes the launch (stop, rm), stops and
 * removes anything still listed in the scratch folder, and deletes the launch
 * folders (they hold keys) and the token file.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const scratch = process.argv[2];
const binary = process.argv[3];
if (!scratch || !scratch.includes("/.ops/work/launch-pr2-smoke/")) throw new Error("Give a scratch dir under .ops/work/launch-pr2-smoke/");
if (!binary || !existsSync(binary)) throw new Error("Give the plannotator binary built from this branch");
mkdirSync(scratch, { recursive: true });
const root = realpathSync(scratch);
const dataDir = join(root, "data");
const work = join(root, "work");
const logDir = join(root, "logs");
const binDir = join(root, "bin");
for (const dir of [dataDir, work, logDir, binDir]) mkdirSync(dir, { recursive: true });
for (const name of readdirSync(work)) rmSync(join(work, name), { recursive: true, force: true });
const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  writeFileSync(join(logDir, "permission.log"), `${stamped}\n`, { flag: "a" });
};

process.env.PLANNOTATOR_DATA_DIR = dataDir;
process.env.PLANNOTATOR_UPDATE_CHECK = "0";
process.env.PLANNOTATOR_INBOX_CONNECT = "0";
const { NO_BROWSER } = await import("../../tests/helpers/no-browser");
process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
const { isRealDataDir } = await import("../../tests/helpers/real-data-dir");
if (isRealDataDir(dataDir)) throw new Error(`refusing the real data dir ${dataDir}`);
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, fullPermissions: false, model: "haiku" } }, null, 2));

const realClaude = Bun.which("claude");
if (!realClaude) throw new Error("claude is not on PATH");
// The wrapper: `--bg` in manual permission mode, every other call as it is.
const wrapper = join(binDir, "claude");
writeFileSync(
  wrapper,
  `#!/bin/sh\nif [ "$1" = "--bg" ]; then exec "${realClaude}" "$@" --permission-mode default; fi\nexec "${realClaude}" "$@"\n`,
);
chmodSync(wrapper, 0o755);
const cleanPath = `${binDir}:${dirname(realClaude)}:/usr/bin:/bin:/usr/sbin:/sbin`;
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
// The stand-in login shell: a clean env, the wrapper first on PATH.
const shell = join(root, "login-shell.sh");
writeFileSync(shell, `#!/bin/sh\nexec /usr/bin/env -i HOME="${homedir()}" USER="$USER" SHELL="${shell}" PATH="${cleanPath}" LANG=en_US.UTF-8 /bin/sh -c "$2"\n`);
chmodSync(shell, 0o755);
process.env.SHELL = shell;
delete process.env.PLANNOTATOR_TEST_SANDBOX;

const { startInboxServer } = await import("../../packages/server/inbox");
const { createAgentEnvironmentFor } = await import("../../packages/server/inbox-agents");
const { createClaudeHost } = await import("../../packages/server/inbox-launch-claude");
const { launchPlainEnv } = await import("../../packages/server/inbox-launch-env");

const server = await startInboxServer({ dataDir, version: "dev", selfCommand: [realpathSync(binary)] });
if (server.port === 59812) throw new Error("refusing the person's Inbox port");
const base = `http://127.0.0.1:${server.port}`;
writeFileSync(join(root, "pids.txt"), `permission smoke: inbox (this process) ${process.pid} port ${server.port}\n`, { flag: "a" });
log(`test Inbox on ${server.port}, data ${dataDir}`);

const host = createClaudeHost({ environment: async () => createAgentEnvironmentFor({ platform: platform(), homeDir: homedir(), env: launchPlainEnv(process.env, [binDir]) }) });

const api = async (path: string, body?: Record<string, unknown>) => {
  const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ serverSession, ...body }) };
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, json: (await res.json()) as any };
};
let serverSession: string | undefined;
serverSession = (await api("/api/inbox/sessions")).json.serverSession as string;

const until = async <T>(what: string, ms: number, probe: () => Promise<T | null | undefined | false>): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await Bun.sleep(500);
  }
  throw new Error(`timed out: ${what}`);
};
const readThread = async (threadId: string) => (await api(`/api/inbox/threads/${threadId}`)).json as { thread: { messages: any[] }; run?: any };
const permQuestions = async (threadId: string) => (await readThread(threadId)).thread.messages.filter((m) => m.author.kind === "agent" && String(m.author.session ?? "").startsWith("perm:") && m.questions?.length);
const transcriptOf = (session: string): string => {
  const projects = join(homedir(), ".claude", "projects");
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${session}.jsonl`);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return "";
};
/** The person's answer, as the window sends it: one reply that picks and sends. */
const answer = async (message: any, pick: { selected: string[]; other?: string }, key: string) => {
  const q = message.questions[0];
  return api(`/api/inbox/messages/${message.id}/reply`, {
    idempotency_key: key,
    words: "",
    questions: [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: pick.selected, ...(pick.other ? { other: pick.other } : {}) } }],
  });
};

const results: Record<string, unknown> = {};
let launchId: string | null = null;
try {
  const seeded = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "Smoke project.", project_path: work, agent_session: "smoke-seed", agent_host: "claude-code" } } }),
  });
  if (seeded.status !== 200) throw new Error(`seeding the project failed: ${seeded.status}`);
  const project = (await api("/api/inbox/sessions")).json.launch?.projects?.find((p: any) => p.root === work);
  if (!project) throw new Error("the scratch folder is not offered");

  const words =
    "Permission smoke. Use the Bash tool twice, one call each, in this order: `touch allowed.txt`, then `touch denied.txt`. " +
    "If a call is denied, do not retry it and do not try another way; go on. Then run `ls` and send me its exact output through the Plannotator Inbox (reply_to this message). Nothing else.";
  const sent = await api("/api/inbox/messages", { idempotency_key: "smoke-perm-1", body: words, thread_name: "Permission smoke", to: { launch: { agent: "claude-code", project_id: project.id } } });
  if (sent.status !== 200) throw new Error(`launch failed ${sent.status} ${JSON.stringify(sent.json)}`);
  const threadId = sent.json.thread_id as string;
  launchId = sent.json.launch.id as string;
  const settings = JSON.parse(readFileSync(await until("the settings file", 30_000, async () => {
    const file = join(dataDir, "inbox", "launch", launchId!, "settings.json");
    return existsSync(file) && file;
  }), "utf8"));
  results.settings_hook = settings.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.command?.replace(realpathSync(binary), "<binary>");
  results.settings_hook_timeout_s = settings.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.timeout;

  // ── 1: Allow once ──
  const started = Date.now();
  const first = await until("the first permission question", 240_000, async () => (await permQuestions(threadId))[0]);
  results.q1_after_s = Math.round((Date.now() - started) / 1000);
  results.q1_author = { host: first.author.host, session_prefix: String(first.author.session).slice(0, 5), name: first.author.name };
  results.q1_prompt = first.questions[0].prompt;
  results.q1_choices = first.questions[0].choices.map((c: any) => c.label);
  results.q1_body = first.body;
  results.q1_run = (await until("waiting_answer", 15_000, async () => {
    const run = (await readThread(threadId)).run;
    return run?.state === "waiting_answer" && run;
  })).state;
  const session = String(first.author.session).slice("perm:".length);
  const listed = (await host.agents(work)) ?? [];
  results.q1_host = listed.map((a) => ({ state: a.state, status: a.status, waitingFor: a.waitingFor }));
  results.allowed_before_answer = existsSync(join(work, "allowed.txt"));
  log(`question 1 after ${results.q1_after_s}s: ${results.q1_prompt}; host ${JSON.stringify(results.q1_host)}`);
  // Wait past the host's settle time and two host reads (the thread reads below ask for them): a live question
  // must not read as answered in Terminal while Claude Code waits on the hook.
  const holdEnd = Date.now() + 25_000;
  const hostSeen = new Set<string>();
  while (Date.now() < holdEnd) {
    await readThread(threadId);
    for (const a of (await host.agents(work)) ?? []) hostSeen.add(`${a.state}/${a.status}/${a.waitingFor}`);
    await Bun.sleep(2000);
  }
  results.q1_host_during_25s = [...hostSeen];
  results.q1_state_after_25s = (await permQuestions(threadId)).find((m) => m.id === first.id)?.questions[0].state;
  results.q1_run_after_25s = (await readThread(threadId)).run?.state ?? null;
  const a1 = await answer(first, { selected: ["Allow once"] }, "smoke-perm-answer-1");
  results.a1_status = a1.status;
  const allowedAt = Date.now();
  await until("allowed.txt", 60_000, async () => existsSync(join(work, "allowed.txt")));
  results.allowed_after_answer_ms = Date.now() - allowedAt;
  log(`allowed.txt made ${results.allowed_after_answer_ms} ms after Allow once`);

  // ── 2: Deny with a reason ──
  const second = await until("the second permission question", 120_000, async () => (await permQuestions(threadId)).find((m) => m.id !== first.id));
  results.q2_prompt = second.questions[0].prompt;
  results.q2_body = second.body;
  const reason = "Only the first file is needed for this test.";
  const a2 = await answer(second, { selected: [], other: reason }, "smoke-perm-answer-2");
  results.a2_status = a2.status;
  // Any later prompt (the `ls`, when the person's setup does not allow it already) is allowed once and counted.
  const extra: string[] = [];
  const reply = await until("the agent's answer", 180_000, async () => {
    for (const m of await permQuestions(threadId)) {
      if (m.id === first.id || m.id === second.id || extra.includes(m.id) || m.questions[0].state !== "open") continue;
      extra.push(m.id);
      await answer(m, { selected: ["Allow once"] }, `smoke-perm-answer-extra-${extra.length}`);
    }
    return (await readThread(threadId)).thread.messages.find((m) => m.author.kind === "agent" && !String(m.author.session ?? "").startsWith("perm:"));
  });
  results.extra_prompts_allowed = extra.length;
  results.agent_reply = reply.body;
  results.denied_exists = existsSync(join(work, "denied.txt"));
  results.allowed_exists = existsSync(join(work, "allowed.txt"));
  await until("the run line at rest", 60_000, async () => (await readThread(threadId)).run === null);
  const read = await readThread(threadId);
  results.agent_messages = read.thread.messages.filter((m) => m.author.kind === "agent" && !String(m.author.session ?? "").startsWith("perm:")).length;
  results.question_states = read.thread.messages.filter((m) => m.questions?.length).map((m) => m.questions[0].state);
  const transcript = transcriptOf(session);
  results.transcript_modes = [...new Set([...transcript.matchAll(/"permissionMode":"([^"]+)"/g)].map((m) => m[1]!))];
  results.transcript_deny_message = transcript.includes("The person denied this in the Plannotator Inbox");
  results.transcript_deny_reason = transcript.includes(reason);
  log(`answered: ${JSON.stringify(reply.body)}; denied.txt ${results.denied_exists}; modes ${results.transcript_modes}`);
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error);
  log(`ERROR ${results.error}`);
} finally {
  if (launchId) {
    const deleted = await api(`/api/inbox/launch/${launchId}/delete`, {});
    results.delete_status = deleted.status;
  }
  for (const agent of (await host.agents(work)) ?? []) {
    const s = await host.stop(agent.id);
    const r = await host.rm(agent.id);
    log(`teardown ${agent.id}: stop ${s.exitCode} / rm ${r.exitCode}`);
  }
  results.left_after_teardown = (await host.agents(work))?.map((x) => x.id) ?? "unreadable";
  results.hooks_left = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes("permission-hook") && line.includes(realpathSync(binary))).length;
  await server.stop();
  rmSync(join(dataDir, "inbox", "inbox.json"), { force: true });
  rmSync(join(dataDir, "inbox", "launch"), { recursive: true, force: true });
  writeFileSync(join(root, "permission-results.json"), JSON.stringify(results, null, 2));
  log(`done; results in ${join(root, "permission-results.json")}`);
  process.exit(0);
}
