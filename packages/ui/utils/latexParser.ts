import type { Block } from '../types';

/**
 * A LaTeX parser that splits `.tex` / `.ltx` source into the same linear
 * `Block` model as `parseMarkdownToBlocks`, so the Viewer, annotations,
 * line-accurate feedback exports, drafts, sharing, and rendered diffs work
 * uniformly.
 *
 * Every block keeps its real 1-based source line span (`startLine` +
 * `sourceLineCount`) so exported comments name the exact lines in the `.tex`
 * source. Unrecognized commands degrade cleanly to readable text rather than
 * dropping content.
 */

const HEADING_LEVELS: Record<string, number> = {
  part: 1,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

const DISPLAY_MATH_ENVS = new Set([
  'equation',
  'equation*',
  'displaymath',
]);

const ALIGNED_MATH_ENVS = new Set([
  'align',
  'align*',
  'alignat',
  'alignat*',
  'flalign',
  'flalign*',
  'eqnarray',
  'eqnarray*',
]);

const GATHERED_MATH_ENVS = new Set([
  'gather',
  'gather*',
  'multline',
  'multline*',
]);

const THEOREM_TITLES: Record<string, string> = {
  theorem: 'Theorem',
  thm: 'Theorem',
  lemma: 'Lemma',
  lem: 'Lemma',
  proposition: 'Proposition',
  prop: 'Proposition',
  corollary: 'Corollary',
  cor: 'Corollary',
  definition: 'Definition',
  defn: 'Definition',
  remark: 'Remark',
  rem: 'Remark',
  example: 'Example',
  ex: 'Example',
  proof: 'Proof',
  assumption: 'Assumption',
  assump: 'Assumption',
  hypothesis: 'Hypothesis',
  claim: 'Claim',
  conjecture: 'Conjecture',
  note: 'Note',
  exercise: 'Exercise',
  problem: 'Problem',
  solution: 'Solution',
  observation: 'Observation',
  fact: 'Fact',
  axiom: 'Axiom',
  property: 'Property',
};

const LIST_ENVS = new Set(['itemize', 'enumerate', 'description']);
const TABLE_ENVS = new Set(['tabular', 'tabular*', 'tabularx', 'longtable']);
const QUOTE_ENVS = new Set(['quote', 'quotation']);
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'algorithmic']);

const ACCENT_TABLES: Record<string, Record<string, string>> = {
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý', C: 'Ć', N: 'Ń', S: 'Ś', Z: 'Ź' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü', Y: 'Ÿ' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', c: 'ĉ', g: 'ĝ', s: 'ŝ', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û', C: 'Ĉ', G: 'Ĝ', S: 'Ŝ' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  '=': { a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū', A: 'Ā', E: 'Ē', I: 'Ī', O: 'Ō', U: 'Ū' },
  '.': { c: 'ċ', e: 'ė', g: 'ġ', I: 'İ', z: 'ż', C: 'Ċ', E: 'Ė', G: 'Ġ', Z: 'Ż' },
  c: { c: 'ç', C: 'Ç', s: 'ş', S: 'Ş', t: 'ţ', T: 'Ţ' },
  u: { a: 'ă', g: 'ğ', G: 'Ğ', u: 'ŭ', A: 'Ă', U: 'Ŭ' },
  v: { c: 'č', d: 'ď', e: 'ě', n: 'ň', r: 'ř', s: 'š', t: 'ť', z: 'ž', C: 'Č', D: 'Ď', E: 'Ě', N: 'Ň', R: 'Ř', S: 'Š', T: 'Ť', Z: 'Ž' },
  r: { a: 'å', A: 'Å', u: 'ů', U: 'Ů' },
  H: { o: 'ő', u: 'ű', O: 'Ő', U: 'Ű' },
  k: { a: 'ą', e: 'ę', A: 'Ą', E: 'Ę' },
};

const SYMBOL_COMMANDS: Record<string, string> = {
  LaTeX: 'LaTeX',
  TeX: 'TeX',
  BibTeX: 'BibTeX',
  ldots: '…',
  dots: '…',
  textellipsis: '…',
  textbullet: '•',
  textemdash: '—',
  textendash: '–',
  textquoteleft: '‘',
  textquoteright: '’',
  textquotedblleft: '“',
  textquotedblright: '”',
  textbackslash: '\\',
  textasciitilde: '~',
  textasciicircum: '^',
  textdegree: '°',
  degree: '°',
  copyright: '©',
  textcopyright: '©',
  textregistered: '®',
  registered: '®',
  texttrademark: '™',
  trademark: '™',
  S: '§',
  P: '¶',
  dag: '†',
  ddag: '‡',
  i: 'ı',
  j: 'ȷ',
  ss: 'ß',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  o: 'ø',
  O: 'Ø',
  l: 'ł',
  L: 'Ł',
  aa: 'å',
  AA: 'Å',
  checkmark: '✓',
  par: '\n\n',
  newline: '\n',
};

const SKIPPED_NOARG_COMMANDS = new Set([
  'noindent',
  'centering',
  'raggedright',
  'raggedleft',
  'smallskip',
  'medskip',
  'bigskip',
  'normalfont',
  'bfseries',
  'itshape',
  'ttfamily',
  'sffamily',
  'rmfamily',
  'small',
  'footnotesize',
  'scriptsize',
  'tiny',
  'normalsize',
  'large',
  'Large',
  'LARGE',
  'huge',
  'Huge',
  'xspace',
  'maketitle',
  'tableofcontents',
  'listoffigures',
  'listoftables',
  'protect',
  'relax',
  'ignorespaces',
]);

const SKIPPED_ONEARG_COMMANDS = new Set([
  'label',
  'index',
  'nocite',
  'phantom',
  'hphantom',
  'vphantom',
  'color',
  'vspace',
  'hspace',
  'bibliographystyle',
  'addbibresource',
  'thispagestyle',
  'pagestyle',
]);

/** Strip an unescaped `% ...` comment from one LaTeX line. */
export function stripLatexInlineComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === '%') return line.slice(0, i);
  }
  return line;
}

const isFullCommentLine = (line: string): boolean => /^\s*%/.test(line);

/**
 * Read a balanced `{...}` or `[...]` group starting at `openIdx`.
 * Returns `null` when the group is unclosed.
 */
export function readBalancedGroup(
  text: string,
  openIdx: number,
  openCh = '{',
  closeCh = '}',
): { content: string; endIdx: number } | null {
  if (text[openIdx] !== openCh) return null;
  let depth = 1;
  let braceDepth = openCh === '{' ? 1 : 0;
  for (let i = openIdx + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (openCh === '[' && ch === '{') {
      braceDepth++;
      continue;
    }
    if (openCh === '[' && ch === '}' && braceDepth > 0) {
      braceDepth--;
      continue;
    }
    if (openCh === '[' && braceDepth > 0) continue;
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) {
        return { content: text.slice(openIdx + 1, i), endIdx: i + 1 };
      }
    }
  }
  return null;
}

const skipSpaces = (text: string, idx: number): number => {
  while (idx < text.length && /[ \t\r\n]/.test(text[idx])) idx++;
  return idx;
};

/** Normalize a `\input` / `\include` / `\subfile` path to a `.tex` link target. */
function normalizeTexIncludeTarget(raw: string): string {
  const trimmed = raw.trim();
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (/\.[a-z0-9]+$/i.test(base)) return trimmed;
  return `${trimmed}.tex`;
}

function unescapeCodeText(text: string): string {
  return text
    .replace(/\\([\\{}$&#_%])/g, '$1')
    .replace(/\\textbackslash(?:\{\})?/g, '\\')
    .replace(/\\textasciitilde(?:\{\})?/g, '~');
}

function wrapInlineCode(raw: string): string {
  if (!raw.includes('`')) return `\`${raw}\``;
  const maxRun = Math.max(...(raw.match(/`+/g) ?? []).map((r) => r.length), 1);
  const fence = '`'.repeat(maxRun + 1);
  const pad = raw.startsWith('`') || raw.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${raw}${pad}${fence}`;
}

function readOptionalGroups(text: string, idx: number, maxCount: number): { optionals: string[]; nextIdx: number } {
  const optionals: string[] = [];
  let cursor = idx;
  for (let k = 0; k < maxCount; k++) {
    const probe = skipSpaces(text, cursor);
    if (text[probe] !== '[') break;
    const grp = readBalancedGroup(text, probe, '[', ']');
    if (!grp) break;
    optionals.push(grp.content);
    cursor = grp.endIdx;
  }
  return { optionals, nextIdx: cursor };
}

function readRequiredGroup(text: string, idx: number): { content: string; nextIdx: number } | null {
  const probe = skipSpaces(text, idx);
  const grp = readBalancedGroup(text, probe, '{', '}');
  if (!grp) return null;
  return { content: grp.content, nextIdx: grp.endIdx };
}

function formatCitation(optionals: string[], keysRaw: string): string {
  const keys = keysRaw.trim();
  let pre = '';
  let post = '';
  if (optionals.length === 1) {
    post = transpileLatexInline(optionals[0]).trim();
  } else if (optionals.length >= 2) {
    pre = transpileLatexInline(optionals[0]).trim();
    post = transpileLatexInline(optionals[1]).trim();
  }
  const inner = [pre ? `${pre} ${keys}` : keys, post].filter(Boolean).join(', ');
  return wrapInlineCode(`[${inner}]`);
}

function transpileBracedGroup(inner: string): string {
  const trimmed = inner.trimStart();
  const fontMatch = trimmed.match(/^\\(bf|bfseries|it|itshape|em|tt|ttfamily|rm|sf|sc|sl|normalfont)(?![a-zA-Z])(?:\s+([\s\S]*))?$/);
  if (fontMatch) {
    const cmd = fontMatch[1];
    const body = fontMatch[2] ?? '';
    if (cmd === 'bf' || cmd === 'bfseries') return `**${transpileLatexSegment(body)}**`;
    if (cmd === 'it' || cmd === 'itshape' || cmd === 'em' || cmd === 'sl') return `*${transpileLatexSegment(body)}*`;
    if (cmd === 'tt' || cmd === 'ttfamily') return wrapInlineCode(unescapeCodeText(body.trim()));
    return transpileLatexSegment(body);
  }
  if (/^\\color(?:\s*\[[^\]]*\])?\s*\{[^}]*\}/.test(trimmed)) {
    const rest = trimmed.replace(/^\\color(?:\s*\[[^\]]*\])?\s*\{[^}]*\}\s*/, '');
    return transpileLatexSegment(rest);
  }
  return transpileLatexSegment(inner);
}

/** Rewrite LaTeX inline markup in a math-free / verb-free segment into Markdown. */
function transpileLatexSegment(text: string): string {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '{') {
      const grp = readBalancedGroup(text, i, '{', '}');
      if (grp) {
        out += transpileBracedGroup(grp.content);
        i = grp.endIdx;
        continue;
      }
    }

    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) {
        out += '\\';
        i++;
        continue;
      }

      // Line break `\\` with optional `[length]` and optional `*`
      if (next === '\\') {
        i += 2;
        if (text[i] === '*') i++;
        const afterOpt = readOptionalGroups(text, i, 1);
        i = afterOpt.nextIdx;
        out += '\n';
        continue;
      }

      // Single-char accent macros: \'e, \"u, \`a, \^o, \~n, \=a, \.I, etc.
      if ("'`\"^~=.".includes(next)) {
        const table = ACCENT_TABLES[next];
        const afterMacro = i + 2;
        if (text[afterMacro] === '{') {
          const grp = readBalancedGroup(text, afterMacro, '{', '}');
          if (grp) {
            const letter = grp.content.trim().replace(/^\\([ij])$/, '$1');
            out += table?.[letter] ?? letter;
            i = grp.endIdx;
            continue;
          }
        } else if (text[afterMacro] && /[a-zA-Z]/.test(text[afterMacro])) {
          out += table?.[text[afterMacro]] ?? text[afterMacro];
          i = afterMacro + 1;
          continue;
        }
      }

      // Escaped special characters
      if ('%&#{}'.includes(next)) {
        out += next;
        i += 2;
        continue;
      }
      if (next === '$' || next === '_') {
        // Keep escaped so InlineMarkdown renders literal `$` / `_` instead of math / italic.
        out += `\\${next}`;
        i += 2;
        continue;
      }
      if (next === ' ' || next === '\t' || next === ',' || next === ';') {
        out += ' ';
        i += 2;
        continue;
      }
      if (next === ':' || next === '!' || next === '/' || next === '-') {
        i += 2;
        continue;
      }

      // Named control sequences `\cmd`
      const cmdMatch = text.slice(i + 1).match(/^([a-zA-Z]+)(\*?)/);
      if (cmdMatch) {
        const cmd = cmdMatch[1];
        const hasStar = cmdMatch[2] === '*';
        let cursor = i + 1 + cmd.length + (hasStar ? 1 : 0);

        // Letter accent macros: \c{c}, \u{g}, \v{s}, \r{a}, \H{o}, \k{a}
        if (ACCENT_TABLES[cmd] && !hasStar) {
          const table = ACCENT_TABLES[cmd];
          const req = readRequiredGroup(text, cursor);
          if (req) {
            const letter = req.content.trim().replace(/^\\([ij])$/, '$1');
            out += table[letter] ?? letter;
            i = req.nextIdx;
            continue;
          }
        }

        // Known 0-arg symbol commands (consume optional trailing `{}` if written e.g. `\LaTeX{}`)
        if (Object.prototype.hasOwnProperty.call(SYMBOL_COMMANDS, cmd)) {
          out += SYMBOL_COMMANDS[cmd];
          const probe = skipSpaces(text, cursor);
          if (text.startsWith('{}', probe)) cursor = probe + 2;
          i = cursor;
          continue;
        }

        if (SKIPPED_NOARG_COMMANDS.has(cmd)) {
          i = cursor;
          continue;
        }

        if (SKIPPED_ONEARG_COMMANDS.has(cmd)) {
          const opt = readOptionalGroups(text, cursor, 1);
          const req = readRequiredGroup(text, opt.nextIdx);
          if (req) {
            i = req.nextIdx;
            continue;
          }
        }

        if (cmd === 'textbf') {
          const req = readRequiredGroup(text, cursor);
          if (req) {
            out += `**${transpileLatexSegment(req.content)}**`;
            i = req.nextIdx;
            continue;
          }
        }

        if (cmd === 'emph' || cmd === 'textit' || cmd === 'textsl') {
          const req = readRequiredGroup(text, cursor);
          if (req) {
            out += `*${transpileLatexSegment(req.content)}*`;
            i = req.nextIdx;
            continue;
          }
        }

        if (cmd === 'texttt') {
          const req = readRequiredGroup(text, cursor);
          if (req) {
            out += wrapInlineCode(unescapeCodeText(req.content));
            i = req.nextIdx;
            continue;
          }
        }

        if (cmd === 'sout' || cmd === 'st') {
          const req = readRequiredGroup(text, cursor);
          if (req) {
            out += `~~${transpileLatexSegment(req.content)}~~`;
            i = req.nextIdx;
            continue;
          }
        }

        if (
          cmd === 'underline' ||
          cmd === 'textsc' ||
          cmd === 'textrm' ||
          cmd === 'textsf' ||
          cmd === 'text' ||
          cmd === 'mbox' ||
          cmd === 'hbox' ||
          cmd === 'textup' ||
          cmd === 'textnormal' ||
          cmd === 'fbox' ||
          cmd === 'MakeUppercase' ||
          cmd === 'MakeLowercase'
        ) {
          const req = readRequiredGroup(text, cursor);
          if (req) {
            out += transpileLatexSegment(req.content);
            i = req.nextIdx;
            continue;
          }
        }

        if (cmd === 'textcolor') {
          const opt = readOptionalGroups(text, cursor, 1);
          const colorReq = readRequiredGroup(text, opt.nextIdx);
          const bodyReq = colorReq ? readRequiredGroup(text, colorReq.nextIdx) : null;
          if (bodyReq) {
            out += transpileLatexSegment(bodyReq.content);
            i = bodyReq.nextIdx;
            continue;
          }
        }

        if (cmd === 'href') {
          const urlReq = readRequiredGroup(text, cursor);
          const labelReq = urlReq ? readRequiredGroup(text, urlReq.nextIdx) : null;
          if (urlReq && labelReq) {
            const url = urlReq.content.trim().replace(/\\([%&#_])/g, '$1');
            const label = transpileLatexSegment(labelReq.content).trim() || url;
            out += `[${label}](${url})`;
            i = labelReq.nextIdx;
            continue;
          }
        }

        if (cmd === 'url') {
          const urlReq = readRequiredGroup(text, cursor);
          if (urlReq) {
            const url = urlReq.content.trim().replace(/\\([%&#_])/g, '$1');
            out += `[${url}](${url})`;
            i = urlReq.nextIdx;
            continue;
          }
        }

        if (
          cmd === 'cite' ||
          cmd === 'citep' ||
          cmd === 'citet' ||
          cmd === 'citealt' ||
          cmd === 'citealp' ||
          cmd === 'citeauthor' ||
          cmd === 'citeyear' ||
          cmd === 'autocite' ||
          cmd === 'parencite' ||
          cmd === 'textcite' ||
          cmd === 'footcite'
        ) {
          const opt = readOptionalGroups(text, cursor, 2);
          const keysReq = readRequiredGroup(text, opt.nextIdx);
          if (keysReq) {
            out += formatCitation(opt.optionals, keysReq.content);
            i = keysReq.nextIdx;
            continue;
          }
        }

        if (cmd === 'eqref') {
          const req = readRequiredGroup(text, cursor);
          if (req) {
            out += wrapInlineCode(`Eq. (${req.content.trim()})`);
            i = req.nextIdx;
            continue;
          }
        }

        if (
          cmd === 'ref' ||
          cmd === 'autoref' ||
          cmd === 'cref' ||
          cmd === 'Cref' ||
          cmd === 'pageref' ||
          cmd === 'vref' ||
          cmd === 'nameref' ||
          cmd === 'fref' ||
          cmd === 'Fref'
        ) {
          const req = readRequiredGroup(text, cursor);
          if (req) {
            out += wrapInlineCode(`[ref: ${req.content.trim()}]`);
            i = req.nextIdx;
            continue;
          }
        }

        if (cmd === 'footnote' || cmd === 'footnotetext') {
          const opt = readOptionalGroups(text, cursor, 1);
          const req = readRequiredGroup(text, opt.nextIdx);
          if (req) {
            out += ` *(Footnote: ${transpileLatexInline(req.content).trim()})*`;
            i = req.nextIdx;
            continue;
          }
        }

        if (cmd === 'input' || cmd === 'include' || cmd === 'subfile') {
          const req = readRequiredGroup(text, cursor);
          if (req) {
            const target = normalizeTexIncludeTarget(req.content);
            out += `[${target}](${target})`;
            i = req.nextIdx;
            continue;
          }
        }
      }

      // Unknown escape/command: preserve verbatim
      out += ch;
      i++;
      continue;
    }

    if (ch === '~') {
      out += ' ';
      i++;
      continue;
    }

    if (text.startsWith('---', i)) {
      out += '—';
      i += 3;
      continue;
    }

    if (text.startsWith('--', i)) {
      out += '–';
      i += 2;
      continue;
    }

    if (text.startsWith('``', i)) {
      out += '“';
      i += 2;
      continue;
    }

    if (text.startsWith("''", i)) {
      out += '”';
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Rewrite inline LaTeX syntax to Markdown while keeping `$...$`, `\(...\)`,
 * and `\verb|...|` spans protected from prose macro transpilation.
 */
export function transpileLatexInline(text: string): string {
  if (!text) return text;

  let out = '';
  let proseStart = 0;
  let i = 0;

  const flushProse = (end: number) => {
    if (end > proseStart) {
      out += transpileLatexSegment(text.slice(proseStart, end));
    }
  };

  while (i < text.length) {
    // `\verb|...|` or `\verb*|...|`
    if (text.startsWith('\\verb', i)) {
      const nextAfter = text[i + 5];
      const hasStar = nextAfter === '*';
      const delimIdx = hasStar ? i + 6 : i + 5;
      const delim = text[delimIdx];
      if (delim && !/[a-zA-Z\s]/.test(delim)) {
        const closeIdx = text.indexOf(delim, delimIdx + 1);
        if (closeIdx !== -1) {
          flushProse(i);
          out += wrapInlineCode(text.slice(delimIdx + 1, closeIdx));
          i = closeIdx + 1;
          proseStart = i;
          continue;
        }
      }
    }

    // Inline math: `\(...\)`
    if (text.startsWith('\\(', i)) {
      let end = -1;
      for (let j = i + 2; j < text.length - 1; j++) {
        if (text[j] === '\\') {
          if (text[j + 1] === ')') {
            end = j;
            break;
          }
          j++;
        }
      }
      if (end !== -1) {
        flushProse(i);
        const inner = text.slice(i + 2, end).trim();
        out += inner ? `$${inner}$` : '';
        i = end + 2;
        proseStart = i;
        continue;
      }
    }

    // Backslash escape in prose (e.g. `\$`, `\\`): advance past both chars so `$` is not misread.
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }

    // Inline math: `$...$` (not `$$`)
    if (text[i] === '$' && text[i + 1] !== '$') {
      let end = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '\\') {
          j++;
          continue;
        }
        if (text[j] === '$' && text[j + 1] !== '$') {
          end = j;
          break;
        }
      }
      if (end > i + 1) {
        const inner = text.slice(i + 1, end);
        if (!/\n\s*\n/.test(inner)) {
          flushProse(i);
          const trimmed = inner.trim();
          out += trimmed ? `$${trimmed}$` : text.slice(i, end + 1);
          i = end + 1;
          proseStart = i;
          continue;
        }
      }
    }

    i++;
  }

  flushProse(text.length);
  return out;
}

/** Strip `\label{...}`, `\nonumber`, `\notag` and normalize display math for KaTeX. */
function normalizeDisplayMathBody(body: string, envName?: string): string {
  let cleaned = body
    .split('\n')
    .map((l) => stripLatexInlineComment(l))
    .join('\n');
  cleaned = cleaned
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .replace(/\\(?:nonumber|notag)(?![a-zA-Z])/g, '')
    .trim();

  if (envName && ALIGNED_MATH_ENVS.has(envName)) {
    return `\\begin{aligned}\n${cleaned}\n\\end{aligned}`;
  }
  if (envName && GATHERED_MATH_ENVS.has(envName)) {
    return `\\begin{gathered}\n${cleaned}\n\\end{gathered}`;
  }
  return cleaned;
}

/** Split `row` on unescaped `&` at brace depth 0 outside `$...$`. */
function splitTableCells(row: string): string[] {
  const cells: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let inMath = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '$') {
      inMath = !inMath;
      continue;
    }
    if (inMath) continue;
    if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
    else if (ch === '&' && braceDepth === 0) {
      cells.push(row.slice(start, i));
      start = i + 1;
    }
  }
  cells.push(row.slice(start));
  return cells;
}

/** Split table body into logical rows on unescaped `\\` at brace depth 0. */
function splitTableRows(body: string): string[] {
  const rows: string[] = [];
  let start = 0;
  let braceDepth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      braceDepth++;
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      continue;
    }
    if (ch === '\\') {
      if (body[i + 1] === '\\' && braceDepth === 0) {
        rows.push(body.slice(start, i));
        let next = i + 2;
        const opt = readOptionalGroups(body, next, 1);
        next = opt.nextIdx;
        start = next;
        i = next - 1;
        continue;
      }
      i++;
    }
  }
  if (start < body.length) rows.push(body.slice(start));
  return rows;
}

function expandTableCell(rawCell: string): string[] {
  let cell = rawCell.trim();
  let colspan = 1;

  // Unwrap `\multicolumn{N}{spec}{body}`
  if (cell.startsWith('\\multicolumn')) {
    const nGrp = readRequiredGroup(cell, '\\multicolumn'.length);
    const specGrp = nGrp ? readRequiredGroup(cell, nGrp.nextIdx) : null;
    const bodyGrp = specGrp ? readRequiredGroup(cell, specGrp.nextIdx) : null;
    if (nGrp && bodyGrp) {
      const parsed = Number.parseInt(nGrp.content.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 1) colspan = Math.min(parsed, 32);
      cell = bodyGrp.content.trim();
    }
  }

  // Unwrap `\multirow[vpos]{N}{width}{body}`
  if (cell.startsWith('\\multirow')) {
    const opt1 = readOptionalGroups(cell, '\\multirow'.length, 1);
    const nGrp = readRequiredGroup(cell, opt1.nextIdx);
    const opt2 = nGrp ? readOptionalGroups(cell, nGrp.nextIdx, 1) : null;
    const widthGrp = opt2 ? readRequiredGroup(cell, opt2.nextIdx) : null;
    const opt3 = widthGrp ? readOptionalGroups(cell, widthGrp.nextIdx, 1) : null;
    const bodyGrp = opt3 ? readRequiredGroup(cell, opt3.nextIdx) : null;
    if (bodyGrp) {
      cell = bodyGrp.content.trim();
    }
  }

  const transpiled = transpileLatexInline(cell)
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
  const out = [transpiled];
  for (let s = 1; s < colspan; s++) out.push('');
  return out;
}

/** Convert a `tabular`/`longtable` body into a GFM pipe table string. */
function latexTableToPipeMarkdown(bodyLines: string[], envName: string): { table: string; captions: string[] } {
  let text = bodyLines.map((l) => stripLatexInlineComment(l)).join('\n').trim();

  // Consume environment preamble args: optional `[pos]`, optional `{width}` for tabular*/tabularx, then `{cols}`
  let cursor = 0;
  cursor = readOptionalGroups(text, cursor, 1).nextIdx;
  if (envName === 'tabular*' || envName === 'tabularx') {
    const w = readRequiredGroup(text, cursor);
    if (w) cursor = w.nextIdx;
  }
  const colsGrp = readRequiredGroup(text, cursor);
  if (colsGrp) cursor = colsGrp.nextIdx;
  text = text.slice(cursor);

  const captions: string[] = [];
  // Extract any `\caption{...}` inside `longtable`
  text = replaceMacroWithOneArg(text, ['caption'], (cap) => {
    const cleaned = transpileLatexInline(cap).trim();
    if (cleaned) captions.push(cleaned);
    return '';
  });

  // Strip booktabs / hline / rule / table-head commands
  text = text
    .replace(/\\(?:toprule|midrule|bottomrule|hline|endfirsthead|endhead|endfoot|endlastfoot|centering|small|footnotesize|scriptsize|tiny|normalsize)(?![a-zA-Z])/g, '')
    .replace(/\\cline\s*\{[^}]*\}/g, '')
    .replace(/\\cmidrule(?:\([^)]*\))?(?:\[[^\]]*\])?\s*\{[^}]*\}/g, '')
    .replace(/\\addlinespace(?:\s*\[[^\]]*\])?/g, '')
    .replace(/\\label\s*\{[^}]*\}/g, '');

  const rawRows = splitTableRows(text);
  const parsedRows: string[][] = [];
  for (const rawRow of rawRows) {
    const trimmedRow = rawRow.trim();
    if (!trimmedRow) continue;
    const cells = splitTableCells(trimmedRow).flatMap(expandTableCell);
    if (cells.some((c) => c !== '')) parsedRows.push(cells);
  }

  if (parsedRows.length === 0) return { table: '', captions };

  const columnCount = Math.max(1, ...parsedRows.map((r) => r.length));
  const formatRow = (row: string[]) => {
    const padded = [...row];
    while (padded.length < columnCount) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };

  const header = parsedRows[0];
  const body = parsedRows.slice(1);
  const lines = [formatRow(header), `|${' --- |'.repeat(columnCount)}`, ...body.map(formatRow)];
  return { table: lines.join('\n'), captions };
}

function replaceMacroWithOneArg(
  text: string,
  names: readonly string[],
  replacer: (arg: string) => string,
): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      const m = text.slice(i + 1).match(/^([a-zA-Z]+)(\*?)/);
      if (m && names.includes(m[1])) {
        let cursor = i + 1 + m[0].length;
        const opt = readOptionalGroups(text, cursor, 1);
        cursor = opt.nextIdx;
        const req = readRequiredGroup(text, cursor);
        if (req) {
          out += replacer(req.content);
          i = req.nextIdx;
          continue;
        }
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * Read a multi-line macro call starting on `lines[startIdx]` at `cmdName`,
 * collecting lines until its balanced `{...}` closes.
 */
function readMultilineCommandArg(
  lines: string[],
  startIdx: number,
  cmdName: string,
): { optArg?: string; arg: string; endIdx: number; trailing: string } | null {
  const combinedStart = stripLatexInlineComment(lines[startIdx]);
  const cmdRe = new RegExp(`^\\s*\\\\${cmdName}\\*?`);
  const m = combinedStart.match(cmdRe);
  if (!m) return null;

  let buf = combinedStart.slice(m[0].length);
  let endIdx = startIdx;

  while (true) {
    const opt = readOptionalGroups(buf, 0, 1);
    const probe = skipSpaces(buf, opt.nextIdx);
    if (buf[probe] === '{') {
      const grp = readBalancedGroup(buf, probe, '{', '}');
      if (grp) {
        return {
          optArg: opt.optionals[0],
          arg: grp.content,
          endIdx,
          trailing: buf.slice(grp.endIdx),
        };
      }
    }
    if (endIdx + 1 >= lines.length) return null;
    endIdx++;
    buf += '\n' + stripLatexInlineComment(lines[endIdx]);
  }
}

/** Transpile the body of a theorem-like environment, keeping inner display math intact. */
function transpileTheoremBody(rawLines: string[], titlePrefix: string): string {
  const cleanedLines = rawLines.map((l) => (isFullCommentLine(l) ? '' : stripLatexInlineComment(l)));
  const outParts: string[] = [];
  let paraBuf: string[] = [];
  let mathBuf: string[] | null = null;
  let mathCloser: string | null = null;
  let mathEnvName: string | undefined;

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    const text = transpileLatexInline(paraBuf.join('\n')).trim();
    if (text) outParts.push(text);
    paraBuf = [];
  };

  for (const line of cleanedLines) {
    const trimmed = line.trim();

    if (mathBuf !== null) {
      const endMatch = mathCloser === '$$'
        ? trimmed === '$$'
        : mathCloser === '\\]'
          ? trimmed === '\\]'
          : new RegExp(`^\\\\end\\{${mathCloser?.replace('*', '\\*')}\\}`).test(trimmed);
      if (endMatch) {
        const mathBody = normalizeDisplayMathBody(mathBuf.join('\n'), mathEnvName);
        if (mathBody) outParts.push(`$$\n${mathBody}\n$$`);
        mathBuf = null;
        mathCloser = null;
        mathEnvName = undefined;
      } else {
        mathBuf.push(line);
      }
      continue;
    }

    const singleBracketMath = trimmed.match(/^\\\[([\s\S]+)\\\]$/);
    if (singleBracketMath) {
      flushPara();
      const mathBody = normalizeDisplayMathBody(singleBracketMath[1]);
      if (mathBody) outParts.push(`$$\n${mathBody}\n$$`);
      continue;
    }

    const singleDollarMath = trimmed.match(/^\$\$([\s\S]+)\$\$$/);
    if (singleDollarMath) {
      flushPara();
      const mathBody = normalizeDisplayMathBody(singleDollarMath[1]);
      if (mathBody) outParts.push(`$$\n${mathBody}\n$$`);
      continue;
    }

    if (trimmed === '\\[' || trimmed === '$$') {
      flushPara();
      mathBuf = [];
      mathCloser = trimmed === '\\[' ? '\\]' : '$$';
      mathEnvName = undefined;
      continue;
    }

    const beginEnv = trimmed.match(/^\\begin\{([a-zA-Z]+\*?)\}/);
    if (
      beginEnv &&
      (DISPLAY_MATH_ENVS.has(beginEnv[1]) || ALIGNED_MATH_ENVS.has(beginEnv[1]) || GATHERED_MATH_ENVS.has(beginEnv[1]))
    ) {
      flushPara();
      const env = beginEnv[1];
      const endTag = `\\end{${env}}`;
      const endPos = trimmed.indexOf(endTag);
      if (endPos !== -1) {
        let inner = trimmed.slice(beginEnv[0].length, endPos);
        if (env === 'alignat' || env === 'alignat*') inner = inner.replace(/^\s*\{[^}]*\}/, '');
        const mathBody = normalizeDisplayMathBody(inner, env);
        if (mathBody) outParts.push(`$$\n${mathBody}\n$$`);
      } else {
        mathBuf = [];
        mathCloser = env;
        mathEnvName = env;
      }
      continue;
    }

    if (trimmed === '') {
      flushPara();
      continue;
    }

    paraBuf.push(trimmed);
  }
  flushPara();

  if (outParts.length === 0) return titlePrefix;
  if (outParts[0].startsWith('$$')) return `${titlePrefix}\n\n${outParts.join('\n\n')}`;
  outParts[0] = `${titlePrefix} ${outParts[0]}`;
  return outParts.join('\n\n');
}

function cleanAuthorMetadata(raw: string): string {
  const withoutThanks = replaceMacroWithOneArg(raw, ['thanks', 'affil', 'affiliation', 'email'], () => '');
  const withCommaAnd = withoutThanks
    .replace(/\\and(?![a-zA-Z])/g, ', ')
    .replace(/\\\\(?:\[[^\]]*\])?/g, ', ');
  return transpileLatexInline(withCommaAnd)
    .replace(/\s+,/g, ',')
    .replace(/\s*,\s*(?:,\s*)+/g, ', ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .replace(/\s+/g, ' ');
}

function extractLstlistingLanguage(header: string): string | undefined {
  const m = header.match(/language\s*=\s*\{?([A-Za-z0-9_+-]+)\}?/i);
  return m ? m[1].toLowerCase() : undefined;
}

function extractMintedLanguage(header: string): string | undefined {
  const opt = readOptionalGroups(header, 0, 1);
  const req = readRequiredGroup(header, opt.nextIdx);
  return req ? req.content.trim().toLowerCase() || undefined : undefined;
}

/**
 * Parse a LaTeX document (or standalone chapter/section/diff chunk) into
 * Plannotator `Block[]` with accurate 1-based `startLine` and `sourceLineCount`.
 */
export const parseLatexToBlocks = (source: string): Block[] => {
  const normalized = source.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const blocks: Block[] = [];
  let currentId = 0;

  let buffer: string[] = [];
  let bufferStartLine = 1;
  let bufferEndLine = 1;
  let listItemOpen = false;
  const listStack: Array<{ env: string; ordered: boolean }> = [];
  const floatStack: Array<'figure' | 'table' | 'algorithm'> = [];

  const push = (block: Omit<Block, 'id' | 'order'>) => {
    listItemOpen = false;
    blocks.push({ ...block, id: `block-${currentId++}`, order: currentId });
  };

  const pushSpan = (
    block: Omit<Block, 'id' | 'order' | 'startLine' | 'sourceLineCount'>,
    startLine: number,
    endLine: number,
  ) => push({ ...block, startLine, sourceLineCount: Math.max(1, endLine - startLine + 1) });

  const flush = () => {
    if (buffer.length === 0) return;
    const startLine = bufferStartLine;
    const endLine = bufferEndLine;
    const raw = buffer.join('\n');
    buffer = [];
    const content = transpileLatexInline(raw.trim());
    if (content.trim()) {
      pushSpan({ type: 'paragraph', content }, startLine, endLine);
    }
  };

  // Detect `\begin{document}` outside comments. Only full documents strip the preamble.
  let beginDocIdx = -1;
  for (let j = 0; j < lines.length; j++) {
    if (isFullCommentLine(lines[j])) continue;
    if (/^\s*\\begin\{document\}/.test(stripLatexInlineComment(lines[j]))) {
      beginDocIdx = j;
      break;
    }
  }

  let bodyStartIdx = 0;
  if (beginDocIdx !== -1) {
    bodyStartIdx = beginDocIdx + 1;
    let titleBlock: { content: string; startLine: number; endLine: number } | null = null;
    let authorText = '';
    let dateText = '';
    let metaStartLine = 0;
    let metaEndLine = 0;

    for (let j = 0; j < beginDocIdx; j++) {
      if (isFullCommentLine(lines[j])) continue;
      const stripped = stripLatexInlineComment(lines[j]).trim();
      if (/^\\title\*?(?:\s*\[|\s*\{)/.test(stripped)) {
        const read = readMultilineCommandArg(lines, j, 'title');
        if (read) {
          const text = transpileLatexInline(read.arg.replace(/\\\\(?:\[[^\]]*\])?/g, ' ')).replace(/\s+/g, ' ').trim();
          if (text) {
            titleBlock = { content: text, startLine: j + 1, endLine: read.endIdx + 1 };
          }
          j = read.endIdx;
          continue;
        }
      }
      if (/^\\author\*?(?:\s*\[|\s*\{)/.test(stripped)) {
        const read = readMultilineCommandArg(lines, j, 'author');
        if (read) {
          authorText = cleanAuthorMetadata(read.arg);
          if (!metaStartLine) metaStartLine = j + 1;
          metaEndLine = read.endIdx + 1;
          j = read.endIdx;
          continue;
        }
      }
      if (/^\\date\*?(?:\s*\[|\s*\{)/.test(stripped)) {
        const read = readMultilineCommandArg(lines, j, 'date');
        if (read) {
          const cleaned = transpileLatexInline(read.arg.replace(/\\today(?![a-zA-Z])/g, 'Today')).trim();
          if (cleaned) {
            dateText = cleaned;
            if (!metaStartLine) metaStartLine = j + 1;
            metaEndLine = read.endIdx + 1;
          }
          j = read.endIdx;
          continue;
        }
      }
    }

    if (titleBlock) {
      pushSpan({ type: 'heading', level: 1, content: titleBlock.content }, titleBlock.startLine, titleBlock.endLine);
    }
    const metaParts = [authorText, dateText].filter(Boolean);
    if (metaParts.length > 0) {
      pushSpan({ type: 'paragraph', content: `*${metaParts.join(' · ')}*` }, metaStartLine, metaEndLine);
    }
  }

  /** Collect lines from `startIdx + 1` until a line matching `isClose(strippedLine)`. */
  const collectUntil = (startIdx: number, isClose: (stripped: string) => boolean, stripComments: boolean): [string[], number] => {
    const body: string[] = [];
    for (let j = startIdx + 1; j < lines.length; j++) {
      const candidate = stripComments ? stripLatexInlineComment(lines[j]) : lines[j];
      if (isClose(candidate.trim())) return [body, j];
      body.push(candidate);
    }
    return [body, lines.length - 1];
  };

  for (let i = bodyStartIdx; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNum = i + 1;

    if (isFullCommentLine(rawLine)) continue;

    const line = stripLatexInlineComment(rawLine);
    const trimmed = line.trim();

    if (trimmed === '') {
      flush();
      listItemOpen = false;
      continue;
    }

    if (/^\\end\{document\}/.test(trimmed)) {
      flush();
      break;
    }

    // Display math: `$$ ... $$` single-line or multi-line
    const singleDollarDisplay = trimmed.match(/^\$\$([\s\S]+)\$\$$/);
    if (singleDollarDisplay) {
      flush();
      const content = normalizeDisplayMathBody(singleDollarDisplay[1]);
      if (content) pushSpan({ type: 'math', content }, lineNum, lineNum);
      continue;
    }
    if (trimmed.startsWith('$$')) {
      flush();
      const firstLineRest = trimmed.slice(2);
      const [rest, closeIdx] = collectUntil(i, (t) => t.endsWith('$$'), true);
      const lastLine = stripLatexInlineComment(lines[closeIdx]).trim();
      const body = [
        ...(firstLineRest ? [firstLineRest] : []),
        ...rest,
        ...(closeIdx > i && lastLine.length > 2 ? [lastLine.slice(0, -2)] : []),
      ];
      const content = normalizeDisplayMathBody(body.join('\n'));
      if (content) pushSpan({ type: 'math', content }, lineNum, closeIdx + 1);
      i = closeIdx;
      continue;
    }

    // Display math: `\[ ... \]` single-line or multi-line
    const singleBracketDisplay = trimmed.match(/^\\\[([\s\S]+)\\\]$/);
    if (singleBracketDisplay) {
      flush();
      const content = normalizeDisplayMathBody(singleBracketDisplay[1]);
      if (content) pushSpan({ type: 'math', content }, lineNum, lineNum);
      continue;
    }
    if (trimmed.startsWith('\\[')) {
      flush();
      const firstLineRest = trimmed.slice(2);
      const [rest, closeIdx] = collectUntil(i, (t) => t.endsWith('\\]'), true);
      const lastLine = stripLatexInlineComment(lines[closeIdx]).trim();
      const body = [
        ...(firstLineRest ? [firstLineRest] : []),
        ...rest,
        ...(closeIdx > i && lastLine.length > 2 ? [lastLine.slice(0, -2)] : []),
      ];
      const content = normalizeDisplayMathBody(body.join('\n'));
      if (content) pushSpan({ type: 'math', content }, lineNum, closeIdx + 1);
      i = closeIdx;
      continue;
    }

    // `\begin{env}` environments
    const beginMatch = trimmed.match(/^\\begin\{([a-zA-Z]+\*?)\}(.*)$/);
    if (beginMatch) {
      const env = beginMatch[1];
      const headerRest = beginMatch[2];
      const endRe = new RegExp(`^\\\\end\\{${env.replace('*', '\\*')}\\}`);

      if (DISPLAY_MATH_ENVS.has(env) || ALIGNED_MATH_ENVS.has(env) || GATHERED_MATH_ENVS.has(env)) {
        flush();
        const endToken = `\\end{${env}}`;
        const inlineEnd = headerRest.indexOf(endToken);
        if (inlineEnd !== -1) {
          let inner = headerRest.slice(0, inlineEnd);
          if (env === 'alignat' || env === 'alignat*') inner = inner.replace(/^\s*\{[^}]*\}/, '');
          const content = normalizeDisplayMathBody(inner, env);
          if (content) pushSpan({ type: 'math', content }, lineNum, lineNum);
          continue;
        }
        const [body, closeIdx] = collectUntil(i, (t) => endRe.test(t), true);
        let rawBody = [headerRest, ...body].join('\n');
        if (env === 'alignat' || env === 'alignat*') rawBody = rawBody.replace(/^\s*\{[^}]*\}/, '');
        const content = normalizeDisplayMathBody(rawBody, env);
        if (content) pushSpan({ type: 'math', content }, lineNum, closeIdx + 1);
        i = closeIdx;
        continue;
      }

      if (VERBATIM_ENVS.has(env)) {
        flush();
        const [body, closeIdx] = collectUntil(i, (t) => endRe.test(t), false);
        let language: string | undefined;
        let codeLines = body;
        if (env === 'lstlisting') {
          language = extractLstlistingLanguage(headerRest);
        } else if (env === 'minted') {
          language = extractMintedLanguage(headerRest);
        }
        // Preserve leading text only if it followed closing header args on the same line (unusual)
        pushSpan({ type: 'code', content: codeLines.join('\n'), language }, lineNum, closeIdx + 1);
        i = closeIdx;
        continue;
      }

      if (TABLE_ENVS.has(env)) {
        flush();
        const [body, closeIdx] = collectUntil(i, (t) => endRe.test(t), true);
        const { table, captions } = latexTableToPipeMarkdown([headerRest, ...body], env);
        if (table) pushSpan({ type: 'table', content: table }, lineNum, closeIdx + 1);
        for (const cap of captions) {
          pushSpan({ type: 'paragraph', content: `*Table: ${cap}*` }, lineNum, closeIdx + 1);
        }
        i = closeIdx;
        continue;
      }

      if (env === 'figure' || env === 'figure*' || env === 'table' || env === 'table*' || env === 'algorithm' || env === 'algorithm*') {
        flush();
        const kind = env.startsWith('figure') ? 'figure' : env.startsWith('table') ? 'table' : 'algorithm';
        floatStack.push(kind);
        continue;
      }

      if (env === 'abstract') {
        flush();
        pushSpan({ type: 'heading', level: 2, content: 'Abstract' }, lineNum, lineNum);
        continue;
      }

      if (LIST_ENVS.has(env)) {
        flush();
        listStack.push({ env, ordered: env === 'enumerate' });
        continue;
      }

      if (QUOTE_ENVS.has(env)) {
        flush();
        const [body, closeIdx] = collectUntil(i, (t) => endRe.test(t), true);
        const content = body
          .join('\n')
          .split(/\n\s*\n+/)
          .map((p) => transpileLatexInline(p.replace(/\s*\n\s*/g, ' ').trim()))
          .filter(Boolean)
          .join('\n\n');
        if (content) pushSpan({ type: 'blockquote', content }, lineNum, closeIdx + 1);
        i = closeIdx;
        continue;
      }

      const baseEnv = env.replace(/\*$/, '').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(THEOREM_TITLES, baseEnv)) {
        flush();
        const opt = readOptionalGroups(headerRest, 0, 1);
        const titleLabel = THEOREM_TITLES[baseEnv];
        const optTitle = opt.optionals[0] ? ` (${transpileLatexInline(opt.optionals[0]).trim()})` : '';
        const prefix = `**${titleLabel}${optTitle}.**`;
        const inlineEnd = headerRest.indexOf(`\\end{${env}}`);
        if (inlineEnd !== -1) {
          const inner = headerRest.slice(opt.nextIdx, inlineEnd);
          const content = transpileTheoremBody([inner], prefix);
          pushSpan({ type: 'blockquote', content }, lineNum, lineNum);
          continue;
        }
        const [body, closeIdx] = collectUntil(i, (t) => endRe.test(t), true);
        const restOfOpening = headerRest.slice(opt.nextIdx).trim();
        const combined = restOfOpening ? [restOfOpening, ...body] : body;
        const content = transpileTheoremBody(combined, prefix);
        pushSpan({ type: 'blockquote', content }, lineNum, closeIdx + 1);
        i = closeIdx;
        continue;
      }
    }

    // `\end{env}` closings for transparent / list environments
    const endMatch = trimmed.match(/^\\end\{([a-zA-Z]+\*?)\}/);
    if (endMatch) {
      const env = endMatch[1];
      if (LIST_ENVS.has(env)) {
        flush();
        listItemOpen = false;
        if (listStack.length > 0 && listStack[listStack.length - 1].env === env) {
          listStack.pop();
        }
        continue;
      }
      if (env === 'figure' || env === 'figure*' || env === 'table' || env === 'table*' || env === 'algorithm' || env === 'algorithm*') {
        flush();
        floatStack.pop();
        continue;
      }
      if (env === 'abstract') {
        flush();
        continue;
      }
    }

    // Section headings: `\part`, `\chapter`, `\section`, `\subsection`, `\subsubsection`, `\paragraph`, `\subparagraph`
    const headingCmd = trimmed.match(/^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\s*\[|\s*\{)/);
    if (headingCmd) {
      const cmd = headingCmd[1];
      const read = readMultilineCommandArg(lines, i, cmd);
      if (read) {
        flush();
        const cleanedTitle = replaceMacroWithOneArg(read.arg, ['label'], () => '').trim();
        const content = transpileLatexInline(cleanedTitle);
        pushSpan({ type: 'heading', level: HEADING_LEVELS[cmd], content }, lineNum, read.endIdx + 1);
        const trailingText = replaceMacroWithOneArg(read.trailing, ['label'], () => '').trim();
        if (trailingText) {
          bufferStartLine = read.endIdx + 1;
          bufferEndLine = read.endIdx + 1;
          buffer.push(trailingText);
        }
        i = read.endIdx;
        continue;
      }
    }

    // Page breaks / horizontal rules
    if (/^\\(?:newpage|clearpage|cleardoublepage|pagebreak|hrule|hrulefill)(?:\s*)$/.test(trimmed)) {
      flush();
      push({ type: 'hr', content: '', startLine: lineNum });
      continue;
    }

    // Standalone `\includegraphics[...]{path}`
    if (/^\\includegraphics\*?(?:\s*\[|\s*\{)/.test(trimmed)) {
      const read = readMultilineCommandArg(lines, i, 'includegraphics');
      if (read) {
        flush();
        const imgPath = read.arg.trim();
        const isVectorPrint = /\.(?:pdf|eps|ps)$/i.test(imgPath);
        const content = isVectorPrint
          ? `**Figure:** \`${imgPath}\``
          : `![${imgPath.slice(imgPath.lastIndexOf('/') + 1)}](${imgPath})`;
        pushSpan({ type: 'paragraph', content }, lineNum, read.endIdx + 1);
        i = read.endIdx;
        continue;
      }
    }

    // Standalone `\caption{...}` (typically inside `figure`, `table`, or `algorithm` float)
    if (/^\\caption\*?(?:\s*\[|\s*\{)/.test(trimmed)) {
      const read = readMultilineCommandArg(lines, i, 'caption');
      if (read) {
        flush();
        const currentFloat = floatStack[floatStack.length - 1];
        const label =
          currentFloat === 'figure'
            ? 'Figure'
            : currentFloat === 'table'
              ? 'Table'
              : currentFloat === 'algorithm'
                ? 'Algorithm'
                : 'Caption';
        const cleanedCap = replaceMacroWithOneArg(read.arg, ['label'], () => '').trim();
        pushSpan(
          { type: 'paragraph', content: `*${label}: ${transpileLatexInline(cleanedCap)}*` },
          lineNum,
          read.endIdx + 1,
        );
        i = read.endIdx;
        continue;
      }
    }

    // `\input{file}`, `\include{file}`, `\subfile{file}`
    const includeMatch = trimmed.match(/^\\(input|include|subfile)\s*\{([^}\n]+)\}\s*$/);
    if (includeMatch) {
      flush();
      const target = normalizeTexIncludeTarget(includeMatch[2]);
      pushSpan({ type: 'paragraph', content: `[${target}](${target})` }, lineNum, lineNum);
      continue;
    }

    // Bibliography commands
    const bibMatch = trimmed.match(/^\\bibliography\s*\{([^}\n]+)\}\s*$/);
    if (bibMatch) {
      flush();
      pushSpan({ type: 'paragraph', content: `*Bibliography:* \`${bibMatch[1].trim()}\`` }, lineNum, lineNum);
      continue;
    }
    if (/^\\printbibliography(?:\s*\[[^\]]*\])?\s*$/.test(trimmed)) {
      flush();
      pushSpan({ type: 'heading', level: 2, content: 'References' }, lineNum, lineNum);
      continue;
    }

    // Standalone non-rendering commands (`\label`, `\centering`, `\maketitle`, `\usepackage`, etc.)
    if (
      buffer.length === 0 &&
      /^\\(?:maketitle|tableofcontents|listoffigures|listoftables|centering|raggedright|raggedleft|noindent|label\{[^}]*\}|bibliographystyle\{[^}]*\}|addbibresource(?:\[[^\]]*\])?\{[^}]*\}|vspace\*?(?:\[[^\]]*\])?\{[^}]*\}|hspace\*?(?:\[[^\]]*\])?\{[^}]*\}|smallskip|medskip|bigskip|thispagestyle\{[^}]*\}|pagestyle\{[^}]*\}|documentclass(?:\[[^\]]*\])?\{[^}]*\}|usepackage(?:\[[^\]]*\])?\{[^}]*\}|graphicspath\{.+\}|(?:re)?newcommand\*?\{[^}]*\}.*|newtheorem\*?\{[^}]*\}.*)\s*$/.test(
        trimmed,
      )
    ) {
      continue;
    }

    // List `\item` (only inside `itemize` / `enumerate` / `description`, or standalone `\item` in a diff chunk!)
    const itemMatch = trimmed.match(/^\\item(?:\s+(.*)|(\[[\s\S]*)|())$/);
    if (itemMatch && (listStack.length > 0 || /^\\item(?:\s|\[|$)/.test(trimmed))) {
      flush();
      let rest = trimmed.slice('\\item'.length);
      const opt = readOptionalGroups(rest, 0, 1);
      rest = rest.slice(opt.nextIdx).trim();
      const top = listStack[listStack.length - 1];
      const level = Math.max(0, listStack.length - 1);
      const ordered = top?.ordered ? true : undefined;
      let prefix = '';
      if (opt.optionals[0] !== undefined) {
        const label = transpileLatexInline(opt.optionals[0]).trim();
        if (label) {
          prefix = top?.env === 'description' ? `**${label}:** ` : `**${label}** — `;
        }
      }
      push({
        type: 'list-item',
        content: prefix + transpileLatexInline(rest),
        level,
        ordered,
        startLine: lineNum,
      });
      listItemOpen = true;
      continue;
    }

    // Continuation line of an open list item
    const last = blocks[blocks.length - 1];
    if (listItemOpen && buffer.length === 0 && last?.type === 'list-item') {
      const transpiledLine = transpileLatexInline(trimmed);
      if (transpiledLine) {
        last.content = last.content ? `${last.content}\n${transpiledLine}` : transpiledLine;
      }
      last.sourceLineCount = lineNum - last.startLine + 1;
      continue;
    }

    if (buffer.length === 0) bufferStartLine = lineNum;
    bufferEndLine = lineNum;
    buffer.push(trimmed);
  }

  flush();

  // Diff chunks may hold only `%` comments or preamble lines (`\usepackage{...}`).
  // Emit a latex code block rather than returning an empty block list so diff views
  // never render a blank card for non-empty source.
  if (blocks.length === 0 && normalized.trim() !== '') {
    const rawLines = normalized.replace(/\n$/, '').split('\n');
    pushSpan({ type: 'code', language: 'latex', content: normalized.trimEnd() }, 1, rawLines.length);
  }

  return blocks;
};
