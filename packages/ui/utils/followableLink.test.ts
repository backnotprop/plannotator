/**
 * The markdown Viewer's Pinpoint follows the same links the HTML viewer's
 * bridge follows (owner's ruling `html-link-click`).
 *
 * What regresses if this fails: the two viewers disagree on which links a
 * plain click follows while armed, e.g. a markdown `[Save](#)` follows while
 * the same `<a href="#">` in an HTML page pins. The bridge's `isFollowableHref`
 * ships as a string inside the iframe script, so this evaluates that shipped
 * function and checks it against `isFollowableHref` case by case.
 */
import { describe, expect, test } from 'bun:test';
import { BRIDGE_SCRIPT } from '../components/html-viewer/bridge-script';
import { isFollowableHref } from './followableLink';

function extractFunction(name: string): string {
  const start = BRIDGE_SCRIPT.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bridge no longer defines ${name}`);
  let depth = 0;
  for (let i = BRIDGE_SCRIPT.indexOf('{', start); i < BRIDGE_SCRIPT.length; i += 1) {
    if (BRIDGE_SCRIPT[i] === '{') depth += 1;
    else if (BRIDGE_SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return BRIDGE_SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces around ${name}`);
}

// The bridge trims the raw href (`navigableLinkHref`) before it asks.
const bridgeIsFollowableHref = new Function(
  `${extractFunction('isFollowableHref')}; return (raw) => isFollowableHref(typeof raw === 'string' ? raw.trim() : '');`,
)() as (raw: string | null) => boolean;

const GOES_NOWHERE: Array<[string, string | null]> = [
  ['href="#"', '#'],
  ['href=""', ''],
  ['javascript:', 'javascript:void 0'],
  ['JavaScript: in any case', 'JavaScript:alert(1)'],
  ['no href', null],
  ['only spaces', '   '],
  ['"#" with spaces', ' # '],
];

const FOLLOWS: Array<[string, string]> = [
  ['an external URL', 'https://example.com/page'],
  ['a relative markdown file', './other.md'],
  ['a parent-relative file', '../notes/plan.md'],
  ['an in-page anchor', '#notes'],
  ['a root-relative path', '/docs/intro.html'],
  ['mailto:', 'mailto:someone@example.com'],
];

describe('isFollowableHref', () => {
  for (const [label, raw] of GOES_NOWHERE) {
    test(`a link that goes nowhere (${label}) is not followable, as in the bridge`, () => {
      expect(isFollowableHref(raw)).toBe(false);
      expect(bridgeIsFollowableHref(raw)).toBe(false);
    });
  }

  for (const [label, raw] of FOLLOWS) {
    test(`${label} is followable, as in the bridge`, () => {
      expect(isFollowableHref(raw)).toBe(true);
      expect(bridgeIsFollowableHref(raw)).toBe(true);
    });
  }
});
