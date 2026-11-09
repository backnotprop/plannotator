/**
 * The Inbox window's stylesheet keys on page marks, not on `:has()` anchored on the page.
 *
 * Chromium has to look again at a `:has()` whose subject is `html`, `body`, `:root` or `.pn-inbox` whenever
 * anything under that element changes, and every part of a thread is under all four. On a long thread (hundreds of
 * highlighted code fences, about 440,000 elements) the 23 such rules in the window's sheets made every DOM change
 * cost about 40 ms of style work: a fence highlighted, a message arriving, a fold, an embed loading. With them
 * keyed on attributes it is under 1 ms.
 *
 * The sheets keep their `:has()` rules (they say what each look means, and other apps load them as written). This
 * plugin, in the window's build only, rewrites each one in place to the attribute its part holds while it is in the
 * page (`PAGE_MARKS`; the holders are packages/inbox/pageMarks.ts and ui's `pageMarks` option), with the same
 * specificity and in the same place in the cascade, and drops the rules keyed on what only the plan review and code
 * review apps draw (`NEVER_IN_THE_INBOX`). A mark here that no sheet uses any more fails the build, so a sheet that
 * changes its `:has()` cannot quietly bring the cost back; tests/inbox-page-marks.test.ts runs this over the real
 * sheets and fails on any `:has()` left on the page.
 */
import type { Plugin } from 'vite';

export interface PageMark {
  /** The selector part as the sheet writes it. */
  has: string;
  /** What the window's sheet says instead. Each attribute weighs what a class weighs, as `:has()` weighs its argument. */
  mark: string;
}

export const PAGE_MARKS: readonly PageMark[] = [
  // inbox.css. Holders: packages/inbox/pageMarks.ts.
  { has: 'html:has(.pn-inbox)', mark: 'html[data-pn-inbox]' },
  { has: 'body:has(.pn-inbox)', mark: 'body[data-pn-inbox]' },
  { has: ':root[data-ib-keyboard-pin]:has(.pn-inbox)', mark: ':root[data-ib-keyboard-pin][data-pn-inbox]' },
  { has: '.pn-inbox:has(.ib-dm-pill)', mark: '.pn-inbox[data-ib-dm-pill]' },
  { has: '.pn-inbox:has(.ib-imgcompose)', mark: '.pn-inbox[data-ib-imgcompose]' },
  { has: '.pn-inbox:has(.ib-fcomp)', mark: '.pn-inbox[data-ib-fcomp]' },
  { has: '.pn-inbox:has(.ib-rpick)', mark: '.pn-inbox[data-ib-rpick]' },
  // The argument weighs two classes: the mark twice.
  { has: 'body:has([data-shape-layer] .shp-dock)', mark: 'body[data-ib-shape-dock][data-ib-shape-dock]' },
  { has: 'body:has([data-shape-layer] .shp-pill)', mark: 'body[data-ib-shape-pill][data-ib-shape-pill]' },
  // ui's theme.css and review-editor's comments.css. Holders: ui's `pageMarks` option (utils/pageMarks.ts).
  { has: 'body:has([data-popout=true])', mark: 'body[data-pn-popout]' },
  { has: 'html:has([data-selection-chooser])', mark: 'html[data-pn-selection-chooser]' },
];

/**
 * Attributes only Plannotator's plan review and code review apps draw (packages/editor/App.tsx,
 * packages/review-editor/App.tsx), never the Inbox: theme.css's `html:has([…])` / `body:has([…])` rules on them
 * can never match in the window, so they go.
 */
export const NEVER_IN_THE_INBOX: readonly string[] = ['data-pn-browser-canvas', 'data-pn-document-scroll', 'data-pn-compact-touch-layout'];

/** `[a="b"]` and `[a='b']` read `[a=b]` when b is a name (the same selector), and runs of space one space. */
export function normalizeSelector(selector: string): string {
  return selector
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/=\s*(["'])(-?[A-Za-z_][\w-]*)\1\s*\]/g, '=$2]');
}

/** Split on `sep` outside (), [], strings and escapes. */
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
  /** How often each `PAGE_MARKS` entry was applied, by its `has`. */
  used: Map<string, number>;
  /** The selectors dropped (`NEVER_IN_THE_INBOX`), normalized. */
  dropped: string[];
}

/** A style rule's selector list rewritten, or null when every selector goes. Unchanged text is returned as is. */
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
      // A whole compound only: `.pn-inbox:has(.ib-fcomp)` is not the start of `.pn-inbox:has(.ib-fcomp-x)`.
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

/** At-rules whose block holds rules (rewritten); any other at-rule's block is copied as it is. */
const GROUPS = /^@(media|supports|layer|container|scope|starting-style|document)\b/i;

/**
 * `css` with the window's page marks. Comments, strings and every block's declarations are copied as they are; only
 * style rules' selector lists change.
 */
export function rewriteInboxCss(css: string): RewriteResult {
  const used = new Map<string, number>();
  const dropped: string[] = [];
  let i = 0;

  /** Index just past the `}` that closes the block opened at `open`, skipping strings and comments. */
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

  /** Rules from `i` up to the `}` that closes the group (or the end); returns them rewritten. */
  const statements = (inGroup: boolean): string => {
    let out = '';
    let prelude = '';
    while (i < css.length) {
      const char = css[i]!;
      if (char === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2);
        const stop = end < 0 ? css.length : end + 2;
        // Between rules a comment goes out as it is; inside a prelude it stays in it.
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
            i++; // the group's }
            // A group every rule of which was dropped goes with them; one that was empty (`@layer x {}` orders the
            // layers) stays.
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

/** The Vite plugin: the window's CSS with its page marks. A `PAGE_MARKS` entry no sheet used fails the build. */
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
