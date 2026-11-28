/**
 * The Inbox's store and server-side functions timed directly over a seeded
 * world (scripts/inbox-perf/seed.ts), with no Inbox and no server:
 *
 *   bun scripts/inbox-perf/bench-store.ts --root /tmp/inbox-perf/medium [--runs 15] [--out results.json] [--label main]
 *
 * It copies the seeded data dir into a new scratch folder first (the appends
 * and the deletion write to it), so the seed stays as it was. Every timing is
 * repeated: median, p95 (nearest rank), min and max in milliseconds. The
 * launch engine and the live sessions are built as packages/server/inbox.ts
 * builds them, with fake agent hosts (no agent CLI can run) and polls fed in
 * by hand. `PLANNOTATOR_DATA_DIR` points at the copy; launch is on in the
 * copy's config.json, as on a box that launched agents.
 *
 *   bun scripts/inbox-perf/bench-store.ts --mem <data dir>   (internal: one open, its memory)
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { heapStats } from "bun:jsc";
import { refuseRealDataDir } from "../../tests/helpers/real-data-dir";
import type { PerfManifest } from "./seed";

export interface Timing {
  name: string;
  runs: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  /** Anything the timed call reported (sizes, counts). */
  note?: Record<string, unknown>;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function summarize(name: string, samples: number[], note?: Record<string, unknown>): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  return { name, runs: samples.length, median: round(at(0.5)), p95: round(at(0.95)), min: round(sorted[0]!), max: round(sorted.at(-1)!), ...(note ? { note } : {}) };
}

function args() {
  const list = process.argv.slice(2);
  const flag = (name: string) => {
    const i = list.indexOf(name);
    return i >= 0 ? list[i + 1] : undefined;
  };
  return { flag };
}

async function memChild(dataDir: string): Promise<void> {
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  const { InboxStore } = await import("../../packages/shared/inbox/store");
  Bun.gc(true);
  const before = process.memoryUsage();
  const t0 = performance.now();
  const store = InboxStore.open(dataDir);
  const openMs = performance.now() - t0;
  Bun.gc(true);
  const after = process.memoryUsage();
  const heap = heapStats();
  const rows = store.listRows().length;
  Bun.gc(true);
  const afterList = process.memoryUsage();
  process.stdout.write(
    JSON.stringify({
      openMs: round(openMs),
      rssBeforeMb: round(before.rss / 1048576),
      rssAfterOpenMb: round(after.rss / 1048576),
      rssAfterListMb: round(afterList.rss / 1048576),
      heapAfterOpenMb: round(heap.heapSize / 1048576),
      rows,
    }),
  );
}

async function main(): Promise<void> {
  const { flag } = args();
  const mem = flag("--mem");
  if (mem) return memChild(refuseRealDataDir(mem, "bench-store --mem"));
  const root = resolve(flag("--root") ?? "");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as PerfManifest;
  const runs = Number(flag("--runs") ?? 15);
  const label = flag("--label") ?? "main";
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const loadavgAtStart = loadavg().map(round);

  // A copy of the seed, in a new scratch folder: everything below reads and writes only it.
  const work = realpathSync(mkdtempSync(join(tmpdir(), `inbox-perf-bench-${manifest.preset}-`)));
  const dataDir = join(work, "data");
  cpSync(manifest.dataDir, dataDir, { recursive: true });
  refuseRealDataDir(dataDir, "scripts/inbox-perf/bench-store.ts");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  process.env.NO_BROWSER = "1";
  process.env.NO_ANON_PING = "1";
  process.env.PLANNOTATOR_UPDATE_CHECK = "0";
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });

  const { InboxStore } = await import("../../packages/shared/inbox/store");
  const { InboxSearchIndex } = await import("../../packages/shared/inbox/search");
  const { createInboxLaunch } = await import("../../packages/server/inbox-launch");
  const { createInboxLiveSessions } = await import("../../packages/server/inbox-sessions");
  const { claudeSessionOutdated, createClaudePluginInstallReader } = await import("../../packages/server/inbox-restart");
  const { createAgentEnvironmentFor } = await import("../../packages/server/inbox-agents");
  const { fakeLaunchHost } = await import("../../tests/helpers/fake-launch-host");

  const results: Timing[] = [];
  const time = (name: string, n: number, fn: () => unknown, options: { warmup?: number; before?: () => void; note?: (value: unknown) => Record<string, unknown> } = {}) => {
    for (let i = 0; i < (options.warmup ?? 1); i++) {
      options.before?.();
      fn();
    }
    const samples: number[] = [];
    let last: unknown;
    for (let i = 0; i < n; i++) {
      options.before?.();
      const t0 = performance.now();
      last = fn();
      samples.push(performance.now() - t0);
    }
    const result = summarize(name, samples, options.note?.(last));
    results.push(result);
    log(`  ${name.padEnd(44)} median ${String(result.median).padStart(9)} ms   p95 ${String(result.p95).padStart(9)} ms`);
    return last;
  };
  const timeAsync = async (name: string, n: number, fn: () => Promise<unknown>, note?: (value: unknown) => Record<string, unknown>) => {
    const samples: number[] = [];
    let last: unknown;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      last = await fn();
      samples.push(performance.now() - t0);
    }
    const result = summarize(name, samples, note?.(last));
    results.push(result);
    log(`  ${name.padEnd(44)} median ${String(result.median).padStart(9)} ms   p95 ${String(result.p95).padStart(9)} ms`);
    return last;
  };
  log(`${manifest.preset} (${label}): ${manifest.counts.threads} threads, ${manifest.counts.messages} messages, ${manifest.sessions.length} agents, ${manifest.counts.launched} launched`);

  // ── Open and memory ──
  const memory: Record<string, unknown>[] = [];
  for (let i = 0; i < 3; i++) {
    const child = Bun.spawnSync(["bun", import.meta.path, "--mem", dataDir], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    memory.push(JSON.parse(child.stdout.toString()));
  }
  results.push(summarize("open (fresh process)", memory.map((m) => m.openMs as number), { rssAfterOpenMb: memory[0]!.rssAfterOpenMb, heapAfterOpenMb: memory[0]!.heapAfterOpenMb, rssAfterListMb: memory[0]!.rssAfterListMb, rssBeforeMb: memory[0]!.rssBeforeMb }));
  log(`  open (fresh process): ${JSON.stringify(memory[0])}`);
  time("open (in process, warm file cache)", Math.min(runs, manifest.preset === "huge" ? 3 : 5), () => InboxStore.open(dataDir), { warmup: 0 });

  const clock = { now: Date.now() };
  const store = InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  const long = manifest.longThread;
  const sample = manifest.sampleThreads[0]!;
  const sessions = manifest.sessions.map((s) => s.session);

  // ── Reads with no presence (the store alone) ──
  const internals = store as unknown as { rowsMemo: unknown; buildRows(filter: object): unknown[] };
  time("listRows full build (no presence)", runs, () => store.listRows(), { before: () => (internals.rowsMemo = null), note: (rows) => ({ rows: (rows as unknown[]).length }) });
  time("listRows memo hit (no presence)", runs, () => store.listRows());
  time("listSections", runs, () => store.listSections());
  time("listRow (the long thread)", runs, () => store.listRow(long));
  time("thread (400 messages)", runs, () => store.thread(long), { note: (t) => ({ messages: (t as { messages: unknown[] }).messages.length }) });
  time("windowThread (400 messages)", runs, () => store.windowThread(long));
  time("windowThread (an ordinary thread)", runs, () => store.windowThread(sample), { note: (t) => ({ messages: (t as { messages: unknown[] }).messages.length }) });
  time("openDecisions", runs, () => store.openDecisions());
  time("unsentRows", runs, () => store.unsentRows());

  // ── Pending replies: one walk per session against one pass for all ──
  time("pendingReplies x every session", runs, () => {
    let n = 0;
    for (const s of sessions) n += store.pendingReplies(s, { tags: true }).length;
    return n;
  }, { note: (n) => ({ pending: n, sessions: sessions.length }) });
  results.at(-1)!.note = { ...results.at(-1)!.note, perCallMedianMs: round(results.at(-1)!.median / sessions.length) };
  time("pendingRepliesFor (one pass, every session)", runs, () => store.pendingRepliesFor(new Set(sessions), { tags: true }));

  // ── The live sessions and the restart judgment, wired as inbox.ts wires them ──
  const agentsHome = join(dataDir, "agents-home");
  const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: agentsHome, env: { HOME: agentsHome, PATH: "" } });
  const reader = createClaudePluginInstallReader(environment, () => clock.now) as ReturnType<typeof createClaudePluginInstallReader> & { realPath?: unknown };
  const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { version: string }).version;
  const live = createInboxLiveSessions({
    store,
    serverSession: "perf",
    now: () => clock.now,
    resolveRoot: async (path) => path,
    outdatedOf: (host, plugin, folder) =>
      host === "claude-code"
        ? claudeSessionOutdated({ loaded: plugin, records: reader.records(), folder, cliVersion: version, pluginsDir: reader.pluginsDir(), changedAt: reader.changedAt, ...(reader.realPath ? { realPath: reader.realPath } : {}) } as Parameters<typeof claudeSessionOutdated>[0])
        : null,
  });
  const polling = manifest.sessions.filter((s) => s.live && s.host !== "codex");
  const ends: (() => void)[] = [];
  for (const s of polling) {
    ends.push(
      await live.pollStarted(s.session, s.host, {
        project_path: s.folder,
        session_folder: s.folder,
        started_at: clock.now - 3_600_000,
        busy: false,
        idle_since: clock.now - 600_000,
        ...(s.plugin ? { plugin: { ...s.plugin, loaded_at: clock.now - 3_600_000 } } : {}),
      }),
    );
  }
  const liveSet = new Set(polling.map((s) => s.session));
  const tick = () => (clock.now += 5_000);
  time("live.restartAgents (5 s apart)", runs, () => live.restartAgents(), { before: tick, note: () => ({ live: polling.length }) });
  time(`live.connectionOf x every live session`, runs, () => polling.map((s) => live.connectionOf(s.session)), { before: tick });
  time(`live.reloadOfferFor x every live session`, runs, () => polling.map((s) => live.reloadOfferFor(s.session)), { before: tick });
  time("live.deliverySignature", runs, () => live.deliverySignature());

  // ── The launch engine over the launched threads (fake hosts for every agent id) ──
  const fake = (agent: string) => {
    const made = fakeLaunchHost();
    return {
      ...made.host,
      agent: agent as typeof made.host.agent,
      sessions: async () => () => ({ status: "idle" as const, state: "running" as const, waitingFor: null }),
      resume: async () => ({ exitCode: 0, text: "", failure: null }),
      start: async () => ({ ok: false as const, code: "untrusted", text: "No starts in the benchmark." }),
    };
  };
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: (session) => (liveSet.has(session) ? { busy: false, busySince: null, polls: 1 } : null) },
    dataDir,
    serverSession: "perf",
    homeDir: home,
    platform: process.platform,
    loginEnv: async () => ({ HOME: home, PATH: "" }),
    ownEnv: () => ({ HOME: home, PATH: "" }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    hosts: () => ["claude-code", "codex", "pi", "opencode"].map(fake) as never,
    now: () => clock.now,
  });
  const onePass = (launch as unknown as { onePass?: <T>(read: () => T) => T }).onePass;
  store.setDeliveryPresence({
    connection: live.deliveryConnectionOf,
    askerLive: live.askerLive,
    launchResumes: (threadId, session) => launch.resumes(threadId, session),
    ...(onePass ? { onePass: (read: () => unknown) => onePass(read) } : {}),
    hostOf: live.hostOf,
    stuck: live.stuck,
  } as Parameters<typeof store.setDeliveryPresence>[0]);
  const variant = { onePass: !!onePass, realPathCache: !!reader.realPath };
  time("launch.sweep(false)", runs, () => launch.sweep(false), { note: () => ({ launched: store.launchedRoots().length }) });
  time("launch.signature()", runs, () => launch.signature());
  time("launch.agents()", runs, () => launch.agents());
  const rowsNow = store.listRows();
  time("launch.rowDecorator() over every row", runs, () => {
    const decorate = launch.rowDecorator();
    for (const row of rowsNow) decorate(row);
  });
  time("listRows full build (server presence)", runs, () => store.listRows(), { before: () => (internals.rowsMemo = null) });
  time("listRows memo check (server presence)", runs, () => store.listRows());
  // One delivery-watch tick with a window open (inbox.ts: sweep, then the signatures).
  time("delivery tick: sweep + signature + deliverySignature", runs, () => {
    launch.sweep(false);
    launch.signature();
    live.deliverySignature();
  });
  // The list route's store work: rows, every row decorated, the restart judgment.
  time("list read: listRows + rowDecorator + restartAgents", runs, () => {
    const rows = store.listRows();
    const decorate = launch.rowDecorator();
    for (const row of rows) decorate(row);
    live.restartAgents();
  }, { before: tick });

  // ── Search ──
  const queries = ["retry queue", "deploy", "Charlie Dunn", "ledger invoice", "timeout socket", "the", "canary rollout", "zzqx-nothing"];
  let index = new InboxSearchIndex(store);
  await timeAsync("search index first build", manifest.preset === "huge" ? 2 : 3, async () => {
    index.dispose();
    index = new InboxSearchIndex(store);
    await index.ensureBuilt();
    return index.lastBuildStats();
  }, (stats) => ({ ...(stats as object) }));
  const searchSamples: number[] = [];
  for (let r = 0; r < runs; r++) {
    for (const q of queries) {
      const t0 = performance.now();
      index.search({ q });
      searchSamples.push(performance.now() - t0);
    }
  }
  results.push(summarize(`search query (mix of ${queries.length})`, searchSamples));
  log(`  ${"search query (mix)".padEnd(44)} median ${results.at(-1)!.median} ms   p95 ${results.at(-1)!.p95} ms`);

  // ── Writes (to the copy) ──
  const agent = manifest.sessions.find((s) => !s.launched)!;
  let k = 0;
  time("append: agent message into the long thread", runs, () =>
    store.sendMessage({ project_id: store.message(long)!.project_id, author: { kind: "agent", host: agent.host, session: agent.session, name: null }, body: `Perf append ${++k}. The retry queue is drained.`, reply_to: long, idempotency_key: `perf-append-${k}` }),
  );
  const lastAgent = () => store.thread(long)!.messages.filter((m) => m.author.kind === "agent").at(-1)!;
  time("append: person reply (sendReply)", runs, () => store.sendReply(lastAgent().id, { words: `Perf reply ${++k}.`, idempotency_key: `perf-reply-${k}` }));
  time("append + listRows (a new message, then the list)", runs, () => {
    store.sendMessage({ project_id: store.message(long)!.project_id, author: { kind: "agent", host: agent.host, session: agent.session, name: null }, body: `Perf append ${++k}.`, reply_to: long, idempotency_key: `perf-append-${k}` });
    return store.listRows();
  });
  time("markSeen (one thread)", runs, () => store.markSeen(sample));
  time("diskUsage", Math.min(runs, 5), () => store.diskUsage());
  // A deletion rewrites the project's files whole and reloads the store (store-log/jsonl-log.ts).
  const victims = [...manifest.sampleThreads];
  time("deleteThread (full-file rewrite + reload)", victims.length, () => store.deleteThread(victims.shift()!), { warmup: 0 });

  launch.stop();
  for (const end of ends) end();
  const out = {
    preset: manifest.preset,
    label,
    variant,
    machine: { platform: process.platform, arch: process.arch, bun: Bun.version, cpus: navigator.hardwareConcurrency, loadavgAtEnd: loadavg().map(round), loadavgAtStart },
    shape: manifest.shape,
    counts: manifest.counts,
    dataBytes: manifest.dataBytes,
    runs,
    at: new Date().toISOString(),
    memory,
    results,
    scratch: work,
  };
  const file = flag("--out");
  if (file) writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
