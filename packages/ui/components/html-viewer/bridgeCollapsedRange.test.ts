/**
 * A text highlight whose text the page takes out of the DOM: it comes back only on the very same text, never on
 * lookalike words, and is reported unanchored while it cannot.
 *
 * Evaluates the SHIPPED bridge functions out of the bridge's string against a live document. When a page removes
 * the text node a live Range covers, or rewrites the node's data, the DOM moves the Range's ends and it collapses.
 * What would regress: that collapsed Range counted as alive (the highlight silently paints nothing and is never
 * reported); or the highlight re-anchored by searching for its words, which puts it on text the person did not
 * highlight (another row that shares them); or detached nodes kept alive for good.
 *
 * happy-dom does NOT move live Range boundary points when the DOM changes (it leaves the Range on the detached
 * node). Browsers do, per the DOM spec. The helpers below (liveRemove, liveInsert, replaceAllData) perform the
 * spec's steps on the test's Range by hand, exactly: the "live range pre-remove steps" (a boundary inside the
 * removed node moves to (parent, index of the node); a boundary in the parent after it shifts left), the insert
 * steps (a boundary in the parent after the insertion point shifts right) and the "replace data" steps (setting
 * a text node's data moves every boundary inside it with offset > 0 to offset 0).
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

const KEEP_MS = constant('LOST_PLACE_KEEP_MS');
const MAX_QUOTE = constant('MAX_SELECTION_TEXT');

type Target = { kind: 'range'; range: Range | null; text: string; markerless: boolean; searchBackoffUntil?: number };
type Record = { id: string; params: { anchor: { id: string } | null }; targets: Target[] };

/** The bridge's per-pass target refresh in this document, on a clock the test moves. */
function bridge() {
  return new Function(
    'document',
    'NodeFilter',
    'DEAD_SEARCH_BACKOFF_MS',
    'DEAD_SEARCH_BACKOFF_MAX_MS',
    'LOST_PLACE_KEEP_MS',
    'MAX_SELECTION_TEXT',
    `var domGeneration = 1;
     var deadSearchBudget = Infinity;
     var deadSearchSkipped = false;
     var clock = 1000;
     function monotonicNow() { return clock; }
     function isViewerOverlayNode() { return false; }
     function resolveAnchorElement(anchor) { return anchor ? document.getElementById(anchor.id) : null; }
     ${['rangeAlive', 'findTextRange', 'notePlace', 'rangeAtPlace', 'sameWords', 'rangeCollapsed', 'deadSearchAllowed', 'noteDeadSearchResult', 'refreshRecordTargets'].map(extractFunction).join('\n')}
     return {
       rangeAlive: rangeAlive,
       refresh: function(record) { deadSearchBudget = Infinity; refreshRecordTargets(record); },
       pageChanged: function() { domGeneration += 1; },
       advance: function(ms) { clock += ms; },
     };`,
  )(document, NodeFilter, constant('DEAD_SEARCH_BACKOFF_MS'), constant('DEAD_SEARCH_BACKOFF_MAX_MS'), KEEP_MS, MAX_QUOTE) as {
    rangeAlive: (range: Range | null) => boolean;
    refresh: (record: Record) => void;
    pageChanged: () => void;
    advance: (ms: number) => void;
  };
}

type Bridge = ReturnType<typeof bridge>;

describe.skipIf(!hasDom)('a text highlight whose text leaves the page', () => {
  // Guards: the same nodes detached and re-attached (a keyed move) bring the highlight back at exactly the
  // characters the person selected, including a selection that began on the space before a word (stored text
  // trimmed to "quoted", Range " quoted"), and it is reported unanchored only while away.
  test('the same row moved: restored at the exact original start and end, leading space included', () => {
    const { list, range, record, b } = setup(
      '<div id="l"><p id="r0">First row</p><p id="r1">The quoted sentence.</p><p id="r2">Last row</p></div>',
      'r1', 3, 10, 'quoted',
    );
    const row = byId('r1');
    const node = row.firstChild as Text;
    liveRemove(row, [range]);
    pass(record, b);
    expect(reportedUnanchored(record, b)).toBe(true);

    liveInsert(list, row, null, [range]);
    pass(record, b);
    const back = record.targets[0]!.range!;
    expect(reportedUnanchored(record, b)).toBe(false);
    expect(back.startContainer).toBe(node);
    expect(back.startOffset).toBe(3);
    expect(back.endContainer).toBe(node);
    expect(back.endOffset).toBe(10);
    expect(back.toString()).toBe(' quoted');
  });

  // Guards: a highlight spanning two text nodes, hidden by removal and shown again later (same nodes), comes back
  // with both ends exactly where they were.
  test('a highlight across two text nodes, hidden by removal and shown again: both ends restored', () => {
    document.body.innerHTML = '<div id="l"><p id="r0">Intro</p><p id="r1">Net <b>revenue</b> fell sharply</p></div>';
    const list = byId('l');
    const row = byId('r1');
    const first = row.firstChild as Text; // "Net "
    const last = row.lastChild as Text; // " fell sharply"
    const range = document.createRange();
    range.setStart(first, 1);
    range.setEnd(last, 5);
    const b = bridge();
    const record = makeRecord(range, 'et revenue fell');
    b.refresh(record);
    liveRemove(row, [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(reportedUnanchored(record, b)).toBe(true);
    }
    liveInsert(list, row, null, [range]);
    pass(record, b);
    const back = record.targets[0]!.range!;
    expect(back.startContainer).toBe(first);
    expect(back.startOffset).toBe(1);
    expect(back.endContainer).toBe(last);
    expect(back.endOffset).toBe(5);
    expect(back.toString()).toBe('et revenue fell');
  });

  // Guards the accepted limit: a page that destroys the row and builds a new one with identical text (most
  // virtualizers) leaves the highlight unanchored, reported so, rather than guessed onto the new nodes. A reload
  // restores it from its stored text (restoreAnnotation, not exercised here).
  test('the row recreated with identical text: stays unanchored and is reported unanchored', () => {
    const { list, range, record, b } = setup(
      '<div id="l"><p id="r0">First row</p><p id="r1">The quoted sentence.</p><p id="r2">Last row</p></div>',
      'r1', 4, 10, 'quoted',
    );
    liveRemove(byId('r1'), [range]);
    pass(record, b);
    const again = document.createElement('p');
    again.textContent = 'The quoted sentence.';
    liveInsert(list, again, byId('r2'), [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(record.targets[0]!.range).toBeNull();
      expect(reportedUnanchored(record, b)).toBe(true);
    }
  });

  // Guards: two rows share the quoted word; the highlighted row leaves (scrolled away) and later a new copy of it
  // is mounted. In no pass may the highlight sit on the other row ("Revenue grew."), and it is reported unanchored.
  test('two rows share the word, the highlighted one is removed: never placed on the other row', () => {
    const { list, range, record, b } = setup(
      '<div id="l"><p id="r0">Revenue grew.</p><p id="r1">Revenue fell.</p></div>',
      'r1', 0, 7, 'Revenue',
    );
    liveRemove(byId('r1'), [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(rowOf(record)).not.toBe('r0');
      expect(reportedUnanchored(record, b)).toBe(true);
    }
    const again = document.createElement('p');
    again.textContent = 'Revenue fell.';
    liveInsert(list, again, null, [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(rowOf(record)).not.toBe('r0');
      expect(reportedUnanchored(record, b)).toBe(true);
    }
  });

  // Guards (identical rows): the middle of three identical rows is removed; the highlight never moves to a neighbour.
  test('three identical rows, the middle one removed: not moved to a neighbour', () => {
    const { range, record, b } = setup(
      '<div id="l"><p id="r0">Same row text.</p><p id="r1">Same row text.</p><p id="r2">Same row text.</p></div>',
      'r1', 0, 4, 'Same',
    );
    liveRemove(byId('r1'), [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(record.targets[0]!.range).toBeNull();
      expect(reportedUnanchored(record, b)).toBe(true);
    }
  });

  // Guards (text rewritten in place, e.g. an index-keyed list re-sorted): setting the node's data collapses the
  // Range inside it. The node now says something else, so the highlight is unanchored, not left on the new words;
  // when the very same node holds the very same text again, the highlight is back on it, exactly.
  test("a row's text rewritten in place (node.data): unanchored, back exactly when the same text returns", () => {
    const { range, record, b } = setup(
      '<div id="l"><p id="r0">Revenue grew.</p><p id="r1">Revenue fell.</p></div>',
      'r1', 0, 7, 'Revenue',
    );
    const t0 = byId('r0').firstChild as Text;
    const t1 = byId('r1').firstChild as Text;
    replaceAllData(t0, 'Revenue fell.', [range]);
    replaceAllData(t1, 'Revenue grew.', [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(record.targets[0]!.range).toBeNull();
      expect(reportedUnanchored(record, b)).toBe(true);
    }
    replaceAllData(t0, 'Revenue grew.', [range]);
    replaceAllData(t1, 'Revenue fell.', [range]);
    pass(record, b);
    const back = record.targets[0]!.range!;
    expect(back.startContainer).toBe(t1);
    expect(back.startOffset).toBe(0);
    expect(back.endOffset).toBe(7);
  });

  // Guards (text node replaced, replaceChild): the new node is not the node the person highlighted.
  test('the text node replaced by a new one (replaceChild): unanchored, not re-found', () => {
    const { range, record, b } = setup(
      '<div id="l"><p id="r0">Revenue grew.</p><p id="r1">Revenue fell.</p></div>',
      'r1', 0, 7, 'Revenue',
    );
    const row = byId('r1');
    const old = row.firstChild as Text;
    const fresh = document.createTextNode('Revenue fell.');
    // replaceChild = remove the old child, insert the new one at its index.
    liveRemove(old, [range]);
    liveInsert(row, fresh, row.firstChild, [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(record.targets[0]!.range).toBeNull();
      expect(reportedUnanchored(record, b)).toBe(true);
    }
  });

  // Guards (rewrite, then removal): once lost, nothing ever falls back to the first occurrence in the document.
  test('the text rewritten and then the row removed: unanchored, never the first occurrence', () => {
    const { range, record, b } = setup(
      '<div id="l"><p id="r0">Revenue grew.</p><p id="r1">Q3 Revenue fell.</p></div>',
      'r1', 3, 10, 'Revenue',
    );
    replaceAllData(byId('r1').firstChild as Text, 'Q3: Revenue fell.', [range]);
    pass(record, b);
    expect(record.targets[0]!.range).toBeNull();
    liveRemove(byId('r1'), [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(rowOf(record)).not.toBe('r0');
      expect(reportedUnanchored(record, b)).toBe(true);
    }
  });

  // Guards: an anchored highlight that was in place and collapsed is searched for only inside its anchor element.
  // Its row removed from the still-present anchor: unanchored, never on "Revenue grew." outside the anchor. A row
  // with the quoted word added inside the anchor again: found there (the same search a reload runs first).
  test('an anchored highlight, its row removed inside the anchor: unanchored, then found when the anchor has it again', () => {
    const { card, range, record, b } = anchoredSetup();
    liveRemove(byId('r1'), [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(record.targets[0]!.range).toBeNull();
    }
    const fresh = document.createElement('p');
    fresh.id = 'r2';
    fresh.textContent = 'Revenue fell sharply.';
    liveInsert(card, fresh, null, [range]);
    pass(record, b);
    expect(rowOf(record)).toBe('r2');
    expect(record.targets[0]!.range!.toString()).toBe('Revenue');
  });

  // Guards: an anchored highlight that was in place, with its anchor element itself removed, never falls back to
  // the whole-document search (which would put it on "Revenue grew.").
  test('an anchored highlight whose anchor element is removed: unanchored, never the other row', () => {
    const { card, range, record, b } = anchoredSetup();
    liveRemove(card, [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(rowOf(record)).not.toBe('r0');
      expect(record.targets[0]!.range).toBeNull();
    }
  });

  // Guards the reload / late-render path: a target that was never in place (a live restore's placeholder) still
  // finds its text by the restore search, as on main, with or without an anchor.
  test('a target never in place still finds its text by the restore search', () => {
    document.body.innerHTML = '<p id="r0">Late rendered text.</p>';
    const b = bridge();
    const record: Record = { id: 'late', params: { anchor: null }, targets: [{ kind: 'range', range: null, text: 'rendered', markerless: false }] };
    pass(record, b);
    expect(rowOf(record)).toBe('r0');
    expect(record.targets[0]!.range!.toString()).toBe('rendered');

    const anchored: Record = { id: 'late2', params: { anchor: { id: 'missing' } }, targets: [{ kind: 'range', range: null, text: 'rendered', markerless: true }] };
    pass(anchored, b);
    expect(rowOf(anchored)).toBe('r0');
  });

  // Guards: two text nodes that come back apart, with other content between them, would give a Range over words
  // the person did not select: not restored.
  test('a two-node highlight whose nodes come back apart: unanchored', () => {
    const { list, rows, range, record, b } = twoRowHighlight();
    liveRemove(rows[0]!, [range]);
    liveRemove(rows[1]!, [range]);
    pass(record, b);
    liveInsert(list, rows[0]!, null, [range]);
    const between = document.createElement('p');
    between.textContent = 'Inserted row.';
    liveInsert(list, between, null, [range]);
    liveInsert(list, rows[1]!, null, [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(record.targets[0]!.range).toBeNull();
      expect(reportedUnanchored(record, b)).toBe(true);
    }
  });

  // Guards: two text nodes back in reversed order give an empty Range: not restored, and the lost timer keeps
  // running, so the node references are still dropped after the bound.
  test('a two-node highlight whose nodes come back reversed: unanchored, references dropped after the bound', () => {
    const { list, rows, range, record, b } = twoRowHighlight();
    const first = rows[0]!.firstChild as Text;
    liveRemove(rows[0]!, [range]);
    liveRemove(rows[1]!, [range]);
    pass(record, b);
    liveInsert(list, rows[1]!, null, [range]);
    liveInsert(list, rows[0]!, null, [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(record.targets[0]!.range).toBeNull();
    }
    b.advance(KEEP_MS + 1000);
    pass(record, b);
    expect(holds(record.targets[0], first)).toBe(false);
  });

  // Guards the capped quote: a selection longer than MAX_SELECTION_TEXT is stored cut to it, so the stored
  // words cannot confirm where a two-node highlight ends. It stays unanchored even when its nodes return.
  test('a long two-node highlight with a capped quote stays unanchored when its nodes return', () => {
    const long = 'word '.repeat(Math.ceil(MAX_QUOTE / 5) + 10);
    document.body.innerHTML = '<div id="l"><p id="r0"></p><p id="r1">Tail words.</p></div>';
    const list = byId('l');
    const p0 = byId('r0');
    p0.textContent = long;
    const first = p0.firstChild as Text;
    const last = byId('r1').firstChild as Text;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, 4);
    const b = bridge();
    const record = makeRecord(range, range.toString().trim().slice(0, MAX_QUOTE));
    b.refresh(record);
    const p1 = byId('r1');
    liveRemove(p0, [range]);
    liveRemove(p1, [range]);
    pass(record, b);
    liveInsert(list, p0, null, [range]);
    liveInsert(list, p1, null, [range]);
    pass(record, b);
    expect(first.isConnected && last.isConnected).toBe(true);
    expect(record.targets[0]!.range).toBeNull();
  });

  // Guards the bound: a lost highlight lets go of the detached nodes after LOST_PLACE_KEEP_MS (and then stays
  // unanchored even if the same node returns); before the bound, the same node returning restores it.
  test('references to the lost nodes are dropped after the bound', () => {
    const early = setup('<div id="l"><p id="r0">Row</p><p id="r1">The quoted sentence.</p></div>', 'r1', 4, 10, 'quoted');
    const earlyRow = byId('r1');
    liveRemove(earlyRow, [early.range]);
    pass(early.record, early.b);
    early.b.advance(KEEP_MS - 1000);
    liveInsert(early.list, earlyRow, null, [early.range]);
    pass(early.record, early.b);
    expect(early.record.targets[0]!.range!.toString()).toBe('quoted');

    const late = setup('<div id="l"><p id="r0">Row</p><p id="r1">The quoted sentence.</p></div>', 'r1', 4, 10, 'quoted');
    const lateRow = byId('r1');
    const lateNode = lateRow.firstChild as Text;
    liveRemove(lateRow, [late.range]);
    pass(late.record, late.b);
    expect(holds(late.record.targets[0], lateNode)).toBe(true);
    late.b.advance(KEEP_MS + 1000);
    pass(late.record, late.b);
    expect(holds(late.record.targets[0], lateNode)).toBe(false);
    liveInsert(late.list, lateRow, null, [late.range]);
    pass(late.record, late.b);
    expect(late.record.targets[0]!.range).toBeNull();
    expect(reportedUnanchored(late.record, late.b)).toBe(true);
  });

  // Guards: a highlight that never collapses is left exactly as it is (same Range, same offsets) through page
  // changes, including text appended to its own node (streaming), which keeps the Range in place.
  test('a highlight that never collapses is untouched', () => {
    document.body.innerHTML = '<p id="p">Some quoted words, quoted twice.</p>';
    const text = byId('p').firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 19);
    range.setEnd(text, 25);
    const b = bridge();
    const record = makeRecord(range, 'quoted');
    for (let i = 0; i < 3; i += 1) {
      document.body.appendChild(document.createElement('div'));
      text.appendData(' More.');
      pass(record, b);
      expect(record.targets[0]!.range).toBe(range);
      expect(range.startContainer).toBe(text);
      expect(range.startOffset).toBe(19);
      expect(range.endOffset).toBe(25);
    }
  });

  // Guards the non-text boundary decision: a highlight whose start is an element boundary (e.g. a whole-paragraph
  // selection) has no text to confirm it by, so once lost it stays unanchored: never searched for, even with the
  // same paragraph back and its words elsewhere on the page.
  test('a highlight starting on an element boundary, once lost, stays unanchored', () => {
    document.body.innerHTML = '<div id="l"><p id="r0">Revenue fell.</p><p id="r1">Revenue fell.</p></div>';
    const list = byId('l');
    const row = byId('r1');
    const range = document.createRange();
    range.setStart(row, 0);
    range.setEnd(row.firstChild!, 7);
    const b = bridge();
    const record = makeRecord(range, 'Revenue');
    b.refresh(record);
    liveRemove(row, [range]);
    pass(record, b);
    liveInsert(list, row, null, [range]);
    for (let i = 0; i < 3; i += 1) {
      pass(record, b);
      expect(record.targets[0]!.range).toBeNull();
      expect(reportedUnanchored(record, b)).toBe(true);
    }
  });

  // Guards robustness: the script runs inside arbitrary pages; a page that patches Range or Node getters to throw
  // must not abort the overlay pass.
  test('a page whose Range and Node getters throw cannot abort the pass', () => {
    const node = setup('<p id="r0">Revenue fell.</p>', 'r0', 0, 7, 'Revenue');
    Object.defineProperty(byId('r0').firstChild!, 'nodeType', { get() { throw new Error('page getter'); } });
    expect(() => pass(node.record, node.b)).not.toThrow();

    const range = setup('<p id="r0">Revenue fell.</p>', 'r0', 0, 7, 'Revenue');
    Object.defineProperty(range.range, 'collapsed', { get() { throw new Error('page getter'); } });
    expect(() => pass(range.record, range.b)).not.toThrow();
  });
});

function byId(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function makeRecord(range: Range, text: string): Record {
  return { id: 'a1', params: { anchor: null }, targets: [{ kind: 'range', range, text, markerless: false }] };
}

/** A document, a live highlight from `start` to `end` in row `rowId`'s first text node, painted once. */
function setup(html: string, rowId: string, start: number, end: number, text: string) {
  document.body.innerHTML = html;
  const node = byId(rowId).firstChild as Text;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const b = bridge();
  const record = makeRecord(range, text);
  b.refresh(record);
  expect(record.targets[0]!.range).toBe(range);
  return { list: byId(rowId).parentElement!, range, record, b };
}

/** "Revenue grew." outside, and an anchored card holding "Revenue fell." with a markerless highlight on "Revenue". */
function anchoredSetup() {
  document.body.innerHTML = '<p id="r0">Revenue grew.</p><div id="card"><p id="r1">Revenue fell.</p></div>';
  const range = document.createRange();
  range.setStart(byId('r1').firstChild!, 0);
  range.setEnd(byId('r1').firstChild!, 7);
  const b = bridge();
  const record: Record = {
    id: 'anchored', params: { anchor: { id: 'card' } },
    targets: [{ kind: 'range', range, text: 'Revenue', markerless: true }],
  };
  b.refresh(record);
  expect(record.targets[0]!.range).toBe(range);
  return { card: byId('card'), range, record, b };
}

/** A highlight from "row." in the first row to "Beta" in the second (two text nodes), painted once. */
function twoRowHighlight() {
  document.body.innerHTML = '<div id="l"><p id="r0">Alpha row.</p><p id="r1">Beta row.</p><p id="r2">Gamma.</p></div>';
  const rows = [byId('r0'), byId('r1')];
  const range = document.createRange();
  range.setStart(rows[0]!.firstChild!, 6);
  range.setEnd(rows[1]!.firstChild!, 4);
  const b = bridge();
  const record = makeRecord(range, 'row.\n\nBeta');
  b.refresh(record);
  expect(record.targets[0]!.range).toBe(range);
  return { list: byId('l'), rows, range, record, b };
}

/** A later reconcile pass after the page changed, past any failed search's backoff. */
function pass(record: Record, b: Bridge) {
  b.pageChanged();
  b.advance(16);
  for (const target of record.targets) target.searchBackoffUntil = 0;
  b.refresh(record);
}

/** What the overlay pass reports to the host: no target alive (renderAnnotationOverlay's recordAnchored). */
function reportedUnanchored(record: Record, b: Bridge): boolean {
  return !record.targets.some((target) => b.rangeAlive(target.range));
}

/** The id of the row the highlight starts in, or null when it has none. */
function rowOf(record: Record): string | null {
  const range = record.targets[0]!.range;
  if (!range) return null;
  const start = range.startContainer;
  return ((start.nodeType === 3 ? start.parentNode : start) as Element).id;
}

/** Whether the target (or a plain object it holds) still references the node. */
function holds(value: unknown, node: Node, depth = 0): boolean {
  if (value === node) return true;
  if (!value || typeof value !== 'object' || depth > 2) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) return false;
  return Object.values(value as object).some((child) => holds(child, node, depth + 1));
}

const indexOf = (node: Node) => Array.prototype.indexOf.call(node.parentNode!.childNodes, node);

/** removeChild plus the DOM spec's live range pre-remove steps for the given ranges. */
function liveRemove(node: Node, ranges: Range[]) {
  const parent = node.parentNode!;
  const index = indexOf(node);
  const points = ranges.map((r) => {
    let [sc, so, ec, eo] = [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
    if (node.contains(sc)) { sc = parent; so = index; } else if (sc === parent && so > index) so -= 1;
    if (node.contains(ec)) { ec = parent; eo = index; } else if (ec === parent && eo > index) eo -= 1;
    return [sc, so, ec, eo] as const;
  });
  parent.removeChild(node);
  ranges.forEach((r, i) => { const [sc, so, ec, eo] = points[i]!; r.setStart(sc, so); r.setEnd(ec, eo); });
}

/** insertBefore plus the DOM spec's insert steps for live ranges (a boundary in parent after the index shifts right). */
function liveInsert(parent: Node, node: Node, before: Node | null, ranges: Range[]) {
  const index = before ? indexOf(before) : parent.childNodes.length;
  const points = ranges.map((r) => {
    let [sc, so, ec, eo] = [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
    if (sc === parent && so > index) so += 1;
    if (ec === parent && eo > index) eo += 1;
    return [sc, so, ec, eo] as const;
  });
  parent.insertBefore(node, before);
  ranges.forEach((r, i) => { const [sc, so, ec, eo] = points[i]!; r.setStart(sc, so); r.setEnd(ec, eo); });
}

/** node.data = text plus the DOM spec's replace data steps: a boundary inside the node with offset > 0 moves to 0. */
function replaceAllData(node: Text, text: string, ranges: Range[]) {
  const points = ranges.map((r) => {
    let [sc, so, ec, eo] = [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
    if (sc === node && so > 0) so = 0;
    if (ec === node && eo > 0) eo = 0;
    return [sc, so, ec, eo] as const;
  });
  node.data = text;
  ranges.forEach((r, i) => { const [sc, so, ec, eo] = points[i]!; r.setStart(sc, so); r.setEnd(ec, eo); });
}
