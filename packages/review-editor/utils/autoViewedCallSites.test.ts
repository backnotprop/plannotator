/**
 * Source-level pin for WHICH diff transitions may invoke auto-mark-viewed's
 * Rule 5.
 *
 * The scope logic is tested behaviorally in autoViewed.test.ts, but that
 * cannot see the thing that actually went wrong: the review app funnels every
 * diff transition through one apply path, so an un-scoped Rule 5 call there
 * silently applied to a commit detour, a base switch and the whitespace
 * toggle as well as the staleness refresh. The gate is an opt-in
 * (`contentRefresh`) from the caller, which means the guarantee lives in
 * which call sites pass it, and only source can assert that.
 *
 * Same idiom as webmcp/iframeIsolation.test.ts: assert on the source text.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8');

/** Every `fetchDiffSwitch(...)` call in App.tsx, with its argument text. */
function fetchDiffSwitchCalls(): string[] {
  return [...APP.matchAll(/fetchDiffSwitch\(([^;\n]*)\)/g)].map((m) => m[1]);
}

describe('Rule 5 call-site scope', () => {
  test('exactly the two same-diff refreshes opt in to un-viewing', () => {
    const calls = fetchDiffSwitchCalls();
    // Sanity: the regex is finding real call sites, not nothing.
    expect(calls.length).toBeGreaterThanOrEqual(8);
    const optedIn = calls.filter((args) => args.includes('contentRefresh: true'));
    expect(optedIn).toHaveLength(2);
    // Both are the "same selection, fresh snapshot" shape: they also preserve
    // the active file, which is what a refresh does and a switch does not.
    for (const args of optedIn) expect(args).toContain('preserveFile: true');
  });

  test('the hide-whitespace toggle does not opt in', () => {
    // Its patches all differ by design; that delta is a presentation choice,
    // not the reviewed content changing.
    const effect = APP.slice(
      APP.indexOf('// Re-fetch diff when hideWhitespace toggles'),
      APP.indexOf('// --- Diff staleness ---'),
    );
    expect(effect).toContain('fetchDiffSwitch(');
    expect(effect).not.toContain('contentRefresh');
  });

  test('no commit-family switch opts in', () => {
    // The Commits rail auto-opens HEAD on entry, so an opted-in commit switch
    // would strip the checkmark off every file that commit touches.
    for (const args of fetchDiffSwitchCalls()) {
      if (args.includes('contentRefresh')) {
        expect(args).not.toContain('commit');
      }
    }
  });

  test('every path that marks a file viewed clears its suppression', () => {
    // Rule 3 says un-viewing is "come back to this" and marking viewed by hand
    // releases it. `v`, the header button and the tree row all funnel through
    // handleToggleViewed, but STAGING marks viewed on its own path — and a
    // file the reviewer un-viewed and later staged would otherwise stay
    // permanently off-limits to auto-view.
    const stageHandler = APP.slice(
      APP.indexOf('const handleFileViewedFromStage'),
      APP.indexOf('const sidecarStaged'),
    );
    expect(stageHandler).toContain('setViewedFiles');
    expect(stageHandler).toContain('applyAutoViewSuppression');
  });

  test('the apply path routes through the scoped resolver, not the raw one', () => {
    // resolveContentChangedUnviews answers "what changed"; calling it directly
    // from the apply path is precisely the bug this pins.
    expect(APP).toContain('resolveDiffSwitchUnviews({');
    expect(APP).not.toContain('resolveContentChangedUnviews({');
  });
});
