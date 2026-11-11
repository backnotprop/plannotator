// Scratch bench: feed.ts results (results-feed/*.jsonl) as one table per shape and log, before vs after: the median
// over processes of each process's median, with the range of those medians.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2]!;
type Stat = { median: number; p90: number; max: number } | null;
type Row = { shape: string; tree: string; log: string; threads: number; start_ms: number; frame_ms: Stat; frame_bytes: Stat; since_read_ms: Stat; since_read_bytes: Stat; full_read_ms: Stat; full_read_bytes: Stat; first_window_read: { ms: number; bytes: number }; first_full_read: { ms: number; bytes: number } };
const rows: Row[] = [];
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".jsonl")) continue;
  const shape = file.split("-")[0]!;
  for (const line of readFileSync(join(dir, file), "utf8").split("\n")) if (line.trim().startsWith("{")) rows.push({ shape, ...JSON.parse(line) });
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const cell = (rs: Row[], pick: (r: Row) => Stat) => {
  const xs = rs.map(pick).filter((s): s is NonNullable<Stat> => s !== null);
  if (xs.length === 0) return "—";
  const meds = xs.map((s) => s.median);
  return `${med(meds)} (${Math.min(...meds)}–${Math.max(...meds)}; p90 ≤ ${Math.max(...xs.map((s) => s.p90))})`;
};
const groups = new Map<string, Row[]>();
for (const r of rows) groups.set(`${r.shape}|${r.log}|${r.tree}`, [...(groups.get(`${r.shape}|${r.log}|${r.tree}`) ?? []), r]);
console.log("| shape | log | tree | threads | runs | list frame: write → frame, ms | frame bytes | window's since read, ms | its bytes | phone's whole read, ms | its bytes | first window read ms / bytes | start ms |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [key, rs] of [...groups].sort()) {
  const [shape, log, tree] = key.split("|");
  console.log(
    `| ${shape} | ${log} | ${tree} | ${rs[0]!.threads} | ${rs.length} | ${cell(rs, (r) => r.frame_ms)} | ${cell(rs, (r) => r.frame_bytes)} | ${cell(rs, (r) => r.since_read_ms)} | ${cell(rs, (r) => r.since_read_bytes)} | ${cell(rs, (r) => r.full_read_ms)} | ${cell(rs, (r) => r.full_read_bytes)} | ${med(rs.map((r) => r.first_window_read.ms))} / ${med(rs.map((r) => r.first_window_read.bytes))} | ${med(rs.map((r) => r.start_ms))} |`,
  );
}
