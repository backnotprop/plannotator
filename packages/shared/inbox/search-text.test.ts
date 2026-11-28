/**
 * The Inbox search text rules the server's index and the window share:
 * tokens (ASCII fast path equal to the segmenter's runs, CJK words without
 * spaces, Arabic as written), folding (case, accents, NFKC, invisible code
 * points), ranges that point into the original text, snippets cut on
 * graphemes with long runs shortened (never CJK, Arabic or Hebrew), and the
 * file name's middle cut.
 */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  INBOX_SEARCH_LONG_TOKEN,
  foldInboxSearchText,
  inboxSearchMatchesAll,
  inboxSearchRanges,
  inboxSearchSnippet,
  inboxSearchTerms,
  middleCutInboxName,
  tokenizeInboxSearchText,
} from '@plannotator/core/inbox-search';

const tokens = (text: string) => tokenizeInboxSearchText(text).map((t) => t.token);
const marked = (snippet: { text: string; marks: [number, number][] }) => snippet.marks.map(([a, l]) => snippet.text.slice(a, a + l));

describe('tokens', () => {
  test('ASCII: maximal letter and digit runs, lower-cased; one-character runs dropped', () => {
    expect(tokens("Relay: rate-limits on retry-policy.md, snake_case don't 3,000 a")).toEqual(['relay', 'rate', 'limits', 'on', 'retry', 'policy', 'md', 'snake', 'case', 'don', '000']);
  });

  test('the ASCII fast path gives the same tokens as the segmenter path', () => {
    // A trailing non-ASCII word forces the segmenter path on the same text.
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9 .,:;'_\-/()]{0,80}$/), (ascii) => {
        expect(tokens(`${ascii} é`).filter((t) => t !== 'é')).toEqual(tokens(ascii));
      }),
    );
  });

  test('Japanese and Chinese split into words without spaces; single CJK characters are kept', () => {
    const japanese = tokens('デプロイ後の決済エラーの調査（deploy 2026-10-12）');
    expect(japanese).toContain('決済');
    expect(japanese).toContain('エラー');
    expect(japanese).toContain('の');
    expect(japanese).toContain('deploy');
    expect(tokens('支付网关超时')).toEqual(expect.arrayContaining(['支付']));
  });

  test('Arabic and Hebrew work as written', () => {
    expect(tokens('تقرير أخطاء الدفع بعد آخر deploy')).toEqual(['تقرير', 'أخطاء', 'الدفع', 'بعد', 'آخر', 'deploy']);
    expect(tokens('שגיאת תשלום')).toEqual(['שגיאת', 'תשלום']);
  });

  test('folding: case, accents, NFKC, invisible code points, ß', () => {
    expect(foldInboxSearchText('Résumé')).toBe('resume');
    expect(foldInboxSearchText('ＡＵＴＨ')).toBe('auth');
    expect(foldInboxSearchText('re​sume')).toBe('resume');
    expect(foldInboxSearchText('Straße')).toBe('strasse');
    // Japanese voicing marks are not accents: デ stays デ.
    expect(foldInboxSearchText('デプロイ')).toBe('デプロイ');
  });

  test('a soft hyphen inside a word keeps it one word; outer ones stay outside its span', () => {
    expect(tokenizeInboxSearchText('fi\u00adnance')).toEqual([{ token: 'finance', start: 0, end: 8 }]);
    expect(tokenizeInboxSearchText('fi\u00ad\u00adnance')).toEqual([{ token: 'finance', start: 0, end: 9 }]);
    expect(tokenizeInboxSearchText('\u00adfinance\u00ad')).toEqual([{ token: 'finance', start: 1, end: 8 }]);
    expect(tokenizeInboxSearchText('支付fi\u00adnance网关').filter((t) => t.token === 'finance')).toEqual([{ token: 'finance', start: 2, end: 10 }]);
    expect(tokens('\u00ad\u00ad')).toEqual([]);
    expect(inboxSearchTerms('fi\u00adnance')).toEqual(inboxSearchTerms('finance'));
  });

  test('query terms: at most 8, duplicates once, empty for words under 2 characters', () => {
    expect(inboxSearchTerms('Rate rate LIMIT')).toEqual(['rate', 'limit']);
    expect(inboxSearchTerms('a b c')).toEqual([]);
    expect(inboxSearchTerms('one two three four five six seven eight nine ten')).toHaveLength(8);
    expect(inboxSearchTerms('x'.repeat(500))).toEqual(['x'.repeat(200)]);
  });
});

describe('ranges', () => {
  test('point into the original text; the last term marks only its typed part', () => {
    const text = 'The relay’s rate limit is 20 a minute';
    const ranges = inboxSearchRanges(text, inboxSearchTerms('rate lim'));
    expect(ranges.map(([a, b]) => text.slice(a, b))).toEqual(['rate', 'lim']);
  });

  test('an accented word is marked whole in the original', () => {
    const text = 'Send the Résumé today';
    expect(inboxSearchRanges(text, ['resume']).map(([a, b]) => text.slice(a, b))).toEqual(['Résumé']);
  });

  test('a prefix inside a folded word ends in the original', () => {
    const text = 'Écoles';
    expect(inboxSearchRanges(text, ['eco']).map(([a, b]) => text.slice(a, b))).toEqual(['Éco']);
  });

  test('a word with soft hyphens inside is marked in the original, whole or up to the typed prefix', () => {
    const cases: [text: string, start: number, end: number, prefixEnd: number][] = [
      ['finance', 0, 7, 3],
      ['fi\u00adnance', 0, 8, 4],
      ['fi\u00ad\u00adnance', 0, 9, 5],
      ['😀 fi\u00adnance', 3, 11, 7],
      ['支付fi\u00adnance网关', 2, 10, 6],
      ['\u00adfinance\u00ad', 1, 8, 4],
    ];
    for (const [text, start, end, prefixEnd] of cases) {
      expect(inboxSearchRanges(text, ['finance'])).toEqual([[start, end]]);
      expect(inboxSearchRanges(text, ['fin'])).toEqual([[start, prefixEnd]]);
    }
    expect(inboxSearchRanges('fi\u00adnance', ['fi'])).toEqual([[0, 2]]);
    const snippet = inboxSearchSnippet('😀 fi\u00adnance', inboxSearchRanges('😀 fi\u00adnance', ['finance']));
    expect(snippet.marks).toEqual([[3, 8]]);
    expect(marked(snippet)).toEqual(['fi\u00adnance']);
  });

  test('a visible hyphen or a space between the parts is not the whole word', () => {
    for (const text of ['fi-nance', 'fi nance']) {
      expect(inboxSearchMatchesAll(text, ['finance'])).toBe(false);
      expect(inboxSearchRanges(text, ['finance'])).toEqual([]);
    }
  });

  test('matchesAll needs every term', () => {
    expect(inboxSearchMatchesAll('rate limit on mailboxes', ['rate', 'mail'])).toBe(true);
    expect(inboxSearchMatchesAll('rate limit', ['rate', 'mail'])).toBe(false);
  });
});

describe('snippets', () => {
  test('cut about 40 characters before the first match, at a word start, with an ellipsis', () => {
    const text = `${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(3)}The relay rate limit is 20 a minute per IP, so a storm of reconnects is braked.`;
    const snippet = inboxSearchSnippet(text, inboxSearchRanges(text, ['rate', 'limit']));
    expect(snippet.text.startsWith('…')).toBe(true);
    expect(snippet.text.charAt(1)).not.toBe(' ');
    expect(marked(snippet)).toEqual(['rate', 'limit']);
  });

  test('never splits an emoji or an accented letter', () => {
    const text = `${'👩🏽‍💻'.repeat(30)} the deploy order matters ${'é'.repeat(200)}`;
    const snippet = inboxSearchSnippet(text, inboxSearchRanges(text, ['deploy']));
    expect(marked(snippet)).toEqual(['deploy']);
    // Every family emoji is whole: the snippet holds only whole ZWJ sequences.
    const emoji = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(snippet.text)].map((g) => g.segment).filter((g) => /\p{Extended_Pictographic}/u.test(g));
    for (const g of emoji) expect(g).toBe('👩🏽‍💻');
  });

  test('a long URL is shortened around an ellipsis; a run with a match is kept', () => {
    const url = `https://ci.example.com/pipelines/northwind/customer-portal-frontend/jobs/8812734/artifacts/raw/deploy.log?attempt=2`;
    const text = `The nightly deploy fails: ${url} shows the CDN serving the old manifest.`;
    const snippet = inboxSearchSnippet(text, inboxSearchRanges(text, ['cdn']), { before: 200 });
    expect(snippet.text).not.toContain(url);
    expect(snippet.text).toContain('…');
    expect(marked(snippet)).toEqual(['CDN']);
    const inside = inboxSearchSnippet(text, inboxSearchRanges(text, ['northwind']));
    expect(marked(inside)).toEqual(['northwind']);
  });

  test('CJK, Arabic and Hebrew runs are never cut as long tokens', () => {
    const cjk = '決済'.repeat(60);
    const snippet = inboxSearchSnippet(`${cjk} deploy`, inboxSearchRanges(`${cjk} deploy`, ['deploy']), { before: 500, after: 500 });
    expect(snippet.text).toContain(cjk);
    expect(cjk.length).toBeGreaterThan(INBOX_SEARCH_LONG_TOKEN);
  });

  test('marks are UTF-16 offsets into the snippet text for any input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 300 }), fc.constantFrom('rate', 'lim', 'deploy'), (noise, word) => {
        const text = `${noise} ${word}limit ${noise}`;
        const snippet = inboxSearchSnippet(text, inboxSearchRanges(text, [word]));
        for (const [a, l] of snippet.marks) {
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a + l).toBeLessThanOrEqual(snippet.text.length);
          expect(foldInboxSearchText(snippet.text.slice(a, a + l)).startsWith(word)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('middle cut', () => {
  test('keeps the extension and the date, cuts by grapheme, follows the marks', () => {
    const name = 'SPIKE-claude-deploy-pipeline-investigation-for-northwind-customer-portal-20261012.md';
    const cut = middleCutInboxName(name, 46, [[6, 6]]);
    expect(cut.text.endsWith('-20261012.md')).toBe(true);
    expect(cut.text).toContain('…');
    expect(marked(cut)).toEqual(['claude']);
    expect(middleCutInboxName('notes.md', 46).text).toBe('notes.md');
  });
});
