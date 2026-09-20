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
    // Alt+click is the quiet alias INTO References; the trigger's own key is
    // Cmd/Ctrl, so the two are separate gestures onto one destination. Both
    // still have to dismiss an open card, which is what the funnel above
    // guarantees for either of them.
    for (const view of ['components/DiffViewer.tsx', 'components/AllFilesCodeView.tsx']) {
      const source = readFileSync(join(import.meta.dir, '..', view), 'utf8');
      expect(source).toMatch(/event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey/);
    }
  });
});

/**
 * The other half of the held-modifier gesture, pinned the same way and for the
 * same reason: the coupling lives in App.tsx, whose only entry point is a full
 * mount. The behavior itself (both transitions reported, with the token the
 * pointer is parked on) is covered in useTokenHover.test.tsx; what can rot
 * here is the App forgetting to wire the callback, or wiring it to something
 * that does not paint, which reads as harmless and silently returns the mode
 * to opening cards on tokens wearing no affordance.
 */
describe('the modifier gate paints the navigable-target affordance', () => {
  test('App passes onModifierGate and the handler toggles pn-token-nav', () => {
    const source = readFileSync(APP, 'utf8');

    expect(source).toContain('onModifierGate: handleModifierGate');

    const start = source.indexOf('const handleModifierGate = useCallback(');
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf('\n  }, [', start));
    expect(body).toContain("classList.add('pn-token-nav')");
    expect(body).toContain("classList.remove('pn-token-nav')");
  });

  test('both diff views gate the hovered-token class on a hover handler', () => {
    // pn-token-hover carries a `cursor: pointer !important`, so painting it
    // unconditionally promises clickability on every token in a session where
    // hover cards are switched off — and paints it in the portable viewer,
    // which wires no hover handler at all.
    for (const view of ['components/DiffViewer.tsx', 'components/AllFilesCodeView.tsx']) {
      const source = readFileSync(join(import.meta.dir, '..', view), 'utf8');
      const start = source.indexOf('const handleTokenEnter =');
      expect(start).toBeGreaterThan(0);
      const body = source.slice(start, source.indexOf('const handleTokenLeave =', start));

      const paint = body.indexOf("classList.add('pn-token-hover')");
      const guard = body.indexOf('onTokenHoverEnter');
      expect(paint).toBeGreaterThan(0);
      // The handler reads the hover prop BEFORE painting: either arm is a
      // guard (`if (onTokenHoverEnter)` / an early return on its absence), and
      // both leave the class unreachable without one.
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(paint);
    }
  });
});
