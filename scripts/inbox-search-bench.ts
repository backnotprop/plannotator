import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { heapStats } from "bun:jsc";
import { isScratchDataDir, refuseRealDataDir } from "../tests/helpers/real-data-dir";
import { seedInboxSearchWorld, WORST_CASE, type UniqueMix } from "./inbox-large-store";

export { seedInboxSearchWorld, WORST_CASE, type SeedShape, type UniqueMix } from "./inbox-large-store";

const QUERIES = [
  "relay", "rate limit", "retry storm", "deploy rollback", "the", "de", "re", "migration schema index", "cursor pag", "webhook",
  "jitter backoff", "pipeline nightly build", "token session lease", "kalo", "mine", "決済", "タイムアウト", "أخطاء", "relay mailbox rate limit", "bundle cdn",
  "idempotency", "percentile histogram", "tokenizer segmenter", "fixture snapshot", "nonexistentword", "pairing tailnet", "certificate", "latency timeout socket", "a b", "release checklist changelog",
  "the an", "the and of", "to be",
];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function heldBytes(): number {
  for (let i = 0; i < 3; i++) Bun.gc(true);
  const stats = heapStats() as { heapSize: number; extraMemorySize: number };
  return stats.heapSize + stats.extraMemorySize;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const uniqueAt = args.indexOf("--unique");
  const unique: UniqueMix = {
    share: uniqueAt >= 0 ? Number(args[uniqueAt + 1]) / 100 : 0,
    kind: args.includes("--unique-words") ? "words" : "ids",
  };
  const keepAt = args.indexOf("--keep");
  const root = keepAt >= 0 ? args[keepAt + 1]! : mkdtempSync(join(tmpdir(), "plannotator-inbox-search-bench-"));
  mkdirSync(root, { recursive: true });
  const dataDir = join(root, "data");
  refuseRealDataDir(dataDir, "scripts/inbox-search-bench.ts");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.PLANNOTATOR_TEST_SANDBOX = dataDir;
  const log = (line: string) => (asJson ? process.stderr : process.stdout).write(`${line}\n`);
  const seedStart = performance.now();
  const seeded = seedInboxSearchWorld(dataDir, WORST_CASE, 1, unique);
  log(`seeded ${seeded.threadIds.length} threads, ${(seeded.textChars / 1024 / 1024).toFixed(1)} M characters in ${((performance.now() - seedStart) / 1000).toFixed(1)} s`);
  const { startInboxServer } = await import("../packages/server/inbox");
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    Bun.gc(true);
    const heapBefore = heldBytes();
    const idle: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      await fetch(`${base}/api/inbox/health`);
      idle.push(performance.now() - t);
    }
    const health: number[] = [];
    let building = true;
    const healthLoop = (async () => {
      while (building) {
        const t = performance.now();
        await fetch(`${base}/api/inbox/health`);
        health.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const buildStart = performance.now();
    let first: Record<string, any>;
    for (;;) {
      first = (await (await fetch(`${base}/api/inbox/search?q=relay`)).json()) as Record<string, any>;
      if (!first.indexing) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const buildWall = performance.now() - buildStart;
    building = false;
    await healthLoop;
    const stats = server.search.lastBuildStats()!;
    Bun.gc(true);
    const heapAfter = heldBytes();

    const took: number[] = [];
    const roundTrip: number[] = [];
    const byQuery = new Map<string, number[]>();
    const project = server.store.listProjects()[0]!.id;
    for (let round = 0; round < 10; round++) {
      for (const q of QUERIES) {
        for (const extra of ["", `&project=${project}`, "&status=quiet", "&from=agent", `&current=${project}`]) {
          const t = performance.now();
          const answer = (await (await fetch(`${base}/api/inbox/search?q=${encodeURIComponent(q)}${extra}`)).json()) as Record<string, any>;
          roundTrip.push(performance.now() - t);
          took.push(answer.took_ms);
          byQuery.set(q, [...(byQuery.get(q) ?? []), answer.took_ms]);
        }
      }
    }
    const p = server.store.listProjects()[1]!;
    server.store.sendMessage({ project_id: p.id, author: { kind: "agent", host: "pi", session: "ses_late", name: null }, subject: "Zyxwvut arrival", body: "A zyxwvut message." });
    const t = performance.now();
    const late = (await (await fetch(`${base}/api/inbox/search?q=zyxwvut`)).json()) as Record<string, any>;
    const lateMs = performance.now() - t;

    const result = {
      threads: stats.threads,
      documents: stats.docs,
      tokens: stats.tokens,
      vocabulary: stats.vocabulary,
      text_mb: +(seeded.textChars / 1024 / 1024).toFixed(1),
      build_total_ms: +stats.totalMs.toFixed(1),
      build_wall_ms_first_search: +buildWall.toFixed(1),
      build_slices: stats.slices,
      build_longest_slice_ms: +stats.longestSliceMs.toFixed(2),
      build_slices_over_8ms: stats.slicesOver8Ms,
      health_idle_ms: { p50: +percentile(idle, 50).toFixed(2), p95: +percentile(idle, 95).toFixed(2) },
      health_during_build_ms: { samples: health.length, p50: +percentile(health, 50).toFixed(2), p95: +percentile(health, 95).toFixed(2), max: +Math.max(...health).toFixed(2) },
      slowest_queries_p95_ms: Object.fromEntries(
        [...byQuery].map(([q, t]) => [q, +percentile(t, 95).toFixed(2)] as const).sort((a, b) => b[1] - a[1]).slice(0, 5),
      ),
      unique_share: unique.share,
      unique_kind: unique.kind,
      query_server_ms: { samples: took.length, p50: +percentile(took, 50).toFixed(2), p95: +percentile(took, 95).toFixed(2), max: +Math.max(...took).toFixed(2) },
      query_round_trip_ms: { p50: +percentile(roundTrip, 50).toFixed(2), p95: +percentile(roundTrip, 95).toFixed(2) },
      index_heap_mb: +((heapAfter - heapBefore) / 1024 / 1024).toFixed(1),
      index_heap_over_text: +((heapAfter - heapBefore) / seeded.textChars).toFixed(2),
      index_counted_mb: +(stats.indexBytes / 1024 / 1024).toFixed(1),
      index_counted_over_text: +(stats.indexBytes / seeded.textChars).toFixed(2),
      id_buckets: stats.idBuckets,
      late_message_found: (late.groups?.threads ?? []).length === 1,
      late_message_ms: +lateMs.toFixed(1),
      first_total_relay: first.totals,
    };
    if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else log(JSON.stringify(result, null, 2));
  } finally {
    server.stop();
    if (keepAt < 0) rmSync(root, { recursive: true, force: true });
  }
}

const RERUN_MARK = "PLANNOTATOR_BENCH_SCRATCH_HOME_RERUN";

function rerunWithScratchHome(): never {
  if (process.env[RERUN_MARK]) {
    process.stderr.write(`scripts/inbox-search-bench.ts: homedir() is ${homedir()} even with a scratch HOME; refusing to run\n`);
    process.exit(2);
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-search-bench-home-")));
  const env = { ...process.env, HOME: home, USERPROFILE: home, [RERUN_MARK]: "1" };
  const child = Bun.spawnSync([process.execPath, ...process.argv.slice(1)], { env, stdio: ["inherit", "inherit", "inherit"] });
  rmSync(home, { recursive: true, force: true });
  process.exit(child.exitCode ?? 1);
}

if (import.meta.main) {
  if (!isScratchDataDir(homedir())) rerunWithScratchHome();
  await main();
}
