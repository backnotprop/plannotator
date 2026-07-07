import { Block, type AlertKind } from '../types';
import { parseMarkdownToBlocks } from './parser';
import type { DocumentFormat } from '@plannotator/core/document-format';

/**
 * A simplified AsciiDoc parser that splits content into the same linear Block
 * model as `parseMarkdownToBlocks`. Block structure (sections, lists, listing
 * blocks, admonitions, tables, quotes) is parsed natively; inline formatting
 * is transpiled to markdown inline syntax because the Viewer's InlineMarkdown
 * renderer speaks markdown. Anything unrecognized passes through literally —
 * worst case is visible raw syntax, never lost (un-annotatable) content.
 */

/** Pick the block parser for a document format. */
export const parseDocumentToBlocks = (text: string, format: DocumentFormat): Block[] =>
  format === 'asciidoc' ? parseAsciidocToBlocks(text) : parseMarkdownToBlocks(text);

const ADMONITION_KINDS = new Set(['note', 'tip', 'important', 'warning', 'caution']);

/** Pending block metadata collected from attribute/anchor lines (`[source,js]`,
 *  `[NOTE]`, `[[anchor]]`, …) that attach to the NEXT block. `startLine` is the
 *  first metadata line so the block's exported line span covers it. */
interface PendingMeta {
  startLine: number;
  style?: string;
  language?: string;
  admonition?: AlertKind;
  quoteAttribution?: string;
}

/** Substitute `{name}` attribute references. Only known attributes are
 *  replaced; unknown references stay literal (they may be plain braces). */
const substituteAttributes = (text: string, attrs: Map<string, string>): string =>
  text.replace(/\{([a-zA-Z0-9_][a-zA-Z0-9_-]*)\}/g, (whole, name: string) => {
    const builtin = BUILTIN_ATTRIBUTES[name];
    if (builtin !== undefined) return builtin;
    const value = attrs.get(name);
    return value !== undefined ? value : whole;
  });

const BUILTIN_ATTRIBUTES: Record<string, string> = {
  nbsp: ' ',
  empty: '',
  sp: ' ',
  plus: '+',
  asterisk: '*',
  tilde: '~',
  backtick: '`',
  startsb: '[',
  endsb: ']',
  vbar: '|',
};

/** Transpile AsciiDoc inline syntax to markdown inline syntax for one
 *  non-code text segment. */
const transpileSegment = (text: string, attrs: Map<string, string>): string => {
  let out = substituteAttributes(text, attrs);

  // Passthroughs: strip the markers, keep content verbatim-ish.
  out = out.replace(/\+\+\+(.*?)\+\+\+/g, '$1');
  out = out.replace(/pass:[a-z,]*\[([^\]]*)\]/g, '$1');

  // Inline image macro (single colon). Alt is the first positional attribute.
  out = out.replace(/image:([^:\s\[][^\[\s]*)\[([^\]]*)\]/g, (_, path: string, attrList: string) => {
    const alt = attrList.split(',')[0].trim();
    return `![${alt}](${path})`;
  });

  // Explicit link macro.
  out = out.replace(/link:([^\s\[]+)\[([^\]]*)\]/g, (_, url: string, label: string) => {
    const text = label.split(',')[0].trim();
    return `[${text || url}](${url})`;
  });

  // Bare URL followed directly by [text]. Bare URLs without brackets already
  // autolink in InlineMarkdown.
  out = out.replace(/(https?:\/\/[^\s\[\]]+)\[([^\]]*)\]/g, (_, url: string, label: string) => {
    const text = label.split(',')[0].trim();
    return text ? `[${text}](${url})` : url;
  });

  // Cross references degrade to their text: heading anchors are slug-derived
  // in the Viewer, so AsciiDoc ids won't resolve — plain text beats dead links.
  out = out.replace(/xref:([^\s\[]+)\[([^\]]*)\]/g, (_, id: string, label: string) => label.trim() || id);
  out = out.replace(/<<([^,>]+),\s*([^>]+)>>/g, '$2');
  out = out.replace(/<<([^,>]+)>>/g, '$1');

  // Footnotes become parentheticals.
  out = out.replace(/footnote:[\w-]*\[([^\]]*)\]/g, (_, note: string) => (note ? ` (${note})` : ''));

  // Constrained single-asterisk bold → markdown double-asterisk. `**x**` means
  // bold in both syntaxes and is excluded by the inner char classes.
  out = out.replace(/(^|[^\w*])\*([^\s*](?:[^*]*[^\s*])?)\*(?![\w*])/g, '$1**$2**');

  return out;
};

/** Transpile inline AsciiDoc to markdown, protecting backtick code spans
 *  (odd split segments) from transformation. */
export const transpileInline = (text: string, attrs: Map<string, string> = new Map()): string => {
  if (!text) return text;
  return text
    .split('`')
    .map((segment, idx) => (idx % 2 === 0 ? transpileSegment(segment, attrs) : segment))
    .join('`');
};

/** Strip simple cell specs (`2+|`, `a|`, `^|`, `.2+|`, …) so they don't leak
 *  into cell text, then split a physical table line into cells. */
const splitTableCells = (line: string): string[] => {
  const cleaned = line.replace(
    /(^|\s)(?:\d+(?:\.\d+)?[+*]|\.\d+\+|[aemshldv]|[<^>](?:\.[<^>])?)?\|/g,
    '$1|',
  );
  const parts = cleaned.split('|');
  return parts.slice(1).map((cell) => cell.trim());
};

const escapePipes = (cell: string): string => cell.replace(/\|/g, '\\|');

/** Convert collected `|===` body lines to a pipe-markdown table string.
 *  Row grouping: blank-line-separated groups are rows (one-cell-per-line
 *  style); with no blank lines, each physical line is a row. The first row is
 *  treated as the header. */
const asciidocTableToPipeMarkdown = (bodyLines: string[], attrs: Map<string, string>): string => {
  const hasBlankSeparators = bodyLines.some((l) => l.trim() === '');
  const rows: string[][] = [];

  if (hasBlankSeparators) {
    let current: string[] = [];
    for (const line of bodyLines) {
      if (line.trim() === '') {
        if (current.length) rows.push(current);
        current = [];
      } else {
        current.push(...splitTableCells(line));
      }
    }
    if (current.length) rows.push(current);
  } else {
    for (const line of bodyLines) {
      if (line.trim() === '') continue;
      rows.push(splitTableCells(line));
    }
  }

  if (rows.length === 0) return '';

  const columnCount = Math.max(...rows.map((r) => r.length));
  const normalize = (row: string[]): string[] => {
    const cells = [...row];
    while (cells.length < columnCount) cells.push('');
    return cells.map((c) => escapePipes(transpileInline(c, attrs)));
  };

  const lines: string[] = [];
  lines.push(`| ${normalize(rows[0]).join(' | ')} |`);
  lines.push(`|${' --- |'.repeat(columnCount)}`);
  for (const row of rows.slice(1)) {
    lines.push(`| ${normalize(row).join(' | ')} |`);
  }
  return lines.join('\n');
};

const AUTHOR_LINE_REGEX = /^[^\s<>][^<>]*<[^\s<>]+@[^\s<>]+>\s*$/;
const REVISION_LINE_REGEX = /^v?\d[\w.]*(?:,\s*.*)?$/;

export const parseAsciidocToBlocks = (source: string): Block[] => {
  const lines = source.split('\n');
  const blocks: Block[] = [];
  const attrs = new Map<string, string>();
  let currentId = 0;

  let buffer: string[] = [];
  let bufferStartLine = 1;
  let pendingMeta: PendingMeta | null = null;
  // Set right after the document title is emitted so the optional author and
  // revision lines directly below it are consumed instead of rendered.
  let expectHeaderAuthorLines = false;
  // Set by a lone `+` continuation line: the next paragraph appends to the
  // preceding list item instead of becoming its own block.
  let listContinuation = false;

  const takeMeta = (): PendingMeta | null => {
    const meta = pendingMeta;
    pendingMeta = null;
    return meta;
  };

  const push = (block: Omit<Block, 'id' | 'order'>) => {
    // Any explicit block emission cancels a dangling `+` continuation, so a
    // stray continuation line never glues a later paragraph onto a list item.
    listContinuation = false;
    blocks.push({ ...block, id: `block-${currentId++}`, order: currentId });
  };

  const flush = (endLine?: number) => {
    if (buffer.length === 0) return;
    const meta = takeMeta();
    const raw = buffer.join('\n').trim();
    const startLine = meta?.startLine ?? bufferStartLine;
    const lastContentLine = endLine ?? bufferStartLine + buffer.length - 1;
    const sourceSpan = lastContentLine - startLine + 1;
    buffer = [];

    // `[source,lang]` (or `[listing]`/`[literal]`) styling a plain paragraph
    // makes it a listing without delimiters.
    if (meta?.style === 'source' || meta?.style === 'listing' || meta?.style === 'literal') {
      push({
        type: 'code',
        content: raw,
        language: meta.language,
        startLine,
        sourceLineCount: sourceSpan,
      });
      return;
    }

    const content = transpileInline(raw, attrs);
    const contentLineCount = content.split('\n').length;

    if (listContinuation && blocks.length > 0 && blocks[blocks.length - 1].type === 'list-item') {
      blocks[blocks.length - 1].content += '\n\n' + content;
      listContinuation = false;
      return;
    }
    listContinuation = false;

    if (meta?.admonition) {
      push({
        type: 'blockquote',
        content,
        alertKind: meta.admonition,
        startLine,
        sourceLineCount: sourceSpan,
      });
      return;
    }
    push({
      type: 'paragraph',
      content,
      startLine,
      sourceLineCount: sourceSpan !== contentLineCount ? sourceSpan : undefined,
    });
  };

  /** Consume lines i+1.. until a line matching `close`; returns [bodyLines, closingIndex]. */
  const collectDelimited = (startIdx: number, close: RegExp): [string[], number] => {
    const body: string[] = [];
    let j = startIdx;
    while (j + 1 < lines.length) {
      j++;
      if (close.test(lines[j].trim())) return [body, j];
      body.push(lines[j]);
    }
    return [body, j];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const currentLineNum = i + 1;

    // Optional author/revision lines directly under the document title.
    if (expectHeaderAuthorLines) {
      if (AUTHOR_LINE_REGEX.test(trimmed)) continue;
      expectHeaderAuthorLines = false;
      if (REVISION_LINE_REGEX.test(trimmed) && i >= 2 && AUTHOR_LINE_REGEX.test(lines[i - 1].trim())) {
        continue;
      }
    }

    // Comment block: //// ... ////
    if (/^\/{4,}$/.test(trimmed)) {
      flush(currentLineNum - 1);
      const [, closeIdx] = collectDelimited(i, /^\/{4,}$/);
      i = closeIdx;
      continue;
    }

    // Line comment (but not a block-comment delimiter, handled above).
    if (trimmed.startsWith('//')) continue;

    // Attribute entry: :name: value / :!name: — collected, no block.
    const attrMatch = trimmed.match(/^:(!?)([a-zA-Z0-9_][a-zA-Z0-9_-]*)(!?):(?:\s+(.*))?$/);
    if (attrMatch) {
      flush(currentLineNum - 1);
      const [, unsetPre, name, unsetPost, value] = attrMatch;
      if (unsetPre || unsetPost) attrs.delete(name);
      else attrs.set(name, (value ?? '').trim());
      continue;
    }

    // Headings: = Title … ====== Sub. Level = count of '='.
    const headingMatch = trimmed.match(/^(={1,6})\s+(.+)$/);
    if (headingMatch) {
      flush(currentLineNum - 1);
      const meta = takeMeta();
      const level = headingMatch[1].length;
      push({
        type: 'heading',
        content: transpileInline(headingMatch[2].trim(), attrs),
        level,
        startLine: meta?.startLine ?? currentLineNum,
        sourceLineCount: meta ? currentLineNum - meta.startLine + 1 : undefined,
      });
      if (level === 1 && blocks.length === 1) expectHeaderAuthorLines = true;
      continue;
    }

    // Thematic break / page break.
    if (/^'{3,}$/.test(trimmed) || trimmed === '<<<') {
      flush(currentLineNum - 1);
      takeMeta();
      push({ type: 'hr', content: '', startLine: currentLineNum });
      continue;
    }

    // Listing (----) and literal (....) delimited blocks → code.
    const listingMatch = trimmed.match(/^(-{4,}|\.{4,})$/);
    if (listingMatch) {
      flush(currentLineNum - 1);
      const meta = takeMeta();
      const close = listingMatch[1].startsWith('-') ? /^-{4,}$/ : /^\.{4,}$/;
      const [body, closeIdx] = collectDelimited(i, close);
      push({
        type: 'code',
        content: body.join('\n'),
        language: meta?.language,
        startLine: meta?.startLine ?? currentLineNum,
        sourceLineCount: closeIdx + 1 - (meta?.startLine ?? currentLineNum) + 1,
      });
      i = closeIdx;
      continue;
    }

    // Passthrough block (++++) → shown literally as a code block.
    if (/^\+{4,}$/.test(trimmed)) {
      flush(currentLineNum - 1);
      const meta = takeMeta();
      const [body, closeIdx] = collectDelimited(i, /^\+{4,}$/);
      push({
        type: 'code',
        content: body.join('\n'),
        startLine: meta?.startLine ?? currentLineNum,
        sourceLineCount: closeIdx + 1 - (meta?.startLine ?? currentLineNum) + 1,
      });
      i = closeIdx;
      continue;
    }

    // Example block (====): admonition body when tagged [NOTE] etc.; otherwise
    // a transparent grouping — the delimiters vanish and inner lines flow
    // through the main loop (flat block model, like the md parser's quotes).
    const exampleMatch = trimmed.match(/^={4,}$/);
    if (exampleMatch) {
      if (pendingMeta?.admonition) {
        flush(currentLineNum - 1);
        const meta = takeMeta()!;
        const [body, closeIdx] = collectDelimited(i, /^={4,}$/);
        push({
          type: 'blockquote',
          content: transpileInline(body.join('\n').trim(), attrs),
          alertKind: meta.admonition,
          startLine: meta.startLine,
          sourceLineCount: closeIdx + 1 - meta.startLine + 1,
        });
        i = closeIdx;
      } else {
        flush(currentLineNum - 1);
      }
      continue;
    }

    // Sidebar (****) and open (--) blocks: transparent grouping.
    if (/^\*{4,}$/.test(trimmed) || trimmed === '--') {
      flush(currentLineNum - 1);
      continue;
    }

    // Quote block (____) → blockquote, attribution from [quote, Name].
    if (/^_{4,}$/.test(trimmed)) {
      flush(currentLineNum - 1);
      const meta = takeMeta();
      const [body, closeIdx] = collectDelimited(i, /^_{4,}$/);
      let content = transpileInline(body.join('\n').trim(), attrs);
      if (meta?.quoteAttribution) content += `\n— ${meta.quoteAttribution}`;
      push({
        type: 'blockquote',
        content,
        startLine: meta?.startLine ?? currentLineNum,
        sourceLineCount: closeIdx + 1 - (meta?.startLine ?? currentLineNum) + 1,
      });
      i = closeIdx;
      continue;
    }

    // Table: |=== ... |===
    if (/^\|={3,}$/.test(trimmed)) {
      flush(currentLineNum - 1);
      const meta = takeMeta();
      const [body, closeIdx] = collectDelimited(i, /^\|={3,}$/);
      push({
        type: 'table',
        content: asciidocTableToPipeMarkdown(body, attrs),
        startLine: meta?.startLine ?? currentLineNum,
        sourceLineCount: closeIdx + 1 - (meta?.startLine ?? currentLineNum) + 1,
      });
      i = closeIdx;
      continue;
    }

    // Anchor line [[id]] → metadata for the next block.
    if (/^\[\[[^\]]+\]\]$/.test(trimmed)) {
      flush(currentLineNum - 1);
      if (!pendingMeta) pendingMeta = { startLine: currentLineNum };
      continue;
    }

    // Block attribute list: [source,js] / [NOTE] / [quote, Name] / [cols=…] …
    const attrListMatch = trimmed.match(/^\[([^\]]*)\]$/);
    if (attrListMatch) {
      flush(currentLineNum - 1);
      const parts = attrListMatch[1].split(',').map((p) => p.trim());
      const first = parts[0] ?? '';
      const meta: PendingMeta = pendingMeta ?? { startLine: currentLineNum };
      if (ADMONITION_KINDS.has(first.toLowerCase()) && first === first.toUpperCase()) {
        meta.admonition = first.toLowerCase() as AlertKind;
      } else if (first.toLowerCase() === 'source') {
        meta.style = 'source';
        meta.language = parts[1] || undefined;
      } else if (first.toLowerCase() === 'listing' || first.toLowerCase() === 'literal') {
        meta.style = first.toLowerCase();
      } else if (first.toLowerCase() === 'quote' || first.toLowerCase() === 'verse') {
        meta.quoteAttribution = parts.slice(1).filter(Boolean).join(', ') || undefined;
      }
      pendingMeta = meta;
      continue;
    }

    // Inline admonition paragraph: NOTE: text …
    const admonitionMatch = trimmed.match(/^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+(.*)$/);
    if (admonitionMatch) {
      flush(currentLineNum - 1);
      takeMeta();
      const startLine = currentLineNum;
      const body: string[] = [admonitionMatch[2]];
      while (i + 1 < lines.length && lines[i + 1].trim() !== '') {
        i++;
        body.push(lines[i].trim());
      }
      push({
        type: 'blockquote',
        content: transpileInline(body.join('\n'), attrs),
        alertKind: admonitionMatch[1].toLowerCase() as AlertKind,
        startLine,
        sourceLineCount: i + 1 - startLine + 1,
      });
      continue;
    }

    // Block image macro.
    const blockImageMatch = trimmed.match(/^image::([^\[\s]+)\[([^\]]*)\]$/);
    if (blockImageMatch) {
      flush(currentLineNum - 1);
      const meta = takeMeta();
      const alt = blockImageMatch[2].split(',')[0].trim();
      push({
        type: 'paragraph',
        content: `![${alt}](${blockImageMatch[1]})`,
        startLine: meta?.startLine ?? currentLineNum,
        sourceLineCount: meta ? currentLineNum - meta.startLine + 1 : undefined,
      });
      continue;
    }

    // Unordered lists: * / ** / *** and the single-level - marker.
    const unorderedMatch = line.match(/^\s*(\*{1,5}|-)\s+(.+)$/);
    // Ordered lists: . / .. / ...
    const orderedMatch = line.match(/^\s*(\.{1,5})\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      flush(currentLineNum - 1);
      takeMeta();
      const marker = (unorderedMatch ?? orderedMatch)![1];
      let content = (unorderedMatch ?? orderedMatch)![2];
      const ordered = !!orderedMatch;
      const level = marker === '-' ? 0 : marker.length - 1;

      let checked: boolean | undefined = undefined;
      const checkboxMatch = content.match(/^\[([ xX*])\]\s*/);
      if (checkboxMatch) {
        checked = checkboxMatch[1] !== ' ';
        content = content.replace(/^\[([ xX*])\]\s*/, '');
      }

      push({
        type: 'list-item',
        content: transpileInline(content, attrs),
        level,
        ordered: ordered || undefined,
        checked,
        startLine: currentLineNum,
      });
      continue;
    }

    // List continuation: a lone `+` attaches the next block to the previous item.
    if (trimmed === '+' && blocks.length > 0 && blocks[blocks.length - 1].type === 'list-item' && buffer.length === 0) {
      listContinuation = true;
      continue;
    }

    // Description list: term:: definition (definition may start on the next line).
    const descMatch = trimmed.match(/^(\S.*?)::(?:\s+(.*))?$/);
    if (descMatch && !trimmed.includes('::[')) {
      flush(currentLineNum - 1);
      takeMeta();
      const term = descMatch[1];
      const startLine = currentLineNum;
      const defParts: string[] = descMatch[2] ? [descMatch[2]] : [];
      if (defParts.length === 0) {
        while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !/^(\S.*?)::(?:\s+.*)?$/.test(lines[i + 1].trim())) {
          i++;
          defParts.push(lines[i].trim());
        }
      }
      const definition = transpileInline(defParts.join('\n'), attrs);
      push({
        type: 'list-item',
        content: `**${transpileInline(term, attrs)}**${definition ? ` — ${definition}` : ''}`,
        level: 0,
        startLine,
        sourceLineCount: i + 1 - startLine + 1 > 1 ? i + 1 - startLine + 1 : undefined,
      });
      continue;
    }

    // Block title: .Title (dot + non-space, non-dot) → bold caption paragraph.
    const blockTitleMatch = trimmed.match(/^\.([^\s.].*)$/);
    if (blockTitleMatch && buffer.length === 0) {
      flush(currentLineNum - 1);
      push({
        type: 'paragraph',
        content: `**${transpileInline(blockTitleMatch[1].trim(), attrs)}**`,
        startLine: currentLineNum,
      });
      continue;
    }

    // Blank lines separate paragraphs.
    if (trimmed === '') {
      flush(currentLineNum - 1);
      continue;
    }

    // Accumulate paragraph text.
    if (buffer.length === 0) bufferStartLine = currentLineNum;
    buffer.push(line);
  }

  flush(lines.length);

  return blocks;
};
