// Fuzz test: random stacks built with real git in temp repos, each layer one
// or more commits. Every label the map gives must name the layer that wrote
// the line, as defined in stack-layers.ts: the layer whose own (squashed)
// diff shows it added, with no layer above changing it. The module may say
// less, never something false.
//
// Two oracles: a plain walk down the layers' own diffs (the definition), and
// `git blame` over the stack with each layer squashed to one commit.

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { diffHunkLines, parseDiffToFiles, type DiffFile } from "./diff-files";
import { lineOrigin, mapStackLines, type StackLineMap } from "./stack-layers";

// Git must see only the temp repo: no GIT_DIR or GIT_INDEX_FILE from a hook
// that runs these tests, and no user or system config.
const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
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

/** mulberry32: a small deterministic random source, so a failure replays from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] };
}
type Random = ReturnType<typeof random>;

/** Repeated lines (braces, blanks) make diffs ambiguous, the hard case for following lines. */
const REPEATED = ["}", "", "  return null;", "{"];

function readLines(dir: string, path: string): string[] | null {
  try {
    const text = readFileSync(join(dir, path), "utf8");
    return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  } catch {
    return null;
  }
}

function writeLines(dir: string, path: string, lines: readonly string[]): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), lines.map((line) => `${line}\n`).join(""));
}

/** One commit's random edits: insert, delete, rewrite, re-indent, rename or delete a file, or add one back. */
function editCommit(dir: string, files: string[], layer: number, rnd: Random): void {
  const text = () => (rnd.next() < 0.4 ? rnd.pick(REPEATED) : `x${rnd.int(1e6)} by L${layer}`);
  for (let op = 1 + rnd.int(4); op > 0; op--) {
    const index = rnd.int(files.length);
    const path = files[index];
    const lines = readLines(dir, path);
    if (!lines) {
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
      if (kind < 0.3) lines.splice(at, 0, ...Array.from({ length: 1 + rnd.int(4) }, text));
      else if (kind < 0.5 && lines.length > 1) lines.splice(Math.min(at, lines.length - 1), 1 + rnd.int(3));
      else if (kind < 0.65) for (let i = at; i < Math.min(lines.length, at + 3 + rnd.int(8)); i++) lines[i] = `  ${lines[i]}`;
      else if (lines.length > 0) lines[Math.min(at, lines.length - 1)] = kind < 0.9 ? text() : `base ${at}`;
      writeLines(dir, path, lines);
    }
  }
}

/** The layer (0-based) a top line belongs to by the definition: walk down the layers' own diffs. -1 for base, null when a binary step hides it. */
function definedWriter(layers: readonly DiffFile[][], path: string, line: number): number | null {
  let p = path;
  let n = line;
  for (let k = layers.length - 1; k >= 0; k--) {
    const file = layers[k].find((f) => f.status !== "deleted" && f.path === p);
    if (!file) continue;
    const hunks = diffHunkLines(file.patch);
    if (!hunks) return null;
    if (hunks.length === 0 && /^Binary files /m.test(file.patch)) return null;
    let old = n;
    let shift = 0;
    for (const hunk of hunks) {
      if (n < hunk.newStart) break;
      if (n < hunk.newEnd) {
        const at = hunk.lines.find((l) => l.kind !== "del" && l.newLine === n)!;
        if (at.kind === "add") return k;
        if (at.kind === "context") old = at.oldLine;
        shift = Number.NaN;
        break;
      }
      shift = hunk.oldEnd - hunk.newEnd;
    }
    n = Number.isNaN(shift) ? old : n + shift;
    p = file.oldPath ?? file.path;
  }
  return -1;
}

/** Layer index (0-based) of the squashed commit that wrote each line of a file at the top, by `git blame`; -1 for base. */
function squashedBlame(dir: string, commits: readonly string[], path: string): number[] {
  const out: number[] = [];
  for (const row of git(dir, "blame", "--porcelain", commits.at(-1)!, "--", path).split("\n")) {
    const match = /^([0-9a-f]{40}) \d+ (\d+)/.exec(row);
    if (match) out[Number(match[2])] = commits.indexOf(match[1]) - 1;
  }
  return out;
}

interface Audit {
  added: number;
  labelled: number;
  wrong: string[];
  /** Labels squashed blame disagrees with (it places some blocks other than the diffs do). */
  blameDisagrees: string[];
}

/** Every label checked against the definition and against squashed blame. */
function audit(dir: string, squashed: readonly string[], layers: readonly string[], map: StackLineMap, review: string): Audit {
  const result: Audit = { added: 0, labelled: 0, wrong: [], blameDisagrees: [] };
  const layerFiles = layers.map((patch) => parseDiffToFiles(patch));
  for (const file of parseDiffToFiles(review)) {
    if (file.status === "deleted") continue;
    const blame = squashedBlame(dir, squashed, file.path);
    for (const hunk of diffHunkLines(file.patch) ?? []) {
      for (const line of hunk.lines) {
        if (line.kind !== "add") continue;
        result.added += 1;
        const origin = lineOrigin(map, { path: file.path, start: line.newLine, end: line.newLine });
        if (origin.kind === "unknown") continue;
        result.labelled += 1;
        const ids = origin.kind === "layer" ? [origin.id] : origin.ids;
        const writer = map.ids.indexOf(ids.at(-1)!);
        const earlier = ids.slice(0, -1).map((id) => map.ids.indexOf(id));
        const where = `${file.path}:${line.newLine} ${JSON.stringify(origin)}`;
        const defined = definedWriter(layerFiles, file.path, line.newLine);
        if (writer !== defined || earlier.some((layer) => layer >= writer)) result.wrong.push(`${where} defined=${defined}`);
        if (writer !== blame[line.newLine]) result.blameDisagrees.push(`${where} blame=${blame[line.newLine]}`);
      }
    }
  }
  return result;
}

/** A random stack in a fresh repo: each layer 1–4 commits, its diff squashed; sometimes a layer's diff lacks its `index` lines. */
function randomStack(root: string, seed: number) {
  const rnd = random(seed);
  const dir = mkdtempSync(join(root, `s${seed}-`));
  git(dir, "init", "-q");
  const files = ["a.ts", "b.ts", "src/c.ts"];
  for (const path of files) writeLines(dir, path, Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? rnd.pick(REPEATED) : `base ${i}`)));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const heads = [git(dir, "rev-parse", "HEAD").trim()];
  const layerCount = 2 + rnd.int(4);
  for (let layer = 1; layer <= layerCount; layer++) {
    for (let commit = 1 + rnd.int(4); commit > 0; commit--) {
      editCommit(dir, files, layer, rnd);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "--allow-empty", "-m", `L${layer}`);
    }
    heads.push(git(dir, "rev-parse", "HEAD").trim());
  }
  // The same trees, one commit per layer, for blame.
  const squashed = [heads[0]];
  for (const head of heads.slice(1)) squashed.push(git(dir, "commit-tree", `${head}^{tree}`, "-p", squashed.at(-1)!, "-m", "layer").trim());
  const stripped = rnd.next() < 0.2 ? rnd.int(layerCount) : -1;
  const layers = heads.slice(1).map((head, i) => {
    const diff = git(dir, "diff", heads[i], head);
    return i === stripped ? diff.replace(/^index .*\n/gm, "") : diff;
  });
  return { dir, squashed, layers, review: git(dir, "diff", heads[0], heads.at(-1)!) };
}

// Eight stacks keep this under 5 s. Set STACK_LAYERS_FUZZ_SEEDS for a longer run.
const SEEDS = Number(process.env.STACK_LAYERS_FUZZ_SEEDS ?? 8);

describe("labels against the definition and squashed blame", () => {
  const root = mkdtempSync(join(tmpdir(), "stack-layers-blame-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("never names a layer that did not write the line", () => {
    const total: Audit = { added: 0, labelled: 0, wrong: [], blameDisagrees: [] };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { dir, squashed, layers, review } = randomStack(root, seed);
      const map = mapStackLines(
        layers.map((patch, i) => ({ id: `L${i + 1}`, patch })),
        { reviewPatch: review },
      );
      const result = audit(dir, squashed, layers, map, review);
      total.added += result.added;
      total.labelled += result.labelled;
      total.wrong.push(...result.wrong.map((label) => `seed ${seed}: ${label}`));
      total.blameDisagrees.push(...result.blameDisagrees.map((label) => `seed ${seed}: ${label}`));
    }
    expect(total.wrong).toEqual([]);
    // Blame agrees on these stacks. On real code it can differ at a block's
    // edge: blame diffs with no context and may place an inserted block a line
    // or two from where the `-U3` diff a forge shows places it. The diff is the
    // definition; a disagreement here is a reason to look, not proof of a bug.
    expect(total.blameDisagrees).toEqual([]);
    // Saying nothing would pass too: most changed lines must get a label.
    expect(total.labelled / total.added).toBeGreaterThan(0.6);
  }, 600_000);
});
