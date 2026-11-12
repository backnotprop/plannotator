import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const GATE = 'Full CI (all green)';
const LABEL_CHECK = "contains(github.event.pull_request.labels.*.name, 'ci:full')";
const HEAVY = ['windows.yml', 'release.yml', 'inbox-pi.yml', 'inbox-claude-code.yml', 'relay.yml'];
const FAST = ['test.yml', 'security.yml', 'browser-smoke.yml'];
const E2E = 'inbox-e2e.yml';
const E2E_LABELS = ['ci:e2e', 'ci:e2e-all'];
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

  test('browser-smoke.yml runs on every PR to main, whatever it changes', () => {
    const { on } = workflow('browser-smoke.yml');
    expect(on.pull_request).toBeDefined();
    expect(on.pull_request?.paths).toBeUndefined();
  });
});
