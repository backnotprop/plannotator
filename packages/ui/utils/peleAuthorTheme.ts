/**
 * An author's colours under Pele: only the colours a diagram's source spells
 * out (`themeVariables` in a `%%{init: …}%%` directive or front matter
 * `config:`, with or without `theme: base`). A theme NAME (forest, dark,
 * neutral, default, base or any other) is ignored: the diagram draws in the
 * person's Plannotator theme exactly as if no directive were there. The
 * owner's decision (2026-11-21): follow the colours an author typed, never a
 * whole foreign palette.
 *
 * Each typed colour replaces its own over the person's palette (the adapter
 * shape of `peleTheme.ts`: Mermaid's names in, `--pele-*` variables out).
 * Every value must be a colour by the strict pattern labels use
 * (`safeLabelColor`); unknown keys, `themeCSS` and `background` are ignored:
 * no panel is ever painted behind a diagram.
 *
 * Readability (`PELE_TEXT_MIN` 4.6:1 for text, `PELE_LINE_MIN` 3.1:1 for
 * lines, the floors the person's own palette is held to):
 *   - drawn on the person's page (edge lines and arrowheads, sequence
 *     lifelines, and text outside a filled shape such as edge and message
 *     labels): an author colour that does not reach the floor against the
 *     person's page ground gives way to the person's colour for that element;
 *   - text inside a filled shape (a node, a sequence actor, a note): the
 *     author's text colour when they give one and it reaches the floor on
 *     that fill, else whichever of the person's text and ground colours reads
 *     better on it.
 * Pure: reads nothing but its arguments.
 */
import { contrastRatio, parseCssColor, toHex } from './cssColor';
import { mermaidDirectives, safeLabelColor } from './pele-labels';
import { PELE_LINE_MIN, PELE_SERIES_COUNT, PELE_TEXT_MIN, type PeleThemeVariables } from './peleTheme';

// ------------------------------------------------------------------ reading

/** Mermaid's JSON-ish directive object (single quotes, bare keys, trailing commas) as JSON; strings are set aside first, so nothing inside one is touched. */
function parseLooseObject(text: string): unknown {
  const strings: string[] = [];
  const held = holdStrings(text, strings);
  if (held === null) return null;
  const json = held
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/gu, '$1"$2":')
    .replace(/,\s*([}\]])/gu, '$1')
    .replace(/\u0000(\d+)\u0000/gu, (_m, i: string) => strings[Number(i)] ?? '""');
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/**
 * The text with each quoted string replaced by `\u0000<n>\u0000` and the string, as JSON, put in `strings`; null when a
 * quote is never closed. One pass: a pattern for this rescans to the end from every unclosed quote.
 */
function holdStrings(text: string, strings: string[]): string | null {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const quote = text[i];
    if (quote !== "'" && quote !== '"') {
      out += quote;
      continue;
    }
    let j = i + 1;
    while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1;
    if (j >= text.length) return null;
    const inner = text.slice(i + 1, j);
    strings.push(quote === "'" ? JSON.stringify(inner.replace(/\\'/gu, "'")) : `"${inner}"`);
    out += `\u0000${strings.length - 1}\u0000`;
    i = j;
  }
  return out;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `config:` map of a front matter block: nested `key: value` lines, two levels deep is all a theme needs. */
function frontMatterConfig(source: string): Record<string, unknown> | null {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i += 1;
  if ((lines[i] ?? '').trim() !== '---') return null;
  const block: string[] = [];
  for (i += 1; i < lines.length && (lines[i] ?? '').trim() !== '---'; i += 1) block.push(lines[i] ?? '');
  const root: Record<string, unknown> = {};
  const stack: { indent: number; map: Record<string, unknown> }[] = [{ indent: -1, map: root }];
  for (const full of block) {
    // A comment starts at ` #`; the value is trimmed by hand. Every pattern here has one way to match, so a long
    // run of spaces on a line costs one pass.
    const hash = full.search(/\s#/u);
    const line = hash === -1 ? full : full.slice(0, hash);
    const m = /^(\s*)([\w$-]+)\s*:(.*)$/u.exec(line);
    if (m === null) continue;
    const indent = (m[1] ?? '').length;
    while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) stack.pop();
    const parent = stack[stack.length - 1]?.map ?? root;
    const raw = (m[3] ?? '').trim();
    if (raw === '') {
      const child: Record<string, unknown> = {};
      parent[m[2] as string] = child;
      stack.push({ indent, map: child });
    } else {
      parent[m[2] as string] = /^(['"])(.*)\1$/u.exec(raw)?.[2] ?? raw;
    }
  }
  return isObject(root['config']) ? root['config'] : null;
}

/** Every `%%{init: …}%%` (or `initialize`) object of a source, in order. */
function initDirectives(source: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const directive of mermaidDirectives(source)) {
    const body = /^\s*(?:init|initialize)\s*:([\s\S]*)$/u.exec(directive.body)?.[1];
    if (body === undefined) continue;
    const parsed = parseLooseObject(body);
    if (isObject(parsed)) out.push(parsed);
  }
  return out;
}

/** The colours a source spells out (`themeVariables`), safe ones only; null when it gives none. A theme name is not read. */
export function readPeleAuthorColors(source: string): Readonly<Record<string, string>> | null {
  const configs = [frontMatterConfig(source), ...initDirectives(source)].filter(isObject);
  const colors: Record<string, string> = {};
  for (const config of configs) {
    const given = config['themeVariables'];
    if (!isObject(given)) continue;
    for (const [key, value] of Object.entries(given)) {
      const color = typeof value === 'string' ? safeLabelColor(value) : null;
      if (color !== null) colors[key] = color;
    }
  }
  return Object.keys(colors).length === 0 ? null : colors;
}

// --------------------------------------------------------------- to Pele

/** Mermaid's names for the colours Pele draws with; the first given wins. `background` is deliberately absent. */
const MAP: ReadonlyArray<readonly [`--pele-${string}`, readonly string[]]> = [
  ['--pele-fg', ['primaryTextColor', 'textColor']],
  ['--pele-muted', ['titleColor', 'tertiaryTextColor']],
  ['--pele-line', ['lineColor']],
  ['--pele-surface', ['mainBkg', 'primaryColor']],
  ['--pele-surface-alt', ['clusterBkg', 'tertiaryColor']],
  ['--pele-border', ['nodeBorder', 'primaryBorderColor']],
  ['--pele-accent', ['taskBkgColor']],
  ['--pele-critical', ['critBkgColor']],
  ...Array.from({ length: PELE_SERIES_COUNT }, (_, i) => [`--pele-series-${i + 1}`, i === 0 ? ['cScale0', 'primaryColor'] : [`cScale${i}`]] as const),
];

/** A colour as hex when it parses opaque, else as given (a name the parser does not list; it already passed the safe pattern). */
function hexOr(value: string): string {
  const parsed = parseCssColor(value);
  return parsed === undefined || parsed.a < 1 ? value : toHex(parsed);
}

/** One rule `diagram-render.ts` scopes under the svg's id. Selectors are fixed here; values are checked colours. */
export interface PeleColorRule {
  readonly selector: 'g.pele-node text' | 'g.pele-note text' | '.pele-lifelines';
  readonly property: 'fill' | 'stroke';
  readonly value: string;
}

export interface PeleAuthorColors {
  /** The person's variables with the author's typed colours over them (and any page fallback applied). */
  readonly vars: PeleThemeVariables;
  /** Per-element colours the variables alone cannot express. */
  readonly rules: readonly PeleColorRule[];
  /** What gave way to the person's colour, for tests and debugging (`'line'`, `'text'`, `'muted'`, `'lifelines'`). */
  readonly fellBack: readonly string[];
}

const reads = (ink: string | undefined, ground: string | undefined, min: number): boolean => {
  const a = parseCssColor(ink);
  const b = parseCssColor(ground);
  return a === undefined || b === undefined || contrastRatio(a, b) >= min;
};

/** Text on `fill`: the author's own text colour when it reads there, else the better of the person's text and ground colours. */
function inkOn(fill: string | undefined, authorInk: string | undefined, person: PeleThemeVariables): string | undefined {
  if (authorInk !== undefined && reads(authorInk, fill, PELE_TEXT_MIN)) return authorInk;
  const ground = parseCssColor(fill);
  const options = [person['--pele-fg'], person['--pele-bg']].filter((c): c is string => c !== undefined);
  if (ground === undefined || options.length === 0) return authorInk ?? person['--pele-fg'];
  return options.reduce((best, c) => (contrastRatio(parseCssColor(c) ?? ground, ground) > contrastRatio(parseCssColor(best) ?? ground, ground) ? c : best));
}

/**
 * Pele's colours for a source's typed colours over the person's palette, or
 * null when the source spells out none (a theme name alone is none).
 */
export function peleAuthorColors(source: string, personOrNull: PeleThemeVariables | null): PeleAuthorColors | null {
  const given = readPeleAuthorColors(source);
  if (given === null) return null;
  // With no palette on the page (a host without theme tokens), the author's colours apply with nothing to give way to.
  const person: PeleThemeVariables = personOrNull ?? {};
  const author: Record<`--pele-${string}`, string> = {};
  for (const [name, keys] of MAP) {
    const key = keys.find((k) => given[k] !== undefined);
    if (key !== undefined) author[name] = hexOr(given[key] as string);
  }
  if (Object.keys(author).length === 0) return null;
  const page = person['--pele-bg'];
  const vars: Record<`--pele-${string}`, string> = { ...person, ...author };
  const rules: PeleColorRule[] = [];
  const fellBack: string[] = [];
  // Drawn on the page: give way where the author's colour does not read on the person's ground.
  const giveWay = (name: `--pele-${string}`, min: number, label: string): void => {
    const own = person[name];
    if (author[name] !== undefined && own !== undefined && !reads(author[name], page, min)) {
      vars[name] = own;
      fellBack.push(label);
    }
  };
  giveWay('--pele-line', PELE_LINE_MIN, 'line');
  giveWay('--pele-fg', PELE_TEXT_MIN, 'text');
  giveWay('--pele-muted', PELE_TEXT_MIN, 'muted');
  // Lifelines are drawn on the page in the border colour; node outlines keep the author's.
  if (author['--pele-border'] !== undefined && person['--pele-border'] !== undefined && !reads(author['--pele-border'], page, PELE_LINE_MIN)) {
    rules.push({ selector: '.pele-lifelines', property: 'stroke', value: person['--pele-border'] });
    fellBack.push('lifelines');
  }
  // Text inside a filled shape reads on that fill.
  for (const [selector, fill] of [['g.pele-node text', '--pele-surface'], ['g.pele-note text', '--pele-surface-alt']] as const) {
    if (author[fill] === undefined && author['--pele-fg'] === undefined) continue;
    const ink = inkOn(vars[fill], author['--pele-fg'], person);
    if (ink !== undefined && ink !== vars['--pele-fg']) rules.push({ selector, property: 'fill', value: ink });
  }
  return { vars, rules, fellBack };
}
