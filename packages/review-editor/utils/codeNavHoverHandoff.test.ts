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
    for (const view of ['components/DiffViewer.tsx', 'components/AllFilesCodeView.tsx']) {
      const source = readFileSync(join(import.meta.dir, '..', view), 'utf8');
      expect(source).toMatch(/event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey/);
    }
  });
});

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
    for (const view of ['components/DiffViewer.tsx', 'components/AllFilesCodeView.tsx']) {
      const source = readFileSync(join(import.meta.dir, '..', view), 'utf8');
      const start = source.indexOf('const handleTokenEnter =');
      expect(start).toBeGreaterThan(0);
      const body = source.slice(start, source.indexOf('const handleTokenLeave =', start));

      const paint = body.indexOf("classList.add('pn-token-hover')");
      const guard = body.indexOf('onTokenHoverEnter');
      expect(paint).toBeGreaterThan(0);
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(paint);
    }
  });
});
