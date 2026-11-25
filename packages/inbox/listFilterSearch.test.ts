/**
 * The find fields of the list's filter menu (listFilterSearch.ts): when a section gets one, and how a query narrows
 * that section's rows.
 *
 * What this catches: a field on a section of eight rows (or none on nine); a match that misses on case or accents, or
 * bolds the wrong letters; a pinned row that goes when it does not match (it could no longer be unticked) or that is
 * drawn twice; a row that is not pinned kept without a match; a wrong count (a screen reader would hear it); a fold that
 * takes away a mark making another letter (か matching が) or misses ı and ς; a long label shortened inside a grapheme,
 * or not shortened when its match is out of view (CJK counted narrow).
 */
import { describe, expect, test } from 'bun:test';
import { findInSection, labelStart, searchHit, sectionIsLong } from './listFilterSearch';

type Row = { key: string; label: string };
const r = (label: string): Row => ({ key: `k_${label}`, label });
const PROJECTS: Row[] = ['api', 'Billing', 'web', 'rebill', 'docs'].map(r);
const pins = (...labels: string[]) => new Set(labels.map((label) => `k_${label}`));
const labels = (rows: readonly { row: Row }[]) => rows.map((x) => x.row.label);

describe('when a section gets its field', () => {
  test('only once it holds more than eight rows', () => {
    expect(sectionIsLong(0)).toBe(false);
    expect(sectionIsLong(8)).toBe(false);
    expect(sectionIsLong(9)).toBe(true);
  });
});

describe('a match', () => {
  test('ignores case and accents and says where it is in the label', () => {
    expect(searchHit('Billing', 'BIL')).toEqual([0, 3]);
    expect(searchHit('rebill', 'bil')).toEqual([2, 5]);
    expect(searchHit('Café menu', 'cafe')).toEqual([0, 4]);
    expect(searchHit('cafe', 'café')).toEqual([0, 4]);
    // A letter written as e plus an accent mark is still one letter of the label.
    expect(searchHit('Cafe\u0301 au lait', 'e au')).toEqual([3, 8]);
    // The mark after a matched letter stays inside the bold with it.
    expect(searchHit('Cafe\u0301 au lait', 'cafe')).toEqual([0, 5]);
    expect(searchHit('Last 7 days', '7 d')).toEqual([5, 8]);
  });

  test('other scripts, emoji and long names: the bold lands on the matched characters', () => {
    expect(searchHit('数据管道', '管道')).toEqual([2, 4]);
    expect(searchHit('ユーザー管理', 'ザー')).toEqual([2, 4]);
    expect(searchHit('لوحة-التحكم', 'التحكم')).toEqual([5, 11]);
    // An emoji is two UTF-16 units: the match after it starts after both, and an emoji itself is found whole.
    expect(searchHit('🚀 launch-pad', 'launch')).toEqual([3, 9]);
    expect(searchHit('🚀 launch-pad', '🚀')).toEqual([0, 2]);
    // A capital whose lower case is longer (İ is i plus a dot mark) still maps back to its one character.
    expect(searchHit('İstanbul ops', 'stan')).toEqual([1, 5]);
    expect(searchHit('Überwachung', 'uber')).toEqual([0, 4]);
    const long = `reports-${'x'.repeat(64)}-quarterly-review`;
    expect(searchHit(long, 'quarterly')).toEqual([long.indexOf('quarterly'), long.indexOf('quarterly') + 9]);
  });

  test('a voicing mark makes another letter: か never matches が, nor か followed by its mark', () => {
    expect(searchHit('が', 'か')).toBeNull();
    expect(searchHit('パン', 'ハ')).toBeNull();
    expect(searchHit('か\u3099', 'か')).toBeNull();
    expect(searchHit('ぎんこう', 'が')).toBeNull();
    expect(searchHit('ががく', 'が')).toEqual([0, 1]);
    expect(searchHit('किताब', 'कि')).toEqual([0, 2]);
    expect(searchHit('น้ำ', 'น้ำ')).toEqual([0, 3]);
    // Arabic harakat and an emoji's variation selector still fold away.
    expect(searchHit('مُحَمَّد', 'محمد')).not.toBeNull();
    expect(searchHit('❤️ team', '❤')).toEqual([0, 2]);
  });

  test('typed letter by letter, Hindi, Thai and Korean keep finding the name; the marks after the match are drawn bold', () => {
    // Each prefix finds the name, the vowel sign after it inside the bold.
    expect(searchHit('किताब', 'क')).toEqual([0, 2]);
    expect(searchHit('किताब', 'कित')).toEqual([0, 4]);
    expect(searchHit('สวัสดี', 'สวัสด')).toEqual([0, 6]);
    expect(searchHit('น้ำ', 'น')).toEqual([0, 2]);
    // A Korean syllable being composed (가 on the way to 각) finds the name.
    expect(searchHit('각사', '가')).toEqual([0, 1]);
  });

  test('dotless ı and final ς match i and σ', () => {
    expect(searchHit('Istanbul', 'ıstanbul')).toEqual([0, 8]);
    expect(searchHit('ılık', 'ilik')).toEqual([0, 4]);
    expect(searchHit('ΟΔΟΣ ops', 'οδος')).toEqual([0, 4]);
    expect(searchHit('οδός', 'ΟΔΟΣ')).toEqual([0, 4]);
  });

  test('a blank query or an absent one is no match', () => {
    expect(searchHit('Billing', '')).toBeNull();
    expect(searchHit('Billing', '   ')).toBeNull();
    expect(searchHit('Billing', 'zz')).toBeNull();
  });

  test('the query is trimmed, the space inside it is kept', () => {
    expect(searchHit('Last 7 days', '  7 days ')).toEqual([5, 11]);
    expect(searchHit('Last7days', '7 days')).toBeNull();
  });
});

describe("narrowing one section's rows", () => {
  test('no query: the pinned rows above, every other row below in its order, none bold; not searching', () => {
    const all = findInSection(PROJECTS, '', pins('web'));
    expect(all.searching).toBe(false);
    expect(labels(all.pinned)).toEqual(['web']);
    expect(labels(all.rows)).toEqual(['api', 'Billing', 'rebill', 'docs']);
    expect(all.matches).toBe(5);
    expect([...all.pinned, ...all.rows].every((x) => x.hit === null)).toBe(true);
  });

  test('a query keeps the rows that hold it, in their order, with where it is', () => {
    const found = findInSection(PROJECTS, 'BIL', pins());
    expect(labels(found.rows)).toEqual(['Billing', 'rebill']);
    expect(found.rows.map((x) => x.hit)).toEqual([[0, 3], [2, 5]]);
    expect(found.matches).toBe(2);
    expect(found.searching).toBe(true);
  });

  test('a pinned row stays above whatever is typed, and is never drawn twice', () => {
    const miss = findInSection(PROJECTS, 'bil', pins('web'));
    expect(labels(miss.pinned)).toEqual(['web']);
    expect(miss.pinned[0]!.hit).toBeNull();
    expect(labels(miss.rows)).toEqual(['Billing', 'rebill']);
    // A pinned row that matches is bold and counted, still only above.
    const hit = findInSection(PROJECTS, 'bil', pins('rebill'));
    expect(labels(hit.pinned)).toEqual(['rebill']);
    expect(hit.pinned[0]!.hit).toEqual([2, 5]);
    expect(labels(hit.rows)).toEqual(['Billing']);
    expect(hit.matches).toBe(2);
  });

  test('nothing matches: no match counted, only the pinned rows stay', () => {
    const found = findInSection(PROJECTS, 'zzz', pins('web'));
    expect(found.matches).toBe(0);
    expect(labels(found.pinned)).toEqual(['web']);
    expect(found.rows).toEqual([]);
  });
});

describe('a long label drawn from past its start', () => {
  const at = (label: string, query: string) => labelStart(label, searchHit(label, query));

  test('a label that fits, or a match within the part shown, starts at 0', () => {
    expect(at('billing-api', 'api')).toBe(0);
    expect(at(`reports-${'x'.repeat(60)}`, 'reports')).toBe(0);
    expect(labelStart(`reports-${'x'.repeat(60)}`, null)).toBe(0);
  });

  test('a match past the cut keeps eight characters before it', () => {
    const label = `reports-${'x'.repeat(60)}-quarterly-review`;
    const start = at(label, 'quarterly');
    expect(start).toBe(label.indexOf('quarterly') - 8);
  });

  test('never inside a flag, a skin tone, a family emoji or a letter and its accent', () => {
    const edges = (label: string) => new Set([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(label)].map((p) => p.index));
    for (const before of ['🇫🇷', '👍🏽', '👨‍👩‍👧', 'e\u0301', '각']) {
      for (let pad = 0; pad < 10; pad += 1) {
        const label = `${'a'.repeat(30 + pad)}${before}${before}${before}quarterly`;
        const start = at(label, 'quarterly');
        expect(start).toBeGreaterThan(0);
        expect(edges(label).has(start)).toBe(true);
      }
    }
  });

  test('wide characters count twice: a CJK match out of view is brought in, one in view is not', () => {
    const cjk = '数据管道和报表导出服务的季度财务审查';
    expect(at(cjk, '审查')).toBeGreaterThan(0);
    expect(at(cjk, '数据')).toBe(0);
    // The same length in Latin letters fits.
    expect(at('abcdefghijklmnopqrs', 'rs')).toBe(0);
  });
});

describe('a long label without Intl.Segmenter (Firefox before 125)', () => {
  test('the cut falls back to code points, keeps a letter with its accent, a skin tone and a ZWJ family whole, and never throws', () => {
    const intl = Intl as { Segmenter?: unknown };
    const real = intl.Segmenter;
    delete intl.Segmenter;
    try {
      const at = (label: string, query: string) => labelStart(label, searchHit(label, query));
      expect(at('billing-api', 'api')).toBe(0);
      const long = `reports-${'x'.repeat(60)}-quarterly-review`;
      expect(at(long, 'quarterly')).toBe(long.indexOf('quarterly') - 8);
      for (const before of ['👍🏽', '👨‍👩‍👧', 'e\u0301']) {
        for (let pad = 0; pad < 10; pad += 1) {
          const label = `${'a'.repeat(30 + pad)}${before}${before}${before}quarterly`;
          const start = at(label, 'quarterly');
          expect(start).toBeGreaterThan(0);
          // Never right before what belongs to the code point before it.
          expect(/^(?:\p{M}|[\u{1F3FB}-\u{1F3FF}]|\u200D)/u.test(label.slice(start))).toBe(false);
          expect(label.slice(start - 1, start)).not.toBe('\u200D');
        }
      }
    } finally {
      intl.Segmenter = real;
    }
    expect(typeof Intl.Segmenter).toBe('function');
  });
});
