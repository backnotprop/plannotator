import { describe, expect, test } from 'bun:test';
import { liveSvgFences, partialJsonStringFields } from './inbox-drafting';

describe('partialJsonStringFields', () => {
  const whole = JSON.stringify({ action: 'send_message', pulls: ['a/b#1', 'say "hi", {ok}'], reply_to: 'msg_1', body: 'A "box"\n```svg\n<svg>é 😀</svg>\n```\n' });

  test('every cut of a call reads as a prefix of the finished fields, and never throws', () => {
    const full = partialJsonStringFields(whole);
    expect(full).toEqual({ action: 'send_message', reply_to: 'msg_1', body: 'A "box"\n```svg\n<svg>é 😀</svg>\n```\n' });
    for (let cut = 0; cut <= whole.length; cut++) {
      const fields = partialJsonStringFields(whole.slice(0, cut));
      for (const [key, value] of Object.entries(fields)) expect(full[key]!.startsWith(value)).toBe(true);
    }
  });

  test('an escape cut short is left out until it is whole', () => {
    expect(partialJsonStringFields('{"body":"a\\')).toEqual({ body: 'a' });
    expect(partialJsonStringFields('{"body":"a\\u00e')).toEqual({ body: 'a' });
    // Half of an emoji's pair: not drawn until the other half is there.
    expect(partialJsonStringFields('{"body":"a\\ud83d')).toEqual({ body: 'a' });
    expect(partialJsonStringFields('{"body":"a\\ud83d\\ude00')).toEqual({ body: 'a😀' });
  });

  test('text that is no object gives nothing', () => {
    expect(partialJsonStringFields('')).toEqual({});
    expect(partialJsonStringFields('"body"')).toEqual({});
  });
});

describe('liveSvgFences', () => {
  test('an open fence gives its markup so far; a half-written closing fence is not markup', () => {
    expect(liveSvgFences('Here:\n\n```svg\n<svg><rect/>')).toEqual([{ source: '<svg><rect/>', closed: false }]);
    expect(liveSvgFences('```svg\n<svg></svg>\n``')).toEqual([{ source: '<svg></svg>', closed: false }]);
    expect(liveSvgFences('```svg\n<svg></svg>\n```\nAfter')).toEqual([{ source: '<svg></svg>', closed: true }]);
  });

  test('other fences are not drawings, and two drawings come in order', () => {
    expect(liveSvgFences('```html\n<svg></svg>\n```')).toEqual([]);
    expect(liveSvgFences('```svg\n<svg id="a"/>\n```\n\n```svg\n<svg id="b"')).toEqual([
      { source: '<svg id="a"/>', closed: true },
      { source: '<svg id="b"', closed: false },
    ]);
  });
});
