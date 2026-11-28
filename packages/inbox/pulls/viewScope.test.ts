/**
 * The PR page's view in the address (viewScope.ts, app/route.ts): a reload or Back keeps "Layers i–j" and Since you
 * looked. What regresses: an address with `&range=` or `&since=` opening the layer's own diff, a `since` that is no
 * commit id reaching the diff route, a range's key losing a character in the address, and the old `&scope=stack`.
 */
import { describe, expect, test } from 'bun:test';
import { routeOf } from '../app/route';
import { scopeParts, viewScopeHash } from './viewScope';

const KEY = 'github.com/northwind/ledger#3';
const SHA = 'c'.repeat(40);

describe('the address', () => {
  test('a range and since you looked are read back from it, on the PR page and in Reviews', () => {
    expect(routeOf(`#prs&stack=s&layer=l&range=${encodeURIComponent(KEY)}`).scope).toBe(`range:${KEY}`);
    expect(routeOf(`#reviews&stack=s&layer=l&since=${SHA}`).scope).toBe(`since:${SHA}`);
    expect(routeOf('#prs&stack=s&layer=l&scope=stack').scope).toBe('stack');
  });

  test('a since that is no whole commit id is the layer', () => {
    expect(routeOf('#prs&stack=s&layer=l&since=main').scope).toBe('layer');
    expect(routeOf('#prs&stack=s&layer=l&since=abc123').scope).toBe('layer');
  });

  test("written as the route reads it: a range's key encoded, nothing for the layer's own diff", () => {
    expect(viewScopeHash(`range:${KEY}`)).toBe(`&range=${encodeURIComponent(KEY)}`);
    expect(viewScopeHash(`since:${SHA}`)).toBe(`&since=${SHA}`);
    expect(viewScopeHash('stack')).toBe('&scope=stack');
    expect(viewScopeHash('layer')).toBe('');
  });

  test("the diff route's scope and from", () => {
    expect(scopeParts(`range:${KEY}`)).toEqual({ scope: 'range', from: KEY });
    expect(scopeParts(`since:${SHA}`)).toEqual({ scope: 'since', from: SHA });
    expect(scopeParts('layer')).toEqual({ scope: 'layer' });
  });
});
