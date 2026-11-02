/**
 * Launch PR 1, the real-CLI smoke (PLAN section 3, "Smoke (real `claude`)").
 * Manual, NEVER in CI: it starts real Claude Code sessions. Run by hand:
 *
 *   bun scripts/launch-smoke/claude.ts <scratch dir under .ops/work/launch-pr1-smoke/>
 *
 * Everything goes through the real Inbox endpoints, as the window does:
 *  A (full permissions): Send with `to.launch` starts Claude Code with no
 *    prompt; the real mod connects and takes the first turn; a `CLAUDE_*`
 *    value from the login shell reaches the worker through the settings
 *    file; the run line moves Starting → Working → rests, never blinking out
 *    before the turn. Stop → "stopped"; a reply respawns it ("Starting
 *    again") and is answered once, the value still there, the transcript
 *    still in bypass mode. Delete stops, removes and drops the launch folder.
 *  The supervisor: the `claude daemon run` our calls reach is in its own
 *    process group, never the Inbox's (a time-out kills only our call anyway).
 *  The login shell ran once: for the start, never for the stop or respawn.
 *
 * Not covered here, on purpose: a real permission prompt. This smoke runs
 * none, so the `waiting_terminal` line has no real-CLI check in PR 1 (the
 * person's own default mode decides, and the settings file carries no
 * permission rules; the e2e and the run-line unit tests cover the line
 * against the recorded bg-perm-test contract; PR 2's smoke runs one). Nor an
 * untrusted folder
 * (the scratch folder sits in a trusted tree; the fake replays the recorded
 * error text) and Open in Terminal (it would open a window on the person's
 * screen; the e2e checks the osascript argument).
 *
 * Isolation: a test Inbox in this process on <scratch>/data with its own
 * config.json (`inboxLaunch.enabled`, `inboxLaunch.model: "haiku"`), never
 * the person's Inbox or ~/.plannotator; a stand-in login shell with a clean
 * env, so the person's rc files never decide the result; nothing written to
 * ~/.claude. Teardown stops and removes every session in the scratch folder,
 * deletes the launch folders (they hold keys) and the token file.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const scratch = process.argv[2];
if (!scratch || !scratch.includes("/.ops/work/launch-pr1-smoke/")) throw new Error("Give a scratch dir under .ops/work/launch-pr1-smoke/");
mkdirSync(scratch, { recursive: true });
const root = realpathSync(scratch);
const dataDir = join(root, "data");
const work = join(root, "work");
const logDir = join(root, "logs");
for (const dir of [dataDir, work, logDir]) mkdirSync(dir, { recursive: true });
const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  writeFileSync(join(logDir, "claude.log"), `${stamped}\n`, { flag: "a" });
};

process.env.PLANNOTATOR_DATA_DIR = dataDir;
process.env.PLANNOTATOR_UPDATE_CHECK = "0";
process.env.PLANNOTATOR_INBOX_CONNECT = "0";
const { NO_BROWSER } = await import("../../tests/helpers/no-browser");
process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
const { isRealDataDir } = await import("../../tests/helpers/real-data-dir");
if (isRealDataDir(dataDir)) throw new Error(`refusing the real data dir ${dataDir}`);
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, fullPermissions: true, model: "haiku" } }, null, 2));

// The stand-in login shell: the Inbox reads `$SHELL -ilc`; this one prints a clean env with one CLAUDE_* marker.
const claudeBin = Bun.which("claude");
if (!claudeBin) throw new Error("claude is not on PATH");
const marker = `smoke-${Math.random().toString(36).slice(2, 10)}`;
const shell = join(root, "login-shell.sh");
writeFileSync(
  shell,
  `#!/bin/sh\nexec /usr/bin/env -i HOME="${homedir()}" USER="$USER" SHELL="${shell}" PATH="${dirname(claudeBin)}:/usr/bin:/bin:/usr/sbin:/sbin" LANG=en_US.UTF-8 CLAUDE_LAUNCH_SMOKE="${marker}" /bin/sh -c "$2"\n`,
);
chmodSync(shell, 0o755);
process.env.SHELL = shell;
delete process.env.PLANNOTATOR_TEST_SANDBOX;

const { startInboxServer } = await import("../../packages/server/inbox");
const { createAgentEnvironmentFor } = await import("../../packages/server/inbox-agents");
const { createClaudeHost } = await import("../../packages/server/inbox-launch-claude");
const { launchPlainEnv } = await import("../../packages/server/inbox-launch-env");

const server = await startInboxServer({ dataDir, version: "dev" });
if (server.port === 59812) throw new Error("refusing the person's Inbox port");
const base = `http://127.0.0.1:${server.port}`;
writeFileSync(join(root, "pids.txt"), `claude smoke: inbox (this process) ${process.pid} port ${server.port}\n`, { flag: "a" });
log(`test Inbox on ${server.port}, data ${dataDir}, marker ${marker}`);

// Teardown's own view of the supervisor: the plain env the Inbox uses for every call but a start.
const host = createClaudeHost({ environment: async () => createAgentEnvironmentFor({ platform: platform(), homeDir: homedir(), env: launchPlainEnv(process.env, [dirname(claudeBin)]) }) });
// The Inbox logs each login-shell read; count them.
let loginReads = 0;
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  if (String(chunk).includes("Inbox launch: login env read") || String(chunk).includes("could not read the login shell")) loginReads++;
  return (stderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stderr.write;
/** Every `claude daemon run` (the shared supervisor): pid, its group and session leader. */
const supervisors = () =>
  spawnSync("/bin/ps", ["-axo", "pid=,pgid=,ppid=,command="], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((line) => /claude daemon run/.test(line))
    .map((line) => {
      const [pid, pgid, ppid] = line.trim().split(/\s+/).map(Number);
      return { pid, pgid, ppid, ownGroup: pid === pgid };
    });
const inboxGroup = Number(spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim());

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
    await Bun.sleep(1000);
  }
  throw new Error(`timed out: ${what}`);
};
const readThread = async (threadId: string) => (await api(`/api/inbox/threads/${threadId}`)).json as { thread: { messages: any[] }; row: any; run?: any };
const agentReplies = async (threadId: string) => (await readThread(threadId)).thread.messages.filter((m) => m.author.kind === "agent");
/** Every run-line state seen while `probe` waits, in order, without repeats. */
const watchRun = (threadId: string, seen: string[]) => async () => {
  const read = await readThread(threadId);
  const state = read.run === undefined ? "absent" : read.run === null ? "rest" : `${read.run.state}${read.run.again ? "(again)" : ""}`;
  if (seen.at(-1) !== state) seen.push(state);
  return read;
};
const transcriptModes = (session: string): string[] => {
  const projects = join(homedir(), ".claude", "projects");
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${session}.jsonl`);
    if (existsSync(file)) return [...new Set([...readFileSync(file, "utf8").matchAll(/"permissionMode":"([^"]+)"/g)].map((m) => m[1]!))];
  }
  return [];
};
const launchDirOf = (id: string) => join(dataDir, "inbox", "launch", id);

const results: Record<string, unknown> = { marker };
try {
  // The scratch folder as an Inbox project (an agent wrote from it once), so the folder menu lists it.
  const seeded = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "Smoke project.", project_path: work, agent_session: "smoke-seed", agent_host: "claude-code" } } }),
  });
  if (seeded.status !== 200) throw new Error(`seeding the project failed: ${seeded.status}`);
  const block = (await api("/api/inbox/sessions")).json.launch;
  results.compose_block = { agents: block?.agents, project_listed: Boolean(block?.projects?.some((p: any) => p.root === work)) };
  const project = block?.projects?.find((p: any) => p.root === work);
  if (!block?.agents?.length || !project) throw new Error(`no start row: ${JSON.stringify(block)}`);
  log(`compose offers ${JSON.stringify(block.agents)}`);

  const ask = (n: number) =>
    `Smoke ${n}: run the shell command \`printenv CLAUDE_LAUNCH_SMOKE; printenv PLANNOTATOR_LAUNCH\` and send me its exact output through the Plannotator Inbox (reply_to this message). Nothing else.`;

  // ── A: full permissions ──
  const sentA = await api("/api/inbox/messages", { idempotency_key: "smoke-launch-a", body: ask(1), thread_name: "Smoke A", to: { launch: { agent: "claude-code", project_id: project.id } } });
  if (sentA.status !== 200) throw new Error(`launch A failed ${sentA.status} ${JSON.stringify(sentA.json)}`);
  const threadA = sentA.json.thread_id as string;
  const launchA = sentA.json.launch.id as string;
  const settingsA = join(launchDirOf(launchA), "settings.json");
  await until("A's settings file", 30_000, async () => existsSync(settingsA));
  const fileA = JSON.parse(readFileSync(settingsA, "utf8"));
  results.A_settings = { mode: (statSync(settingsA).mode & 0o777).toString(8), model: fileA.model, env_names: Object.keys(fileA.env ?? {}).sort(), allow: fileA.permissions?.allow };
  const seenA: string[] = [];
  const firstStart = Date.now();
  const first = await until("A's first answer", 240_000, async () => (await watchRun(threadA, seenA)()).thread.messages.filter((m) => m.author.kind === "agent").at(-1));
  results.A_first_answer_s = Math.round((Date.now() - firstStart) / 1000);
  results.A_first_reply = first.body;
  results.A_first_marker = String(first.body).includes(marker);
  results.A_first_launch_id = String(first.body).includes(launchA);
  const sessionA = first.author.session as string;
  results.supervisors = supervisors().map((sup) => ({ ...sup, sharesInboxGroup: sup.pgid === inboxGroup }));
  log(`supervisors ${JSON.stringify(results.supervisors)} (Inbox group ${inboxGroup})`);
  await until("A resting (no line)", 60_000, async () => (await watchRun(threadA, seenA)()).run === null);
  results.A_lines_first_turn = [...seenA];
  log(`A answered in ${results.A_first_answer_s}s: marker ${results.A_first_marker}, lines ${seenA.join(" → ")}`);

  const stopped = await api(`/api/inbox/launch/${launchA}/stop`, {});
  results.A_stop = { status: stopped.status, run: stopped.json.run?.state ?? stopped.json.run };
  const seenStop: string[] = [];
  await until("A stopped", 60_000, async () => (await watchRun(threadA, seenStop)()).run?.state === "stopped");
  results.A_lines_after_stop = seenStop;

  const seenAgain: string[] = [];
  const reply = await api(`/api/inbox/messages/${first.id}/reply`, { idempotency_key: "smoke-launch-a-2", words: ask(2) });
  if (reply.status !== 200) throw new Error(`reply failed ${reply.status} ${JSON.stringify(reply.json)}`);
  const second = await until("A's answer after the reply respawned it", 240_000, async () => {
    const read = await watchRun(threadA, seenAgain)();
    const replies = read.thread.messages.filter((m) => m.author.kind === "agent");
    return replies.length >= 2 ? replies.at(-1) : null;
  });
  await until("A resting again", 60_000, async () => (await watchRun(threadA, seenAgain)()).run === null);
  results.A_lines_after_reply = seenAgain;
  results.A_second_reply = second.body;
  results.A_second_marker = String(second.body).includes(marker);
  results.A_agent_messages = (await agentReplies(threadA)).length;
  results.A_transcript_modes = transcriptModes(sessionA);
  log(`A after reply: lines ${seenAgain.join(" → ")}, marker ${results.A_second_marker}, modes ${results.A_transcript_modes}`);

  // ── Delete ──
  const deleted = await api(`/api/inbox/launch/${launchA}/delete`, {});
  results.A_delete = { status: deleted.status, launch_dir_left: existsSync(launchDirOf(launchA)) };
  results.login_shell_reads = loginReads;
  const left = await host.agents(work);
  results.listed_after_delete = left?.map((x) => ({ id: x.id, state: x.state })) ?? "unreadable";
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error);
  log(`ERROR ${results.error}`);
} finally {
  // Whatever is still listed in the scratch folder is ours: stop and remove it.
  for (const agent of (await host.agents(work)) ?? []) {
    const s = await host.stop(agent.id);
    const r = await host.rm(agent.id);
    log(`teardown ${agent.id}: stop ${s.exitCode} / rm ${r.exitCode}`);
  }
  results.left_after_teardown = (await host.agents(work))?.map((x) => x.id) ?? "unreadable";
  await server.stop();
  rmSync(join(dataDir, "inbox", "inbox.json"), { force: true });
  rmSync(join(dataDir, "inbox", "launch"), { recursive: true, force: true });
  writeFileSync(join(root, "claude-results.json"), JSON.stringify(results, null, 2));
  log(`done; results in ${join(root, "claude-results.json")}`);
  process.exit(0);
}
