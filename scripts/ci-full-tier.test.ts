/**
 * Guard for the two CI tiers (docs/agent-guides/project-and-development.md,
 * "CI tiers").
 *
 * The merge script merges a PR only when its fast-tier checks and every
 * `Full CI (all green)` check on its head succeeded. Each failure this
 * catches would let a PR merge with part of the heavy tier never run:
 *  - a heavy job missing from its workflow's gate (a skipped or failed job
 *    would not hold the gate back);
 *  - a heavy workflow that does not run when the `ci:full` label is added, or
 *    a root job that ignores the label;
 *  - the fast tier rerunning (and cancelling itself) on every label change.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const GATE = 'Full CI (all green)';
const LABEL_CHECK = "contains(github.event.pull_request.labels.*.name, 'ci:full')";
const HEAVY = ['windows.yml', 'release.yml', 'inbox-e2e.yml', 'inbox-pi.yml', 'inbox-claude-code.yml', 'relay.yml'];
const FAST = ['test.yml', 'security.yml'];

type Job = { name?: string; if?: string; needs?: string | string[] };
type Workflow = { on: { pull_request?: { types?: string[] } }; jobs: Record<string, Job> };

function workflow(file: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows', file), 'utf8')) as Workflow;
}

const needsOf = (job: Job) => (job.needs === undefined ? [] : [job.needs].flat());
/** Jobs that never run on a PR: the release's tag-only publishing jobs. */
const tagOnly = (job: Job) => (job.if ?? '').includes("startsWith(github.ref, 'refs/tags/v')");

describe('CI tiers', () => {
  for (const file of HEAVY) {
    test(`${file}: runs when ci:full is added, and its gate needs every PR job`, () => {
      const wf = workflow(file);
      expect(wf.on.pull_request?.types).toContain('labeled');
      const { 'full-ci': gate, ...jobs } = wf.jobs;
      expect(gate?.name).toBe(GATE);
      expect(gate.if).toContain('!cancelled()');
      expect(gate.if).toContain(LABEL_CHECK);
      const prJobs = Object.entries(jobs).filter(([, job]) => !tagOnly(job));
      expect([...needsOf(gate)].sort()).toEqual(prJobs.map(([id]) => id).sort());
      for (const [id, job] of prJobs) {
        if (needsOf(job).length === 0) expect(job.if, `${file}: ${id}`).toContain(LABEL_CHECK);
      }
    });
  }

  for (const file of FAST) {
    test(`${file}: fast tier, not rerun by a label and no gate`, () => {
      const wf = workflow(file);
      expect(wf.on.pull_request).toBeDefined();
      expect(wf.on.pull_request?.types ?? []).not.toContain('labeled');
      expect(Object.values(wf.jobs).map((job) => job.name)).not.toContain(GATE);
    });
  }
});
