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
import { ELEMENT_CONTEXT_SHED_ORDER } from '@plannotator/core/html-anchor';
import { BRIDGE_SCRIPT } from './bridge-script';

// Failure to catch: the bridge and the parent's validator shedding different
// fields (or one of them never shedding a new field such as sourceName), so a
// context the bridge trimmed to fit is dropped whole at the trust boundary.
describe('element context shed order', () => {
  test("the bridge's CTX_SHED_ORDER equals core's ELEMENT_CONTEXT_SHED_ORDER", () => {
    const match = /var CTX_SHED_ORDER = (\[[^\]]*\]);/.exec(BRIDGE_SCRIPT);
    if (!match) throw new Error('bridge no longer defines CTX_SHED_ORDER');
    const bridgeOrder = JSON.parse(match[1]!.replace(/'/g, '"')) as string[];
    expect(bridgeOrder).toEqual([...ELEMENT_CONTEXT_SHED_ORDER]);
    expect(bridgeOrder).toContain('sourceName');
  });
});

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

const makeScrub = (live: unknown) => new Function(
  'CTX_MAX_ATTR_VALUE',
  'ctxTruncate',
  'LIVE',
  `${extractFunction(BRIDGE_SCRIPT, 'ctxScrubUrl')}; return ctxScrubUrl;`,
)(120, (s: string, max: number) => s.slice(0, max), live) as (value: string) => string | null;
const scrub = makeScrub(null);

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

  // Failure to catch: every srcdoc asset reaching the agent as
  // /api/html-assets/<session token>/x.png, a path that exists nowhere in
  // the author's source and changes every session.
  test("a srcdoc session's asset route reads as the author's own relative path", () => {
    expect(scrub('/api/html-assets/d4d63ee508f145c5/img/team.png')).toBe('img/team.png');
    expect(scrub('/api/html-assets/d4d63ee508f145c5/team.png?v=2#x')).toBe('team.png?…');
    // The route percent-encodes segments; the author wrote the decoded name.
    expect(scrub('/api/html-assets/tok/avatars/jane%20doe.png')).toBe('avatars/jane doe.png');
    // A malformed escape, or one that would decode to a query mark, stays raw.
    expect(scrub('/api/html-assets/tok/bad%E0%A4%A.png')).toBe('bad%E0%A4%A.png');
    expect(scrub('/api/html-assets/tok/what%3Fnow.png')).toBe('what%3Fnow.png');
    // A live app's own paths are real routes of that app and stay whole.
    expect(makeScrub({})('/api/html-assets/abc/team.png')).toBe('/api/html-assets/abc/team.png');
  });
});
