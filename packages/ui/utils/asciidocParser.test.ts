import { describe, test, expect } from 'bun:test';
import { parseAsciidocToBlocks, parseDocumentToBlocks, transpileInline } from './asciidocParser';
import { exportAnnotations } from './parser';
import { AnnotationType, type Block } from '../types';

const parse = parseAsciidocToBlocks;

const types = (blocks: Block[]) => blocks.map((b) => b.type);

describe('parseAsciidocToBlocks — headings and header', () => {
  test('document title and section levels map to heading levels', () => {
    const blocks = parse('= Title\n\n== Section\n\n=== Sub\n\n====== Deep');
    expect(types(blocks)).toEqual(['heading', 'heading', 'heading', 'heading']);
    expect(blocks.map((b) => b.level)).toEqual([1, 2, 3, 6]);
    expect(blocks[0].content).toBe('Title');
  });

  test('author and revision lines under the title are consumed', () => {
    const blocks = parse('= Title\nJane Doe <jane@example.com>\nv1.0, 2026-01-01\n\nBody text.');
    expect(types(blocks)).toEqual(['heading', 'paragraph']);
    expect(blocks[1].content).toBe('Body text.');
  });

  test('attribute entries are consumed and substituted', () => {
    const blocks = parse(':product: Plannotator\n\nUse {product} today. Unknown {nope} stays.');
    expect(types(blocks)).toEqual(['paragraph']);
    expect(blocks[0].content).toBe('Use Plannotator today. Unknown {nope} stays.');
  });

  test('line and block comments are skipped', () => {
    const blocks = parse('// line comment\n\n////\nhidden\n////\n\nVisible.');
    expect(types(blocks)).toEqual(['paragraph']);
    expect(blocks[0].content).toBe('Visible.');
  });
});

describe('parseAsciidocToBlocks — listing blocks', () => {
  test('[source,lang] + ---- becomes a code block with language', () => {
    const blocks = parse('[source,rust]\n----\nfn main() {}\n----');
    expect(types(blocks)).toEqual(['code']);
    expect(blocks[0].language).toBe('rust');
    expect(blocks[0].content).toBe('fn main() {}');
    // Span covers the attribute line through the closing delimiter.
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].sourceLineCount).toBe(4);
  });

  test('bare ---- listing and .... literal become code blocks', () => {
    const blocks = parse('----\nplain listing\n----\n\n....\nliteral text\n....');
    expect(types(blocks)).toEqual(['code', 'code']);
    expect(blocks[0].content).toBe('plain listing');
    expect(blocks[1].content).toBe('literal text');
  });

  test('[source] on a plain paragraph makes it a listing', () => {
    const blocks = parse('[source,js]\nconst x = 1;\n\nAfter.');
    expect(types(blocks)).toEqual(['code', 'paragraph']);
    expect(blocks[0].language).toBe('js');
    expect(blocks[0].content).toBe('const x = 1;');
  });

  test('code content is not inline-transpiled', () => {
    const blocks = parse('----\n*not bold* link:x[y]\n----');
    expect(blocks[0].content).toBe('*not bold* link:x[y]');
  });
});

describe('parseAsciidocToBlocks — admonitions', () => {
  test('inline NOTE: paragraph becomes an alert blockquote', () => {
    const blocks = parse('NOTE: Remember this\nand this too.\n\nNext.');
    expect(types(blocks)).toEqual(['blockquote', 'paragraph']);
    expect(blocks[0].alertKind).toBe('note');
    expect(blocks[0].content).toBe('Remember this\nand this too.');
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].sourceLineCount).toBe(2);
  });

  test('all five admonition kinds map', () => {
    const blocks = parse(
      'NOTE: a\n\nTIP: b\n\nIMPORTANT: c\n\nWARNING: d\n\nCAUTION: e',
    );
    expect(blocks.map((b) => b.alertKind)).toEqual(['note', 'tip', 'important', 'warning', 'caution']);
  });

  test('[WARNING] + ==== block form becomes an alert blockquote with full span', () => {
    const blocks = parse('[WARNING]\n====\nDanger zone.\n\nStill inside.\n====');
    expect(types(blocks)).toEqual(['blockquote']);
    expect(blocks[0].alertKind).toBe('warning');
    expect(blocks[0].content).toBe('Danger zone.\n\nStill inside.');
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].sourceLineCount).toBe(6);
  });

  test('[NOTE] on a plain paragraph becomes an alert', () => {
    const blocks = parse('[NOTE]\nJust a styled paragraph.');
    expect(types(blocks)).toEqual(['blockquote']);
    expect(blocks[0].alertKind).toBe('note');
  });
});

describe('parseAsciidocToBlocks — lists', () => {
  test('unordered nesting via marker count', () => {
    const blocks = parse('* one\n** two\n*** three\n- dash');
    expect(types(blocks)).toEqual(['list-item', 'list-item', 'list-item', 'list-item']);
    expect(blocks.map((b) => b.level)).toEqual([0, 1, 2, 0]);
    expect(blocks.map((b) => b.ordered)).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('ordered lists via dot markers', () => {
    const blocks = parse('. first\n.. nested\n. second');
    expect(blocks.map((b) => b.ordered)).toEqual([true, true, true]);
    expect(blocks.map((b) => b.level)).toEqual([0, 1, 0]);
  });

  test('checklists', () => {
    const blocks = parse('* [x] done\n* [*] also done\n* [ ] todo');
    expect(blocks.map((b) => b.checked)).toEqual([true, true, false]);
    expect(blocks[0].content).toBe('done');
  });

  test('description list becomes bold-term list item', () => {
    const blocks = parse('CPU:: the processor\nRAM::\nworking memory');
    expect(types(blocks)).toEqual(['list-item', 'list-item']);
    expect(blocks[0].content).toBe('**CPU** — the processor');
    expect(blocks[1].content).toBe('**RAM** — working memory');
  });

  test('+ continuation attaches the next paragraph to the list item', () => {
    const blocks = parse('* item\n+\ncontinued text\n\nSeparate.');
    expect(types(blocks)).toEqual(['list-item', 'paragraph']);
    expect(blocks[0].content).toBe('item\n\ncontinued text');
    expect(blocks[1].content).toBe('Separate.');
  });
});

describe('parseAsciidocToBlocks — tables', () => {
  test('compact style: each line is a row, first row is header', () => {
    const blocks = parse('|===\n|Name |Age\n|Ada |36\n|Alan |41\n|===');
    expect(types(blocks)).toEqual(['table']);
    expect(blocks[0].content).toBe(
      '| Name | Age |\n| --- | --- |\n| Ada | 36 |\n| Alan | 41 |',
    );
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].sourceLineCount).toBe(5);
  });

  test('blank-separated style: one cell per line groups into rows', () => {
    const blocks = parse('|===\n|Name |Age\n\n|Ada\n|36\n\n|Alan\n|41\n|===');
    expect(blocks[0].content).toBe(
      '| Name | Age |\n| --- | --- |\n| Ada | 36 |\n| Alan | 41 |',
    );
  });

  test('cell specs are stripped', () => {
    const blocks = parse('|===\n|H1 |H2\n2+|span\n|===');
    expect(blocks[0].content).toContain('| span |');
    expect(blocks[0].content).not.toContain('2+');
  });
});

describe('parseAsciidocToBlocks — quotes, rules, images, misc', () => {
  test('____ quote block with [quote] attribution', () => {
    const blocks = parse('[quote, Ada Lovelace]\n____\nThat brain of mine.\n____');
    expect(types(blocks)).toEqual(['blockquote']);
    expect(blocks[0].content).toBe('That brain of mine.\n— Ada Lovelace');
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].sourceLineCount).toBe(4);
  });

  test("''' and <<< become hr", () => {
    const blocks = parse("above\n\n'''\n\n<<<\n\nbelow");
    expect(types(blocks)).toEqual(['paragraph', 'hr', 'hr', 'paragraph']);
  });

  test('block image macro becomes a markdown image paragraph', () => {
    const blocks = parse('image::diagram.png[Architecture,600]');
    expect(types(blocks)).toEqual(['paragraph']);
    expect(blocks[0].content).toBe('![Architecture](diagram.png)');
  });

  test('example/sidebar delimiters are transparent grouping', () => {
    const blocks = parse('====\ninside example\n====\n\n****\ninside sidebar\n****');
    expect(types(blocks)).toEqual(['paragraph', 'paragraph']);
    expect(blocks[0].content).toBe('inside example');
  });

  test('block title becomes a bold caption paragraph', () => {
    const blocks = parse('.Fine Print\nThe details.');
    expect(types(blocks)).toEqual(['paragraph', 'paragraph']);
    expect(blocks[0].content).toBe('**Fine Print**');
  });

  test('unknown block macros degrade to literal paragraphs', () => {
    const blocks = parse('toc::[]\n\ninclude::other.adoc[]');
    expect(types(blocks)).toEqual(['paragraph', 'paragraph']);
    expect(blocks[0].content).toBe('toc::[]');
    expect(blocks[1].content).toBe('include::other.adoc[]');
  });

  test('[[anchor]] lines fold into the next block span', () => {
    const blocks = parse('[[intro]]\n== Introduction');
    expect(types(blocks)).toEqual(['heading']);
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].sourceLineCount).toBe(2);
  });
});

describe('transpileInline', () => {
  const t = (s: string) => transpileInline(s);

  test('constrained bold converts, double-star bold untouched', () => {
    expect(t('this is *bold* text')).toBe('this is **bold** text');
    expect(t('already **bold** here')).toBe('already **bold** here');
    expect(t('2*3*4 math stays')).toBe('2*3*4 math stays');
  });

  test('links', () => {
    expect(t('see link:https://x.dev[the docs] now')).toBe('see [the docs](https://x.dev) now');
    expect(t('see https://x.dev[docs]')).toBe('see [docs](https://x.dev)');
    expect(t('bare https://x.dev stays')).toBe('bare https://x.dev stays');
    expect(t('link:guide.html[]')).toBe('[guide.html](guide.html)');
  });

  test('inline image', () => {
    expect(t('an image:icon.png[Icon] inline')).toBe('an ![Icon](icon.png) inline');
  });

  test('xrefs and cross references degrade to text', () => {
    expect(t('see xref:setup[Setup Guide]')).toBe('see Setup Guide');
    expect(t('see <<intro,the intro>>')).toBe('see the intro');
    expect(t('see <<intro>>')).toBe('see intro');
  });

  test('footnotes become parentheticals', () => {
    expect(t('a claim.footnote:[source needed]')).toBe('a claim. (source needed)');
  });

  test('passthroughs strip markers', () => {
    expect(t('keep +++<raw>+++ text')).toBe('keep <raw> text');
    expect(t('pass:[literal] here')).toBe('literal here');
  });

  test('code spans are protected from transformation', () => {
    expect(t('use `*argv` and *bold*')).toBe('use `*argv` and **bold**');
    expect(t('`link:x[y]` is literal')).toBe('`link:x[y]` is literal');
  });
});

describe('line-number accuracy through exportAnnotations', () => {
  test('annotation on a delimited block reports the full source span', () => {
    const source = '= Doc\n\n[source,py]\n----\nprint(1)\nprint(2)\n----\n\ntail';
    const blocks = parse(source);
    const code = blocks.find((b) => b.type === 'code')!;
    expect(code.startLine).toBe(3);
    expect(code.sourceLineCount).toBe(5);

    const out = exportAnnotations(blocks, [
      {
        id: 'a1',
        blockId: code.id,
        startOffset: 0,
        endOffset: 5,
        type: AnnotationType.COMMENT,
        text: 'why two prints?',
        originalText: 'print(1)',
        createdA: 1,
      },
    ]);
    expect(out).toContain('(lines 3–7)');
  });

  test('annotation on a single-line paragraph reports one line', () => {
    const blocks = parse('First.\n\nSecond paragraph.');
    const para = blocks[1];
    const out = exportAnnotations(blocks, [
      {
        id: 'a1',
        blockId: para.id,
        startOffset: 0,
        endOffset: 3,
        type: AnnotationType.COMMENT,
        text: 'ok',
        originalText: 'Second',
        createdA: 1,
      },
    ]);
    expect(out).toContain('(line 3)');
  });
});

describe('parseDocumentToBlocks router', () => {
  test('routes asciidoc and markdown to the right parser', () => {
    const adoc = parseDocumentToBlocks('== Section', 'asciidoc');
    expect(adoc[0].type).toBe('heading');
    expect(adoc[0].level).toBe(2);

    const md = parseDocumentToBlocks('== Section', 'markdown');
    expect(md[0].type).toBe('paragraph');

    const mdHeading = parseDocumentToBlocks('## Section', 'markdown');
    expect(mdHeading[0].type).toBe('heading');
  });
});
