/**
 * What an Artifacts wall tile says about its file, as plain functions (WallFace.tsx draws them): the type under its
 * name, a Markdown file's first blocks, a CSV's first rows and a PDF's page count.
 */

import { readInboxAttachmentKind } from '@plannotator/core/inbox-types';
import type { InboxArtifactRow } from '@plannotator/core/inbox-artifact-pins';
import { plural } from './format';

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  cs: 'C#', php: 'PHP', sql: 'SQL', sh: 'Shell', bash: 'Shell', zsh: 'Shell', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', css: 'CSS',
  scss: 'SCSS', html: 'HTML', xml: 'XML', vue: 'Vue', svelte: 'Svelte', lua: 'Lua', dart: 'Dart', ex: 'Elixir', exs: 'Elixir', scala: 'Scala',
};

export function extOf(name: string): string {
  return /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? '';
}

export function isTable(name: string): boolean {
  const ext = extOf(name);
  return ext === 'csv' || ext === 'tsv';
}

/** The type under a tile's name: "PNG image", "Markdown", "TypeScript", "CSV table", "PDF · 3 pages", "TGZ file". */
export function wallTypeLabel(row: Pick<InboxArtifactRow, 'attachment'>, pages: number | null = null): string {
  const attachment = row.attachment;
  if (!attachment) return 'Guided review';
  const kind = readInboxAttachmentKind(attachment.kind);
  const ext = extOf(attachment.name);
  const upper = ext ? ext.toUpperCase() : '';
  switch (kind) {
    case 'image':
      return upper ? `${upper} image` : 'Image';
    case 'video':
      return upper ? `${upper} video` : 'Video';
    case 'audio':
      return upper ? `${upper} audio` : 'Audio';
    case 'html':
      return 'HTML page';
    case 'markdown':
      return 'Markdown';
    case 'mermaid':
      return 'Mermaid diagram';
    case 'graphviz':
      return 'Graphviz diagram';
    case 'pdf':
      return pages ? `PDF · ${plural(pages, 'page')}` : 'PDF';
    case 'code':
      return LANGUAGES[ext] ?? (upper || 'Code');
    case 'text':
      return isTable(attachment.name) ? `${upper} table` : 'Text';
    default:
      return upper ? `${upper} file` : 'File';
  }
}

/** A PDF's page count from its bytes (`/Type /Pages … /Count N`, else the `/Type /Page` objects), or null. */
export function pdfPageCount(bytes: string): number | null {
  let most = 0;
  for (const match of bytes.matchAll(/\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)/g)) most = Math.max(most, Number(match[1]));
  if (most > 0) return most;
  const pages = bytes.match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
  return pages > 0 ? pages : null;
}

/** Inline Markdown words without their marks: `**bold**`, `code`, [label](url), images gone. */
function plainInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export type Block = { kind: 'h1' | 'h2' | 'p' | 'li'; text: string };

/** The first blocks of a Markdown (or plain text) file: headings, paragraphs and list items; fences and tables skipped. */
export function documentBlocks(text: string, markdown: boolean, max = 12): Block[] {
  const blocks: Block[] = [];
  let fence = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (blocks.length >= max) break;
    const line = raw.trimEnd();
    if (markdown && /^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || line.trim() === '') continue;
    if (!markdown) {
      blocks.push({ kind: 'p', text: line });
      continue;
    }
    if (/^\s*\|/.test(line) || /^\s*[-*_]{3,}\s*$/.test(line) || /^\s*<\/?[a-z]/i.test(line)) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: heading[1]!.length === 1 && blocks.length === 0 ? 'h1' : 'h2', text: plainInline(heading[2]!) });
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      blocks.push({ kind: 'li', text: plainInline(item[1]!.replace(/^\[[ xX]\]\s*/, '')) });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    blocks.push({ kind: 'p', text: plainInline(quote ? quote[1]! : line) });
  }
  return blocks;
}

/** The first rows of a CSV or TSV: up to 6 rows of 4 cells (quoted cells kept whole). */
export function tableRows(text: string, tab: boolean, rows = 6, cols = 4): string[][] {
  const out: string[][] = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (out.length >= rows) break;
    if (line.trim() === '') continue;
    const cells: string[] = [];
    if (tab) cells.push(...line.split('\t'));
    else {
      let cell = '';
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') {
            cell += '"';
            i += 1;
          } else if (ch === '"') quoted = false;
          else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          cells.push(cell);
          cell = '';
        } else cell += ch;
      }
      cells.push(cell);
    }
    out.push(cells.slice(0, cols).map((c) => c.trim()));
  }
  return out;
}

