/**
 * Tables from the harness's results (scripts/inbox-perf/README.md):
 *
 *   bun scripts/inbox-perf/summary.ts <results dir> > summary.md
 *
 * Reads every results-<preset>-<label>.json there: the store benchmark's
 * (bench-store.ts) as one table per label, a preset per column, and the live
 * baseline's (live.ts, files named results-<preset>-<label>-live.json) as
 * cold and warm route tables, idle CPU and memory, and the debug log lines.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Timing } from "./bench-store";

const PRESETS = ["small", "medium", "large", "huge"];
const dir = process.argv[2] ?? ".";
const files = readdirSync(dir).filter((f) => /^results-.*\.json$/.test(f));
type Store = { preset: string; label: string; results: Timing[]; counts: Record<string, number>; dataBytes: number; machine: Record<string, unknown>; memory: Record<string, number>[] };
type Live = { preset: string; label: string; cold: { name: string; ms: number; bytes: number; indexReadyMs?: number }[]; warm: Timing[]; idle: { label: string; avgCpuPercent: number; psCpuMax: number; rssMbStart: number; rssMbEnd: number; rssMbMax: number }[]; debug: Record<string, unknown>[]; startup: { healthMs: number }; memoryAtReady: { rssMb: number } | null; memoryAtEnd: { rssMb: number } | null; pollers: number; delivered: number; spawnOrLaunchOutputLines: string[]; realPortSeen: boolean };
const store: Store[] = [];
const live: Live[] = [];
for (const f of files) {
  const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
  if (f.endsWith("-live.json")) live.push(data);
  else store.push(data);
}
const out: string[] = [];
const fmt = (n: number | undefined) => (n === undefined ? "" : n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
const labels = [...new Set(store.map((s) => s.label))].sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)));

if (store.length > 0) {
  const any = store[0]!;
  out.push(`# Inbox performance baseline`, "", `Machine: ${any.machine.platform} ${any.machine.arch}, ${any.machine.cpus} cores, Bun ${any.machine.bun}. Milliseconds, median / p95.`, "");
  out.push("## Store-level benchmark (no server)", "");
  out.push("| preset | threads | messages | agents | launched | data on disk | fresh-process RSS after open | after list |", "|---|---|---|---|---|---|---|---|");
  for (const p of PRESETS) {
    const s = store.find((x) => x.preset === p && x.label === labels[0]);
    if (!s) continue;
    out.push(`| ${p} | ${s.counts.threads} | ${s.counts.messages} | ${(s as unknown as { shape: { agents: number } }).shape.agents} | ${s.counts.launched} | ${(s.dataBytes / 1048576).toFixed(0)} MB | ${Math.round(s.memory[0]!.rssAfterOpenMb as number)} MB | ${Math.round(s.memory[0]!.rssAfterListMb as number)} MB |`);
  }
  out.push("");
  for (const label of labels) {
    const rows = PRESETS.map((p) => store.find((x) => x.preset === p && x.label === label));
    const names = rows.find(Boolean)!.results.map((r) => r.name);
    out.push(`### ${label}`, "", `| measurement | ${PRESETS.filter((_, i) => rows[i]).join(" | ")} | large / medium |`, `|---|${rows.filter(Boolean).map(() => "---").join("|")}|---|`);
    for (const name of names) {
      const cells = rows.filter(Boolean).map((r) => r!.results.find((x) => x.name === name)).map((t) => (t ? `${fmt(t.median)} / ${fmt(t.p95)}` : ""));
      const m = rows[1]?.results.find((x) => x.name === name)?.median;
      const l = rows[2]?.results.find((x) => x.name === name)?.median;
      out.push(`| ${name} | ${cells.join(" | ")} | ${m && l ? `${(l / m).toFixed(1)}x` : ""} |`);
    }
    out.push("");
  }
  if (labels.length > 1) {
    out.push("### Variants against the first label (median, ms)", "");
    const base = labels[0]!;
    const names = store.find((x) => x.label === base)!.results.map((r) => r.name);
    for (const p of PRESETS) {
      const b = store.find((x) => x.preset === p && x.label === base);
      if (!b) continue;
      out.push(`#### ${p}`, "", `| measurement | ${labels.join(" | ")} |`, `|---|${labels.map(() => "---").join("|")}|`);
      for (const name of names) {
        const cells = labels.map((l) => store.find((x) => x.preset === p && x.label === l)?.results.find((r) => r.name === name)?.median);
        const bm = cells[0];
        const changed = cells.slice(1).some((c) => c !== undefined && bm !== undefined && bm > 0.5 && (c < bm * 0.67 || c > bm * 1.5));
        if (!changed) continue;
        out.push(`| ${name} | ${cells.map((c) => fmt(c)).join(" | ")} |`);
      }
      out.push("", "(Only the measurements a variant moved by more than a third, of those over 0.5 ms.)", "");
    }
  }
}

for (const l of live.sort((a, b) => PRESETS.indexOf(a.preset) - PRESETS.indexOf(b.preset))) {
  out.push(`## Live baseline: ${l.preset} (${l.label})`, "");
  out.push(`Ready (health answers) ${l.startup.healthMs} ms after spawn. RSS at ready ${l.memoryAtReady?.rssMb} MB, at the end ${l.memoryAtEnd?.rssMb} MB. ${l.pollers} sessions polling; ${l.delivered} items they took. Real Inbox port seen in output: ${l.realPortSeen}. Spawn or launch lines in output: ${l.spawnOrLaunchOutputLines.length}.`, "");
  out.push("| route | cold (first) | warm median | warm p95 | bytes |", "|---|---|---|---|---|");
  for (const w of l.warm) {
    const c = l.cold.find((x) => x.name === w.name || (w.name === "search" && x.name === "search (first query)"));
    out.push(`| ${w.name} | ${c ? fmt(c.ms) : ""}${c?.indexReadyMs ? ` (index ready ${c.indexReadyMs})` : ""} | ${fmt(w.median)} | ${fmt(w.p95)} | ${(w.note as { bytes?: number })?.bytes ?? ""} |`);
  }
  out.push("", "| idle | avg CPU % | ps %cpu max | RSS start → end (max) MB |", "|---|---|---|---|");
  for (const i of l.idle) out.push(`| ${i.label} | ${i.avgCpuPercent} | ${i.psCpuMax} | ${i.rssMbStart} → ${i.rssMbEnd} (${i.rssMbMax}) |`);
  const kinds = new Map<string, { n: number; max: number; total: number }>();
  for (const d of l.debug) {
    const ev = String(d.ev ?? "?");
    if (ev === "store_load") {
      out.push("", `store_load: ${d.ms} ms (${d.threads} threads, ${d.messages} messages)`);
      continue;
    }
    const key = ev === "slow_req" ? `slow_req ${d.route}` : `loop_stall in ${d.in ?? "?"}${d.route ? ` (${d.route})` : ""}`;
    const k = kinds.get(key) ?? { n: 0, max: 0, total: 0 };
    k.n += 1;
    k.max = Math.max(k.max, Number(d.ms) || 0);
    k.total += Number(d.ms) || 0;
    kinds.set(key, k);
  }
  out.push("", "| debug line | count | max ms | total ms |", "|---|---|---|---|");
  for (const [key, k] of [...kinds].sort((a, b) => b[1].total - a[1].total)) out.push(`| ${key} | ${k.n} | ${k.max} | ${k.total} |`);
  if (kinds.size === 0) out.push("| (none) | | | |");
  out.push("");
}
process.stdout.write(`${out.join("\n")}\n`);
