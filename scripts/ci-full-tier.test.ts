/**
 * Guard for the CI tiers (docs/agent-guides/project-and-development.md,
 * "CI tiers").
 *
 * Each failure this catches would let a PR skip a heavy suite its change
 * touches, start one again on every label, or leave main without its runs:
 *  - a heavy workflow that waits for a label, reruns on a label, or still has
 *    a `Full CI (all green)` gate (no merge script reads it any more);
 *  - a heavy workflow with no path rule on a PR (it would run on every PR) or
 *    one that does not run when its own workflow file changes;
 *  - a heavy workflow running again after every merge to main, or losing the
 *    nightly and manual runs that cover main and that a release dispatches
 *    before its tag;
 *  - the fast tier rerunning (and cancelling itself) on every label change;
 *  - the full browser suite (inbox-e2e.yml) running on a PR without its label,
 *    losing its two-hourly run on main, its head check or its blame job, or a
 *    PR's `ci:e2e` run not being held to its gate;
 *  - the browser smoke no longer starting on a PR (its gate job decides).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const GATE = 'Full CI (all green)';
const HEAVY = ['windows.yml', 'release.yml', 'inbox-pi.yml', 'inbox-claude-code.yml', 'relay.yml'];
const FAST = ['test.yml', 'security.yml', 'browser-smoke.yml', 'e2e-slice.yml'];
/** The full browser suite: on main every two hours, on a PR only with one of these labels. */
const E2E = 'inbox-e2e.yml';
const E2E_LABELS = ['ci:e2e', 'ci:e2e-all'];
/** Heavy workflows that cover main nightly; release.yml runs on its tags instead. */
const NIGHTLY = HEAVY.filter((file) => file !== 'release.yml');

type Job = { name?: string; if?: string; needs?: string | string[]; steps?: { run?: string }[] };
type Workflow = {
  on: {
    pull_request?: { types?: string[]; paths?: string[] };
    push?: { branches?: string[] } | null;
    schedule?: { cron: string }[];
    workflow_dispatch?: unknown;
  };
  jobs: Record<string, Job>;
};

function workflow(file: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(repoRoot, '.github/workflows', file), 'utf8')) as Workflow;
}

const needsOf = (job: Job) => (job.needs === undefined ? [] : [job.needs].flat());
describe('CI tiers', () => {
  for (const file of HEAVY) {
    test(`${file}: runs on a PR when its paths change, with no label and no gate job`, () => {
      const wf = workflow(file);
      expect(wf.on.pull_request).toBeDefined();
      expect(wf.on.pull_request?.types ?? [], 'rerun by a label').not.toContain('labeled');
      expect(Object.values(wf.jobs).map((job) => job.name)).not.toContain(GATE);
      expect(JSON.stringify(wf.jobs)).not.toContain('ci:full');
      // Path rules: the workflow's own list, or (windows.yml) a gate job every other job needs.
      const paths = wf.on.pull_request?.paths;
      if (paths) expect(paths).toContain(`.github/workflows/${file}`);
      else {
        expect(wf.jobs.gate, `${file}: a path gate`).toBeDefined();
        for (const [id, job] of Object.entries(wf.jobs)) if (id !== 'gate') expect(needsOf(job), `${file}: ${id}`).toContain('gate');
      }
    });
  }

  for (const file of HEAVY) {
    test(`${file}: not run by a push to main`, () => {
      expect(workflow(file).on.push?.branches ?? []).not.toContain('main');
    });
  }

  for (const file of NIGHTLY) {
    test(`${file}: runs on main nightly and by hand`, () => {
      const { on } = workflow(file);
      expect(on.schedule?.length).toBe(1);
      expect('workflow_dispatch' in on).toBe(true);
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

  describe(`${E2E}: the full browser suite`, () => {
    const wf = workflow(E2E);
    const labelChecks = E2E_LABELS.map((label) => `contains(github.event.pull_request.labels.*.name, '${label}')`);

    test('runs on a PR only with ci:e2e or ci:e2e-all, never for ci:full, and its gate needs every PR job', () => {
      expect(wf.on.pull_request?.types).toContain('labeled');
      const { 'full-ci': gate, head, blame, ...prJobs } = wf.jobs;
      expect(head && blame).toBeTruthy();
      expect(gate?.name).toBe(GATE);
      expect(gate!.if).toContain('!cancelled()');
      for (const check of labelChecks) expect(gate!.if).toContain(check);
      expect([...needsOf(gate!)].sort()).toEqual(Object.keys(prJobs).sort());
      for (const id of ['build', 'plan']) {
        const cond = wf.jobs[id]!.if ?? '';
        for (const check of labelChecks) expect(cond, id).toContain(check);
        expect(cond, id).not.toContain('ci:full');
      }
    });

    test('runs on main every two hours, only when the head job finds no full run of main\'s head, and by hand', () => {
      expect(wf.on.push?.branches ?? []).not.toContain('main');
      expect(wf.on.schedule?.map((s) => s.cron)).toEqual([expect.stringMatching(/^\d+ \*\/2 \* \* \*$/)]);
      expect('workflow_dispatch' in wf.on).toBe(true);
      expect(wf.jobs.head!.if).toBe("github.event_name == 'schedule'");
      expect(wf.jobs.head!.steps?.some((step) => step.run?.trim() === 'bun run scripts/ci-e2e-main.ts head')).toBe(true);
      for (const id of ['build', 'plan']) {
        expect(needsOf(wf.jobs[id]!), id).toEqual(['head']);
        expect(wf.jobs[id]!.if, id).toContain("github.event_name == 'schedule' && needs.head.outputs.run != 'false'");
        expect(wf.jobs[id]!.if, id).toContain("github.event_name == 'workflow_dispatch'");
      }
    });

    test('a red run on main, and only there, runs the blame job', () => {
      const blame = wf.jobs.blame!;
      expect(needsOf(blame)).toContain('inbox-window-e2e');
      expect(blame.if).toContain("needs.inbox-window-e2e.result == 'failure'");
      expect(blame.if).toContain("github.ref == 'refs/heads/main'");
      expect(blame.if).toContain("github.event_name != 'pull_request'");
      expect(blame.steps?.some((step) => step.run?.trim() === 'bun run scripts/ci-e2e-main.ts blame')).toBe(true);
    });
  });

  test('browser-smoke.yml starts on every PR to main; its gate job picks whether the smoke runs', () => {
    const { on, jobs } = workflow('browser-smoke.yml');
    expect(on.pull_request).toBeDefined();
    expect(on.pull_request?.paths).toBeUndefined();
    expect(needsOf(jobs.smoke!)).toEqual(['gate']);
  });
});
