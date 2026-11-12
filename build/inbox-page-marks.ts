import type { Plugin } from 'vite';

export interface PageMark {
  has: string;
  mark: string;
}

export const PAGE_MARKS: readonly PageMark[] = [
  { has: 'html:has(.pn-inbox)', mark: 'html[data-pn-inbox]' },
  { has: 'body:has(.pn-inbox)', mark: 'body[data-pn-inbox]' },
  { has: ':root[data-ib-keyboard-pin]:has(.pn-inbox)', mark: ':root[data-ib-keyboard-pin][data-pn-inbox]' },
  { has: '.pn-inbox:has(.ib-dm-pill)', mark: '.pn-inbox[data-ib-dm-pill]' },
  { has: '.pn-inbox:has(.ib-imgcompose)', mark: '.pn-inbox[data-ib-imgcompose]' },
  { has: '.pn-inbox:has(.ib-fcomp)', mark: '.pn-inbox[data-ib-fcomp]' },
  { has: '.pn-inbox:has(.ib-rpick)', mark: '.pn-inbox[data-ib-rpick]' },
  { has: 'body:has([data-shape-layer] .shp-dock)', mark: 'body[data-ib-shape-dock][data-ib-shape-dock]' },
  { has: 'body:has([data-shape-layer] .shp-pill)', mark: 'body[data-ib-shape-pill][data-ib-shape-pill]' },
  { has: 'body:has([data-popout=true])', mark: 'body[data-pn-popout]' },
  { has: 'html:has([data-selection-chooser])', mark: 'html[data-pn-selection-chooser]' },
];

export const NEVER_IN_THE_INBOX: readonly string[] = ['data-pn-browser-canvas', 'data-pn-document-scroll', 'data-pn-compact-touch-layout'];

export function normalizeSelector(selector: string): string {
  return selector
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/=\s*(["'])(-?[A-Za-z_][\w-]*)\1\s*\]/g, '=$2]');
}

function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\\') {
      current += char + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

export interface RewriteResult {
  css: string;
  used: Map<string, number>;
  dropped: string[];
}

function rewriteSelectors(prelude: string, used: Map<string, number>, dropped: string[]): string | null {
  if (!prelude.includes(':has(')) return prelude;
  let changed = false;
  const kept: string[] = [];
  for (const raw of splitTop(prelude, ',')) {
    if (!raw.includes(':has(')) {
      kept.push(raw);
      continue;
    }
    let selector = normalizeSelector(raw);
    if (NEVER_IN_THE_INBOX.some((name) => selector.includes(`:has([${name}`))) {
      dropped.push(selector);
      changed = true;
      continue;
    }
    for (const { has, mark } of PAGE_MARKS) {
      const at = selector.indexOf(has);
      if (at < 0 || /[\w-]/.test(selector[at - 1] ?? '')) continue;
      selector = selector.slice(0, at) + mark + selector.slice(at + has.length);
      used.set(has, (used.get(has) ?? 0) + 1);
      changed = true;
    }
    kept.push(selector);
  }
  if (!changed) return prelude;
  return kept.length === 0 ? null : kept.map((s) => s.trim()).join(', ');
}

const GROUPS = /^@(media|supports|layer|container|scope|starting-style|document)\b/i;

export function rewriteInboxCss(css: string): RewriteResult {
  const used = new Map<string, number>();
  const dropped: string[] = [];
  let i = 0;

  const blockEnd = (open: number): number => {
    let depth = 0;
    for (let j = open; j < css.length; j++) {
      const char = css[j]!;
      if (char === '\\') j++;
      else if (char === '/' && css[j + 1] === '*') j = css.indexOf('*/', j + 2) + 1 || css.length;
      else if (char === '"' || char === "'") {
        for (j++; j < css.length && css[j] !== char; j++) if (css[j] === '\\') j++;
      } else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return j + 1;
    }
    throw new Error('inbox-page-marks: a block is not closed');
  };

  const statements = (inGroup: boolean): string => {
    let out = '';
    let prelude = '';
    while (i < css.length) {
      const char = css[i]!;
      if (char === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2);
        const stop = end < 0 ? css.length : end + 2;
        if (prelude.trim()) prelude += css.slice(i, stop);
        else {
          out += prelude + css.slice(i, stop);
          prelude = '';
        }
        i = stop;
        continue;
      }
      if (char === '"' || char === "'") {
        let j = i + 1;
        for (; j < css.length && css[j] !== char; j++) if (css[j] === '\\') j++;
        prelude += css.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (char === '\\') {
        prelude += css.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (char === ';') {
        out += prelude + char;
        prelude = '';
        i++;
        continue;
      }
      if (char === '}') {
        if (!inGroup) throw new Error('inbox-page-marks: a stray }');
        out += prelude;
        return out;
      }
      if (char === '{') {
        const head = prelude.trimStart();
        if (head.startsWith('@')) {
          if (GROUPS.test(head)) {
            const start = ++i;
            const inner = statements(true);
            const was = css.slice(start, i);
            i++;
            const empty = (text: string) => !text.replace(/\/\*[\s\S]*?\*\//g, '').trim();
            if (!empty(inner) || empty(was)) out += `${prelude}{${inner}}`;
          } else {
            const end = blockEnd(i);
            out += prelude + css.slice(i, end);
            i = end;
          }
        } else {
          const end = blockEnd(i);
          const lead = prelude.slice(0, prelude.length - prelude.trimStart().length);
          const selectors = rewriteSelectors(prelude.trimStart(), used, dropped);
          if (selectors !== null) out += lead + (selectors === prelude.trimStart() ? selectors : `${selectors} `) + css.slice(i, end);
          i = end;
        }
        prelude = '';
        continue;
      }
      prelude += char;
      i++;
    }
    if (inGroup) throw new Error('inbox-page-marks: a group is not closed');
    return out + prelude;
  };

  return { css: statements(false), used, dropped };
}

export function inboxPageMarks(): Plugin {
  const used = new Map<string, number>();
  let building = false;
  return {
    name: 'plannotator:inbox-page-marks',
    configResolved(config) {
      building = config.command === 'build';
    },
    transform(code, id) {
      if (!/\.css(?:$|\?)/.test(id) || !code.includes(':has(')) return null;
      const result = rewriteInboxCss(code);
      for (const [has, n] of result.used) used.set(has, (used.get(has) ?? 0) + n);
      return result.css === code ? null : { code: result.css, map: null };
    },
    buildEnd(error) {
      if (!building || error) return;
      const unused = PAGE_MARKS.filter(({ has }) => !used.has(has)).map(({ has }) => has);
      if (unused.length) {
        this.error(
          `inbox-page-marks: no sheet has ${unused.join(', ')} any more. A sheet changed its :has(): give the new one a page mark (build/inbox-page-marks.ts, packages/inbox/pageMarks.ts) or take the entry out.`,
        );
      }
    },
  };
}
