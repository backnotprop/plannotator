/**
 * Element-context URL scrubbing in the bridge (no DOM needed).
 *
 * The captured element context is agent-facing and is written into drafts,
 * submission records and exported feedback, so its documented contract is that
 * `href`/`src` keep the path and lose the query and the fragment. That held for
 * absolute http(s) URLs only: a relative `./checkout?session=...#token=...`
 * was copied through whole, which is where per-visit secrets actually live
 * (implicit-flow tokens are specifically a fragment convention).
 *
 * `srcdoc.test.ts` covers the end-to-end click path for one absolute and one
 * relative href; this pins the scrub's edge cases (fragment-only, `../`,
 * clean relative, data:, javascript:) without a DOM. The function is a plain,
 * dependency-light helper inside the bridge's JS string, so the test evaluates
 * the SHIPPED source rather than a copy.
 */
import { describe, expect, test } from 'bun:test';
import { BRIDGE_SCRIPT } from './bridge-script';

/** Pull one `function name(...) { ... }` out of the bridge source by brace
 *  balance, so the test never diverges from what ships. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bridge no longer defines ${name}`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces around ${name}`);
}

const scrub = new Function(
  'CTX_MAX_ATTR_VALUE',
  'ctxTruncate',
  `${extractFunction(BRIDGE_SCRIPT, 'ctxScrubUrl')}; return ctxScrubUrl;`,
)(120, (s: string, max: number) => s.slice(0, max)) as (value: string) => string | null;

describe('ctxScrubUrl (bridge element context)', () => {
  test('relative URLs keep their path and lose query and fragment', () => {
    expect(scrub('./checkout?session=abc123')).toBe('./checkout?…');
    expect(scrub('/account/settings?token=secret#access_token=leak')).toBe('/account/settings?…');
    expect(scrub('../docs/guide.html#section-3')).toBe('../docs/guide.html?…');
    // Nothing but state: no path survives, and none is invented.
    expect(scrub('#access_token=leak')).toBe('?…');
  });

  test('a clean relative URL is untouched', () => {
    expect(scrub('./docs/guide.html')).toBe('./docs/guide.html');
    expect(scrub('/assets/logo.svg')).toBe('/assets/logo.svg');
  });

  test('absolute http(s), data: and javascript: handling is unchanged', () => {
    expect(scrub('https://example.com/a/b?token=x#y')).toBe('https://example.com/a/b?…');
    expect(scrub('https://example.com/a/b')).toBe('https://example.com/a/b');
    expect(scrub('data:image/png;base64,AAAA')).toBe('data:image/png;base64,…');
    expect(scrub('javascript:steal()')).toBeNull();
  });
});
