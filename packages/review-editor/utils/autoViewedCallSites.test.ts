import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(import.meta.dir, '..', 'App.tsx'), 'utf8');

function fetchDiffSwitchCalls(): string[] {
  return [...APP.matchAll(/fetchDiffSwitch\(([^;\n]*)\)/g)].map((m) => m[1]);
}

describe('Rule 5 call-site scope', () => {
  test('exactly the two same-diff refreshes opt in to un-viewing', () => {
    const calls = fetchDiffSwitchCalls();
    expect(calls.length).toBeGreaterThanOrEqual(8);
    const optedIn = calls.filter((args) => args.includes('contentRefresh: true'));
    expect(optedIn).toHaveLength(2);
    for (const args of optedIn) expect(args).toContain('preserveFile: true');
  });

  test('the hide-whitespace toggle does not opt in', () => {
    const start = APP.indexOf('const hideWhitespaceInitialized');
    const effect = APP.slice(start, APP.indexOf('}, [diffHideWhitespace', start));
    expect(start).toBeGreaterThan(-1);
    expect(effect).toContain('fetchDiffSwitch(');
    expect(effect).not.toContain('contentRefresh');
  });

  test('no commit-family switch opts in', () => {
    for (const args of fetchDiffSwitchCalls()) {
      if (args.includes('contentRefresh')) {
        expect(args).not.toContain('commit');
      }
    }
  });

  test('every path that marks a file viewed clears its suppression', () => {
    const stageHandler = APP.slice(
      APP.indexOf('const handleFileViewedFromStage'),
      APP.indexOf('const sidecarStaged'),
    );
    expect(stageHandler).toContain('setViewedFiles');
    expect(stageHandler).toContain('applyAutoViewSuppression');
  });

  test('the apply path routes through the scoped resolver, not the raw one', () => {
    expect(APP).toContain('resolveDiffSwitchUnviews({');
    expect(APP).not.toContain('resolveContentChangedUnviews({');
  });
});
