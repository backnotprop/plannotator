/**
 * Guard for four CI path gates: `guides-show` in .github/workflows/test.yml,
 * the Qwen Code installer and diagram engine rules of windows.yml's gate
 * (GATES['windows.yml'] and HEAVY_FAIL_SAFE in scripts/ci-affected.ts), and
 * the Browser smoke's gate (GATES['browser-smoke.yml']: the binary is built
 * from apps/hook/server/index.ts, and the smoke was once gated on a hand list
 * that left out 359 of the files it imports, apps/hook/server/cli.ts among them).
 *
 * Each diffs a PR against its base and skips its job when nothing in a fixed
 * pattern changed, and each pattern claims to name every input of its job —
 * diagram-engine-gate says so outright, "Only these files can change what that
 * build does", and the guides-show gate adds "skipping is the risky
 * direction". When a pattern is short, a PR that breaks the job skips the only
 * run that would have said so. All three were short:
 *
 *   - guides-show builds the portable viewer and checks its size budgets (the
 *     release refuses a build that blows one, but that fires at the tag). The
 *     build also reads packages/shared/call-flow-types.ts, through
 *     packages/review-editor's CallFlow components, and build/ — the vite
 *     config's own worker plugin and aliases.
 *   - qwen-installers-windows runs scripts/install.test.ts, which imports
 *     packages/shared/plannotator-tool.ts beside the t3-hook-command.ts the
 *     gate already named.
 *   - diagram-engine-windows builds apps/review/diagram-engine, whose
 *     engine.tsx bundles @plannotator/ui's MermaidBlock and GraphvizBlock and
 *     their tail into packages/core.
 *
 * Source of truth: the import closure of each job's entry files, walked here
 * rather than listed, so a new dependency of a gated job has to be in its
 * gate.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { GATES as WINDOWS_RULES, HEAVY_FAIL_SAFE, buildGraph, decideGates } from './ci-affected';

const repoRoot = resolve(import.meta.dir, '..');

interface Gate {
  /** The workflow holding the gate job. */
  workflow: string;
  /** The job id whose `gate` step runs the `grep -Eq`, `windows:<key>` for a rule of windows.yml's gate, or `browser-smoke:smoke`. */
  job: string;
  /** The files its job builds or tests. */
  entries: string[];
  /** One input that was outside the pattern, so the walk's reach is pinned. */
  known: string;
  /** Paths this job must still skip (default UNRELATED). */
  unrelated?: string[];
  /** Leave out `import type` / `export type ... from`: the job runs the code, and typecheck (every PR) covers the types. */
  runtimeOnly?: boolean;
}

const GATES: Gate[] = [
  {
    workflow: '.github/workflows/test.yml',
    job: 'guides-show',
    entries: ['apps/guides-show/viewer/main.tsx', 'apps/guides-show/vite.viewer.config.ts'],
    known: 'packages/shared/call-flow-types.ts',
  },
  {
    workflow: '.github/workflows/windows.yml',
    job: 'windows:qwen',
    entries: ['scripts/install.test.ts'],
    known: 'packages/shared/plannotator-tool.ts',
  },
  {
    workflow: '.github/workflows/windows.yml',
    job: 'windows:diagram_engine',
    entries: [
      'apps/review/diagram-engine/build.ts',
      'apps/review/diagram-engine/engine.tsx',
      'apps/review/diagram-engine/runtime-mermaid.ts',
      'apps/review/diagram-engine/runtime-graphviz.ts',
    ],
    known: 'packages/ui/components/MermaidBlock.tsx',
  },
  {
    workflow: '.github/workflows/browser-smoke.yml',
    job: 'browser-smoke:smoke',
    entries: ['apps/hook/server/index.ts'],
    known: 'apps/hook/server/cli.ts',
    unrelated: ['README.md', 'apps/marketing/src/pages/index.astro'],
    runtimeOnly: true,
  },
];

type Job = { steps?: { id?: string; run?: string }[] };

/** What a gate runs for: the `grep -Eq` pattern of a gate step, or a windows.yml rule's globs with the heavy fail-safe. */
// The picker's graph of this checkout, built once before the tests (not inside a test's time).
const graph = buildGraph();
function gatePattern({ workflow, job }: Gate): { test: (path: string) => boolean } {
  if (job === 'browser-smoke:smoke') {
    return { test: (path) => decideGates('browser-smoke.yml', 'subset', [], [{ status: 'M', path, added: [], removed: [] }], undefined, graph)[0]!.run };
  }
  if (job.startsWith('windows:')) {
    const rule = WINDOWS_RULES['windows.yml']!.find((g) => g.key === job.slice('windows:'.length));
    if (!rule) throw new Error(`windows.yml: no gate rule ${job}`);
    const globs = [...rule.paths, ...HEAVY_FAIL_SAFE].map((g) => new Bun.Glob(g));
    return { test: (path) => globs.some((g) => g.match(path)) };
  }
  const parsed = Bun.YAML.parse(readFileSync(join(repoRoot, workflow), 'utf8')) as { jobs: Record<string, Job> };
  const step = parsed.jobs[job]?.steps?.find((s) => s.id === 'gate');
  const match = /grep -Eq '([^']+)'/.exec(step?.run ?? '');
  if (!match) throw new Error(`${workflow}: the ${job} \`gate\` step has no \`grep -Eq '<pattern>'\``);
  return new RegExp(match[1]);
}

const workspacePackages = new Map<string, string>();
for (const manifest of new Bun.Glob('packages/*/package.json').scanSync(repoRoot)) {
  const name = (JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8')) as { name: string }).name;
  workspacePackages.set(name, dirname(manifest));
}

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx'];

/** The repo file a relative or `@plannotator/*` specifier names; null for anything else (npm, assets). */
function resolveSpecifier(specifier: string, importer: string): string | null {
  let base: string;
  if (specifier.startsWith('.')) {
    base = resolve(dirname(importer), specifier);
  } else if (specifier.startsWith('@plannotator/')) {
    const [, scope, ...rest] = specifier.split('/');
    const dir = workspacePackages.get(`@plannotator/${scope}`);
    if (dir === undefined) return null;
    base = resolve(repoRoot, dir, ...rest);
  } else {
    return null;
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/** Every repo file the entries reach, static and dynamic imports alike, as repo-relative paths. */
function closure(entries: readonly string[], runtimeOnly = false): string[] {
  const seen = new Set<string>();
  const pending = entries.map((entry) => resolve(repoRoot, entry));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx)$/.test(file)) continue;
    let source = readFileSync(file, 'utf8');
    if (runtimeOnly) source = source.replace(/^\s*(?:import|export)\s+type\s[^;]*?from\s*['"][^'"]+['"];?/gm, '');
    for (const match of source.matchAll(SPECIFIER)) {
      const target = resolveSpecifier(match[1], file);
      if (target !== null && !seen.has(target)) pending.push(target);
    }
  }
  return [...seen].map((file) => relative(repoRoot, file)).sort();
}

/** Paths in no gated job: a pattern widened to everything must still fail. */
const UNRELATED = ['README.md', 'packages/inbox/App.tsx', 'apps/marketing/src/pages/index.astro'];

describe('CI path gates cover the jobs they gate', () => {
  for (const gate of GATES) {
    const inputs = closure(gate.entries, gate.runtimeOnly);

    test(`${gate.job}: the closure walk reached its job (a resolver regression must not pass vacuously)`, () => {
      // Without this the coverage assertion would pass on an empty closure.
      for (const entry of gate.entries) expect(inputs).toContain(entry);
      expect(inputs).toContain(gate.known);
    });

    test(`${gate.job}: every file its job reads is in the gate pattern`, () => {
      const pattern = gatePattern(gate);
      const uncovered = inputs.filter((input) => !pattern.test(input));
      expect(
        uncovered,
        `${gate.job} skips a PR that only touches these, so its job never runs on it — widen the pattern in ${gate.workflow}.`,
      ).toEqual([]);
    });

    test(`${gate.job}: still skips a PR that touches none of its job`, () => {
      const pattern = gatePattern(gate);
      for (const path of gate.unrelated ?? UNRELATED) {
        expect(inputs, `${gate.job}: ${path}`).not.toContain(path);
        expect(pattern.test(path), `${gate.job}: ${path}`).toBe(false);
      }
    });
  }
});
