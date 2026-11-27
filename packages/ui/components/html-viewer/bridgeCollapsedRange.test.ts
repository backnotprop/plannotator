/**
 * A text highlight on a page that unmounts what scrolls away (virtualized docs) comes back when the text does.
 *
 * Evaluates the SHIPPED bridge functions out of the bridge's string against a live document. When a page removes
 * the node a live Range covers, the DOM moves both ends of the Range onto the still-connected parent: the Range is
 * connected but collapsed. What would regress: that collapsed Range counted as alive, so the highlight stays empty
 * after the text is mounted again and the text search never runs; or the search taking the first occurrence of the
 * quoted words, so a highlight in one row moves onto another row that shares them, while its row is away or after it
 * comes back.
 */
import { describe, expect, test } from 'bun:test';
import { BRIDGE_SCRIPT } from './bridge-script';

const hasDom = typeof document !== 'undefined' && typeof document.createRange === 'function';

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

const constant = (name: string): number => {
  const match = new RegExp(`var ${name} = (\\d+);`).exec(BRIDGE_SCRIPT);
  if (!match) throw new Error(`bridge no longer defines ${name}`);
  return Number(match[1]);
};

type Target = { kind: 'range'; range: Range | null; text: string; markerless: boolean };
type Record = { id: string; params: { anchor: null }; targets: Target[] };

/** The bridge's dead-range re-search in this document, with its generation counter exposed. */
function bridge() {
  return new Function(
    'document',
    'NodeFilter',
    'DEAD_SEARCH_BACKOFF_MS',
    'DEAD_SEARCH_BACKOFF_MAX_MS',
    `var domGeneration = 1;
     var deadSearchBudget = Infinity;
     var deadSearchSkipped = false;
     function isViewerOverlayNode() { return false; }
     function resolveAnchorElement() { return null; }
     ${['monotonicNow', 'rangeAlive', 'findTextRange', 'lostPlaceOf', 'lostPlaceConnected', 'findAtLostPlace', 'deadSearchAllowed', 'noteDeadSearchResult', 'refreshRecordTargets'].map(extractFunction).join('\n')}
     return {
       rangeAlive: rangeAlive,
       refresh: function(record) { deadSearchBudget = Infinity; refreshRecordTargets(record); },
       pageChanged: function() { domGeneration += 1; },
     };`,
  )(document, NodeFilter, constant('DEAD_SEARCH_BACKOFF_MS'), constant('DEAD_SEARCH_BACKOFF_MAX_MS')) as {
    rangeAlive: (range: Range | null) => boolean;
    refresh: (record: Record) => void;
    pageChanged: () => void;
  };
}

describe.skipIf(!hasDom)('a text highlight on a virtualized page', () => {
  test('the paragraph is unmounted and mounted again: the highlight finds its text again', () => {
    document.body.innerHTML = '<div id="list"><p>First row</p><p id="quoted">The quoted sentence.</p><p>Last row</p></div>';
    const list = document.getElementById('list')!;
    const text = document.getElementById('quoted')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 10);
    const b = bridge();
    const record: Record = { id: 'a1', params: { anchor: null }, targets: [{ kind: 'range', range, text: 'quoted', markerless: false }] };
    b.refresh(record);
    expect(record.targets[0]!.range!.toString()).toBe('quoted');

    // Scrolled away: the page removes the row. The Range's ends move onto the list, which is still connected
    // (the DOM's removing steps, which every browser runs; happy-dom does not, so the test runs that step itself).
    const row = document.getElementById('quoted')!;
    const index = Array.prototype.indexOf.call(list.childNodes, row);
    list.removeChild(row);
    range.setStart(list, index);
    range.collapse(true);
    expect(range.collapsed).toBe(true);
    expect(range.startContainer).toBe(list);
    expect(b.rangeAlive(range)).toBe(false);
    b.pageChanged();
    b.refresh(record);
    expect(record.targets[0]!.range).toBeNull();

    // Scrolled back: the page mounts a new node with the same text.
    const again = document.createElement('p');
    again.textContent = 'The quoted sentence.';
    list.insertBefore(again, list.lastChild);
    b.pageChanged();
    // Past the failed search's backoff, as the next frame after it would be.
    (record.targets[0] as unknown as { searchBackoffUntil: number }).searchBackoffUntil = 0;
    b.refresh(record);
    const found = record.targets[0]!.range!;
    expect(found.collapsed).toBe(false);
    expect(found.toString()).toBe('quoted');
    expect(found.startContainer.parentNode).toBe(again);
  });

  test('a highlight whose text is still in place is left alone', () => {
    document.body.innerHTML = '<p id="p">Some quoted words, quoted twice.</p>';
    const text = document.getElementById('p')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 19);
    range.setEnd(text, 25);
    const b = bridge();
    const record: Record = { id: 'a2', params: { anchor: null }, targets: [{ kind: 'range', range, text: 'quoted', markerless: false }] };
    document.body.appendChild(document.createElement('div'));
    b.pageChanged();
    b.refresh(record);
    // The second "quoted", not the first occurrence a re-search would pick.
    expect(record.targets[0]!.range).toBe(range);
    expect(range.startOffset).toBe(19);
  });

  test('two rows share the quoted words: the highlight waits for its own row and returns to it, never to the other', () => {
    const { list, rows, record, b } = rowsWithHighlight(['Revenue grew.', 'Revenue fell.'], 1, 'Revenue');
    unmount(list, rows[1]!, record);
    for (let pass = 0; pass < 3; pass += 1) {
      nextPass(record, b);
      expect(record.targets[0]!.range).toBeNull();
    }

    const again = document.createElement('p');
    again.textContent = 'Revenue fell.';
    list.appendChild(again);
    nextPass(record, b);
    const found = record.targets[0]!.range!;
    expect(found.toString()).toBe('Revenue');
    expect(found.startContainer.parentNode).toBe(again);
  });

  test('the same, the other way round: the first row away does not move its highlight onto the second', () => {
    const { list, rows, record, b } = rowsWithHighlight(['Revenue grew.', 'Revenue fell.'], 0, 'Revenue');
    unmount(list, rows[0]!, record);
    nextPass(record, b);
    expect(record.targets[0]!.range).toBeNull();

    const again = document.createElement('p');
    again.textContent = 'Revenue grew.';
    list.insertBefore(again, rows[1]!);
    nextPass(record, b);
    expect(record.targets[0]!.range!.startContainer.parentNode).toBe(again);
  });

  test('the row node itself comes back (a recycled row): the highlight returns to the same words in it', () => {
    const { list, rows, record, b } = rowsWithHighlight(['Revenue grew.', 'Net revenue fell, revenue', 'Last row'], 1, 'revenue', 18);
    unmount(list, rows[1]!, record);
    nextPass(record, b);
    expect(record.targets[0]!.range).toBeNull();

    list.insertBefore(rows[1]!, rows[2]!);
    nextPass(record, b);
    const found = record.targets[0]!.range!;
    expect(found.startContainer).toBe(rows[1]!.firstChild);
    expect(found.startOffset).toBe(18);
  });

  test("a page that rewrites the row's text in place keeps the highlight on that row, not the first occurrence", () => {
    const { rows, record, b } = rowsWithHighlight(['Revenue grew.', 'Revenue fell.'], 1, 'Revenue');
    const text = rows[1]!.firstChild as Text;
    const range = record.targets[0]!.range!;
    // Replacing the data collapses a Range inside it to the node's start (the DOM's replace data steps).
    text.data = 'Revenue fell.';
    range.setStart(text, 0);
    range.collapse(true);
    nextPass(record, b);
    const found = record.targets[0]!.range!;
    expect(found.toString()).toBe('Revenue');
    expect(found.startContainer).toBe(text);
  });
});

/** Rows of text in a list, with a live highlight on `quote` in row `index` (at `offset` in it) already painted once. */
function rowsWithHighlight(texts: string[], index: number, quote: string, offset = 0) {
  document.body.innerHTML = '<div id="list"></div>';
  const list = document.getElementById('list')!;
  const rows = texts.map((text) => {
    const row = document.createElement('p');
    row.textContent = text;
    list.appendChild(row);
    return row;
  });
  const range = document.createRange();
  range.setStart(rows[index]!.firstChild!, offset);
  range.setEnd(rows[index]!.firstChild!, offset + quote.length);
  expect(range.toString()).toBe(quote);
  const b = bridge();
  const record: Record = { id: 'a3', params: { anchor: null }, targets: [{ kind: 'range', range, text: quote, markerless: false }] };
  b.refresh(record);
  expect(record.targets[0]!.range).toBe(range);
  return { list, rows, record, b };
}

/** The page removes a row; the live Range collapses onto the list where the row was (the step happy-dom skips). */
function unmount(list: HTMLElement, row: HTMLElement, record: Record) {
  const range = record.targets[0]!.range!;
  const index = Array.prototype.indexOf.call(list.childNodes, row);
  list.removeChild(row);
  range.setStart(list, index);
  range.collapse(true);
}

/** A later reconcile pass after the page changed, past any failed search's backoff. */
function nextPass(record: Record, b: ReturnType<typeof bridge>) {
  b.pageChanged();
  (record.targets[0] as unknown as { searchBackoffUntil: number }).searchBackoffUntil = 0;
  b.refresh(record);
}
