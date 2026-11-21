/**
 * Block ids are positional (`block-N`), and saved state is keyed by them:
 * comments, ticked checkboxes (`useCheckboxOverrides`), the line labels of
 * comments on an attached file. Drawing footnotes must not renumber a single
 * block that is not a note.
 *
 * `tests/test-fixtures/footnote-block-ids.json` holds documents with a
 * definition in each position that matters (interrupting a paragraph, a run
 * of them, with indented continuation, at the start, at the end, under every
 * section, after a lazy line, before a fence or a question, a quote or a
 * table, an unclosed `$$`), and the blocks the parser WITHOUT footnotes
 * (origin/main) made of each: `base` was written by running that commit's
 * `parseMarkdownToBlocks` over the same documents, never by this code.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findQuestionBlocks } from '@plannotator/core/question-block';
import { parseMarkdownToBlocks } from './parser';
import { FOOTNOTE_DEF_RE, indexFootnotes } from './footnotes';

interface BaseBlock { id: string; type: string; content: string; startLine: number }
const fixture = JSON.parse(readFileSync(join(import.meta.dir, '../../../tests/test-fixtures/footnote-block-ids.json'), 'utf8')) as {
  docs: { name: string; markdown: string; base: BaseBlock[] }[];
};

describe('every block that is not a note keeps the id the parser gave it before footnotes', () => {
  for (const doc of fixture.docs) {
    test(doc.name, () => {
      const blocks = parseMarkdownToBlocks(doc.markdown);
      const base = new Map(doc.base.map((b) => [b.id, b]));
      const notes = blocks.filter((b) => b.footnoteLabel !== undefined);
      const noteLines = notes.map((n) => [n.startLine, n.startLine + n.content.split('\n').length - 1]);

      for (const block of blocks) {
        if (block.footnoteLabel !== undefined) {
          // A note takes the id of the paragraph it starts, or one derived from
          // the block before it, which takes no number from the count.
          const same = base.get(block.id);
          if (same) expect(same.startLine).toBe(block.startLine);
          else expect(block.id).toMatch(/^block-\d+-fn\d+$/);
          continue;
        }
        const same = base.get(block.id);
        if (!same) {
          // A `[^x]:` line nobody cites, written under a note: it was part of
          // that note's paragraph, so it has no id of its own there and takes
          // one derived from the block before it (no number from the count).
          expect(block.type).toBe('paragraph');
          expect(block.id).toMatch(/^block-\d+-fn\d+$/);
          expect(FOOTNOTE_DEF_RE.test(block.content), `${block.id} "${block.content}"`).toBe(true);
          continue;
        }
        expect([same!.type, same!.startLine]).toEqual([block.type, block.startLine]);
        if (same!.content !== block.content) {
          // Only a paragraph a definition interrupted: the old block held the
          // definition's lines after its own text.
          expect(block.type).toBe('paragraph');
          expect(same!.content.startsWith(block.content + '\n')).toBe(true);
          expect(FOOTNOTE_DEF_RE.test(same!.content.slice(block.content.length + 1))).toBe(true);
        }
      }
      // An old block that is gone lay inside a note's lines (an indented paragraph the note now holds).
      const ids = new Set(blocks.map((b) => b.id));
      for (const old of doc.base) {
        if (ids.has(old.id)) continue;
        expect(noteLines.some(([from, to]) => old.startLine >= from && old.startLine <= to), `${old.id} "${old.content}"`).toBe(true);
      }
      // Ids stay unique.
      expect(ids.size).toBe(blocks.length);
    });
  }

  test('a ticked task below a run of definitions keeps its id (the checkbox override finds it)', () => {
    const doc = fixture.docs.find((d) => d.name === 'a run of definitions under a line')!;
    const blocks = parseMarkdownToBlocks(doc.markdown);
    const taskB = blocks.find((b) => b.content === 'Task B')!;
    expect(taskB.id).toBe(doc.base.find((b) => b.content === 'Task B')!.id);
    expect(blocks.filter((b) => b.footnoteLabel).map((b) => b.id)).toEqual(['block-0-fn1', 'block-0-fn2']);
  });
});

test('two blocks starting on one line (display math closing mid-line) keep main\'s ids', () => {
  const doc = fixture.docs.find((d) => d.name === 'display math closing mid-line, then text')!;
  expect(parseMarkdownToBlocks(doc.markdown).map((b) => b.id)).toEqual(doc.base.map((b) => b.id));
});

describe('a [^x]: line nobody cites, under a cited note, stays where it is written', () => {
  for (const [name, inPlace, note] of [
    ['an uncited definition line under a cited one, under a line', ['Sources:', '[^2]: RFC 9111', 'Task', 'Cites [^1].'], '[^1]: RFC 9110'],
    ['an uncited definition line right after a note', ['Cite[^1].', '[^2]: Nobody cites this.', 'Task'], '[^1]: Cited note.'],
  ] as const) {
    test(name, () => {
      const doc = fixture.docs.find((d) => d.name === name)!;
      const blocks = parseMarkdownToBlocks(doc.markdown);
      // Only the cited note goes to the notes list; the uncited line is not
      // folded into it (it would move to the end of the document, marker and all).
      expect(blocks.filter((b) => b.footnoteLabel !== undefined).map((b) => b.content)).toEqual([note]);
      const body = indexFootnotes(blocks)!.bodyBlocks;
      expect(body.map((b) => b.content)).toEqual([...inPlace]);
      // In the order it is written.
      const lines = body.map((b) => b.startLine);
      expect(lines).toEqual([...lines].sort((a, b) => a - b));
      // It takes a derived id; every other block keeps main's.
      const uncited = body.find((b) => b.content.startsWith('[^2]:'))!;
      expect(uncited.id).toMatch(/^block-\d+-fn\d+$/);
      const others = blocks.filter((b) => b !== uncited && b.footnoteLabel === undefined);
      for (const b of others) expect(doc.base.find((o) => o.id === b.id)?.startLine, b.content).toBe(b.startLine);
      expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
    });
  }
});

describe('what counts as a citation', () => {
  test('a [^1] inside a link label or escaped as \\[^1] cites nothing: the line stays a paragraph', () => {
    for (const md of ['Read [see [^1]](https://example.com).\n\n[^1]: Not a note.', 'Literal \\[^1] here.\n\n[^1]: Not a note.', 'An image ![alt [^1]](a.png).\n\n[^1]: Not a note.']) {
      expect(parseMarkdownToBlocks(md).some((b) => b.footnoteLabel !== undefined), md).toBe(false);
    }
    // A reference right before a parenthesis is still one.
    expect(parseMarkdownToBlocks('Cited[^1](aside).\n\n[^1]: A note.').some((b) => b.footnoteLabel === '1')).toBe(true);
  });
});

describe('what is a note', () => {
  test('a [^label]: line nobody cites outside code stays the paragraph it always was', () => {
    for (const name of ['regex prose that nobody cites', 'a reference only in code']) {
      const doc = fixture.docs.find((d) => d.name === name)!;
      const blocks = parseMarkdownToBlocks(doc.markdown);
      expect(blocks.some((b) => b.footnoteLabel !== undefined)).toBe(false);
      expect(blocks.map((b): BaseBlock => ({ id: b.id, type: b.type, content: b.content, startLine: b.startLine }))).toEqual(doc.base);
    }
  });

  test('the parser and core find the same question blocks: a note never holds a fence, directive or HTML block', () => {
    for (const doc of fixture.docs) {
      const blocks = parseMarkdownToBlocks(doc.markdown);
      const parsed = blocks.filter((b) => b.type === 'directive' && b.directiveKind === 'question').map((b) => b.startLine);
      expect(findQuestionBlocks(doc.markdown).map((q) => q.startLine), doc.name).toEqual(parsed);
      for (const note of blocks.filter((b) => b.footnoteLabel !== undefined)) {
        expect(note.content, doc.name).not.toMatch(/^\s*(```|:::)/m);
      }
    }
  });

  test('an unclosed $$ inside a note is the note\'s text, as it is a paragraph\'s', () => {
    const doc = fixture.docs.find((d) => d.name === 'unclosed $$ inside a note')!;
    const note = parseMarkdownToBlocks(doc.markdown).find((b) => b.footnoteLabel === 'm')!;
    expect(note.content).toBe('[^m]: costs\n$$100k for infra');
  });
});
