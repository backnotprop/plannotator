/** Size budget at 100,000 messages for each record log. Off by default (writes ~300 MB): `PLANNOTATOR_INBOX_BUDGET=1 bun test <this file>`; `PLANNOTATOR_INBOX_BUDGET_MESSAGES` sets the size. */
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

/** Ceilings in ms at 100,000 messages: generous, to catch a store several times slower, not small drift. */
const CEILING = { start: 25_000, listCold: 25_000, threadRead: 50, searchBuild: 60_000, searchQuery: 1_000 };

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ID = /\b((?:msg|crd|stp|att|ann)_[0-9A-HJKMNP-TV-Z]{26})\b/g;
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function copiedLines(lines: InboxLine[], copies: number): InboxLine[] {
  const top = Math.max(...lines.map((l) => l.seq));
  const out: InboxLine[] = lines.filter((l) => l.kind === "project" || l.kind === "initiative");
  const rest = lines.filter((l) => l.kind !== "project" && l.kind !== "initiative");
  for (let c = 0; c < copies; c++) {
    // Copy 0 keeps its ids; later copies get ids starting "1…" so none collide.
    const tag = B32[1 + (c >> 5)]! + B32[c & 31]!;
    for (const line of rest) {
      const text = c === 0 ? JSON.stringify(line) : JSON.stringify(line).replace(ID, (id) => `${id.slice(0, 4)}${tag}${id.slice(6)}`);
      out.push({ ...(JSON.parse(text) as InboxLine), seq: line.seq + c * top });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

async function timedAsync<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await run();
  return { ms: performance.now() - t, value };
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
      const seedDir = mkdtempSync(join(tmpdir(), "plannotator-budget-seed-"));
      roots.push(seedDir);
      const world = writeInboxWorld({ dataDir: seedDir, seed: 11, steps: Number.POSITIVE_INFINITY, messages: 5_000, growOnly: true });
      const seedLines = jsonlInboxLog(join(seedDir, "inbox")).read().lines;
      const perCopy = new Set(seedLines.flatMap((l) => (l.kind === "message" ? [l.id] : []))).size;
      const lines = copiedLines(seedLines, Math.ceil(TARGET / perCopy));

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
      const upgrade = name === "jsonl" ? await timedAsync(() => importJsonlInbox(dataDir, { now: world.now })) : null;
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
