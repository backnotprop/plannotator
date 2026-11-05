/**
 * Launch PR 1, day-one proofs against the REAL `claude` (PLAN section 6).
 * Manual, never in CI. Run by hand:
 *
 *   bun scripts/launch-smoke/day1.ts <scratch dir under .ops/work/launch-pr1-smoke/>
 *
 * Risk 1: our env and permissions reach a `--bg` worker through the settings
 * FILE: a `CLAUDE_*` value from the (stand-in) login shell is present, full
 * permissions give a bypass session with no dialog blocking it, and both
 * survive `respawn`.
 * Risk 2: the id handshake under a busy supervisor: two launches in one
 * folder at once, plus the person's own `claude --bg` there; the short-id
 * prefix picks the right session every time.
 *
 * Isolation: a test Inbox in this process on <scratch>/data (never the
 * person's), a stand-in login shell with a clean env, `model: haiku` and
 * everything else only through the per-launch settings file. Every session
 * is stopped and removed at the end; the token file is deleted.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(logDir, "day1.log"), `${stamped}\n`, { flag: "a" });
};

// The Inbox in this process reads its data dir and config through the env.
process.env.PLANNOTATOR_DATA_DIR = dataDir;
process.env.PLANNOTATOR_UPDATE_CHECK = "0";
process.env.PLANNOTATOR_INBOX_CONNECT = "0";
const { NO_BROWSER } = await import("../../tests/helpers/no-browser");
process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
// The smoke's folder is under .ops/work (kept for the report), so the temp-folder rule does not apply; the real data dirs are still refused.
const { isRealDataDir } = await import("../../tests/helpers/real-data-dir");
if (isRealDataDir(dataDir)) throw new Error(`refusing the real data dir ${dataDir}`);

const { startInboxServer } = await import("../../packages/server/inbox");
const { createAgentEnvironmentFor } = await import("../../packages/server/inbox-agents");
const { createClaudeHost } = await import("../../packages/server/inbox-launch-claude");
const { createLoginEnv, launchSettingsEnv, launchSpawnEnv } = await import("../../packages/server/inbox-launch-env");

// A stand-in login shell: a clean env with one CLAUDE_* marker, so the person's real rc files never decide the result.
const marker = `smoke-${Math.random().toString(36).slice(2, 10)}`;
const claudeBin = Bun.which("claude");
if (!claudeBin) throw new Error("claude is not on PATH");
const claudeDir = dirname(claudeBin);
const shell = join(root, "login-shell.sh");
writeFileSync(
  shell,
  `#!/bin/sh\nexec /usr/bin/env -i HOME="${homedir()}" USER="$USER" SHELL="${shell}" PATH="${claudeDir}:/usr/bin:/bin:/usr/sbin:/sbin" LANG=en_US.UTF-8 CLAUDE_LAUNCH_SMOKE="${marker}" /bin/sh -c "$2"\n`,
);
chmodSync(shell, 0o755);

const pids = join(root, "pids.txt");
const sessionsMade: string[] = [];

const server = await startInboxServer({ dataDir, version: "dev" });
const base = `http://127.0.0.1:${server.port}`;
if (server.port === 59812) throw new Error("refusing the person's Inbox port");
writeFileSync(pids, `inbox (this process) ${process.pid} port ${server.port}\n`, { flag: "a" });
log(`test Inbox on ${server.port}, data ${dataDir}`);

const loginEnv = createLoginEnv({
  run: (argv, o) => createAgentEnvironmentFor({ platform: platform(), homeDir: homedir(), env: o.env }).run(argv, { timeoutMs: o.timeoutMs }),
  env: () => ({ ...process.env, SHELL: shell }),
  log,
});
const login = await loginEnv();
if (login.CLAUDE_LAUNCH_SMOKE !== marker) throw new Error("the stand-in login shell's marker was not read");
const environment = async () => createAgentEnvironmentFor({ platform: platform(), homeDir: homedir(), env: launchSpawnEnv(login) });
const host = createClaudeHost({ environment });

const writeSettings = (id: string, fullPermissions: boolean) => {
  const dir = join(dataDir, "inbox", "launch", id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  const settings = {
    model: "haiku",
    env: launchSettingsEnv(login, { launchId: id, key: "k".repeat(64), dataDir, fullPermissions }),
    permissions: { allow: ["mcp__plannotator__plannotator_inbox"] },
  };
  writeFileSync(path, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return path;
};

const api = async (path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const serverSession = (await api("/api/inbox/sessions")).json.serverSession as string;
const until = async <T>(what: string, ms: number, probe: () => Promise<T | null | undefined | false>): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await Bun.sleep(1000);
  }
  throw new Error(`timed out: ${what}`);
};
const liveSessions = async () => ((await api("/api/inbox/sessions")).json.projects as any[]).flatMap((p) => p.sessions.map((s: any) => s.session as string));
const transcriptModes = (session: string): string[] => {
  const projects = join(homedir(), ".claude", "projects");
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${session}.jsonl`);
    if (existsSync(file)) return [...readFileSync(file, "utf8").matchAll(/"permissionMode":"([^"]+)"/g)].map((m) => m[1]!);
  }
  return [];
};
const agentReplies = async (threadId: string) =>
  ((await api(`/api/inbox/threads/${threadId}`)).json.thread.messages as any[]).filter((m) => m.author.kind === "agent");

const results: Record<string, unknown> = {};
try {
  // ── Risk 1 ──
  const a = await host.start({ folder: work, shownFolder: work, name: "smoke-A", settingsPath: writeSettings("lch_smokeA", true), fullPermissions: true, environment: await environment() });
  writeFileSync(join(logDir, "A.start.log"), a.output);
  if (!a.ok) throw new Error(`A did not start: ${a.text}`);
  sessionsMade.push(a.short);
  writeFileSync(pids, `session A ${a.short} ${a.session}\n`, { flag: "a" });
  log(`A started ${a.short} ${a.session}`);
  await until("A live in the test Inbox (settings-file PLANNOTATOR_DATA_DIR reached the mod)", 60_000, async () => (await liveSessions()).includes(a.session));
  log("A is live in the test Inbox");
  const ask = (n: number) =>
    `Smoke ${n}: run the shell command \`printenv CLAUDE_LAUNCH_SMOKE; printenv PLANNOTATOR_LAUNCH\` and send me its exact output through the Plannotator Inbox (reply_to this message). Nothing else.`;
  const sent = await api("/api/inbox/messages", { serverSession, idempotency_key: "smoke-a-1", body: ask(1), to: { host: "claude-code", session: a.session } });
  if (sent.status !== 200) throw new Error(`send failed ${sent.status} ${JSON.stringify(sent.json)}`);
  const thread = sent.json.thread_id as string;
  const first = await until("A's first answer", 180_000, async () => (await agentReplies(thread)).at(-1));
  results.first_reply = first.body;
  results.first_marker = String(first.body).includes(marker);
  results.first_launch_id = String(first.body).includes("lch_smokeA");
  results.modes_before_respawn = [...new Set(transcriptModes(a.session))];
  log(`A answered: marker ${results.first_marker}, launch id ${results.first_launch_id}, modes ${results.modes_before_respawn}`);

  const stop = await host.stop(a.short);
  log(`stop: ${stop.exitCode} ${stop.stdout.trim()}`);
  const stopped = (await host.agents(work))?.find((x) => x.id === a.short);
  results.after_stop = stopped ? { status: stopped.status, state: stopped.state } : "missing";
  await until("A off the live list", 60_000, async () => !(await liveSessions()).includes(a.session));
  const reply = await api(`/api/inbox/messages/${first.id}/reply`, { serverSession, idempotency_key: "smoke-a-2", words: ask(2) });
  if (reply.status !== 200) throw new Error(`reply failed ${reply.status} ${JSON.stringify(reply.json)}`);
  const respawn = await host.respawn(a.short);
  log(`respawn: ${respawn.exitCode} ${respawn.stdout.trim()}`);
  const second = await until("A's answer after respawn", 180_000, async () => {
    const replies = await agentReplies(thread);
    return replies.length >= 2 ? replies.at(-1) : null;
  });
  results.second_reply = second.body;
  results.second_marker = String(second.body).includes(marker);
  results.modes_after_respawn = [...new Set(transcriptModes(a.session))];
  log(`A after respawn: marker ${results.second_marker}, modes ${results.modes_after_respawn}`);

  // ── Risk 2 ──
  const own = join(root, "own-settings.json");
  writeFileSync(own, JSON.stringify({ model: "haiku", env: { PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_CLAUDE_MOD: "0" }, enabledPlugins: { "plannotator@plannotator": false } }), { mode: 0o600 });
  const e = await environment();
  const [b, c, d] = await Promise.all([
    host.start({ folder: work, shownFolder: work, name: "smoke-B", settingsPath: writeSettings("lch_smokeB", false), fullPermissions: false, environment: e }),
    host.start({ folder: work, shownFolder: work, name: "smoke-C", settingsPath: writeSettings("lch_smokeC", false), fullPermissions: false, environment: e }),
    e.run([e.which("claude")!, "--bg", "--name", "smoke-own", "--settings", own], { timeoutMs: 30_000, cwd: work }),
  ]);
  const ownShort = /backgrounded · ([0-9a-f]{8})/.exec(d.stdout)?.[1] ?? null;
  for (const [name, s] of [["B", b], ["C", c]] as const) {
    if (s.ok) {
      sessionsMade.push(s.short);
      writeFileSync(pids, `session ${name} ${s.short} ${s.session}\n`, { flag: "a" });
    }
  }
  if (ownShort) {
    sessionsMade.push(ownShort);
    writeFileSync(pids, `session own ${ownShort}\n`, { flag: "a" });
  }
  const raw = await e.run([e.which("claude")!, "agents", "--json", "--all", "--cwd", work], { timeoutMs: 15_000, cwd: work });
  writeFileSync(join(logDir, "agents.json"), raw.stdout);
  const listed = JSON.parse(raw.stdout) as any[];
  const nameOf = (session: string) => listed.find((x) => x.sessionId === session)?.name ?? null;
  results.handshake = {
    B: b.ok ? { short: b.short, name: nameOf(b.session), right: nameOf(b.session) === "smoke-B" } : b.text,
    C: c.ok ? { short: c.short, name: nameOf(c.session), right: nameOf(c.session) === "smoke-C" } : c.text,
    own: ownShort,
    listed: listed.map((x) => ({ id: x.id, name: x.name, status: x.status, state: x.state })),
  };
  results.agents_json_keys = [...new Set(listed.flatMap((x) => Object.keys(x)))].sort();
  log(`handshake ${JSON.stringify(results.handshake)}`);
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error);
  log(`ERROR ${results.error}`);
} finally {
  for (const short of sessionsMade) {
    const s = await host.stop(short);
    const r = await host.rm(short);
    log(`teardown ${short}: stop ${s.exitCode} ${s.stdout.trim()} / rm ${r.exitCode} ${r.stdout.trim()}`);
  }
  const left = await host.agents(work);
  results.left_after_teardown = left?.map((x) => x.id) ?? "unreadable";
  await server.stop();
  rmSync(join(dataDir, "inbox", "inbox.json"), { force: true });
  writeFileSync(join(root, "day1-results.json"), JSON.stringify(results, null, 2));
  log(`done; results in ${join(root, "day1-results.json")}`);
  process.exit(0);
}
