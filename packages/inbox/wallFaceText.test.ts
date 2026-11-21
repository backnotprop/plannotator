import { describe, expect, test } from 'bun:test';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { documentBlocks, pdfPageCount, tableRows, wallTypeLabel } from './wallFaceText';

const row = (name: string, kind: string) => ({ attachment: { name, kind } as unknown as InboxAttachmentState });

describe('the Artifacts wall tile text', () => {
  test('the type under a name says what the file is, with a PDF page count once known', () => {
    expect(wallTypeLabel(row('shot.png', 'image'))).toBe('PNG image');
    expect(wallTypeLabel(row('retry.ts', 'code'))).toBe('TypeScript');
    expect(wallTypeLabel(row('0042.sql', 'code'))).toBe('SQL');
    expect(wallTypeLabel(row('q3.csv', 'text'))).toBe('CSV table');
    expect(wallTypeLabel(row('notes.txt', 'text'))).toBe('Text');
    expect(wallTypeLabel(row('invoice.pdf', 'pdf'))).toBe('PDF');
    expect(wallTypeLabel(row('invoice.pdf', 'pdf'), 3)).toBe('PDF · 3 pages');
    expect(wallTypeLabel(row('build.tgz', 'file'))).toBe('TGZ file');
    expect(wallTypeLabel({ attachment: null })).toBe('Guided review');
  });

  test("a PDF's page count comes from its page tree, else its page objects", () => {
    expect(pdfPageCount('%PDF-1.4\n1 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj')).toBe(2);
    expect(pdfPageCount('<< /Type /Page >> << /Type /Page >> << /Type /Page >>')).toBe(3);
    expect(pdfPageCount('not a pdf')).toBeNull();
  });

  test('a Markdown page keeps its title, headings, words and items, without marks, fences or tables', () => {
    const blocks = documentBlocks('# Release **2.4**\n\nSmart [retries](http://x) ship.\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n\n## Rollout\n- [x] 10% on `Monday`', true);
    expect(blocks).toEqual([
      { kind: 'h1', text: 'Release 2.4' },
      { kind: 'p', text: 'Smart retries ship.' },
      { kind: 'h2', text: 'Rollout' },
      { kind: 'li', text: '10% on Monday' },
    ]);
  });

  test('a CSV table keeps quoted commas in one cell and stops at 6 rows of 4 cells', () => {
    const rows = tableRows('name,city,n,a,b\n"Doe, Jane",Paris,3,x,y\n' + 'r,c,1,2,3\n'.repeat(9), false);
    expect(rows[1]).toEqual(['Doe, Jane', 'Paris', '3', 'x']);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.length === 4)).toBe(true);
  });
});
