/**
 * The Plannotator Inbox on SQLite, proven on the COMPILED binary of this OS (CI: `.github/workflows/inbox-sqlite-binary.yml`,
 * on Windows, Linux and macOS). Not `bun test`: every Inbox here is the binary, started and stopped as a person or an
 * agent does; this script only generates Inboxes and reads what is on disk afterwards (from source).
 *
 *   bun scripts/inbox-sqlite-proof/run.ts <binary> [--big] [--only <phase>,…]
 *
 * Phases (each in its own scratch HOME and data dir; never the person's):
 *   new-install  the switch unset on an empty data dir: SQLite, no backup, Storage counts inbox.db, write and read
 *                back through the server (MCP and HTTP), export, restart
 *   import       a generated JSONL Inbox moved with the switch on (the check run apart, in the binary's second
 *                process), byte-for-byte backup, export equal to the files, then off: everything back into the files
 *   moves        the move again and again, each one checked apart (the second process's lock race, run 4)
 *   starters     two starters while a move outlasts their wait, the start lock aged past stale: one Inbox, one move
 *   kills        the binary killed hard at every step of the move, and at random moments: every record file is
 *                still there exactly once, no half database, and the next start (on, or off) serves the same
 *   big          (--big) one 100,000-message move, for the timing
 *
 * Prints one `PROOF` line per check and a table into $GITHUB_STEP_SUMMARY when set. Exit 1 on the first failure.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { INBOX_START_LOCK } from "../../packages/shared/inbox/registry";
import { INBOX_UPGRADING_LINE } from "../../packages/shared/inbox/store-log/sqlite/move-words";
import { INBOX_UPGRADE_MARKER } from "../../packages/shared/inbox/store-log/sqlite/upgrade-marker";
import { copyInbox, databaseDigest, filesDigest, folderDigest, noHalfDatabase, recordFiles, sameFiles, writeJsonlInbox } from "./disk";
import { agentOn, check, cli, envOf, getJson, hardKill, isWindows, notes, type Running, sandbox, type Sandbox, serve, stop } from "./harness";

const args = process.argv.slice(2);
const binary = resolve(args[0] ?? "");
check(args[0] && existsSync(binary), `usage: run.ts <binary>; no binary at ${binary}`);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]!.split(",")) : null;
const rows: string[] = [];
const scratch: string[] = [];

function proof(phase: string, what: string, detail = ""): void {
  const line = `PROOF ${phase}: ${what}${detail ? ` (${detail})` : ""}`;
  process.stdout.write(`${line}\n`);
  rows.push(`| ${phase} | ${what} | ${detail} |`);
}

function box(name: string): Sandbox {
  const s = sandbox(name);
  scratch.push(s.root);
  return s;
}

async function started(s: Sandbox, extra: Record<string, string> = {}, what = "start"): Promise<Running> {
  const loads = notes(s, "store_load").length;
  const run = await serve(binary, s, extra);
  check(run.ok, `${what}: the Inbox exited (${!run.ok && run.code}):\n${!run.ok && run.stderr}`);
  // The start's notes are written at its first API request (the health check above) and flushed shortly after.
  for (let waited = 0; notes(s, "store_load").length === loads; waited += 50) {
    check(waited < 15_000, `${what}: no store_load note in the debug log`);
    await Bun.sleep(50);
  }
  return run;
}

const last = (s: Sandbox, ev: string) => notes(s, ev).at(-1) ?? {};
const backups = (s: Sandbox) => readdirSync(s.inbox).filter((name) => name.startsWith("backup-"));
const ON = { PLANNOTATOR_INBOX_SQLITE: "1" };
const OFF = { PLANNOTATOR_INBOX_SQLITE: "0" };

async function newInstall(): Promise<void> {
  const s = box("new");
  const first = await started(s, {}, "a new install");
  check(last(s, "store_load").log === "sqlite" && last(s, "store_load").why === "new_install", `store_load: ${JSON.stringify(last(s, "store_load"))}`);
  check(existsSync(join(s.inbox, "inbox.db")), "no inbox.db on a new install");
  check(!existsSync(join(s.inbox, "projects")), "record files on a new install");
  check(backups(s).length === 0, "a backup on a new install");
  proof("new-install", "starts on SQLite, nothing moved", `${Math.round(first.ms)} ms to answer`);

  const agent = await agentOn(first, s);
  const a = await agent.send("First message on a new install.");
  const b = await agent.send(["Ship it?", "", ":::question", "Ship the change?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n"));
  const answer = await agent.send("A second message in the same session.");
  const read = await agent.thread(a.thread_id);
  check(read.some((m) => m.id === a.message_id && m.body === "First message on a new install."), "read_thread lost the first message");
  const list = await getJson<{ sections: { threads: { thread_id: string }[] }[] }>(first, "/api/inbox/threads");
  const listed = new Set(list.sections.flatMap((section) => section.threads.map((t) => t.thread_id)));
  check([a, b, answer].every((m) => listed.has(m.thread_id)), "the list misses a thread written on SQLite");
  const storage = await getJson<{ bytes: number; database?: number; backups?: unknown[] }>(first, "/api/inbox/settings/storage");
  check((storage.database ?? 0) > 0 && storage.bytes >= storage.database! && (storage.backups ?? []).length === 0, `Storage: ${JSON.stringify({ ...storage, projects: undefined })}`);
  proof("new-install", "write and read back through the server; Storage counts inbox.db, no Backup", `database ${storage.database} B of ${storage.bytes} B`);

  const out = join(s.root, "export");
  const exported = cli(binary, s, ["inbox", "export", "--jsonl", out, "--json"]);
  check(exported.code === 0 && JSON.parse(exported.out).from === "database", `export: ${exported.code} ${exported.out} ${exported.err}`);
  await agent.close();
  await stop(binary, s, first);
  const served = databaseDigest(s.dataDir);
  check(folderDigest(s.dataDir, out) === served, "the export reads differently from the database");
  proof("new-install", "export while running reads exactly as the database");

  const again = await started(s, {}, "the restart");
  check(last(s, "store_load").why === "database", `restart store_load: ${JSON.stringify(last(s, "store_load"))}`);
  const agent2 = await agentOn(again, s);
  const reread = await agent2.thread(a.thread_id);
  check(JSON.stringify(reread) === JSON.stringify(read), "a restart reads the thread differently");
  await agent2.close();
  await stop(binary, s, again);
  check(databaseDigest(s.dataDir) === served, "a restart changed what the database serves");
  proof("new-install", "restart serves the same, from the database", `${Math.round(again.ms)} ms to answer`);

}

/**
 * A generated Inbox started once on its files, as any Inbox has been: its first start writes what a start writes
 * (notes setting aside questions older than the wait), so the snapshots taken after it are what a move must keep.
 */
async function warm(s: Sandbox): Promise<void> {
  const files = recordFiles(s.inbox);
  const run = await started(s, {}, "the first start on files");
  check(last(s, "store_load").log === "jsonl" && last(s, "store_load").why === "files", `unset over files: ${JSON.stringify(last(s, "store_load"))}`);
  await stop(binary, s, run);
  check(!existsSync(join(s.inbox, "inbox.db")) && statSync(join(s.inbox, "projects")).isDirectory(), "the switch unset moved an Inbox on files");
  // Only appended, as on files today: every record file still starts with exactly what it held.
  const now = recordFiles(s.inbox);
  check(Object.entries(files).every(([name, text]) => now[name]?.startsWith(text)), "the switch unset rewrote a record file");
}

async function importAndBack(): Promise<void> {
  const s = box("import");
  writeJsonlInbox(s.dataDir, 2_000);
  await warm(s);
  proof("import", "unset over record files: stays on them, appended to as today");
  const originals = recordFiles(s.inbox);
  const before = filesDigest(s.dataDir);

  const on = await started(s, ON, "the move");
  const move = last(s, "store_move");
  check(move.status === "imported" && move.apart === true, `store_move: ${JSON.stringify(move)}\n${on.stderr()}`);
  check(sameFiles(recordFiles(s.inbox), originals), "a record file changed or went missing in the move");
  check(!existsSync(join(s.inbox, "projects")) && backups(s).length === 1, `after the move: ${readdirSync(s.inbox).join(", ")}`);
  const storage = await getJson<{ database?: number; backups?: { kind: string }[] }>(on, "/api/inbox/settings/storage");
  check((storage.database ?? 0) > 0 && storage.backups?.length === 1 && storage.backups[0]!.kind === "jsonl", `Storage after the move: ${JSON.stringify(storage.backups)}`);
  proof("import", "moved, checked in the second process; files kept byte for byte in the backup", `${move.lines} lines in ${move.ms} ms`);

  const out = join(s.root, "export");
  const exported = cli(binary, s, ["inbox", "export", "--jsonl", out, "--json"]);
  check(exported.code === 0, `export: ${exported.err}`);
  const agent = await agentOn(on, s);
  await agent.send("Written while on SQLite.");
  await agent.close();
  await stop(binary, s, on);
  check(databaseDigest(s.dataDir) !== before, "the message written on SQLite is not in the database");
  check(folderDigest(s.dataDir, out) === before, "the export reads differently from the files it came from");
  proof("import", "the database serves exactly what the files did (fingerprint), and the export reads the same");

  const onSqlite = databaseDigest(s.dataDir);
  const off = await started(s, OFF, "the way back");
  check(last(s, "store_move").status === "returned", `way back: ${JSON.stringify(last(s, "store_move"))}\n${off.stderr()}`);
  await stop(binary, s, off);
  check(statSync(join(s.inbox, "projects")).isDirectory() && !existsSync(join(s.inbox, "inbox.db")), "after the way back the files are not in place");
  check(filesDigest(s.dataDir) === onSqlite, "the way back lost or changed something written on SQLite");
  proof("import", "switch off: everything back into the files, the message written on SQLite included");
}

async function moves(count: number): Promise<void> {
  const pristine = box("moves-pristine");
  writeJsonlInbox(pristine.dataDir, 3_000, 5);
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const s = box(`moves-${i}`);
    copyInbox(pristine.dataDir, s.dataDir);
    const run = await started(s, ON, `move ${i + 1}`);
    const move = last(s, "store_move");
    check(move.status === "imported" && move.apart === true, `move ${i + 1}: ${JSON.stringify(move)}\n${run.stderr()}`);
    times.push(Number(move.ms));
    await stop(binary, s, run);
    rmSync(s.root, { recursive: true, force: true });
  }
  times.sort((x, y) => x - y);
  proof("moves", `${count} of ${count} moves imported, each checked in the second process`, `3,000 messages: median ${times[times.length >> 1]} ms, max ${times.at(-1)} ms`);
}

async function starters(): Promise<void> {
  const s = box("starters");
  writeJsonlInbox(s.dataDir, 1_500, 3);
  const extra = { ...ON, PLANNOTATOR_INBOX_START_TIMEOUT_MS: "3000", PLANNOTATOR_INBOX_IMPORT_DELAY_MS: "8000" };
  const start = () => {
    const at = Date.now();
    const proc = Bun.spawn([binary, "inbox", "--background"], { cwd: s.root, env: envOf(s, extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([out, err, code]) => ({ out, err, code, ms: Date.now() - at }));
  };
  const movers = new Set<string>();
  let watching = true;
  const watch = (async () => {
    while (watching) {
      try {
        movers.add(readFileSync(join(s.inbox, INBOX_UPGRADE_MARKER), "utf8").trim());
      } catch {}
      await Bun.sleep(25);
    }
  })();
  const first = start();
  const waitedAt = Date.now();
  while (!existsSync(join(s.inbox, INBOX_UPGRADE_MARKER))) {
    check(Date.now() - waitedAt < 60_000, "the move never started");
    await Bun.sleep(25);
  }
  const old = new Date(Date.now() - 120_000);
  utimesSync(join(s.inbox, INBOX_START_LOCK), old, old);
  const second = start();
  const [a, b] = await Promise.all([first, second]);
  watching = false;
  await watch;
  const health = await fetch(`${a.out.trim()}/api/inbox/health`).then((r) => r.json() as Promise<{ pid: number }>).catch(() => null);
  const stopped = cli(binary, s, ["inbox", "stop"]);
  check(a.code === 0 && b.code === 0, `starters: ${a.code} ${a.err} / ${b.code} ${b.err}`);
  check(a.ms > 8_000 && a.err.includes(INBOX_UPGRADING_LINE), `the first starter gave up or said nothing: ${a.ms} ms, ${a.err}`);
  check(a.out === b.out && health !== null, `two Inboxes or none: ${a.out} / ${b.out}`);
  check(movers.size === 1 && movers.has(String(health!.pid)), `moves by ${[...movers].join(", ")}, serving ${health?.pid}`);
  check(stopped.code === 0, `inbox stop: ${stopped.err}`);
  check(existsSync(join(s.inbox, "inbox.db")) && !existsSync(join(s.inbox, INBOX_UPGRADE_MARKER)), "the move did not finish cleanly");
  proof("starters", "two starters through a move longer than their wait: one Inbox, one move, the upgrading line", `${a.ms} ms`);
}

async function kills(randomKills: number): Promise<void> {
  const pristine = box("kills-pristine");
  writeJsonlInbox(pristine.dataDir, 1_000, 12);
  await warm(pristine);
  const originals = recordFiles(pristine.inbox);
  const before = filesDigest(pristine.dataDir);
  let n = 0;

  /** After a crash: the files whole, no half database, and the next start, off or on, serves the same. */
  const afterCrash = async (s: Sandbox, what: string) => {
    check(sameFiles(recordFiles(s.inbox), originals), `${what}: a record file changed or went missing`);
    noHalfDatabase(s.inbox);
    const off = box(`kills-off-${n}`);
    copyInbox(s.dataDir, off.dataDir);
    const offRun = await started(off, OFF, `${what}, restart off`);
    await stop(binary, off, offRun);
    check(filesDigest(off.dataDir) === before && !existsSync(join(off.inbox, "inbox.db")), `${what}: off after the crash serves differently`);
    const onRun = await started(s, ON, `${what}, restart on`);
    const move = last(s, "store_move");
    check(move.status === "imported" || move.status === "already", `${what}: restart on: ${JSON.stringify(move)}\n${onRun.stderr()}`);
    await stop(binary, s, onRun);
    check(databaseDigest(s.dataDir) === before, `${what}: on after the crash serves differently`);
    check(sameFiles(recordFiles(s.inbox), originals) && !existsSync(join(s.inbox, "projects")), `${what}: after the restart the files are not all in the backup`);
    check(!readdirSync(s.inbox).some((name) => name.startsWith("inbox.db.importing")), `${what}: a half file was left`);
    rmSync(s.root, { recursive: true, force: true });
    rmSync(off.root, { recursive: true, force: true });
  };

  const points = ["read", "rows", "load", "integrity", "checked", "marked", "renamed", "backup-entry:1", "backup-entry:2"];
  for (const point of points) {
    const s = box(`kills-${++n}`);
    copyInbox(pristine.dataDir, s.dataDir);
    const run = await serve(binary, s, { ...ON, PLANNOTATOR_INBOX_IMPORT_STOP_AT: point }, 120_000);
    check(!run.ok, `stop at ${point}: the Inbox did not stop`);
    await afterCrash(s, `killed at ${point}`);
  }
  proof("kills", `killed hard at each of the move's ${points.length} steps: files whole, no half database, restart on and off serve the same`, isWindows ? "TerminateProcess (process.kill SIGKILL)" : "SIGKILL");

  // From outside, at random moments of a start that moves (how long one takes, measured first).
  const sample = box("kills-sample");
  copyInbox(pristine.dataDir, sample.dataDir);
  const whole = await started(sample, ON, "the timing run");
  await stop(binary, sample, whole);
  let random = 7;
  const next = () => ((random = (random * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let killedMidway = 0;
  for (let i = 0; i < randomKills; i++) {
    const s = box(`kills-${++n}`);
    copyInbox(pristine.dataDir, s.dataDir);
    const proc = Bun.spawn([binary, "inbox", "--no-open"], { cwd: s.root, env: envOf(s, ON), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(Math.floor(next() * whole.ms));
    const done = existsSync(join(s.inbox, "inbox.db")) && !existsSync(join(s.inbox, "inbox.db.importing"));
    hardKill(proc);
    await proc.exited;
    if (!done) killedMidway++;
    await afterCrash(s, `random kill ${i + 1}`);
  }
  check(killedMidway >= Math.ceil(randomKills / 2), `only ${killedMidway} of ${randomKills} random kills landed before the move ended`);
  proof("kills", `${randomKills} hard kills at random moments (${killedMidway} before the move ended): the same checks`, isWindows ? "taskkill /F on the Inbox alone" : "SIGKILL on the Inbox alone");
}

async function bigMove(): Promise<void> {
  const s = box("big");
  const at = performance.now();
  writeJsonlInbox(s.dataDir, 100_000, 11);
  const made = Math.round(performance.now() - at);
  const run = await started(s, ON, "the 100k move");
  const move = last(s, "store_move");
  check(move.status === "imported" && move.apart === true, `100k: ${JSON.stringify(move)}\n${run.stderr()}`);
  await stop(binary, s, run);
  const again = await started(s, {}, "the 100k restart");
  await stop(binary, s, again);
  proof("big", "100,000 messages moved by the binary", `${move.lines} lines in ${move.ms} ms (read ${move.read}, rows ${move.rows}, load ${move.load}, checkDb ${move.checkDb}); first answer ${Math.round(run.ms)} ms; restart ${Math.round(again.ms)} ms; generated in ${made} ms`);
}

const phases: [string, () => Promise<void>][] = [
  ["new-install", newInstall],
  ["import", importAndBack],
  ["moves", () => moves(process.platform === "linux" ? 10 : 6)],
  ["starters", starters],
  ["kills", () => kills(process.platform === "linux" ? 8 : 5)],
];
if (args.includes("--big")) phases.push(["big", bigMove]);

let failed = false;
try {
  for (const [name, run] of phases) {
    if (only && !only.has(name)) continue;
    process.stdout.write(`== ${name}\n`);
    await run();
  }
} catch (error) {
  failed = true;
  process.stdout.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  rows.push(`| FAILED | ${String(error instanceof Error ? error.message : error).split("\n")[0]!.replace(/\|/g, "/")} | |`);
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### Inbox on SQLite, compiled binary (${process.platform} ${process.arch})`, "", "| phase | proven | detail |", "|---|---|---|", ...rows, ""].join("\n"));
  }
  // Scratch kept on failure for the artifact step; removed otherwise.
  if (!failed) for (const root of scratch) rmSync(root, { recursive: true, force: true });
  else if (process.env.PROOF_KEEP_DIR) {
    mkdirSync(process.env.PROOF_KEEP_DIR, { recursive: true });
    appendFileSync(join(process.env.PROOF_KEEP_DIR, "scratch.txt"), `${scratch.join("\n")}\n`);
  }
}
process.exit(failed ? 1 : 0);
