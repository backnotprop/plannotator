import { describe, test, expect } from 'bun:test';
import { parseAsciidocToBlocks, transpileInline } from './asciidocParser';
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
  test('cells flow into rows by the cols count; %header names the header', () => {
    const blocks = parse('[%header,cols="1,2"]\n|===\n|Key\n|Value\n|a\n|one\n|b\n|two\n|===');
    expect(blocks[0].content).toBe('| Key | Value |\n| --- | --- |\n| a | one |\n| b | two |');
    expect(blocks[0].startLine).toBe(1);
  });

  test('options="header" with a cols multiplier', () => {
    const blocks = parse('[cols="3*", options="header"]\n|===\n|A |B |C\n|1 |2 |3\n|===');
    expect(blocks[0].content).toBe('| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |');
  });

  test('a colspan fills the cells it covers; escaped pipes stay in the cell', () => {
    const blocks = parse('|===\n|H1 |H2\n\n2+|wide\n|a \\| b |c\n|===');
    expect(blocks[0].content).toBe('| H1 | H2 |\n| --- | --- |\n| wide |  |\n| a \\| b | c |');
  });

  test('a line without a pipe continues the previous cell', () => {
    const blocks = parse('|===\n|Name |Notes\n\n|Ada |first line\nsecond line\n|===');
    expect(blocks[0].content).toContain('| Ada | first line second line |');
  });

  test('first line followed by a blank line is the implicit header', () => {
    const blocks = parse('|===\n|Name |Age\n\n|Ada |36\n|Alan |41\n|===');
    expect(types(blocks)).toEqual(['table']);
    expect(blocks[0].content).toBe(
      '| Name | Age |\n| --- | --- |\n| Ada | 36 |\n| Alan | 41 |',
    );
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].sourceLineCount).toBe(6);
  });

  test('without a header the first row stays a body row', () => {
    const blocks = parse('|===\n|Name |Age\n|Ada |36\n|Alan |41\n|===');
    expect(blocks[0].content).toBe(
      '|  |  |\n| --- | --- |\n| Name | Age |\n| Ada | 36 |\n| Alan | 41 |',
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
    expect(blocks[0].content).toBe('`toc::[]`');
    expect(blocks[1].content).toBe('`include::other.adoc[]`');
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

describe('parseAsciidocToBlocks — real-world structure', () => {
  test('a list item continues on the following lines', () => {
    const blocks = parse('* first line\n  continues here\n* second');
    expect(types(blocks)).toEqual(['list-item', 'list-item']);
    expect(blocks[0].content).toBe('first line\ncontinues here');
    expect(blocks[0].sourceLineCount).toBe(2);
    expect(blocks[1].startLine).toBe(3);
  });

  test('explicitly numbered lists keep their start number', () => {
    const blocks = parse('3. third\n4. fourth');
    expect(blocks.map((b) => [b.ordered, b.orderedStart])).toEqual([[true, 3], [true, 4]]);
  });

  test('an indented paragraph is a literal block', () => {
    const blocks = parse('Run:\n\n  $ make build\n  $ make test\n\nDone.');
    expect(types(blocks)).toEqual(['paragraph', 'code', 'paragraph']);
    expect(blocks[1].content).toBe('$ make build\n$ make test');
    expect(blocks[1].startLine).toBe(3);
    expect(blocks[1].sourceLineCount).toBe(2);
  });

  test('markdown fences work as listings', () => {
    const blocks = parse('```yaml\nkey: value\n```');
    expect(blocks[0]).toMatchObject({ type: 'code', language: 'yaml', content: 'key: value', startLine: 1, sourceLineCount: 3 });
  });

  test('a delimited block closes only on its own delimiter', () => {
    const blocks = parse('......\n....\ninner\n....\n......\n\nAfter.');
    expect(types(blocks)).toEqual(['code', 'paragraph']);
    expect(blocks[0].content).toBe('....\ninner\n....');
    expect(blocks[1].startLine).toBe(7);
  });

  test('include and conditional directives are shown as written', () => {
    const blocks = parse('ifdef::env-github[]\ninclude::partials/setup.adoc[leveloffset=+1]\nendif::[]');
    expect(blocks.map((b) => b.content)).toEqual([
      '`ifdef::env-github[]`',
      '`include::partials/setup.adoc[leveloffset=+1]`',
      '`endif::[]`',
    ]);
    expect(blocks.map((b) => b.startLine)).toEqual([1, 2, 3]);
  });

  test('an author line without an email is consumed; a section right under the title is not', () => {
    expect(types(parse('= Title\nJane Doe\nv2.1\n\nBody.'))).toEqual(['heading', 'paragraph']);
    expect(parse('= Title\n== Section\nBody.').map((b) => b.content)).toEqual(['Title', 'Section', 'Body.']);
    // Attribute entries end the lookup: a later directive is not an author line.
    expect(parse('= Title\n:icons: font\nifndef::icons[]\nendif::[]').map((b) => b.content)).toEqual([
      'Title',
      '`ifndef::icons[]`',
      '`endif::[]`',
    ]);
  });

  test('xrefs to other .adoc files become document links', () => {
    expect(transpileInline('see xref:install.adoc#linux[Install]')).toBe('see [Install](install.adoc)');
    expect(transpileInline('see <<guide.adoc#,the guide>>')).toBe('see [the guide](guide.adoc)');
  });

  test('inline anchors are dropped, not rendered as wiki-links', () => {
    expect(transpileInline('Using profiles [[profiles]]')).toBe('Using profiles');
    expect(transpileInline('anchor:intro[]Intro')).toBe('Intro');
  });

  test('Antora resource ids stay text', () => {
    expect(transpileInline('see xref:macros:icons.adoc[Icons]')).toBe('see Icons');
  });

  test('literal markers inside code spans are dropped', () => {
    expect(transpileInline('set `+{version}+` here')).toBe('set `{version}` here');
  });

  test('a realistic document keeps every block on its source lines', () => {
    const source = [
      '= Operator Guide',                       // 1
      'Docs Team <docs@example.com>',           // 2
      ':toc: left',                             // 3
      ':version: 1.4',                          // 4
      '',                                       // 5
      '== Install',                             // 6
      '',                                       // 7
      'Install version {version} with:',        // 8
      '',                                       // 9
      '[source,bash]',                          // 10
      '----',                                   // 11
      'helm install op ./chart',                // 12
      '----',                                   // 13
      '',                                       // 14
      'WARNING: Back up the *cluster* first.',  // 15
      '',                                       // 16
      '.Settings',                              // 17
      '[cols="1,3",options="header"]',          // 18
      '|===',                                   // 19
      '|Name |Meaning',                         // 20
      '|replicas |Pod count',                   // 21
      '|===',                                   // 22
      '',                                       // 23
      'include::upgrade.adoc[]',                // 24
    ].join('\n');
    const blocks = parse(source);
    expect(blocks.map((b) => [b.type, b.startLine])).toEqual([
      ['heading', 1],
      ['heading', 6],
      ['paragraph', 8],
      ['code', 10],
      ['blockquote', 15],
      ['paragraph', 17],
      ['table', 18],
      ['paragraph', 24],
    ]);
    expect(blocks[2].content).toBe('Install version 1.4 with:');
    expect(blocks[4].content).toBe('Back up the **cluster** first.');

    const annotate = (block: Block, text: string) => ({
      id: `a-${block.id}`,
      blockId: block.id,
      startOffset: 0,
      endOffset: text.length,
      type: AnnotationType.COMMENT,
      text: 'check',
      originalText: text,
      createdA: 1,
    });
    const out = exportAnnotations(blocks, [annotate(blocks[3], 'helm install'), annotate(blocks[6], 'replicas')]);
    expect(out).toContain('(lines 10–13)');
    expect(out).toContain('(lines 18–22)');
  });

  test('one-letter table cells stay cells; a bare cols number is the column count', () => {
    expect(parse('|===\n|Name|a|b\n|===')[0].content).toBe('|  |  |  |\n| --- | --- | --- |\n| Name | a | b |');
    expect(parse('[cols="2"]\n|===\n|second\n|s\n|meter\n|m\n|===')[0].content).toBe(
      '|  |  |\n| --- | --- |\n| second | s |\n| meter | m |',
    );
  });

  test('a huge cell repeat is capped instead of crashing the page', () => {
    expect(() => parse('|===\n|9999999*|x\n|===')).not.toThrow();
  });

  test('a description term stops before a list, an attached block or an attribute line', () => {
    const blocks = parse('Bug Fixes::\n  * one\n  * two\n\nCPU:: chip\n[source,bash]\n----\nlscpu\n----');
    expect(types(blocks)).toEqual(['list-item', 'list-item', 'list-item', 'list-item', 'code']);
    expect(blocks[0].content).toBe('**Bug Fixes**');
    expect(blocks[3].content).toBe('**CPU** — chip');
    expect(blocks[4]).toMatchObject({ language: 'bash', startLine: 6, sourceLineCount: 4 });
  });

  test('an indented // line is literal text, not a comment', () => {
    expect(parse('  int x = 0;\n  // increment\n  x++;')[0].content).toBe('int x = 0;\n// increment\nx++;');
  });

  test('a comment inside a paragraph stays inside its line span', () => {
    expect(parse('line a\n// c\nline b')[0]).toMatchObject({ startLine: 1, sourceLineCount: 3 });
  });

  test('numbering continues past a block attached with +', () => {
    const blocks = parse('. one\n. two\n+\n----\ncode\n----\n. three\n\nBreak.\n\n. again');
    const items = blocks.filter((b) => b.type === 'list-item');
    expect(items.map((b) => b.orderedStart)).toEqual([undefined, undefined, 3, undefined]);
  });

  test('[,ruby] is a source block in ruby', () => {
    expect(parse('[,ruby]\n----\nputs 1\n----')[0]).toMatchObject({ type: 'code', language: 'ruby' });
  });

  test('attributes above a block title belong to the block below it', () => {
    const blocks = parse('[source,java]\n.Example\n----\nint x;\n----');
    expect(blocks.map((b) => [b.type, b.startLine])).toEqual([['paragraph', 2], ['code', 3]]);
  });

  test('an indented table row keeps its leading cell spec', () => {
    expect(parse('|===\n  |Col1 |Col2\n\n  a|foo |bar\n  2+|wide\n|===')[0].content).toBe(
      '| Col1 | Col2 |\n| --- | --- |\n| foo | bar |\n| wide |  |',
    );
  });

  test('a role-only attribute list does not make a code block', () => {
    expect(parse('[.lead,someflag]\nPara.')[0]).toMatchObject({ type: 'paragraph', content: 'Para.' });
  });

  test('a definition line starting with inline markup stays in the definition', () => {
    expect(types(parse('Term::\n`code` does x\n*bold* too'))).toEqual(['list-item']);
  });

  test('numbering continues past an attached block that has a title', () => {
    const items = parse('. one\n. two\n+\n.Example\n----\ncode\n----\n. three').filter((b) => b.type === 'list-item');
    expect(items.map((b) => b.orderedStart)).toEqual([undefined, undefined, 3]);
  });
});
