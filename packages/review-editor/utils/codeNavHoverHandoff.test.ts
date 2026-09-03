/**
 * References-panel / hover-card exclusivity, pinned at source level (the
 * `iframeIsolation` and `live-proxy` suites' precedent, because the coupling
 * lives inside a 5000-line component whose only entry point is a full App
 * mount with a stubbed diff, worker pool, and SSE transport).
 *
 * The invariant: `handleCodeNavRequest` is the ONE funnel every route into the
 * References panel passes through — Cmd+click and Ctrl+click, the Alt+click
 * alias, and the card's own location links — so closing the hover surface
 * there covers all of them at once. The regression this catches is the line
 * being dropped in a refactor, which reads as harmless and silently restores
 * the #1461 double-surface: a card standing over the panel, or a dwell that
 * was already in flight resolving into one seconds after the click.
 *
 * The behavior close() itself provides (open card gone, pending dwell
 * cancelled, in-flight request aborted) is covered behaviorally by the
 * "References handoff" suite in useTokenHover.test.tsx.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(import.meta.dir, '..', 'App.tsx');

describe('References panel closes the hover surface', () => {
  test('handleCodeNavRequest closes the token hover before anything else', () => {
    const source = readFileSync(APP, 'utf8');

    const start = source.indexOf('const handleCodeNavRequest = useCallback(');
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf('\n  }, [', start));

    // First statement, ahead of the no-checkout early return: a click that
    // cannot resolve must still dismiss the card it was made on top of.
    expect(body).toContain('closeTokenHover();');
    expect(body.indexOf('closeTokenHover();')).toBeLessThan(body.indexOf('if (!gitContext'));
    expect(body.indexOf('closeTokenHover();')).toBeLessThan(body.indexOf('codeNav.resolve('));
  });

  test('every diff-view route into References goes through that one handler', () => {
    const source = readFileSync(APP, 'utf8');
    // If a second producer ever calls codeNav.resolve directly it bypasses the
    // dismissal, so the funnel is part of the invariant.
    const direct = source.match(/codeNav\.resolve\(/g) ?? [];
    expect(direct).toHaveLength(1);
    expect(source).toContain('onCodeNavRequest: canUseLiveWorkspaceActions ? handleCodeNavRequest : undefined');
  });

  test('the Alt+click alias shares the meta/ctrl branch in both diff views', () => {
    // Alt+click is the alias INTO References, and in modifier mode it is also
    // the key that opens cards, so it is the gesture where the overlap is
    // routine rather than incidental.
    for (const view of ['components/DiffViewer.tsx', 'components/AllFilesCodeView.tsx']) {
      const source = readFileSync(join(import.meta.dir, '..', view), 'utf8');
      expect(source).toMatch(/event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey/);
    }
  });
});
