import { describe, expect, test } from 'bun:test';
import { parseLatexToBlocks, transpileLatexInline } from './latexParser';
import { exportAnnotations } from './parser';
import { AnnotationType, type Block } from '../types';

const parse = parseLatexToBlocks;
const types = (blocks: Block[]) => blocks.map((b) => b.type);

describe('parseLatexToBlocks — preamble and headings', () => {
  test('extracts title, author, date from preamble and ignores setup commands', () => {
    const src = [
      '\\documentclass[11pt]{article}',
      '\\usepackage{amsmath,booktabs}',
      '\\title{A Study on \\textbf{Fast} Parsing}',
      '\\author{Ada Lovelace\\thanks{Oxford} \\and Alan Turing}',
      '\\date{2026}',
      '\\begin{document}',
      '\\maketitle',
      '\\section{Introduction}\\label{sec:intro}',
      'Opening paragraph.',
      '\\end{document}',
    ].join('\n');

    const blocks = parse(src);
    expect(types(blocks)).toEqual(['heading', 'paragraph', 'heading', 'paragraph']);
    expect(blocks[0].level).toBe(1);
    expect(blocks[0].content).toBe('A Study on **Fast** Parsing');
    expect(blocks[0].startLine).toBe(3);

    expect(blocks[1].content).toBe('*Ada Lovelace, Alan Turing · 2026*');
    expect(blocks[1].startLine).toBe(4);
    expect(blocks[1].sourceLineCount).toBe(2);

    expect(blocks[2].level).toBe(2);
    expect(blocks[2].content).toBe('Introduction');
    expect(blocks[2].startLine).toBe(8);

    expect(blocks[3].content).toBe('Opening paragraph.');
    expect(blocks[3].startLine).toBe(9);
  });

  test('heading hierarchy, starred headings, short titles, and trailing text after \\paragraph', () => {
    const src = [
      '\\part{Part One}',
      '\\chapter*{Preliminaries}',
      '\\section[Short]{Long \\emph{Section}}',
      '\\subsection{Sub}',
      '\\subsubsection{SubSub}',
      '\\paragraph{Complexity.} Runtime is $O(n)$.',
      '\\subparagraph{Detail}',
    ].join('\n');

    const blocks = parse(src);
    expect(types(blocks)).toEqual([
      'heading',
      'heading',
      'heading',
      'heading',
      'heading',
      'heading',
      'paragraph',
      'heading',
    ]);
    expect(blocks.filter((b) => b.type === 'heading').map((b) => b.level)).toEqual([1, 1, 2, 3, 4, 5, 6]);
    expect(blocks[2].content).toBe('Long *Section*');
    expect(blocks[5].content).toBe('Complexity.');
    expect(blocks[6].content).toBe('Runtime is $O(n)$.');
  });

  test('abstract environment produces level-2 heading and preserves paragraph line numbers', () => {
    const src = [
      '\\begin{abstract}',
      'We present a fast method.',
      '',
      'Results improve by 20\\%.',
      '\\end{abstract}',
    ].join('\n');

    const blocks = parse(src);
    expect(types(blocks)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(blocks[0].content).toBe('Abstract');
    expect(blocks[1].content).toBe('We present a fast method.');
    expect(blocks[1].startLine).toBe(2);
    expect(blocks[2].content).toBe('Results improve by 20%.');
    expect(blocks[2].startLine).toBe(4);
  });
});

describe('parseLatexToBlocks — math blocks and theorems', () => {
  test('display math: $$, \\[, equation, align*, gather* strip labels and normalize for KaTeX', () => {
    const src = [
      '$$E = mc^2$$',
      '',
      '\\[',
      'a^2 + b^2 = c^2',
      '\\]',
      '',
      '\\begin{equation}\\label{eq:loss}',
      '\\mathcal{L}(\\theta) = \\sum_i y_i % inline comment',
      '\\end{equation}',
      '',
      '\\begin{align*}',
      'x &= 1 + 2 \\label{eq:x} \\\\',
      'y &= 3 + 4',
      '\\end{align*}',
      '',
      '\\begin{gather}',
      'f(x) = x^2 \\\\',
      'g(x) = x^3',
      '\\end{gather}',
    ].join('\n');

    const blocks = parse(src);
    expect(types(blocks)).toEqual(['math', 'math', 'math', 'math', 'math']);
    expect(blocks[0].content).toBe('E = mc^2');
    expect(blocks[1].content).toBe('a^2 + b^2 = c^2');
    expect(blocks[2].content).toBe('\\mathcal{L}(\\theta) = \\sum_i y_i');
    expect(blocks[2].startLine).toBe(7);
    expect(blocks[2].sourceLineCount).toBe(3);

    expect(blocks[3].content).toContain('\\begin{aligned}');
    expect(blocks[3].content).toContain('\\end{aligned}');
    expect(blocks[3].content).not.toContain('\\label');

    expect(blocks[4].content).toContain('\\begin{gathered}');
    expect(blocks[4].content).toContain('\\end{gathered}');
  });

  test('theorem-like environments become styled blockquotes with inner math preserved', () => {
    const src = [
      '\\begin{theorem}[Main Result]\\label{thm:main}',
      'For all $n \\ge 1$, we have',
      '\\[ x_n \\le \\sum_{k=1}^n a_k. \\]',
      '\\end{theorem}',
      '',
      '\\begin{proof}',
      'By induction on $n$.',
      '\\end{proof}',
    ].join('\n');

    const blocks = parse(src);
    expect(types(blocks)).toEqual(['blockquote', 'blockquote']);
    expect(blocks[0].content).toContain('**Theorem (Main Result).** For all $n \\ge 1$, we have');
    expect(blocks[0].content).toContain('$$\nx_n \\le \\sum_{k=1}^n a_k.\n$$');
    expect(blocks[1].content).toBe('**Proof.** By induction on $n$.');
  });
});

describe('parseLatexToBlocks — lists, tables, figures, code, and includes', () => {
  test('nested itemize, enumerate, and description lists', () => {
    const src = [
      '\\begin{itemize}',
      '  \\item First bullet',
      '  continuation line',
      '  \\begin{enumerate}',
      '    \\item Sub step one',
      '    \\item Sub step two',
      '  \\end{enumerate}',
      '  \\item Second bullet',
      '\\end{itemize}',
      '',
      '\\begin{description}',
      '  \\item[Latency] Time to first token.',
      '\\end{description}',
    ].join('\n');

    const blocks = parse(src);
    expect(types(blocks)).toEqual(['list-item', 'list-item', 'list-item', 'list-item', 'list-item']);
    expect(blocks.map((b) => b.level)).toEqual([0, 1, 1, 0, 0]);
    expect(blocks.map((b) => b.ordered)).toEqual([undefined, true, true, undefined, undefined]);
    expect(blocks[0].content).toBe('First bullet\ncontinuation line');
    expect(blocks[4].content).toBe('**Latency:** Time to first token.');
  });

  test('tabular with booktabs, \\multicolumn, \\multirow, and table caption', () => {
    const src = [
      '\\begin{table}[t]',
      '\\centering',
      '\\caption{Accuracy comparison on \\textbf{Benchmark}.\\label{tab:acc}}',
      '\\begin{tabular}{lcc}',
      '\\toprule',
      'Model & \\multicolumn{2}{c}{Scores} \\\\',
      '\\midrule',
      '\\multirow{2}{*}{Ours} & 91.2 & 92.5 \\\\',
      'Baseline & 84.0 & 85.1 \\\\',
      '\\bottomrule',
      '\\end{tabular}',
      '\\end{table}',
    ].join('\n');

    const blocks = parse(src);
    expect(types(blocks)).toEqual(['paragraph', 'table']);
    expect(blocks[0].content).toBe('*Table: Accuracy comparison on **Benchmark**.*');
    expect(blocks[1].content).toBe(
      '| Model | Scores |  |\n' +
        '| --- | --- | --- |\n' +
        '| Ours | 91.2 | 92.5 |\n' +
        '| Baseline | 84.0 | 85.1 |',
    );
  });

  test('figures: raster images become markdown images, PDF/EPS show figure path', () => {
    const src = [
      '\\begin{figure}[htbp]',
      '  \\centering',
      '  \\includegraphics[width=0.8\\linewidth]{figures/arch.png}',
      '  \\caption{System overview.}',
      '\\end{figure}',
      '',
      '\\begin{figure}',
      '  \\includegraphics{plots/loss.pdf}',
      '\\end{figure}',
    ].join('\n');

    const blocks = parse(src);
    expect(types(blocks)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(blocks[0].content).toBe('![arch.png](figures/arch.png)');
    expect(blocks[1].content).toBe('*Figure: System overview.*');
    expect(blocks[2].content).toBe('**Figure:** `plots/loss.pdf`');
  });

  test('verbatim, lstlisting, and minted emit code blocks with language', () => {
    const src = [
      '\\begin{lstlisting}[language=Python, caption=Demo]',
      'def f(x):',
      '    return x * 2 % keep percent',
      '\\end{lstlisting}',
      '',
      '\\begin{minted}{rust}',
      'fn main() {}',
      '\\end{minted}',
    ].join('\n');

    const blocks = parse(src);
    expect(types(blocks)).toEqual(['code', 'code']);
    expect(blocks[0].language).toBe('python');
    expect(blocks[0].content).toContain('% keep percent');
    expect(blocks[1].language).toBe('rust');
    expect(blocks[1].content).toBe('fn main() {}');
  });

  test('\\input, \\include, and \\subfile become clickable .tex links', () => {
    const blocks = parse('\\input{sections/methods}\n\n\\include{appendix.tex}');
    expect(types(blocks)).toEqual(['paragraph', 'paragraph']);
    expect(blocks[0].content).toBe('[sections/methods.tex](sections/methods.tex)');
    expect(blocks[1].content).toBe('[appendix.tex](appendix.tex)');
  });
});

describe('transpileLatexInline and comments / exports', () => {
  test('inline formatting, citations, refs, footnotes, math protection, escapes, and Turkish accents', () => {
    const out = transpileLatexInline(
      '\\textbf{G\\u{g}c\\c{c} \\"u\\c{s} \\.{I}\\i} and \\emph{italic} \\texttt{my\\_fn} \\verb|a*b| ' +
        'with $\\textbf{x}_1 + y$ and \\(z^2\\) costing \\$50 (50\\%) \\cite[p. 4]{vaswani2017} \\eqref{eq:1} \\ref{sec:2} ' +
        '\\href{https://example.com}{link}\\footnote{see note} ``hi\'\' --- wait.',
    );
    expect(out).toContain('**Gğcç üş İı**');
    expect(out).toContain('*italic*');
    expect(out).toContain('`my_fn`');
    expect(out).toContain('`a*b`');
    expect(out).toContain('$\\textbf{x}_1 + y$');
    expect(out).toContain('$z^2$');
    expect(out).toContain('\\$50 (50%)');
    expect(out).toContain('`[vaswani2017, p. 4]`');
    expect(out).toContain('`Eq. (eq:1)`');
    expect(out).toContain('`[ref: sec:2]`');
    expect(out).toContain('[link](https://example.com)');
    expect(out).toContain('*(Footnote: see note)*');
    expect(out).toContain('“hi” — wait.');
  });

  test('comment-only diff chunks do not vanish (code fallback)', () => {
    const blocks = parse('% TODO: revise abstract\n% Check citations');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
    expect(blocks[0].language).toBe('latex');
    expect(blocks[0].content).toContain('% TODO: revise abstract');
  });

  test('exported annotations cite the exact .tex source line numbers', () => {
    const src = [
      '\\section{Method}',
      '',
      'First line of text',
      'second line of text.',
    ].join('\n');
    const blocks = parse(src);
    const exported = exportAnnotations(blocks, [
      {
        id: 'a1',
        blockId: blocks[1].id,
        startOffset: 0,
        endOffset: 10,
        type: AnnotationType.COMMENT,
        text: 'Clarify this.',
        originalText: 'First line',
        createdA: 1,
      },
    ]);
    expect(exported).toContain('(lines 3–4)');
  });
});
