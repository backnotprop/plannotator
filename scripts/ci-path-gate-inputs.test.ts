/**
 * Guard for the three CI path gates: `guides-show` in
 * .github/workflows/test.yml, `qwen-gate` and `diagram-engine-gate` in
 * .github/workflows/windows.yml.
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

const repoRoot = resolve(import.meta.dir, '..');

interface Gate {
  /** The workflow holding the gate job. */
  workflow: string;
  /** The job id whose `gate` step runs the `grep -Eq`. */
  job: string;
  /** The files its job builds or tests. */
  entries: string[];
  /** One input that was outside the pattern, so the walk's reach is pinned. */
  known: string;
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
    job: 'qwen-gate',
    entries: ['scripts/install.test.ts'],
    known: 'packages/shared/plannotator-tool.ts',
  },
  {
    workflow: '.github/workflows/windows.yml',
    job: 'diagram-engine-gate',
    entries: [
      'apps/review/diagram-engine/build.ts',
      'apps/review/diagram-engine/engine.tsx',
      'apps/review/diagram-engine/runtime-mermaid.ts',
      'apps/review/diagram-engine/runtime-graphviz.ts',
    ],
    known: 'packages/ui/components/MermaidBlock.tsx',
  },
];

type Job = { steps?: { id?: string; run?: string }[] };

/** The extended regex a gate job's `gate` step passes to `grep -Eq`. */
function gatePattern({ workflow, job }: Gate): RegExp {
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
function closure(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const pending = entries.map((entry) => resolve(repoRoot, entry));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx)$/.test(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
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
    const inputs = closure(gate.entries);

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
      for (const path of UNRELATED) {
        expect(inputs, `${gate.job}: ${path}`).not.toContain(path);
        expect(pattern.test(path), `${gate.job}: ${path}`).toBe(false);
      }
    });
  }
});
