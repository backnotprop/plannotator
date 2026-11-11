// Scratch bench: the runs' JSON lines (results/*.jsonl) as one table: per shape, log and presence, before vs after,
// the median over processes of each process's median list read after a write, with the range across processes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2]!;
type Row = { shape: string; tree: string; log: string; presence: string; threads: number; start_ms: number; list_cold_ms: number; list_unchanged_ms: number; write_median_ms: number; sections_ms: number; rows_json_ms: number; list_after_write: { median: number; p90: number; min: number; max: number } };
const rows: Row[] = [];
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".jsonl")) continue;
  const shape = file.split("-")[0]!;
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) if (line.trim().startsWith("{")) rows.push({ shape, ...JSON.parse(line) });
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const key = `${r.shape}|${r.log}|${r.presence}|${r.tree}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
console.log("| shape | log | presence | tree | threads | runs | list after a write, ms: median (range of run medians) | p90 (worst run) | max | cold list | start | write | server: sections | server: rows' JSON |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [key, rs] of [...groups].sort()) {
  const [shape, log, presence, tree] = key.split("|");
  const meds = rs.map((r) => r.list_after_write.median);
  console.log(
    `| ${shape} | ${log} | ${presence} | ${tree} | ${rs[0]!.threads} | ${rs.length} | ${med(meds)} (${Math.min(...meds)}–${Math.max(...meds)}) | ${Math.max(...rs.map((r) => r.list_after_write.p90))} | ${Math.max(...rs.map((r) => r.list_after_write.max))} | ${med(rs.map((r) => r.list_cold_ms))} | ${med(rs.map((r) => r.start_ms))} | ${med(rs.map((r) => r.write_median_ms))} | ${med(rs.map((r) => r.sections_ms))} | ${med(rs.map((r) => r.rows_json_ms))} |`,
  );
}
