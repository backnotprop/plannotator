import type { AlertKind, Block } from '../types';

const DEFINITION_STOP_RE =
  /^(?:(?:[*.]{1,5}|-|\d+\.)\s|\+$|(?:-{4,}|\.{4,}|={4,}|\*{4,}|_{4,}|\+{4,}|\|={3,}|--|```.*)$|\[.*\]$|\/\/|[a-z][\w-]*::\S*\[)/;

const ADMONITION_KINDS = new Set(['note', 'tip', 'important', 'warning', 'caution']);

interface PendingMeta {
  startLine: number;
  style?: string;
  language?: string;
  admonition?: AlertKind;
  attribution?: string;
  cols?: string;
  options: Set<string>;
}

const BUILTIN_ATTRIBUTES: Record<string, string> = {
  nbsp: ' ',
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

const substituteAttributes = (text: string, attrs: Map<string, string>): string =>
  text.replace(/\{([a-zA-Z0-9_][a-zA-Z0-9_-]*)\}/g, (whole, name: string) =>
    attrs.get(name) ?? BUILTIN_ATTRIBUTES[name] ?? whole,
  );

const isAsciidocDocTarget = (target: string): boolean => /^[^:$]+\.(?:adoc|asciidoc)(?:#.*)?$/i.test(target);

const crossReference = (target: string, label: string): string => {
  const text = label.trim();
  if (isAsciidocDocTarget(target)) {
    const path = target.replace(/#.*$/, '');
    return `[${text || path}](${path})`;
  }
  return text || target.replace(/^#/, '');
};

const transpileSegment = (text: string, attrs: Map<string, string>): string => {
  let out = substituteAttributes(text, attrs);

  out = out.replace(/\s*\[\[\[?[\w:.-]+(?:,[^\]]*)?\]\]\]?|anchor:[\w:.-]+\[[^\]]*\]/g, '');
  out = out.replace(/\+\+\+(.*?)\+\+\+/g, '$1');
  out = out.replace(/pass:[a-z,]*\[([^\]]*)\]/g, '$1');

  out = out.replace(/image:([^:\s[][^[\s]*)\[([^\]]*)\]/g, (_, path: string, attrList: string) =>
    `![${attrList.split(',')[0].trim()}](${path})`,
  );
  const linkText = (label: string): string => label.split(',')[0].trim().replace(/\^$/, '');
  out = out.replace(/link:([^\s[]+)\[([^\]]*)\]/g, (_, url: string, label: string) => `[${linkText(label) || url}](${url})`);
  out = out.replace(/(https?:\/\/[^\s[\]]+)\[([^\]]*)\]/g, (_, url: string, label: string) => {
    const text = linkText(label);
    return text ? `[${text}](${url})` : url;
  });
  out = out.replace(/xref:([^\s[]+)\[([^\]]*)\]/g, (_, target: string, label: string) => crossReference(target, label));
  out = out.replace(/<<([^,<>\n]+)(?:,\s*([^<>\n]+))?>>/g, (_, target: string, label?: string) => crossReference(target.trim(), label ?? ''));
  out = out.replace(/footnote:[\w-]*\[([^\]]*)\]/g, (_, note: string) => (note ? ` (${note})` : ''));
  out = out.replace(/ \+$/gm, '');

  out = out.replace(/(^|[^\w*])\*([^\s*](?:[^*]*[^\s*])?)\*(?![\w*])/g, '$1**$2**');
  return out;
};

export const transpileInline = (text: string, attrs: Map<string, string> = new Map()): string => {
  if (!text) return text;
  return text
    .split('`')
    .map((segment, idx) => (idx % 2 === 0 ? transpileSegment(segment, attrs) : segment.replace(/^\+(.+)\+$/, '$1')))
    .join('`');
};

const parseAttributeList = (body: string): { positional: string[]; named: Map<string, string> } => {
  const positional: string[] = [];
  const named = new Map<string, string>();
  const parts: string[] = body.match(/(?:[^,"']|"[^"]*"|'[^']*')+/g) ?? [];
  if (body.trimStart().startsWith(',')) parts.unshift('');
  for (const raw of parts) {
    const part = raw.trim();
    const eq = part.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (eq) named.set(eq[1].toLowerCase(), eq[2].replace(/^(["'])(.*)\1$/, '$2'));
    else positional.push(part.replace(/^(["'])(.*)\1$/, '$2'));
  }
  return { positional, named };
};

const columnCountFromSpec = (cols: string): number | null => {
  if (/^\d+$/.test(cols.trim())) return Number(cols.trim()) || null;
  const items = cols.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return null;
  return items.reduce((sum, item) => sum + Number(item.match(/^(\d+)\*/)?.[1] ?? 1), 0);
};

interface TableCell {
  text: string;
  colspan: number;
}

const CELL_SPEC = String.raw`(?:(\d+)\*)?(?:(\d+)(?:\.\d+)?\+|\.\d+\+)?(?:[<^>])?(?:\.[<^>])?[adehlmsv]?$`;
const LEADING_SPEC_RE = new RegExp(`^(\\s*)${CELL_SPEC}`);
const CELL_END_SPEC_RE = new RegExp(`(\\s)${CELL_SPEC}`);
const MAX_CELL_REPEAT = 100;

const tableLineCells = (line: string): { leading: string; cells: TableCell[] } => {
  const parts = line.split(/(?<!\\)\|/);
  const cells: TableCell[] = [];
  let leading = parts[0];
  let pendingSpec = { dup: 1, colspan: 1 };
  const takeSpec = (segment: string, re: RegExp): string => {
    const spec = segment.match(re);
    if (!spec || spec[0].trim() === '') {
      pendingSpec = { dup: 1, colspan: 1 };
      return segment;
    }
    pendingSpec = { dup: Math.min(Number(spec[2] ?? 1), MAX_CELL_REPEAT), colspan: Math.min(Number(spec[3] ?? 1), MAX_CELL_REPEAT) };
    return segment.slice(0, segment.length - spec[0].length + spec[1].length);
  };
  if (parts.length > 1) leading = takeSpec(parts[0], LEADING_SPEC_RE);
  for (let i = 1; i < parts.length; i++) {
    const { dup, colspan } = pendingSpec;
    const text = (i < parts.length - 1 ? takeSpec(parts[i], CELL_END_SPEC_RE) : parts[i]).trim().replace(/\\\|/g, '|');
    for (let d = 0; d < dup; d++) cells.push({ text, colspan });
  }
  return { leading: leading.trim(), cells };
};

const asciidocTableToPipeMarkdown = (bodyLines: string[], meta: PendingMeta | null, attrs: Map<string, string>): string => {
  const cells: TableCell[] = [];
  let firstLineCells = 0;
  let firstLineIndex = -1;
  bodyLines.forEach((line, index) => {
    if (line.trim() === '') return;
    const { leading, cells: lineCells } = tableLineCells(line);
    if (leading && cells.length > 0) cells[cells.length - 1].text += ` ${leading}`;
    else if (leading) cells.push({ text: leading, colspan: 1 });
    if (firstLineIndex === -1 && lineCells.length > 0) {
      firstLineIndex = index;
      firstLineCells = lineCells.reduce((n, c) => n + c.colspan, 0);
    }
    for (const cell of lineCells) cells.push(cell);
  });
  if (cells.length === 0) return '';

  const columnCount = Math.max(1, (meta?.cols ? columnCountFromSpec(meta.cols) : null) ?? firstLineCells);
  const rows: string[][] = [];
  let row: string[] = [];
  for (const cell of cells) {
    row.push(cell.text);
    for (let s = 1; s < cell.colspan; s++) row.push('');
    if (row.length >= columnCount) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);

  const options = meta?.options ?? new Set<string>();
  const implicitHeader = firstLineIndex !== -1 && bodyLines[firstLineIndex + 1]?.trim() === '' && firstLineCells === columnCount;
  const hasHeader = !options.has('noheader') && (options.has('header') || implicitHeader);

  const format = (cellsInRow: string[]): string => {
    const padded = [...cellsInRow];
    while (padded.length < columnCount) padded.push('');
    return `| ${padded.map((c) => transpileInline(c, attrs).replace(/\|/g, '\\|')).join(' | ')} |`;
  };
  const header = hasHeader ? rows.shift()! : [];
  return [format(header), `|${' --- |'.repeat(columnCount)}`, ...rows.map(format)].join('\n');
};

export const parseAsciidocToBlocks = (source: string): Block[] => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const attrs = new Map<string, string>();
  let currentId = 0;

  let buffer: string[] = [];
  let bufferStartLine = 1;
  let bufferEndLine = 1;
  let pendingMeta: PendingMeta | null = null;
  let headerLinesLeft = 0;
  let listContinuation = false;
  let listItemOpen = false;
  let orderedCount: number[] = [];

  const meta = (line: number): PendingMeta => (pendingMeta ??= { startLine: line, options: new Set() });
  const takeMeta = (): PendingMeta | null => {
    const m = pendingMeta;
    pendingMeta = null;
    return m;
  };

  const push = (block: Omit<Block, 'id' | 'order'>) => {
    if (block.type !== 'list-item' && !listContinuation) orderedCount = [];
    listContinuation = false;
    listItemOpen = false;
    blocks.push({ ...block, id: `block-${currentId++}`, order: currentId });
  };

  const pushSpan = (block: Omit<Block, 'id' | 'order' | 'startLine' | 'sourceLineCount'>, startLine: number, endLine: number) =>
    push({ ...block, startLine, sourceLineCount: endLine - startLine + 1 });

  const flush = () => {
    if (buffer.length === 0) return;
    const m = takeMeta();
    const startLine = m?.startLine ?? bufferStartLine;
    const endLine = bufferEndLine;
    const literal = /^\s/.test(buffer[0]);
    const raw = buffer.join('\n');
    buffer = [];

    if (m?.style === 'source' || m?.style === 'listing' || m?.style === 'literal' || literal) {
      const indent = Math.min(...raw.split('\n').filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
      const content = raw.split('\n').map((l) => l.slice(indent)).join('\n');
      pushSpan({ type: 'code', content, language: m?.language }, startLine, endLine);
      return;
    }

    const content = transpileInline(raw.trim(), attrs);
    const last = blocks[blocks.length - 1];
    if (listContinuation && last?.type === 'list-item') {
      last.content += `\n\n${content}`;
      last.sourceLineCount = endLine - last.startLine + 1;
      listContinuation = false;
      return;
    }
    if (m?.admonition) {
      pushSpan({ type: 'blockquote', content, alertKind: m.admonition }, startLine, endLine);
      return;
    }
    if (m?.style === 'quote' || m?.style === 'verse') {
      pushSpan({ type: 'blockquote', content: m.attribution ? `${content}\n— ${m.attribution}` : content }, startLine, endLine);
      return;
    }
    pushSpan({ type: 'paragraph', content }, startLine, endLine);
  };

  const collectDelimited = (startIdx: number, delimiter: string): [string[], number] => {
    const body: string[] = [];
    for (let j = startIdx + 1; j < lines.length; j++) {
      if (lines[j].trim() === delimiter) return [body, j];
      body.push(lines[j]);
    }
    return [body, lines.length - 1];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    if (headerLinesLeft > 0) {
      if (/^[^:/=[.*|<'+-]/.test(trimmed) && !/^[a-z][\w-]*::/.test(trimmed)) {
        headerLinesLeft--;
        continue;
      }
      headerLinesLeft = 0;
    }

    if (/^\/{4,}$/.test(trimmed)) {
      flush();
      i = collectDelimited(i, trimmed)[1];
      continue;
    }
    if (line.startsWith('//')) continue;

    const attrEntry = trimmed.match(/^:(!?)([a-zA-Z0-9_][a-zA-Z0-9_-]*)(!?):(?:\s+(.*))?$/);
    if (attrEntry && buffer.length === 0) {
      const [, unsetBefore, name, unsetAfter, value] = attrEntry;
      if (unsetBefore || unsetAfter) attrs.delete(name);
      else attrs.set(name, substituteAttributes((value ?? '').trim(), attrs));
      continue;
    }

    const heading = line.match(/^(={1,6})\s+(\S.*)$/);
    if (heading) {
      flush();
      const m = takeMeta();
      const level = heading[1].length;
      pushSpan({ type: 'heading', content: transpileInline(heading[2].trim(), attrs), level }, m?.startLine ?? lineNum, lineNum);
      if (level === 1 && blocks.length === 1) headerLinesLeft = 2;
      continue;
    }

    if (/^'{3,}$/.test(trimmed) || trimmed === '<<<') {
      flush();
      takeMeta();
      push({ type: 'hr', content: '', startLine: lineNum });
      continue;
    }

    const fence = trimmed.match(/^```\s*([\w+-]*)/);
    if (/^(-{4,}|\.{4,}|\+{4,})$/.test(trimmed) || fence) {
      flush();
      const m = takeMeta();
      const [body, closeIdx] = collectDelimited(i, fence ? '```' : trimmed);
      const language = (fence?.[1] || undefined) ?? m?.language ?? (m?.style === 'source' ? attrs.get('source-language') : undefined);
      pushSpan({ type: 'code', content: body.join('\n'), language }, m?.startLine ?? lineNum, closeIdx + 1);
      i = closeIdx;
      continue;
    }

    if (/^={4,}$/.test(trimmed)) {
      flush();
      if (pendingMeta?.admonition) {
        const m = takeMeta()!;
        const [body, closeIdx] = collectDelimited(i, trimmed);
        pushSpan({ type: 'blockquote', content: transpileInline(body.join('\n').trim(), attrs), alertKind: m.admonition }, m.startLine, closeIdx + 1);
        i = closeIdx;
      }
      continue;
    }

    if (/^\*{4,}$/.test(trimmed) || trimmed === '--') {
      flush();
      continue;
    }

    if (/^_{4,}$/.test(trimmed)) {
      flush();
      const m = takeMeta();
      const [body, closeIdx] = collectDelimited(i, trimmed);
      let content = transpileInline(body.join('\n').trim(), attrs);
      if (m?.attribution) content += `\n— ${m.attribution}`;
      pushSpan({ type: 'blockquote', content }, m?.startLine ?? lineNum, closeIdx + 1);
      i = closeIdx;
      continue;
    }

    if (/^\|={3,}$/.test(trimmed)) {
      flush();
      const m = takeMeta();
      const [body, closeIdx] = collectDelimited(i, trimmed);
      const content = asciidocTableToPipeMarkdown(body, m, attrs);
      if (content) pushSpan({ type: 'table', content }, m?.startLine ?? lineNum, closeIdx + 1);
      i = closeIdx;
      continue;
    }

    if (/^\[\[[^\]]+\]\]$/.test(trimmed) && buffer.length === 0) {
      meta(lineNum);
      continue;
    }
    const attrLine = trimmed.match(/^\[([^[\]].*)\]$/);
    if (attrLine && buffer.length === 0) {
      const { positional, named } = parseAttributeList(attrLine[1]);
      const m = meta(lineNum);
      const [first = '', ...rest] = positional;
      const style = first.split(/[#.%]/)[0];
      for (const option of first.match(/%[\w-]+/g) ?? []) m.options.add(option.slice(1).toLowerCase());
      for (const option of (named.get('options') ?? named.get('opts') ?? '').split(',')) {
        if (option.trim()) m.options.add(option.trim().toLowerCase());
      }
      if (named.has('cols')) m.cols = named.get('cols');
      if (ADMONITION_KINDS.has(style.toLowerCase()) && style === style.toUpperCase()) {
        m.admonition = style.toLowerCase() as AlertKind;
      } else if (style || (first === '' && rest.length > 0)) {
        m.style = style ? style.toLowerCase() : 'source';
        if (m.style === 'source') m.language = rest[0] || named.get('language') || undefined;
        if (m.style === 'quote' || m.style === 'verse') m.attribution = rest.filter(Boolean).join(', ') || undefined;
      }
      continue;
    }

    const admonition = trimmed.match(/^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+(.*)$/);
    if (admonition && buffer.length === 0) {
      const m = takeMeta();
      const startLine = m?.startLine ?? lineNum;
      const body = [admonition[2]];
      while (i + 1 < lines.length && lines[i + 1].trim() !== '') body.push(lines[++i].trim());
      pushSpan({ type: 'blockquote', content: transpileInline(body.join('\n'), attrs), alertKind: admonition[1].toLowerCase() as AlertKind }, startLine, i + 1);
      continue;
    }

    const blockImage = trimmed.match(/^image::([^[\s]+)\[([^\]]*)\]$/);
    if (blockImage) {
      flush();
      const m = takeMeta();
      pushSpan({ type: 'paragraph', content: `![${blockImage[2].split(',')[0].trim()}](${blockImage[1]})` }, m?.startLine ?? lineNum, lineNum);
      continue;
    }

    if (/^[a-z][\w-]*::\S*\[.*\]$/.test(trimmed)) {
      flush();
      const m = takeMeta();
      pushSpan({ type: 'paragraph', content: trimmed.includes('`') ? trimmed : `\`${trimmed}\`` }, m?.startLine ?? lineNum, lineNum);
      continue;
    }

    const unordered = line.match(/^\s*(\*{1,5}|-)\s+(.*\S)\s*$/);
    const ordered = line.match(/^\s*(\.{1,5}|\d+\.)\s+(.*\S)\s*$/);
    const item = unordered ?? ordered;
    if (item) {
      flush();
      takeMeta();
      const marker = item[1];
      let content = item[2];
      let checked: boolean | undefined;
      const checkbox = unordered ? content.match(/^\[([ xX*])\]\s+/) : null;
      if (checkbox) {
        checked = checkbox[1] !== ' ';
        content = content.slice(checkbox[0].length);
      }
      const numbered = /^\d/.test(marker);
      const level = marker === '-' || numbered ? 0 : marker.length - 1;
      orderedCount.length = level + 1;
      let orderedStart: number | undefined;
      if (ordered) {
        orderedCount[level] = numbered ? Number.parseInt(marker, 10) : (orderedCount[level] ?? 0) + 1;
        if (numbered || (blocks[blocks.length - 1]?.type !== 'list-item' && orderedCount[level] > 1)) orderedStart = orderedCount[level];
      } else {
        orderedCount[level] = 0;
      }
      push({
        type: 'list-item',
        content: transpileInline(content, attrs),
        level,
        ordered: ordered ? true : undefined,
        orderedStart,
        checked,
        startLine: lineNum,
      });
      listItemOpen = true;
      continue;
    }

    if (trimmed === '+' && buffer.length === 0 && blocks[blocks.length - 1]?.type === 'list-item') {
      listContinuation = true;
      listItemOpen = false;
      continue;
    }

    const term = trimmed.match(/^(\S.*?)(?::{2,4}|;;)(?:\s+(.*))?$/);
    if (term && buffer.length === 0) {
      takeMeta();
      const startLine = lineNum;
      const definition = term[2] ? [term[2]] : [];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() !== '' &&
        !/^(\S.*?)(?::{2,4}|;;)(?:\s|$)/.test(lines[i + 1].trim()) &&
        !DEFINITION_STOP_RE.test(lines[i + 1].trim())
      ) {
        definition.push(lines[++i].trim());
      }
      const text = transpileInline(definition.join('\n'), attrs);
      pushSpan({ type: 'list-item', content: `**${transpileInline(term[1], attrs)}**${text ? ` — ${text}` : ''}`, level: 0 }, startLine, i + 1);
      continue;
    }

    const title = trimmed.match(/^\.([^\s.].*)$/);
    if (title && buffer.length === 0) {
      if (pendingMeta) pendingMeta.startLine = lineNum + 1;
      const attached = listContinuation;
      push({ type: 'paragraph', content: `**${transpileInline(title[1].trim(), attrs)}**`, startLine: lineNum });
      listContinuation = attached;
      continue;
    }

    if (trimmed === '') {
      flush();
      listItemOpen = false;
      continue;
    }

    const last = blocks[blocks.length - 1];
    if (listItemOpen && buffer.length === 0 && last?.type === 'list-item') {
      last.content += `\n${transpileInline(trimmed, attrs)}`;
      last.sourceLineCount = lineNum - last.startLine + 1;
      continue;
    }

    if (buffer.length === 0) bufferStartLine = lineNum;
    bufferEndLine = lineNum;
    buffer.push(line);
  }

  flush();
  return blocks;
};
