/**
 * The size budget: an Inbox of 100,000 messages, kept by each record log, starts, lists, opens a thread and
 * searches within fixed ceilings. The SQLite log has to pass the same ceilings (and is expected to beat them).
 *
 * The store is a generated Inbox (`world.ts`, about 5,000 messages) copied whole with fresh ids until it holds
 * the target, appended through the log under test, so the same records reach every log. Ceilings are
 * absolute and generous: this guards a store that gets several times slower, not small drift on a busy
 * laptop. Each number is printed with the machine's load average beside it.
 *
 * On today's JSONL it also times the move into SQLite (`sqlite/import.ts`, check included) and the start after it:
 * what the person waits for on the first start of a version that moves them.
 *
 * Off by default (it writes about 300 MB and takes minutes): `PLANNOTATOR_INBOX_BUDGET=1 bun test
 * packages/shared/inbox/store-log/budget.test.ts`; `PLANNOTATOR_INBOX_BUDGET_MESSAGES` changes the size.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLine, InboxProject } from "@plannotator/core/inbox-types";
import { InboxSearchIndex } from "../search";
import { InboxStore } from "../store";
import { jsonlInboxLog } from "./jsonl-log";
import { LOGS_UNDER_TEST } from "./logs-under-test";
import { importJsonlInbox } from "./sqlite/import";
import { writeInboxWorld } from "./world";

const ON = process.env.PLANNOTATOR_INBOX_BUDGET === "1";
const TARGET = Number(process.env.PLANNOTATOR_INBOX_BUDGET_MESSAGES ?? 100_000);

/**
 * Ceilings in ms at 100,000 messages (30,580 threads). Provisional: about twice today's JSONL store measured
 * 2026-11-11 on a laptop at load average ~30 (start 11.4 s, first list 11.8 s, thread 0.3 ms, search build
 * 23.9 s, a query 0.15 s). Tighten them from a quiet runner's numbers, and again once reads are paged by query.
 * The SQLite log starts from its tables (current state), not by replaying its change log.
 */
const CEILING = { start: 25_000, listCold: 25_000, threadRead: 50, searchBuild: 60_000, searchQuery: 1_000 };

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ID = /\b((?:msg|crd|stp|att|ann)_[0-9A-HJKMNP-TV-Z]{26})\b/g;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The world's lines `copies` times, each copy with its own ids and seqs after the last; projects and initiatives once. */
function copiedLines(lines: InboxLine[], copies: number): InboxLine[] {
  const top = Math.max(...lines.map((l) => l.seq));
  const out: InboxLine[] = lines.filter((l) => l.kind === "project" || l.kind === "initiative");
  const rest = lines.filter((l) => l.kind !== "project" && l.kind !== "initiative");
  for (let c = 0; c < copies; c++) {
    // Copy 0 keeps its ids; copy c's start "1…" where today's start "01" (the time part), so none collide.
    const tag = B32[1 + (c >> 5)]! + B32[c & 31]!;
    for (const line of rest) {
      const text = c === 0 ? JSON.stringify(line) : JSON.stringify(line).replace(ID, (id) => `${id.slice(0, 4)}${tag}${id.slice(6)}`);
      out.push({ ...(JSON.parse(text) as InboxLine), seq: line.seq + c * top });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function timed<T>(run: () => T): { ms: number; value: T } {
  const t = performance.now();
  const value = run();
  return { ms: performance.now() - t, value };
}

describe.skipIf(!ON).each(LOGS_UNDER_TEST)("the size budget through the $name log", ({ name, log }) => {
  test(
    `${TARGET} messages: start, list, thread read and search stay under their ceilings`,
    async () => {
      // One generated Inbox, its lines read back through today's log.
      const seedDir = mkdtempSync(join(tmpdir(), "plannotator-budget-seed-"));
      roots.push(seedDir);
      const world = writeInboxWorld({ dataDir: seedDir, seed: 11, steps: Number.POSITIVE_INFINITY, messages: 5_000, growOnly: true });
      const seedLines = jsonlInboxLog(join(seedDir, "inbox")).read().lines;
      const perCopy = new Set(seedLines.flatMap((l) => (l.kind === "message" ? [l.id] : []))).size;
      const lines = copiedLines(seedLines, Math.ceil(TARGET / perCopy));

      // The same lines, appended through the log under test.
      const dataDir = mkdtempSync(join(tmpdir(), `plannotator-budget-${name}-`));
      roots.push(dataDir);
      const target = log(join(dataDir, "inbox"));
      const projects = new Map<string, InboxProject>();
      const write = timed(() => {
        for (const line of lines) {
          if (line.kind === "project") {
            if (!projects.has(line.id)) target.createProject(line.record, line);
            else target.append(line, line.record);
            projects.set(line.id, line.record);
            continue;
          }
          target.append(line, line.kind === "initiative" ? null : projects.get((line.record as { project_id: string }).project_id)!);
        }
      });

      Bun.gc(true);
      const heapBefore = process.memoryUsage().heapUsed;
      const start = timed(() => InboxStore.open(dataDir, { now: world.now, log }));
      const store = start.value;
      const rss = process.memoryUsage().rss;
      // What the open store holds in JavaScript (the RSS also carries the write phase and SQLite's page cache).
      Bun.gc(true);
      const heldHeap = process.memoryUsage().heapUsed - heapBefore;
      const threads = store.threadIds();
      const messages = threads.reduce((sum, id) => sum + store.threadMessageIds(id).length, 0);
      const listCold = timed(() => store.listRows());
      const sections = timed(() => store.listSections());
      // A typical thread (the median size), read as the window reads it, 50 times.
      const typical = [...threads].sort((a, b) => store.threadMessageIds(a).length - store.threadMessageIds(b).length)[Math.floor(threads.length / 2)]!;
      const threadRead = timed(() => {
        for (let i = 0; i < 50; i++) store.windowThread(typical);
      });
      const index = new InboxSearchIndex(store);
      const searchBuild = await (async () => {
        const t = performance.now();
        await index.ensureBuilt();
        return { ms: performance.now() - t };
      })();
      const rare = timed(() => index.search({ q: "bookmark migration" }));
      const common = timed(() => index.search({ q: "deploy" }));
      const since = timed(() => store.changesSince(store.cursor() - 100));
      index.dispose();
      // The move into SQLite, from these files (JSONL only), and the first start after it.
      const upgrade = name === "jsonl" ? timed(() => importJsonlInbox(dataDir, { now: world.now })) : null;
      const afterUpgrade = upgrade?.value.status === "imported" ? timed(() => InboxStore.open(dataDir, { now: world.now, log: LOGS_UNDER_TEST.find((l) => l.name === "sqlite")!.log })) : null;

      const numbers = {
        log: name,
        messages,
        threads: threads.length,
        load_average: loadavg().map((x) => x.toFixed(1)).join(" "),
        write_all_ms: Math.round(write.ms),
        start_ms: Math.round(start.ms),
        rss_after_start_mb: Math.round(rss / 1e6),
        heap_held_after_start_mb: Math.round(heldHeap / 1e6),
        list_rows_cold_ms: Math.round(listCold.ms),
        list_sections_ms: Math.round(sections.ms),
        thread_read_ms: +(threadRead.ms / 50).toFixed(3),
        search_build_ms: Math.round(searchBuild.ms),
        search_rare_ms: +rare.ms.toFixed(1),
        search_common_ms: +common.ms.toFixed(1),
        changes_since_last_100_ms: +since.ms.toFixed(2),
        ...(upgrade ? { import_ms: Math.round(upgrade.ms), import_status: upgrade.value.status, start_after_import_ms: afterUpgrade ? Math.round(afterUpgrade.ms) : null } : {}),
      };
      console.log(JSON.stringify(numbers));

      expect(messages).toBeGreaterThanOrEqual(TARGET);
      expect(start.ms).toBeLessThan(CEILING.start);
      expect(listCold.ms).toBeLessThan(CEILING.listCold);
      expect(threadRead.ms / 50).toBeLessThan(CEILING.threadRead);
      expect(searchBuild.ms).toBeLessThan(CEILING.searchBuild);
      expect(Math.max(rare.ms, common.ms)).toBeLessThan(CEILING.searchQuery);
    },
    15 * 60_000,
  );
});
