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
import { FOOTNOTE_DEF_RE } from './footnotes';

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
        if (!same && FOOTNOTE_DEF_RE.test(block.content)) {
          // A `[^label]:` line nobody cites, right under a note: an ordinary
          // paragraph split from the note's old paragraph, a block that did not
          // exist before, so its id is derived like a note's.
          expect(block.id).toMatch(/^block-\d+-fn\d+$/);
          continue;
        }
        expect(same, `${block.id} "${block.content}"`).toBeDefined();
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
