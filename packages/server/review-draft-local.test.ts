/** Local drafts must survive edits without leaking across Git review targets.
 * Exercise both HTTP runtimes and the same anchor check the client uses. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer as startBun } from './review';
import { startReviewServer as startPi } from '../../apps/pi-extension/server/serverReview';
import { getGitContext, runGitDiff, type DiffType } from '@plannotator/shared/review-core';
import { contentHash, saveDraft } from '@plannotator/shared/draft';
import { gitRuntime } from './vcs';
import { parseDiffToFiles } from '../review-editor/utils/diffParser';
import { captureAnchor, reanchorCodeAnnotations } from '../review-editor/utils/codeAnnotationAnchor';
import type { CodeAnnotation } from '../ui/types';

let root: string;
let cwd: string;
let restoreEnv: () => void;
const servers: Array<{ stop(): void }> = [];
function git(...args: string[]) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
beforeEach(() => {
  const env = { ...process.env };
  const settings = {
    PLANNOTATOR_DATA_DIR: '', PLANNOTATOR_AI: 'disabled', PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_PORT: '', PLANNOTATOR_REVIEW_PROGRESS: '0', PLANNOTATOR_GIT_REMOTE_CHECK: '0',
    PATH: process.env.PATH,
  };
  restoreEnv = () => {
    for (const key of Object.keys(settings)) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  };
  root = mkdtempSync(join(tmpdir(), 'review-draft-local-'));
  cwd = join(root, 'repo');
  mkdirSync(cwd);
  Object.assign(process.env, settings, { PLANNOTATOR_DATA_DIR: join(root, 'data') });
  delete process.env.PLANNOTATOR_PORT;
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  for (const file of ['a.txt', 'b.txt']) writeFileSync(join(cwd, file), 'before\n');
  git('add', '.');
  git('commit', '-m', 'base');
  git('switch', '-c', 'feature');
  writeFileSync(join(cwd, 'a.txt'), 'after\n');
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

const post = (url: string, body: unknown, method = 'POST') => fetch(url, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const note: CodeAnnotation = {
  id: 'note', filePath: 'a.txt', type: 'comment', side: 'new', lineStart: 1, lineEnd: 1,
  text: 'Please explain this change', createdAt: 1,
};
for (const [runtime, start] of [['Bun', startBun], ['Pi', startPi]] as const) {
  describe(`${runtime} local review draft recovery`, () => {
    async function open(diffType: DiffType = 'since-base', base = 'main', initialBaseExplicit = false) {
      const gitContext = await getGitContext(gitRuntime, cwd);
      const diff = await runGitDiff(gitRuntime, diffType, base, cwd);
      const server = await start({
        rawPatch: diff.patch, gitRef: diff.label, diffType, initialBase: base, initialBaseExplicit, gitContext,
        htmlContent: '<!doctype html><title>Review</title>',
      });
      servers.push(server);
      const view = await (await fetch(`${server.url}/api/diff`)).json();
      expect(view.localDraftTarget).toMatch(/^local-/);
      const endpoint = `${server.url}/api/draft?target=${view.localDraftTarget}&client=page-1`;
      return { server, view, endpoint };
    }
    function body(view: any, draftGeneration = 3) {
      return {
        codeAnnotations: [{ ...note, ...captureAnchor(note, parseDiffToFiles(view.rawPatch)),
          anchorSnapshot: view.snapshotId, localReviewTarget: view.localDraftTarget }],
        draftGeneration, ts: Date.now(),
      };
    }

    test('unrelated edits and commits restore comments; changed or missing code stays as outdated', async () => {
      // Progress is disabled and there is no file-identities sidecar: draft
      // identity must not depend on either viewed-progress capability.
      const first = await open();
      expect((await post(first.endpoint, body(first.view))).status).toBe(200);
      writeFileSync(join(cwd, 'b.txt'), 'unrelated edit\n');
      git('add', '.');
      git('commit', '-m', 'work');
      const second = await open();
      const draft = await (await fetch(second.endpoint)).json();
      expect(draft.patchChanged).toBe(true);
      const check = (view: any) => reanchorCodeAnnotations(draft.codeAnnotations, parseDiffToFiles(view.rawPatch), {
        currentSnapshot: view.snapshotId, patchChanged: true,
      });
      expect(check(second.view)[0]).toMatchObject({ text: note.text, anchorText: 'after', anchorSnapshot: second.view.snapshotId });
      expect(check(second.view)[0].outdated).toBeUndefined();
      writeFileSync(join(cwd, 'a.txt'), 'revised\n');
      const changed = await (await post(`${second.server.url}/api/diff/switch`, { diffType: 'since-base', base: 'main' })).json();
      expect(changed.localDraftTarget).toBe(first.view.localDraftTarget);
      expect(changed.draftState.found).toBe(true);
      expect(check(changed)[0]).toMatchObject({ outdated: true, anchorText: 'after', text: note.text, lineStart: 1 });
      writeFileSync(join(cwd, 'a.txt'), 'before\n');
      const missing = await open();
      expect(check(missing.view)[0].outdated).toBe(true);
    });

    test('identical patches on other branches, worktrees, comparisons and bases stay isolated', async () => {
      const a = await open();
      await post(a.endpoint, body(a.view));
      git('switch', '-c', 'other');
      const b = await open();
      expect(b.view.rawPatch).toBe(a.view.rawPatch);
      expect((await fetch(b.endpoint)).status).toBe(404);
      await post(b.endpoint, { ...body(b.view, 40), codeAnnotations: [{ ...note, id: 'other-note' }] });
      git('switch', 'feature');
      expect((await (await fetch((await open()).endpoint)).json()).codeAnnotations[0].id).toBe('note');
      const comparison = await open('uncommitted');
      expect((await fetch(comparison.endpoint)).status).toBe(404);
      git('branch', 'baseline', 'main');
      expect((await fetch((await open('since-base', 'baseline')).endpoint)).status).toBe(404);
      const worktree = join(root, 'worktree');
      git('worktree', 'add', '-b', 'linked', worktree, 'main');
      const originalCwd = cwd;
      cwd = worktree;
      writeFileSync(join(cwd, 'a.txt'), 'after\n');
      expect((await fetch((await open()).endpoint)).status).toBe(404);
      cwd = originalCwd;
    });

    for (const decision of ['feedback', 'exit', 'discard']) {
      test(`${decision} clears earlier patches and rejects a stale tab's late save`, async () => {
        const a = await open();
        await post(a.endpoint, body(a.view));
        writeFileSync(join(cwd, 'b.txt'), 'edit\n');
        const b = await open();
        expect((await fetch(b.endpoint)).status).toBe(200);
        const response = decision === 'discard'
          ? await fetch(`${b.endpoint}&generation=4`, { method: 'DELETE' })
          : await post(`${b.server.url}/api/${decision}?draftGeneration=4`, { feedback: 'notes', draftGeneration: 4 });
        expect(response.status).toBe(200);
        expect((await post(a.endpoint, body(a.view, 4))).status).toBe(409);
        expect((await fetch(a.endpoint)).status).toBe(404);
        expect((await fetch((await open()).endpoint)).status).toBe(404);
      });
    }

    test('switch adopts the destination generation, protects its comments, and refuses writes from another target', async () => {
      const staged = await open('staged');
      await post(staged.endpoint, body(staged.view, 39));
      const a = await open();
      await post(a.endpoint, body(a.view));
      const switched = await (await post(`${a.server.url}/api/diff/switch`, { diffType: 'staged' })).json();
      expect(switched.draftState).toEqual({ found: true, draftGeneration: 39 });
      expect((await post(a.endpoint, body(a.view, 40))).status).toBe(409);
      const staleLoad = await fetch(a.endpoint);
      expect(staleLoad.status).toBe(409);
      expect(await staleLoad.json()).toMatchObject({ code: 'draft_target_changed' });
      const endpoint = `${a.server.url}/api/draft?target=${switched.localDraftTarget}&client=page-1`;
      const stagedNote = { ...note, id: 'staged-note', localReviewTarget: switched.localDraftTarget };
      await post(endpoint, { codeAnnotations: [...body(a.view).codeAnnotations, stagedNote], draftGeneration: 40 });
      expect((await (await fetch(endpoint)).json()).codeAnnotations.map((a: CodeAnnotation) => a.id)).toEqual(['staged-note']);
      expect((await post(`${a.server.url}/api/feedback?client=page-1`, { feedback: 'all notes', draftGeneration: 41 })).status).toBe(200);
      expect((await fetch((await open()).endpoint)).status).toBe(404);
      expect((await fetch((await open('staged')).endpoint)).status).toBe(404);
    });

    for (const cleanup of ['discard', 'feedback', 'exit']) {
      test(`reloading on B preserves A through autosave and ${cleanup}`, async () => {
        const a = await open();
        await post(a.endpoint, body(a.view));
        const b = await (await post(`${a.server.url}/api/diff/switch`, { diffType: 'unstaged' })).json();
        const endpoint = `${a.server.url}/api/draft?target=${b.localDraftTarget}`;
        const onB = { ...note, id: 'on-b', localReviewTarget: b.localDraftTarget };
        await post(`${endpoint}&client=page-1`, {
          codeAnnotations: [...body(a.view).codeAnnotations, onB], draftGeneration: 4,
        });
        // A reload (or a different tab) knows only B. Missing A isn't a deletion.
        const restored = await (await fetch(`${endpoint}&client=page-2`)).json();
        expect(restored.codeAnnotations.map((a: CodeAnnotation) => a.id)).toEqual(['on-b']);
        expect((await post(`${endpoint}&client=page-2`, { ...restored, draftGeneration: 5 })).status).toBe(200);
        const reopenedA = await open();
        expect(await (await fetch(reopenedA.endpoint)).json()).toMatchObject({ codeAnnotations: [{ id: note.id }] });
        const response = cleanup === 'discard'
          ? await fetch(`${endpoint}&client=page-2&generation=6`, { method: 'DELETE' })
          : await post(`${a.server.url}/api/${cleanup}?client=page-2&draftGeneration=6`, { feedback: 'B only', draftGeneration: 6 });
        expect(response.status).toBe(200);
        expect((await fetch(endpoint)).status).toBe(404);
        expect(await (await fetch(reopenedA.endpoint)).json()).toMatchObject({ codeAnnotations: [{ id: note.id }] });
      });
    }

    test('a draft saved before the startup base upgrade survives the upgrade and restart; explicit local bases stay separate', async () => {
      // Hold the remote probe until AFTER the first view and draft save. Without
      // the gate a fast local remote would hide the orphaned-draft window.
      const remote = join(root, 'origin.git');
      git('clone', '--bare', cwd, remote);
      git('--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      git('remote', 'add', 'origin', remote);
      git('fetch', 'origin');
      // Local main and origin/main deliberately name different comparisons.
      writeFileSync(join(cwd, 'b.txt'), 'committed feature\n');
      git('add', 'b.txt');
      git('commit', '-m', 'feature work');
      git('branch', '-f', 'main', 'HEAD');
      const realGit = Bun.which('git')!;
      const bin = join(root, 'bin');
      const gate = join(root, 'release-probe');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = ls-remote ]; then\n    while [ ! -e ${JSON.stringify(gate)} ]; do sleep 0.01; done\n  fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
      process.env.PATH = `${bin}:${process.env.PATH}`;
      process.env.PLANNOTATOR_GIT_REMOTE_CHECK = '1';
      try {
        const early = await open();
        expect(early.view.base).toBe('main');
        await post(early.endpoint, body(early.view));
        writeFileSync(gate, 'go');
        let upgraded = early.view;
        for (let i = 0; i < 100 && upgraded.base !== 'origin/main'; i++) {
          await Bun.sleep(25);
          upgraded = await (await fetch(`${early.server.url}/api/diff`)).json();
        }
        expect(upgraded.base).toBe('origin/main');
        expect(upgraded.rawPatch).not.toBe(early.view.rawPatch);
        expect(upgraded.localDraftTarget).toBe(early.view.localDraftTarget);
        const draft = await (await fetch(early.endpoint)).json();
        expect(draft).toMatchObject({ patchChanged: true, codeAnnotations: [{ id: note.id }] });
        expect((await post(early.endpoint, body(early.view, 4))).status).toBe(200);
        const restarted = await open('since-base', 'origin/main');
        expect((await (await fetch(restarted.endpoint)).json()).codeAnnotations[0].id).toBe(note.id);
        const explicit = await open('since-base', 'main', true);
        expect(explicit.view.localDraftTarget).not.toBe(upgraded.localDraftTarget);
        expect((await fetch(explicit.endpoint)).status).toBe(404);
        const picked = await (await post(`${early.server.url}/api/diff/switch`, { diffType: 'since-base', base: 'main', explicitBase: true })).json();
        expect(picked.localDraftTarget).toBe(explicit.view.localDraftTarget);
        process.env.PLANNOTATOR_GIT_REMOTE_CHECK = '0';
        const offline = await open();
        expect(offline.view.base).toBe('main');
        expect(offline.view.localDraftTarget).toBe(explicit.view.localDraftTarget);
      } finally { writeFileSync(gate, 'go'); }
    }, 15000);

    test('an unchanged legacy draft migrates without resurfacing after discard', async () => {
      const a = await open();
      saveDraft(contentHash(a.view.rawPatch), { codeAnnotations: [note], draftGeneration: 7 });
      expect((await (await fetch(a.endpoint)).json()).codeAnnotations[0].id).toBe('note');
      await post(a.endpoint, body(a.view, 8));
      await fetch(`${a.endpoint}&generation=9`, { method: 'DELETE' });
      expect((await fetch((await open()).endpoint)).status).toBe(404);
    });

    test('detached checkouts are scoped to their commit rather than borrowing a branch draft', async () => {
      const branch = await open();
      await post(branch.endpoint, body(branch.view));
      git('checkout', '--detach');
      const detached = await open();
      expect((await fetch(detached.endpoint)).status).toBe(404);
      await post(detached.endpoint, body(detached.view));
      expect((await fetch((await open()).endpoint)).status).toBe(200);
      git('commit', '--allow-empty', '-m', 'new detached identity');
      const next = await open();
      expect(next.view.rawPatch).toBe(detached.view.rawPatch);
      expect((await fetch(next.endpoint)).status).toBe(404);
    });
  });
}
