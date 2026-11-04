// Fuzz test: random stacks built with real git in temp repos. Every label the
// map gives must name the layer `git blame` names for that line: the module
// may say less, never something false.

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { diffHunkLines, parseDiffToFiles } from "./diff-files";
import { lineOrigin, mapStackLines, type StackLineMap } from "./stack-layers";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A deterministic random source, so a failure can be replayed by its seed. */
function random(seed: number) {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] };
}

/** Repeated lines (braces, blanks) make diffs ambiguous, the hard case for following lines. */
const REPEATED = ["}", "", "  return null;", "{"];

function readLines(dir: string, path: string): string[] {
  const text = readFileSync(join(dir, path), "utf8");
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function writeLines(dir: string, path: string, lines: readonly string[]): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), lines.map((line) => `${line}\n`).join(""));
}

/** One layer's random edits: insert, delete, rewrite, rename or delete a file, or add one back. */
function editLayer(dir: string, files: string[], layer: number, rnd: ReturnType<typeof random>): void {
  const text = () => (rnd.next() < 0.4 ? rnd.pick(REPEATED) : `x${rnd.int(1e6)} by L${layer}`);
  for (let op = 1 + rnd.int(5); op > 0; op--) {
    const index = rnd.int(files.length);
    const path = files[index];
    let lines: string[] | null = null;
    try {
      lines = readLines(dir, path);
    } catch {
      writeLines(dir, path, Array.from({ length: 5 + rnd.int(10) }, text));
      continue;
    }
    const roll = rnd.next();
    if (roll < 0.04) rmSync(join(dir, path));
    else if (roll < 0.08) {
      files[index] = path.replace(".ts", `${layer}.ts`);
      renameSync(join(dir, path), join(dir, files[index]));
    } else {
      const at = rnd.int(lines.length + 1);
      const kind = rnd.next();
      if (kind < 0.35) lines.splice(at, 0, ...Array.from({ length: 1 + rnd.int(4) }, text));
      else if (kind < 0.6 && lines.length > 1) lines.splice(Math.min(at, lines.length - 1), 1 + rnd.int(3));
      else if (lines.length > 0) lines[Math.min(at, lines.length - 1)] = kind < 0.85 ? text() : `base ${at}`;
      writeLines(dir, path, lines);
    }
  }
}

/** Layer index (0-based) of the commit that wrote each line of a file at the top, by `git blame`; -1 for base. */
function blame(dir: string, top: string, path: string, commits: readonly string[]): number[] {
  const out: number[] = [];
  for (const row of git(dir, "blame", "--porcelain", top, "--", path).split("\n")) {
    const match = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row);
    if (match) out[Number(match[2])] = commits.indexOf(match[1]) - 1;
  }
  return out;
}

/** Labels that disagree with blame, and how many of the review's `+` lines got a label. */
function audit(dir: string, commits: readonly string[], map: StackLineMap, review: string) {
  const wrong: string[] = [];
  let added = 0;
  let labelled = 0;
  for (const file of parseDiffToFiles(review)) {
    if (file.status === "deleted") continue;
    const truth = blame(dir, commits.at(-1)!, file.path, commits);
    for (const hunk of diffHunkLines(file.patch) ?? []) {
      for (const line of hunk.lines) {
        if (line.kind !== "add") continue;
        added += 1;
        const origin = lineOrigin(map, { path: file.path, start: line.newLine, end: line.newLine });
        if (origin.kind === "unknown") continue;
        labelled += 1;
        const ids = origin.kind === "layer" ? [origin.id] : origin.ids;
        const writer = map.ids.indexOf(ids.at(-1)!);
        const earlier = ids.slice(0, -1).map((id) => map.ids.indexOf(id));
        if (writer !== truth[line.newLine] || earlier.some((layer) => layer >= writer)) {
          wrong.push(`${file.path}:${line.newLine} ${JSON.stringify(origin)} blame=L${truth[line.newLine] + 1}`);
        }
      }
    }
  }
  return { wrong, added, labelled };
}

/** Builds a random stack in a fresh repo; returns its layers' diffs and the whole-stack diff. */
function randomStack(root: string, seed: number) {
  const rnd = random(seed);
  const dir = mkdtempSync(join(root, `s${seed}-`));
  git(dir, "init", "-q");
  const files = ["a.ts", "b.ts", "src/c.ts"];
  for (const path of files) writeLines(dir, path, Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? rnd.pick(REPEATED) : `base ${i}`)));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const layers = 2 + rnd.int(4);
  for (let layer = 1; layer <= layers; layer++) {
    editLayer(dir, files, layer, rnd);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", `L${layer}`);
  }
  const commits = git(dir, "rev-list", "--reverse", "HEAD").trim().split("\n");
  const stack = commits.slice(1).map((commit, i) => ({ id: `L${i + 1}`, patch: git(dir, "diff", commits[i], commit) }));
  return { dir, commits, stack, review: git(dir, "diff", commits[0], commits.at(-1)!) };
}

// A dozen stacks keep this near 3 s. Set STACK_LAYERS_FUZZ_SEEDS for a longer run.
const SEEDS = Number(process.env.STACK_LAYERS_FUZZ_SEEDS ?? 12);

describe("labels against git blame", () => {
  const root = mkdtempSync(join(tmpdir(), "stack-layers-blame-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("never names a layer that did not write the line", () => {
    let added = 0;
    let labelled = 0;
    const wrong: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { dir, commits, stack, review } = randomStack(root, seed);
      const map = mapStackLines(stack, { reviewPatch: review });
      expect(map.status).toBe("ok");
      const result = audit(dir, commits, map, review);
      added += result.added;
      labelled += result.labelled;
      wrong.push(...result.wrong.map((label) => `seed ${seed}: ${label}`));
    }
    expect(wrong).toEqual([]);
    // Saying nothing would pass too: most changed lines must get a label.
    expect(labelled / added).toBeGreaterThan(0.75);
  }, 120_000);
});
