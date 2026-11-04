/**
 * writeHighlightCopy: Ctrl+C / Cmd+C while a highlight stands in for the
 * person's selection (DOM-gated, DOM_TESTS=1).
 *
 * Failures to catch: the person's own selection (text selected in a field, or
 * anywhere in the page) loses to the highlight, a caret-only field (the empty
 * composer) copies nothing, another handler's copy is overwritten, or the
 * copy grows an html part (rich text is the toolbar button's alone, #2191).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { writeHighlightCopy } from './highlightCopy';

const hasDom = typeof document !== 'undefined';

afterEach(() => {
  if (!hasDom) return;
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

/** A copy event fired at `target`, recording what a handler writes. */
function copyAt(target: EventTarget, prevented = false) {
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' } });
  Object.defineProperty(event, 'target', { value: target });
  if (prevented) event.preventDefault();
  return { event, data };
}

function textarea(value: string, start: number, end: number) {
  const area = document.createElement('textarea');
  area.value = value;
  document.body.appendChild(area);
  area.focus();
  area.setSelectionRange(start, end);
  return area;
}

describe.if(hasDom)('writeHighlightCopy', () => {
  test('an empty composer (caret only) copies the highlighted text', () => {
    const { event, data } = copyAt(textarea('', 0, 0));
    expect(writeHighlightCopy(event, 'two, four and eight')).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect([...data.keys()]).toEqual(['text/plain']);
    expect(data.get('text/plain')).toBe('two, four and eight');
  });

  test('typed text with a caret but nothing selected still copies the highlight', () => {
    const { event, data } = copyAt(textarea('Why three?', 10, 10));
    writeHighlightCopy(event, 'two, four and eight');
    expect(data.get('text/plain')).toBe('two, four and eight');
  });

  test('text selected in the field copies natively', () => {
    const { event, data } = copyAt(textarea('Why three?', 4, 9));
    expect(writeHighlightCopy(event, 'two, four and eight')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(data.size).toBe(0);
  });

  test('a selection in the page copies natively', () => {
    const p = document.createElement('p');
    p.textContent = 'The person picked these words';
    document.body.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.addRange(range);
    const { event } = copyAt(document.body);
    expect(writeHighlightCopy(event, 'two, four and eight')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test('a copy another handler took is left alone', () => {
    const { event, data } = copyAt(document.body, true);
    expect(writeHighlightCopy(event, 'two, four and eight')).toBe(false);
    expect(data.size).toBe(0);
  });
});
