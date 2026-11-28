/**
 * The host's line marks (hostLineMarks.ts): a real button at the end of the named line, on its side, in split and
 * unified views. What regresses: an old-side mark on the new line of the same number (or the other way), a unified view
 * missing a removed line or a context line's old number, a mark on any other line, a mark lost when the diff draws its
 * lines again (or drawn twice), a mark with no accessible name, a press on the mark reaching the diff's line selection
 * under it, or the host not hearing hover, keyboard focus and presses.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { dropHostLineMarks, keepHostLineMarks, type HostLineMark, type HostLineMarkEvent } from './hostLineMarks';

const hasDom = typeof document !== 'undefined';

const mark = (side: 'old' | 'new', line: number, label = 'High risk: Charges retry.'): HostLineMark => ({ id: `m-${side}-${line}`, filePath: 'a.ts', side, line, label, paint: 'background-image: none;' });

type Row = { line: number; alt?: number; type: string };

/** A file's diff as Pierre draws it, in a shadow root: `pre[data-overflow]`, one `[data-code]` per column, a `[data-line]` per row. */
function diff(columns: Record<'deletions' | 'additions' | 'unified', Row[] | undefined>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const pre = document.createElement('pre');
  pre.setAttribute('data-overflow', 'scroll');
  for (const [name, rows] of Object.entries(columns)) {
    if (!rows) continue;
    const code = document.createElement('code');
    code.setAttribute('data-code', '');
    code.setAttribute(`data-${name}`, '');
    for (const row of rows) code.appendChild(lineEl(name, row));
    pre.appendChild(code);
  }
  root.appendChild(pre);
  return root;
}

function lineEl(column: string, row: Row) {
  const line = document.createElement('div');
  line.setAttribute('data-line', String(row.line));
  if (row.alt !== undefined) line.setAttribute('data-alt-line', String(row.alt));
  line.setAttribute('data-line-type', row.type);
  line.dataset.id = `${column}:${row.type}:${row.line}`;
  line.appendChild(document.createTextNode('const x = 1;'));
  return line;
}

/** The lines that hold a mark's button, and each button's name. */
const marked = (root: ShadowRoot) =>
  [...root.querySelectorAll<HTMLButtonElement>('button[data-host-line-mark]')].map((b) => `${(b.parentElement as HTMLElement).dataset.id} ${b.getAttribute('aria-label')}`);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// New 10 context (old 9), new 11 added, old 10 removed, new 12 context (old 11).
const SPLIT = {
  deletions: [{ line: 9, alt: 10, type: 'context' }, { line: 10, type: 'change-deletion' }, { line: 11, alt: 12, type: 'context' }],
  additions: [{ line: 10, alt: 9, type: 'context' }, { line: 11, type: 'change-addition' }, { line: 12, alt: 11, type: 'context' }],
  unified: undefined,
};
const UNIFIED = {
  deletions: undefined,
  additions: undefined,
  unified: [{ line: 10, alt: 9, type: 'context' }, { line: 10, type: 'change-deletion' }, { line: 11, type: 'change-addition' }, { line: 12, alt: 11, type: 'context' }],
};

const roots: ShadowRoot[] = [];
const kept = (root: ShadowRoot, marks: HostLineMark[], onMark?: Parameters<typeof keepHostLineMarks>[2]) => {
  roots.push(root);
  keepHostLineMarks(root, marks, onMark);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    dropHostLineMarks(root);
    root.host.remove();
  }
});

describe.skipIf(!hasDom)('host line marks', () => {
  test('split: a button on the named line on its side, nothing else', () => {
    expect(marked(kept(diff(SPLIT), [mark('old', 10)]))).toEqual(['deletions:change-deletion:10 High risk: Charges retry.']);
    expect(marked(kept(diff(SPLIT), [mark('new', 10)]))).toEqual(['additions:context:10 High risk: Charges retry.']);
    expect(marked(kept(diff(SPLIT), [mark('new', 11), mark('old', 11)])).sort()).toEqual(['additions:change-addition:11 High risk: Charges retry.', 'deletions:context:11 High risk: Charges retry.']);
  });

  test('unified: a removed line and a context line’s old number are the old side', () => {
    const at = (m: HostLineMark) => marked(kept(diff(UNIFIED), [m])).map((s) => s.split(' ')[0]);
    expect(at(mark('old', 10))).toEqual(['unified:change-deletion:10']);
    expect(at(mark('new', 10))).toEqual(['unified:context:10']);
    expect(at(mark('old', 9))).toEqual(['unified:context:10']);
    expect(at(mark('new', 11))).toEqual(['unified:change-addition:11']);
    expect(at(mark('old', 11))).toEqual(['unified:context:12']);
  });

  test('the diff draws the line again: the same button comes back, once, and goes when its mark does', async () => {
    const root = kept(diff(SPLIT), [mark('new', 11)]);
    const before = root.querySelector('button[data-host-line-mark]');
    const code = root.querySelector('[data-additions]')!;
    const old = code.querySelector('[data-line="11"]')!;
    code.replaceChild(lineEl('additions', { line: 11, type: 'change-addition' }), old);
    await settle();
    expect(marked(root)).toEqual(['additions:change-addition:11 High risk: Charges retry.']);
    expect(root.querySelector('button[data-host-line-mark]')).toBe(before);
    // Its text is the line's alone: the button adds none.
    expect((root.querySelector('[data-additions] [data-line="11"]') as HTMLElement).textContent).toBe('const x = 1;');
    keepHostLineMarks(root, [mark('old', 10, 'Medium risk')], undefined);
    expect(marked(root)).toEqual(['deletions:change-deletion:10 Medium risk']);
    keepHostLineMarks(root, [], undefined);
    expect(marked(root)).toEqual([]);
  });

  test('the host hears hover, keyboard focus and presses; a press never reaches the line under it', () => {
    const heard: string[] = [];
    const root = kept(diff(SPLIT), [mark('new', 11)], (id, event: HostLineMarkEvent) => heard.push(`${id} ${event}`));
    const button = root.querySelector<HTMLButtonElement>('button[data-host-line-mark]')!;
    expect(button.type).toBe('button');
    const line = button.parentElement!;
    let reached = 0;
    for (const type of ['pointerdown', 'mousedown', 'click']) line.addEventListener(type, () => reached++);
    button.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    button.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    // A finger's touch is not a hover (a tap is a press).
    button.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'touch' }));
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    // Focus a press brings is the press's, not keyboard focus.
    button.focus();
    button.click();
    button.blur();
    // Focus with no press: the keyboard's.
    button.focus();
    expect(heard).toEqual(['m-new-11 enter', 'm-new-11 leave', 'm-new-11 press', 'm-new-11 blur', 'm-new-11 focus']);
    expect(reached).toBe(0);
  });
});
