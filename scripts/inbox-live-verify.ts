/**
 * The Inbox live-behaviour verifier: run it against a build, save a baseline, compare a later build with it.
 *
 *   bun scripts/inbox-live-verify.ts run [--binary <path>] [--sizes small,10k,100k] [--profiles local,throttled,hotel]
 *                                        [--runs 5] [--query "?data=db"] [--out <file.json>]
 *   bun scripts/inbox-live-verify.ts compare <baseline.json> <new.json> [--md <table.md>]
 *   bun scripts/inbox-live-verify.ts table <result.json> [--md <table.md>]
 *   bun scripts/inbox-live-verify.ts merge <out.json> <a.json> <b.json>…
 *
 * `run` makes one throwaway sandbox per store size and link (scripts/test-sandbox.ts `makeSandbox`: scratch HOME,
 * data dir, no browser, no ping) and runs tests/live-verify/inbox-live.verify.ts in it under its own Playwright
 * config, so it never joins `bun test` or the e2e shards. It never touches the person's Inbox or ~/.plannotator.
 * `compare` prints baseline vs new per rule (pass/fail) and per stat (median and p95, with the tolerances below)
 * and exits 1 on any regression.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");

export interface Stat {
  unit: "ms" | "count" | "bytes" | "MB";
  samples: number[];
  median: number | null;
  p95: number | null;
}
export interface Rule {
  id: string;
  title: string;
  pass: boolean;
  ms?: number | null;
  detail?: unknown;
}
export interface RunResult {
  meta: Record<string, unknown> & { size: string; profile: string };
  rules: Record<string, Rule>;
  stats: Record<string, Stat>;
}
export interface Suite {
  meta: Record<string, unknown>;
  runs: Record<string, RunResult>;
}

/**
 * How much worse a stat may get before it counts as a regression. Both the median and the p95 are judged; either
 * past its line is a regression. Proposed from the run-to-run spread of the baseline on one machine (see the brief).
 */
export const TOLERANCE: Record<Stat["unit"], { medianPct: number; medianAbs: number; p95Pct: number; p95Abs: number }> = {
  ms: { medianPct: 0.25, medianAbs: 40, p95Pct: 0.5, p95Abs: 100 },
  count: { medianPct: 0.2, medianAbs: 1, p95Pct: 0.5, p95Abs: 2 },
  bytes: { medianPct: 0.25, medianAbs: 4096, p95Pct: 0.5, p95Abs: 8192 },
  MB: { medianPct: 0.2, medianAbs: 30, p95Pct: 0.2, p95Abs: 30 },
};

export type Verdict = "same" | "better" | "worse" | "new" | "missing";

/** One stat, baseline vs new: worse when the median or the p95 passed its line; better when both are clearly lower. */
export function judgeStat(base: Stat | undefined, next: Stat | undefined): Verdict {
  if (!base || base.median === null) return next && next.median !== null ? "new" : "missing";
  if (!next || next.median === null) return "missing";
  const t = TOLERANCE[base.unit];
  const line = (b: number, pct: number, abs: number) => b + Math.max(b * pct, abs);
  const worse = next.median > line(base.median, t.medianPct, t.medianAbs) || (base.p95 !== null && next.p95 !== null && next.p95 > line(base.p95, t.p95Pct, t.p95Abs));
  if (worse) return "worse";
  const better = next.median < base.median - Math.max(base.median * t.medianPct, t.medianAbs);
  return better ? "better" : "same";
}

/** One rule: a pass that now fails is the regression; a missing rule in the new run counts as one too. */
export function judgeRule(base: Rule | undefined, next: Rule | undefined): "pass" | "fail" | "fixed" | "regressed" | "new" | "missing" {
  if (!base) return next ? "new" : "missing";
  if (!next) return "missing";
  if (base.pass && !next.pass) return "regressed";
  if (!base.pass && next.pass) return "fixed";
  return next.pass ? "pass" : "fail";
}

export interface Comparison {
  lines: string[];
  regressions: string[];
}

const fmt = (s: Stat | undefined, k: "median" | "p95") => (s && s[k] !== null ? `${s[k]}${s.unit === "ms" ? " ms" : s.unit === "MB" ? " MB" : s.unit === "bytes" ? " B" : ""}` : "-");

export function compare(base: Suite, next: Suite): Comparison {
  const lines: string[] = [];
  const regressions: string[] = [];
  lines.push(`Baseline: ${base.meta.binaryVersion ?? "?"} (${base.meta.verifierCommit ?? "?"}) · New: ${next.meta.binaryVersion ?? "?"} (${next.meta.verifierCommit ?? "?"})`, "");
  for (const key of new Set([...Object.keys(base.runs), ...Object.keys(next.runs)])) {
    const b = base.runs[key];
    const n = next.runs[key];
    const busy = [b, n].filter((r) => r?.meta?.provisional).map((r) => (r === b ? "baseline" : "new"));
    lines.push(`### ${key}`, "");
    if (busy.length) lines.push(`Provisional timings (${busy.join(" and ")} taken on a busy machine, load ${[b, n].map((r) => (r?.meta as { loadAtStart?: number[] } | undefined)?.loadAtStart?.[0] ?? "?").join(" / ")}): time verdicts are not trustworthy; rules still are.`, "");
    lines.push("| Rule | Baseline | New | Verdict |", "|---|---|---|---|");
    const ids = [...new Set([...Object.keys(b?.rules ?? {}), ...Object.keys(n?.rules ?? {})])].sort();
    for (const id of ids) {
      const v = judgeRule(b?.rules[id], n?.rules[id]);
      if (v === "regressed" || (v === "missing" && b?.rules[id])) regressions.push(`${key} ${id} ${v}`);
      const show = (r: Rule | undefined) => (r ? `${r.pass ? "pass" : "FAIL"}${typeof r.ms === "number" ? ` (${r.ms} ms)` : ""}` : "-");
      lines.push(`| ${id} ${(b?.rules[id] ?? n?.rules[id])?.title ?? ""} | ${show(b?.rules[id])} | ${show(n?.rules[id])} | ${v} |`);
    }
    lines.push("", "| Stat | Base median | New median | Base p95 | New p95 | Verdict |", "|---|---|---|---|---|---|");
    const stats = [...new Set([...Object.keys(b?.stats ?? {}), ...Object.keys(n?.stats ?? {})])].sort();
    for (const s of stats) {
      const v = judgeStat(b?.stats[s], n?.stats[s]);
      if (v === "worse" || (v === "missing" && b?.stats[s]?.median !== null && b?.stats[s] !== undefined)) regressions.push(`${key} ${s} ${v}`);
      lines.push(`| ${s} | ${fmt(b?.stats[s], "median")} | ${fmt(n?.stats[s], "median")} | ${fmt(b?.stats[s], "p95")} | ${fmt(n?.stats[s], "p95")} | ${v} |`);
    }
    lines.push("");
  }
  lines.push(regressions.length ? `REGRESSIONS (${regressions.length}):\n- ${regressions.join("\n- ")}` : "No regressions.");
  return { lines, regressions };
}

/** One result alone, as a table (the baseline's own report). */
export function table(suite: Suite): string[] {
  const lines: string[] = [];
  for (const [key, r] of Object.entries(suite.runs)) {
    const m = r.meta as { provisional?: boolean; loadAtStart?: number[]; loadAtEnd?: number[] };
    lines.push(`### ${key}`, "", `Load average at start / end: ${m.loadAtStart?.join(", ") ?? "?"} / ${m.loadAtEnd?.join(", ") ?? "?"}${m.provisional ? " — PROVISIONAL: taken on a busy machine, re-record when idle" : ""}`, "", "| Rule | Result |", "|---|---|");
    for (const id of Object.keys(r.rules).sort()) {
      const x = r.rules[id]!;
      lines.push(`| ${id} ${x.title} | ${x.pass ? "pass" : "FAIL"}${typeof x.ms === "number" ? ` (${x.ms} ms)` : ""} |`);
    }
    lines.push("", "| Stat | Median | p95 | Samples |", "|---|---|---|---|");
    for (const s of Object.keys(r.stats).sort()) lines.push(`| ${s} | ${fmt(r.stats[s], "median")} | ${fmt(r.stats[s], "p95")} | ${r.stats[s]!.samples.length} |`);
    lines.push("");
  }
  return lines;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function run(argv: string[]): Promise<number> {
  const { makeSandbox, teardown } = await import("./test-sandbox");
  const binary = resolve(flag(argv, "binary") ?? join(REPO, ".local/plannotator"));
  if (!existsSync(binary)) throw new Error(`no binary at ${binary}`);
  const sizes = (flag(argv, "sizes") ?? "small,10k").split(",");
  const profiles = (flag(argv, "profiles") ?? "local").split(",");
  const runs = flag(argv, "runs") ?? "5";
  // `--query "?data=db"`: the page address suffix, for a window that switches data layer by its address (the prototype).
  const query = flag(argv, "query") ?? "";
  const out = resolve(flag(argv, "out") ?? join(REPO, ".local/live-verify/result.json"));
  const suite: Suite = { meta: {}, runs: {} };
  let failed = 0;
  for (const size of sizes)
    for (const profile of profiles) {
      const sandbox = makeSandbox(process.env);
      const part = join(sandbox.root, "result.json");
      try {
        const child = spawnSync(join(REPO, "node_modules/.bin/playwright"), ["test", "-c", "tests/live-verify/playwright.config.ts"], {
          cwd: REPO,
          stdio: "inherit",
          env: { ...sandbox.env, PLANNOTATOR_E2E_BINARY: binary, LIVE_SIZE: size, LIVE_PROFILE: profile, LIVE_RUNS: runs, LIVE_QUERY: query, LIVE_OUT: part, LIVE_LOG: `${out}.${size}-${profile}.log` },
        });
        if (child.status !== 0) failed += 1;
        if (existsSync(part)) {
          const r = JSON.parse(readFileSync(part, "utf8")) as RunResult;
          suite.runs[`${size}/${profile}`] = r;
          suite.meta = { ...r.meta, size: undefined, profile: undefined, sizeShape: undefined };
        }
      } finally {
        const owner = await teardown(sandbox.root);
        if (owner.length) process.stderr.write(`inbox-live-verify: registries naming the person's port, never contacted: ${owner.join(", ")}\n`);
      }
    }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(suite, null, 2));
  process.stdout.write(`${table(suite).join("\n")}\nWrote ${out}\n`);
  return failed ? 2 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "run") return run(rest);
  if (cmd === "merge") {
    // merge <out.json> <a.json> <b.json>…: one suite from several runs (say local and throttled), later keys win.
    const [outFile, ...inputs] = rest;
    if (!outFile || inputs.length === 0) throw new Error("merge <out.json> <in.json>…");
    const merged: Suite = { meta: {}, runs: {} };
    for (const file of inputs) {
      const s = JSON.parse(readFileSync(file, "utf8")) as Suite;
      merged.meta = { ...merged.meta, ...s.meta };
      Object.assign(merged.runs, s.runs);
    }
    writeFileSync(outFile, JSON.stringify(merged, null, 2));
    return 0;
  }
  if (cmd === "compare" || cmd === "table") {
    const files = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));
    const md = flag(rest, "md");
    let text: string[];
    let code = 0;
    if (cmd === "compare") {
      if (files.length !== 2) throw new Error("compare <baseline.json> <new.json>");
      const c = compare(JSON.parse(readFileSync(files[0]!, "utf8")), JSON.parse(readFileSync(files[1]!, "utf8")));
      text = c.lines;
      code = c.regressions.length ? 1 : 0;
    } else text = table(JSON.parse(readFileSync(files[0]!, "utf8")));
    process.stdout.write(`${text.join("\n")}\n`);
    if (md) writeFileSync(md, `${text.join("\n")}\n`);
    return code;
  }
  process.stderr.write("usage: bun scripts/inbox-live-verify.ts run|compare|table … (see the file's header)\n");
  return 64;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
