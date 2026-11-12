import { afterEach, describe, expect, test } from 'bun:test';
import { HIGHLIGHT_COMPOSER_ATTR, writeHighlightCopy } from './highlightCopy';

const hasDom = typeof document !== 'undefined';

afterEach(() => {
  if (!hasDom) return;
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

function copyAt(target: EventTarget, prevented = false) {
  const data = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '' } });
  Object.defineProperty(event, 'target', { value: target });
  if (prevented) event.preventDefault();
  return { event, data };
}

function textarea(value: string, start: number, end: number, parent?: HTMLElement) {
  const area = document.createElement('textarea');
  area.value = value;
  if (parent) {
    parent.appendChild(area);
  } else {
    const composer = document.createElement('div');
    composer.setAttribute('data-comment-popover', 'true');
    composer.appendChild(area);
    document.body.appendChild(composer);
  }
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

  test('a field outside the composer keeps its own copy, even with only a caret', () => {
    const { event, data } = copyAt(textarea('A reply', 7, 7, document.body));
    expect(writeHighlightCopy(event, 'two, four and eight')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(data.size).toBe(0);
  });

  test('an editable region outside the composer keeps its own copy', () => {
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.textContent = 'notes';
    document.body.appendChild(editor);
    const { event } = copyAt(editor);
    expect(writeHighlightCopy(event, 'two, four and eight')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  test('a field in a composer that carries the composer attribute copies the highlight', () => {
    const composer = document.createElement('div');
    composer.setAttribute(HIGHLIGHT_COMPOSER_ATTR, '');
    document.body.appendChild(composer);
    const { event, data } = copyAt(textarea('', 0, 0, composer));
    expect(writeHighlightCopy(event, 'return 4;')).toBe(true);
    expect(data.get('text/plain')).toBe('return 4;');
  });

  test('a button in the page (no field, no selection) copies the highlight', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    const { event, data } = copyAt(button);
    expect(writeHighlightCopy(event, 'two, four and eight')).toBe(true);
    expect(data.get('text/plain')).toBe('two, four and eight');
  });
});
