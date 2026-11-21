/**
 * Saved comments are anchored to the parser's blocks (`block-N` ids, content,
 * start lines). This pins `parseMarkdownToBlocks`' whole output for the
 * fixture corpus to what it was before footnote definitions became blocks of
 * their own, so a parser change that renumbers or rewrites the blocks of a
 * document WITHOUT footnotes (and so moves its existing comments) fails here.
 *
 * A deliberate change to how these fixtures parse updates the hash, with the
 * reason in the commit: the old hash is what existing comments were saved on.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdownToBlocks } from './parser';

const FIXTURES = join(import.meta.dir, '../../../tests/test-fixtures');

const PARSE_HASHES: Record<string, string> = {
  '01-reported-issue': 'dd4701362abcf291',
  '02-list-continuations': 'a5c622372442d8fc',
  '03-hard-line-breaks': '03179ff460819df4',
  '04-unchanged-baseline': '7c8b738bff30fb2b',
  '05-real-world-plan': 'a8d9c1181edd7dc0',
  '06-ordered-list-plan': '1ac8ca955d920689',
  '07-blockquotes': '4e258b64a24489dc',
  '08-ordered-edge-cases': 'deed9bdbab76dc69',
  '09-quoted-list-regression': '3b5439e762f985d7',
  '10-inline-gaps-and-bullets': '446fea6f49e3d13c',
  '11-html-blocks': 'd23317e2ce977cc3',
  '12-gfm-and-inline-extras': '868d5dc8b945615f',
  '13-known-issues': 'ed4682119c240fdc',
  '14-anchor-links': '06ee7e77eee1a920',
  '15-loose-list-items': 'cb398ee6d98391fc',
};

describe('parser output for documents without footnotes', () => {
  for (const [name, hash] of Object.entries(PARSE_HASHES)) {
    test(`${name} parses to the same blocks as before`, () => {
      const markdown = readFileSync(join(FIXTURES, `${name}.md`), 'utf8');
      const blocks = parseMarkdownToBlocks(markdown);
      expect(blocks.some((b) => b.footnoteLabel !== undefined)).toBe(false);
      expect(createHash('sha256').update(JSON.stringify(blocks)).digest('hex').slice(0, 16)).toBe(hash);
    });
  }
});
