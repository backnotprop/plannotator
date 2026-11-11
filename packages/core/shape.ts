import type { CodeGuideOutput } from './guide';
import { ulid } from './ulid';
import { checkShapeScene, shapeHtmlParts, shapeHtmlSceneSlots, shapeHtmlScenes, shapeScenePieceRefs, type ShapeScene } from './shape-scene';
export type { ShapeScene } from './shape-scene';

export const SHAPE_FORMAT_VERSION = 1;

export type ShapeViewId = 'picture' | 'how' | 'changed' | 'know' | 'code';

/** The views a board may hold. */
export const SHAPE_VIEWS: readonly { id: ShapeViewId; label: string }[] = [
  { id: 'picture', label: 'Picture' },
  { id: 'how', label: 'How it works' },
  { id: 'changed', label: "What's changed" },
  { id: 'know', label: 'What to know' },
  { id: 'code', label: 'Code' },
];

const SHAPE_HIDDEN_VIEWS: ReadonlySet<string> = new Set(['know', 'changed']);

export function shapeViewLabel(view: ShapeViewId): string {
  return SHAPE_VIEWS.find((v) => v.id === view)?.label ?? view;
}

export interface ShapeDrawnView {
  html: string;
  css?: string;
  width?: number;
  height?: number;
  tall?: { html: string; css?: string };
  /**
   * The Picture only: a fuller drawing behind the board's "Show more", when there is more
   * that must be drawn. It flows and scrolls like a page. Most boards have none.
   */
  more?: { html: string; css?: string };
  examples?: ShapeExample[];
}

/** One example, followed through How it works: a real case, read from the code (nothing is run). */
export interface ShapeExample {
  name: string;
  title: string;
  lead?: string;
  steps: ShapeExampleStep[];
}

/** Where a value going into a step came from: a line of code, an earlier step's output (1-based), or a few words. */
export type ShapeExampleSource = { path: string; line: number } | { step: number } | string;

export interface ShapeExampleInput {
  name: string;
  value: string;
  type?: string;
  reading?: string;
  from: ShapeExampleSource;
}

export type ShapeExampleResult = 'pass' | 'fail' | 'not-reached';

export interface ShapeExampleCheck {
  code: string;
  constant?: string;
  saw?: string;
  result: ShapeExampleResult;
  decides?: boolean;
  short?: string;
}

export interface ShapeExampleStep {
  part?: string;
  arrow?: string;
  tag: string;
  tagAt?: 'top' | 'bottom';
  text: string;
  detail?: string;
  inputs: ShapeExampleInput[];
  signature: string;
  checks: ShapeExampleCheck[];
  output: { name: string; value: string; type: string; note?: string };
  code: { path: string; line: number };
}

export interface ShapeRequirement {
  id: string;
  text: string;
  code?: { path: string; line: number };
}

export interface ShapeRequirementGroup {
  id: string;
  label: string;
  items: ShapeRequirement[];
}

export interface ShapeRequirements {
  heading?: string;
  groups: ShapeRequirementGroup[];
  foot?: { label: string; text: string }[];
}

/** One file a Code step plans to add or change, before the change exists. */
export interface ShapePlannedFile {
  path: string;
  kind: 'new' | 'change';
}

/** The Code view: a Guided Review (the guide format the review app's guides use). */
export interface ShapeCodeView {
  stage: 'before' | 'after';
  guide: CodeGuideOutput;
  patch?: string;
  planned?: ShapePlannedFile[][];
  source?: string;
  files?: { path: string; line?: number }[];
}

export type ShapeChangeKind = 'behaviour' | 'contract' | 'moved' | 'removed' | 'check';
export const SHAPE_CHANGE_KINDS: readonly ShapeChangeKind[] = ['behaviour', 'contract', 'moved', 'removed', 'check'];

export interface ShapeChangeItem {
  id: string;
  kind: ShapeChangeKind;
  title: string;
  was?: string | string[];
  now?: string | string[];
  from?: string;
  to?: string;
  lines?: number;
  note?: string;
  code?: string[];
  step?: number;
}

/** A step on a call path, marked as it changed. `same` is context. */
export interface ShapeFlowStep {
  call: string;
  is: 'new' | 'gone' | 'changed' | 'same';
  note?: string;
  at?: string;
}

/** Where a path ends: before and after (the same words when it did not change). */
export interface ShapeFlowEnd {
  was?: string;
  now: string;
}

/** One path through the change, read as a unified diff: it starts, steps, forks and ends. */
export interface ShapeChangeFlow {
  id: string;
  title: string;
  start: string;
  steps?: ShapeFlowStep[];
  forks?: { when: string; steps?: ShapeFlowStep[]; end?: ShapeFlowEnd }[];
  end?: ShapeFlowEnd;
}

export interface ShapeChanged {
  summary?: string;
  items: ShapeChangeItem[];
  flows?: ShapeChangeFlow[];
  also?: string;
}

export type ShapeRefKind = 'message' | 'image' | 'file' | 'pr' | 'diff' | 'link';
export const SHAPE_REF_KINDS: readonly ShapeRefKind[] = ['message', 'image', 'file', 'pr', 'diff', 'link'];

export interface ShapeRef {
  n: number;
  kind: ShapeRefKind;
  title: string;
  sub?: string;
  target: string;
  line?: number;
  images?: { src: string; alt: string; crop?: [number, number, number, number] }[];
}

/** What an agent writes: one whole board. */
export interface ShapeBoard {
  title: string;
  claim: string;
  asOf?: string;
  note?: string;
  views: {
    picture?: ShapeDrawnView;
    how?: ShapeDrawnView;
    /** Once "What's changed". Still accepted and kept; never shown or a part (approval shape-whats-changed-removed). */
    changed?: ShapeChanged;
    know?: string;
    reqs?: ShapeRequirements;
    code?: ShapeCodeView;
  };
  refs?: ShapeRef[];
  scenes?: Record<string, ShapeScene>;
  stack?: ShapeStack;
}

/** One pull request of a stack, in landing order. */
export interface ShapeStackPull {
  n: number;
  title: string;
  url?: string;
  step?: number;
}

/** A file a PR changed in a part, with its own counts. */
export interface ShapeStackFile {
  path: string;
  additions?: number;
  deletions?: number;
  lines?: [number, number][];
}

/** What one PR did to one drawn part (a `data-mark` on Picture or How it works). */
export interface ShapeStackChange {
  part: string;
  pr: number;
  said: string;
  files: ShapeStackFile[];
}

export interface ShapeStack {
  pulls: ShapeStackPull[];
  changes: ShapeStackChange[];
}

/** Where a part lives: a view, or the header (title, claim). */
export type ShapePartView = ShapeViewId | 'header';

export interface ShapePart {
  view: ShapePartView;
  id: string;
  text: string;
}

export interface ShapeSession {
  host: string;
  id: string;
}

/** One stored snapshot. */
export interface ShapeVersion extends ShapeBoard {
  n: number;
  at: string;
  base: number | null;
  through: string | null;
  by: ShapeSession | null;
  parts: ShapePart[];
}

export type ShapeState = 'active' | 'finished';

export interface ShapeProject {
  name: string;
  root: string;
  worktree?: string;
}

/** `shape.json`: the shape itself. */
export interface ShapeRecord {
  v: typeof SHAPE_FORMAT_VERSION;
  id: string;
  title: string;
  project: ShapeProject;
  session: ShapeSession | null;
  thread: string | null;
  state: ShapeState;
  created: string;
  updated: string;
  latest: number;
  drawing: { at: string; until: string } | null;
}

export type ShapeNoteKind = 'change' | 'ask' | 'answer';

/** A line of a shape's chat: the person's Change it and Ask, and the agent's answers. */
export interface ShapeNote {
  id: string;
  at: string;
  kind: ShapeNoteKind;
  v: number;
  view: ShapeViewId | null;
  part: string | null;
  quote: string | null;
  text: string;
  from: 'you' | ShapeSession;
  re: string | null;
  delivered: string | null;
  box?: ShapeNoteBox;
  code?: string[];
  picture?: string;
}

/** Where a box sits, as fractions of its drawing. `tall` and `more`: on that layout of the view. */
export interface ShapeNoteBox {
  x: number;
  y: number;
  w: number;
  h: number;
  tall?: true;
  more?: true;
}

/** A Change it that no agent has picked up: "1 change waits for the agent". */
export function shapeNoteWaits(note: ShapeNote): boolean {
  return note.kind === 'change' && note.from === 'you' && !note.delivered;
}

const SHAPE_ID_RE = /^shp_[0-9A-HJKMNP-TV-Z]{26}$/;
const NOTE_ID_RE = /^shn_[0-9A-HJKMNP-TV-Z]{26}$/;

export function shapeId(now?: number): string {
  return `shp_${ulid(now)}`;
}

export function shapeNoteId(now?: number): string {
  return `shn_${ulid(now)}`;
}

export function isShapeId(value: unknown): value is string {
  return typeof value === 'string' && SHAPE_ID_RE.test(value);
}

export function isShapeNoteId(value: unknown): value is string {
  return typeof value === 'string' && NOTE_ID_RE.test(value);
}

/** The most a board may hold. A refusal names the field and the limit. */
export const SHAPE_LIMITS = {
  scenes: 8,
  title: 140,
  claim: 400,
  note: 280,
  html: 300_000,
  css: 60_000,
  canvas: { min: 200, max: 4000 },
  know: 1200,
  knowParagraphs: 2,
  line: 400,
  sections: 20,
  patch: 3_000_000,
  files: 100,
  refs: 60,
  refN: 999,
  refText: 300,
  target: 2000,
  images: 12,
  noteText: 4000,
  quote: 600,
  /** `views.changed` (still checked, never shown): items, lines per side, call paths, steps and forks per path. */
  changes: 40,
  changeLines: 12,
  flows: 6,
  flowSteps: 40,
  forks: 12,
  examples: 6,
  exampleSteps: 12,
  exampleRows: 12,
  exampleCode: 600,
  notePicture: 6_000_000,
  stackPulls: 20,
  stackChanges: 200,
  stackFiles: 30,
  stackLines: 50,
} as const;

const PART_ID_RE = /^[A-Za-z][\w.-]{0,63}$/;

export type ShapeCheck<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const FORBIDDEN_TAGS = ['script', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'form', 'style', 'template', 'portal', 'source', 'animate', 'set', 'animatemotion', 'animatetransform', 'dialog', 'select', 'area', 'map'];
export const SHAPE_FORBIDDEN_TAGS: readonly string[] = FORBIDDEN_TAGS;

/** Attributes that lift a part into the top layer (a popover, a modal), over the app: dropped. */
export const SHAPE_TOP_LAYER_ATTRS: readonly string[] = ['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor', 'interestfor', 'interesttarget'];

/** Attributes that load something and have no safe use on a board: dropped. */
export const SHAPE_DROPPED_ATTRS: readonly string[] = ['srcset', 'imagesrcset', 'poster', 'ping', 'lowsrc', 'dynsrc', 'longdesc'];

/** Attributes that hold a URL: each must pass `shapeUrlAllowed`. */
export const SHAPE_URL_ATTRS: readonly string[] = ['src', 'href', 'xlink:href', 'action', 'formaction', 'background', 'data', 'cite', 'codebase', 'manifest', 'icon', 'usemap', 'profile', 'archive', 'classid'];

/** A URL as a URL parser reads it: the parser drops tabs and newlines anywhere, so `ht\ttps:` is `https:`. */
function urlKey(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
}

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp)[;,]/;
const BOARD_FILE_RE = /^files\/[^/\\%?#.][^/\\%?#]*$/;

/** May a drawing's URL attribute hold this value? */
export function shapeUrlAllowed(value: string, link = false): boolean {
  const key = urlKey(value);
  if (key.startsWith('#') || DATA_IMAGE_RE.test(key) || BOARD_FILE_RE.test(key)) return true;
  if (!link || !key.startsWith('https://')) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

/** A reference's URL as the board opens it: http(s) with a host, else null. */
export function shapeLinkUrl(target: string): string | null {
  if (!/^https?:\/\//.test(urlKey(target))) return null;
  try {
    const url = new URL(target.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

function codePoint(hex: string): string {
  const n = parseInt(hex, 16);
  return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
}

function stripCssComments(css: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (ch === '\\') {
      out += css.slice(i, i + 2);
      i++;
    } else if (quote) {
      out += ch;
      if (ch === quote || ch === '\n') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else out += ch;
  }
  return out;
}

function cssKey(css: string, keepComments = false): string {
  return (keepComments ? css : stripCssComments(css))
    .replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g, (_, hex?: string, _nl?: string, ch?: string) =>
      hex ? codePoint(hex) : ch ?? '',
    )
    .toLowerCase();
}

function cssUrls(key: string): string[] {
  return [...key.matchAll(/url\s*\(\s*["']?([^)"']*)/g)].map((m) => urlKey(m[1] ?? ''));
}

/**
 * What a view's CSS (or a `style` attribute) may not hold: imports, fonts, scripted CSS and
 * anything that loads from outside.
 */
export function shapeCssProblems(css: string): string[] {
  const out: string[] = [];
  const keys = [cssKey(css), cssKey(css, true)];
  const any = (test: (key: string) => boolean) => keys.some(test);
  if (any((k) => /@import/.test(k))) out.push('@import is not allowed');
  if (any((k) => /@font-face/.test(k))) out.push('@font-face is not allowed');
  if (any((k) => /image-set\s*\(/.test(k))) out.push('image-set() is not allowed; use url() with a data:image');
  if (any((k) => /(?:^|[^\w-])src\s*\(/.test(k))) out.push('src() is not allowed; use url() with a data:image');
  if (any((k) => cssUrls(k).some((u) => !u.startsWith('#') && !DATA_IMAGE_RE.test(u)))) out.push('url() may name only a #fragment or a data:image (png, jpeg, gif, webp)');
  if (any((k) => /expression\s*\(|-moz-binding|behavior\s*:/.test(k))) out.push('scripted CSS is not allowed');
  if (any((k) => /base-select|::?picker\s*\(/.test(k))) out.push('a select picker (base-select, ::picker) is not allowed');
  if (/<\/style/i.test(css)) out.push('</style> is not allowed');
  return out;
}

/**
 * A presentation attribute (`fill`, `mask`, `filter`, `clip-path`, `marker-*`…) may use `url(#id)`
 * and nothing else that loads.
 */
export function shapePaintAllowed(value: string): boolean {
  return [cssKey(value), cssKey(value, true)].every(
    (key) => !/image-set\s*\(|(?:^|[^\w-])src\s*\(/.test(key) && cssUrls(key).every((u) => u.startsWith('#')),
  );
}

const TEXT_ATTRS = new Set(['title', 'alt', 'class', 'id', 'role', 'lang', 'dir']);

/**
 * The tags in HTML as `/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g` finds them, in order:
 * each tag's name and the text between the name and its `>`.
 */
export function shapeHtmlTags(html: string): { name: string; attrs: string }[] {
  const n = html.length;
  const close = new Int32Array(n + 1);
  close[n] = -1;
  let nextDouble = -1;
  let nextSingle = -1;
  for (let i = n - 1; i >= 0; i--) {
    const c = html.charCodeAt(i);
    if (c === 62 ) close[i] = i;
    else if (c === 34 ) {
      close[i] = nextDouble < 0 ? -1 : close[nextDouble + 1]!;
      nextDouble = i;
    } else if (c === 39 ) {
      close[i] = nextSingle < 0 ? -1 : close[nextSingle + 1]!;
      nextSingle = i;
    } else close[i] = close[i + 1]!;
  }
  const tags: { name: string; attrs: string }[] = [];
  for (let lt = html.indexOf('<'); lt >= 0; ) {
    if (!/[a-zA-Z]/.test(html[lt + 1] ?? '')) {
      lt = html.indexOf('<', lt + 1);
      continue;
    }
    let end = lt + 2;
    while (end < n && /[\w:-]/.test(html[end]!)) end++;
    const gt = close[end]!;
    if (gt < 0) {
      lt = html.indexOf('<', lt + 1);
      continue;
    }
    tags.push({ name: html.slice(lt + 1, end), attrs: html.slice(end, gt) });
    lt = html.indexOf('<', gt + 1);
  }
  return tags;
}

/**
 * Whether some tag in HTML holds an event handler, as `/<[^>]*\son[a-z]+\s*=/i` finds one: from a
 * `<` up to the next `>` (or the end), with no regard for quotes.
 */
export function shapeHtmlHasEventHandler(html: string): boolean {
  for (let lt = html.indexOf('<'); lt >= 0; ) {
    const gt = html.indexOf('>', lt + 1);
    if (/\son[a-z]+\s*=/i.test(html.slice(lt + 1, gt < 0 ? html.length : gt))) return true;
    if (gt < 0) return false;
    lt = html.indexOf('<', gt + 1);
  }
  return false;
}

const ATTR_RE = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/**
 * What a drawn view's HTML may not hold: scripts, event handlers, and anything that loads from
 * outside the board.
 */
export function shapeHtmlProblems(html: string): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  const lower = html.toLowerCase();
  for (const tag of FORBIDDEN_TAGS) {
    if (new RegExp(`<${tag}[\\s>/]`).test(lower)) {
      add(
        tag === 'style'
          ? '<style> is not allowed here; put rules in the view\'s css'
          : tag === 'dialog' || tag === 'select'
            ? `<${tag}> is not allowed (it opens over the whole app); draw it`
            : `<${tag}> is not allowed`,
      );
    }
  }
  if (shapeHtmlHasEventHandler(html)) add('event handler attributes (on…=) are not allowed');
  if (/javascript\s*:/i.test(html)) add('javascript: URLs are not allowed');
  for (const t of shapeHtmlTags(html)) {
    const tag = t.name.toLowerCase();
    const attrs = [...t.attrs.matchAll(ATTR_RE)].map((a) => ({ name: a[1]!.toLowerCase(), raw: a[2] ?? a[3] ?? a[4] ?? '' }));
    if (tag === 'input' && attrs.some((a) => a.name === 'type' && decodeEntities(a.raw).trim().toLowerCase() === 'image')) add('<input type="image"> is not allowed');
    for (const { name, raw } of attrs) {
      if (name.startsWith('data-') || name.startsWith('aria-') || name.startsWith('on') || TEXT_ATTRS.has(name)) continue;
      const value = decodeEntities(raw);
      const shown = value.slice(0, 80);
      const checked = name === 'style' || SHAPE_URL_ATTRS.includes(name) || /url|image-set|src|\\/i.test(value);
      // A named character reference this check cannot read (`&colon;`) could hide a scheme or a `(`.
      if (checked && /&[a-z][a-z0-9]*;/i.test(value)) {
        add(`${tag} ${name}: write characters plainly, not as named references like &colon;`);
        continue;
      }
      if (SHAPE_TOP_LAYER_ATTRS.includes(name)) add(`${name} is not allowed (it lifts a part over the whole app)`);
      else if (SHAPE_DROPPED_ATTRS.includes(name)) add(`${name} is not allowed (it loads from outside the board); use one src`);
      else if (SHAPE_URL_ATTRS.includes(name)) {
        const link = tag === 'a' && (name === 'href' || name === 'xlink:href');
        if (!shapeUrlAllowed(value, link)) {
          add(`<${tag} ${name}="${shown}">: nothing may load from outside the board; use files/<name>, #id or a data:image (a picture on this computer or the web goes in <img src> or <image href>, and shape update copies it in)${link ? ' (a link may be https://)' : ''}`);
        }
      } else if (name === 'style') {
        for (const p of shapeCssProblems(value)) add(`<${tag} style>: ${p}`);
      } else if (!shapePaintAllowed(value)) add(`<${tag} ${name}="${shown}">: only url(#id) is allowed here`);
    }
  }
  for (const value of shapeHtmlDataCodes(html)) {
    if (!parseShapeCodeTarget(value)) add(`data-code="${value.slice(0, 80)}" is not a file and line in the project (write path#L42)`);
  }
  return out;
}

const isHtmlSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isAsciiAlpha = (c: string | undefined) => !!c && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const DATA_CODE_READ_MAX = 512;

function nextWhere(html: string, stop: (c: string) => boolean): Int32Array {
  const n = html.length;
  const next = new Int32Array(n + 2).fill(n);
  for (let i = n - 1; i >= 0; i--) next[i] = stop(html[i]!) ? i : next[i + 1]!;
  return next;
}

export function shapeHtmlDataCodes(html: string): string[] {
  const out: string[] = [];
  const n = html.length;
  if (!html.includes('<')) return out;
  const tagNameEnd = nextWhere(html, (c) => isHtmlSpace(c) || c === '/' || c === '>');
  const attrNameEnd = nextWhere(html, (c) => isHtmlSpace(c) || c === '/' || c === '>' || c === '=');
  const unquotedEnd = nextWhere(html, (c) => isHtmlSpace(c) || c === '>');
  const nextDouble = nextWhere(html, (c) => c === '"');
  const nextSingle = nextWhere(html, (c) => c === "'");
  const nextSolid = nextWhere(html, (c) => !isHtmlSpace(c));
  const nextAttr = nextWhere(html, (c) => !isHtmlSpace(c) && c !== '/');
  const read = new Uint8Array(n + 1);
  for (let lt = html.indexOf('<'); lt >= 0; lt = html.indexOf('<', lt + 1)) {
    if (!isAsciiAlpha(html[lt + 1])) continue;
    let i = tagNameEnd[lt + 1]!;
    for (;;) {
      i = nextAttr[i]!;
      if (i >= n || html[i] === '>' || read[i]) break;
      read[i] = 1;
      const nameEnd = attrNameEnd[i + 1]!;
      const isCode = nameEnd - i === 9 && html.slice(i, nameEnd).toLowerCase() === 'data-code';
      i = nextSolid[nameEnd]!;
      if (html[i] !== '=') continue;
      i = nextSolid[i + 1]!;
      let from = i;
      let to: number;
      if (html[i] === '"' || html[i] === "'") {
        from = i + 1;
        to = (html[i] === '"' ? nextDouble : nextSingle)[from]!;
        i = Math.min(to + 1, n);
      } else {
        to = unquotedEnd[i]!;
        i = to;
      }
      if (isCode) out.push(to - from > DATA_CODE_READ_MAX ? `${decodeEntities(html.slice(from, from + DATA_CODE_READ_MAX))}…` : decodeEntities(html.slice(from, to)));
    }
  }
  return out;
}

const SVG_BREAKOUT_TAGS = new Set(['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var']);
const SVG_BREAKOUT_VOID = new Set(['br', 'embed', 'hr', 'meta']);
const SVG_HTML_POINTS = new Set(['foreignobject', 'desc', 'title']);
const HTML_RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

export function shapeKeepSvgWhole(html: string): string {
  if (!/<svg/i.test(html)) return html;
  const n = html.length;
  const lower = html.toLowerCase();
  const open: { name: string; as: string }[] = [];
  const inSvg = () => open.length > 0 && !SVG_HTML_POINTS.has(open[open.length - 1]!.name);
  const inText = () => {
    for (let k = open.length - 1; k >= 0 && open[k]!.name !== 'svg'; k--) if (open[k]!.as === 'text') return true;
    return false;
  };
  let out = '';
  let copied = 0;
  for (let lt = html.indexOf('<'); lt >= 0 && lt < n; lt = html.indexOf('<', lt + 1)) {
    if (open.length > 512) break;
    if (html.startsWith('<!--', lt)) {
      if (html.startsWith('>', lt + 4) || html.startsWith('->', lt + 4)) {
        lt = html.indexOf('>', lt + 4);
        continue;
      }
      let e = html.indexOf('--', lt + 4);
      while (e >= 0 && html[e + 2] !== '>' && !html.startsWith('!>', e + 2)) e = html.indexOf('--', e + 1);
      lt = e < 0 ? n : html.indexOf('>', e);
      continue;
    }
    if (inSvg() && html.startsWith('<![CDATA[', lt)) {
      const e = html.indexOf(']]>', lt + 9);
      lt = e < 0 ? n : e + 2;
      continue;
    }
    const at = lt;
    const end = html[lt + 1] === '/';
    const start = end ? lt + 2 : lt + 1;
    if (html[lt + 1] === '!' || html[lt + 1] === '?' || (end && !isAsciiAlpha(html[start]))) {
      const e = html.indexOf('>', lt + 1);
      lt = e < 0 ? n : e;
      continue;
    }
    if (!isAsciiAlpha(html[start])) continue;
    let i = start;
    while (i < n && !isHtmlSpace(html[i]) && html[i] !== '/' && html[i] !== '>') i++;
    const nameEnd = i;
    const name = html.slice(start, nameEnd).toLowerCase();
    for (;;) {
      while (i < n && (isHtmlSpace(html[i]) || html[i] === '/')) i++;
      if (i >= n || html[i] === '>') break;
      i++;
      while (i < n && !isHtmlSpace(html[i]) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') i++;
      while (i < n && isHtmlSpace(html[i])) i++;
      if (html[i] !== '=') continue;
      i++;
      while (i < n && isHtmlSpace(html[i])) i++;
      if (html[i] === '"' || html[i] === "'") {
        const q = html.indexOf(html[i]!, i + 1);
        i = q < 0 ? n : q + 1;
      } else while (i < n && !isHtmlSpace(html[i]) && html[i] !== '>') i++;
    }
    const gt = i;
    const selfClosing = html[gt - 1] === '/' && gt - 1 >= nameEnd;
    lt = gt;
    if (!inSvg()) {
      const point = open[open.length - 1];
      if (!end && name === 'svg') {
        if (!selfClosing) open.push({ name, as: name });
      } else if (end && point && name === point.name) open.pop();
      else if (!end && HTML_RAW_TEXT.has(name)) {
        const close = lower.indexOf(`</${name}`, gt);
        lt = close < 0 ? n : close;
      } else if (!end && name === 'plaintext') break;
      continue;
    }
    if (!end) {
      const breakout =
        SVG_BREAKOUT_TAGS.has(name) || (name === 'font' && /[\s/](?:color|face|size)(?=[\s/=>]|$)/i.test(html.slice(nameEnd, gt)));
      if (!breakout) {
        if (!selfClosing) open.push({ name, as: name });
        continue;
      }
      const words = inText();
      let empty = selfClosing || SVG_BREAKOUT_VOID.has(name);
      if (!empty && !words && name !== 'img') {
        let k = gt + 1;
        while (k < n && isHtmlSpace(html[k])) k++;
        empty = lower.startsWith(`</${name}`, k) && /^[\s/>]?$/.test(html[k + 2 + name.length] ?? '');
      }
      if (name === 'img' || (!words && !empty)) {
        while (inSvg()) open.pop();
        continue;
      }
      const as = words ? 'tspan' : 'g';
      const close = SVG_BREAKOUT_VOID.has(name) && !selfClosing;
      out += html.slice(copied, start) + as + html.slice(nameEnd, gt) + (close ? ' /' : '');
      copied = gt;
      if (!selfClosing && !close) open.push({ name, as });
      continue;
    }
    let k = open.length - 1;
    while (k >= 0 && open[k]!.name !== name && open[k]!.as !== name) k--;
    if (k < 0) {
      if (name !== 'p' && name !== 'br') continue;
      out += html.slice(copied, at) + `<${inText() ? 'tspan' : 'g'}/>`;
      copied = Math.min(gt + 1, n);
      continue;
    }
    const as = open[k]!.as;
    if (as !== name) {
      out += html.slice(copied, at) + `</${as}>`;
      copied = Math.min(gt + 1, n);
    }
    open.length = open.map((o) => o.as).lastIndexOf(as);
  }
  return copied ? out + html.slice(copied) : html;
}

/** A path in the project, relative to its root: `src/a.ts`. */
export function isShapeProjectPath(path: string): boolean {
  if (!path || path.length > 500 || path !== path.trim()) return false;
  if (/[\u0000-\u001f\u007f\\%]/.test(path)) return false;
  if (path.startsWith('/') || path.startsWith('~') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

const PROJECT_PATH_RULE = 'must be a path in the project, relative to its root (src/a.ts): no leading / or ~, no drive or scheme, no . or .. part, no backslash or %';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Checker {
  errors: string[] = [];
  fail(field: string, message: string) {
    this.errors.push(`${field}: ${message}`);
  }
  text(value: unknown, field: string, max: number, required = true): string | undefined {
    if (value === undefined || value === null) {
      if (required) this.fail(field, 'is required');
      return undefined;
    }
    if (typeof value !== 'string') {
      this.fail(field, 'must be a string');
      return undefined;
    }
    if (required && !value.trim()) {
      this.fail(field, 'is empty');
      return undefined;
    }
    if (value.length > max) {
      this.fail(field, `is ${value.length} characters; at most ${max}`);
      return undefined;
    }
    return value;
  }
  int(value: unknown, field: string, min: number, max: number, required = true): number | undefined {
    if (value === undefined || value === null) {
      if (required) this.fail(field, 'is required');
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.fail(field, `must be a whole number from ${min} to ${max}`);
      return undefined;
    }
    return value;
  }
  list(value: unknown, field: string, max: number): unknown[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      this.fail(field, 'must be a list');
      return undefined;
    }
    if (value.length > max) {
      this.fail(field, `has ${value.length} entries; at most ${max}`);
      return undefined;
    }
    return value;
  }
  path(value: unknown, field: string): string | undefined {
    const path = this.text(value, field, 500);
    if (path === undefined) return undefined;
    if (!isShapeProjectPath(path)) {
      this.fail(field, `"${path.slice(0, 80)}" ${PROJECT_PATH_RULE}`);
      return undefined;
    }
    return path;
  }
  id(value: unknown, field: string): string | undefined {
    if (typeof value !== 'string' || !PART_ID_RE.test(value)) {
      this.fail(field, 'must be an id: a letter, then letters, digits, ".", "_" or "-" (at most 64)');
      return undefined;
    }
    return value;
  }
}

function checkDrawn(c: Checker, value: unknown, field: string, withExamples = false): ShapeDrawnView | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    c.fail(field, 'must be an object with html');
    return undefined;
  }
  const html = c.text(value.html, `${field}.html`, SHAPE_LIMITS.html);
  if (html !== undefined) for (const p of shapeHtmlProblems(html)) c.fail(`${field}.html`, p);
  const css = c.text(value.css, `${field}.css`, SHAPE_LIMITS.css, false);
  if (css !== undefined) for (const p of shapeCssProblems(css)) c.fail(`${field}.css`, p);
  const width = c.int(value.width, `${field}.width`, SHAPE_LIMITS.canvas.min, SHAPE_LIMITS.canvas.max, false);
  const height = c.int(value.height, `${field}.height`, SHAPE_LIMITS.canvas.min, SHAPE_LIMITS.canvas.max, false);
  if ((width === undefined) !== (height === undefined) && !c.errors.some((e) => e.startsWith(`${field}.width`) || e.startsWith(`${field}.height`))) {
    c.fail(field, 'width and height go together (a fixed canvas), or neither');
  }
  let tall: ShapeDrawnView['tall'];
  if (value.tall !== undefined && value.tall !== null) {
    if (!isRecord(value.tall)) c.fail(`${field}.tall`, 'must be an object with html');
    else {
      const th = c.text(value.tall.html, `${field}.tall.html`, SHAPE_LIMITS.html);
      if (th !== undefined) for (const p of shapeHtmlProblems(th)) c.fail(`${field}.tall.html`, p);
      const tc = c.text(value.tall.css, `${field}.tall.css`, SHAPE_LIMITS.css, false);
      if (tc !== undefined) for (const p of shapeCssProblems(tc)) c.fail(`${field}.tall.css`, p);
      if (th !== undefined) tall = { html: th, ...(tc ? { css: tc } : {}) };
    }
  }
  let examples: ShapeExample[] | undefined;
  if (value.examples !== undefined && value.examples !== null) {
    if (!withExamples) c.fail(`${field}.examples`, 'examples go on views.how (How it works), the drawing they are followed through');
    else if (html !== undefined) examples = checkExamples(c, value.examples, `${field}.examples`, html, tall?.html);
  }
  let more: ShapeDrawnView['more'];
  if (value.more !== undefined && value.more !== null) {
    if (!isRecord(value.more)) c.fail(`${field}.more`, 'must be an object with html');
    else {
      const mh = c.text(value.more.html, `${field}.more.html`, SHAPE_LIMITS.html);
      if (mh !== undefined) for (const p of shapeHtmlProblems(mh)) c.fail(`${field}.more.html`, p);
      const mc = c.text(value.more.css, `${field}.more.css`, SHAPE_LIMITS.css, false);
      if (mc !== undefined) for (const p of shapeCssProblems(mc)) c.fail(`${field}.more.css`, p);
      if (mh !== undefined) more = { html: mh, ...(mc ? { css: mc } : {}) };
    }
  }
  if (html === undefined) return undefined;
  return {
    html,
    ...(css ? { css } : {}),
    ...(width !== undefined && height !== undefined ? { width, height } : {}),
    ...(tall ? { tall } : {}),
    ...(examples?.length ? { examples } : {}),
    ...(more ? { more } : {}),
  };
}

/** The ids of a drawing's arrows: every `data-edge` value. */
export function shapeHtmlEdges(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/\sdata-edge\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const id = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (id) out.add(id);
  }
  return out;
}

const EXAMPLE_RESULTS: readonly ShapeExampleResult[] = ['pass', 'fail', 'not-reached'];

function checkExamples(c: Checker, value: unknown, field: string, html: string, tallHtml: string | undefined): ShapeExample[] | undefined {
  const list = c.list(value, field, SHAPE_LIMITS.examples);
  if (!list) return undefined;
  const drawings = [{ name: 'html', marks: new Set(shapeHtmlMarks(html).map((m) => m.id)), edges: shapeHtmlEdges(html) }];
  if (tallHtml !== undefined) drawings.push({ name: 'tall.html', marks: new Set(shapeHtmlMarks(tallHtml).map((m) => m.id)), edges: shapeHtmlEdges(tallHtml) });
  const view = field.replace(/\.examples$/, '');
  const out: ShapeExample[] = [];
  const names = new Set<string>();
  list.forEach((ex, ei) => {
    const ef = `${field}[${ei}]`;
    if (!isRecord(ex)) return c.fail(ef, 'must be { name, title, steps }');
    const name = c.text(ex.name, `${ef}.name`, 40);
    if (name && names.has(name)) c.fail(`${ef}.name`, `"${name}" is used twice; name each example by where it ends`);
    if (name) names.add(name);
    const title = c.text(ex.title, `${ef}.title`, 140);
    const lead = c.text(ex.lead, `${ef}.lead`, SHAPE_LIMITS.line, false);
    const steps = c.list(ex.steps, `${ef}.steps`, SHAPE_LIMITS.exampleSteps);
    if (!steps) {
      if (ex.steps === undefined) c.fail(`${ef}.steps`, 'is required');
      return;
    }
    if (!steps.length) c.fail(`${ef}.steps`, 'needs at least one step');
    const outSteps: ShapeExampleStep[] = [];
    steps.forEach((st, si) => {
      const step = checkExampleStep(c, st, `${ef}.steps[${si}]`, si, drawings, view);
      if (step) outSteps.push(step);
    });
    if (name && title && outSteps.length === steps.length && steps.length) out.push({ name, title, ...(lead ? { lead } : {}), steps: outSteps });
  });
  return out;
}

function checkExampleStep(
  c: Checker,
  st: unknown,
  f: string,
  index: number,
  drawings: { name: string; marks: Set<string>; edges: Set<string> }[],
  view: string,
): ShapeExampleStep | undefined {
  if (!isRecord(st)) {
    c.fail(f, 'must be { part or arrow, tag, text, inputs, signature, checks, output, code }');
    return undefined;
  }
  const before = c.errors.length;
  const part = st.part === undefined || st.part === null ? undefined : c.id(st.part, `${f}.part`);
  const arrow = st.arrow === undefined || st.arrow === null ? undefined : c.id(st.arrow, `${f}.arrow`);
  if (st.part == null && st.arrow == null) c.fail(f, 'needs a part (a data-mark) or an arrow (a data-edge) to light');
  for (const d of drawings) {
    if (part && !d.marks.has(part)) c.fail(`${f}.part`, `"${part}" is not a data-mark in ${view}.${d.name}`);
    if (arrow && !d.edges.has(arrow)) c.fail(`${f}.arrow`, `"${arrow}" is not a data-edge in ${view}.${d.name}; put data-edge="${arrow}" on the arrow`);
  }
  const tag = c.text(st.tag, `${f}.tag`, 60);
  let tagAt: ShapeExampleStep['tagAt'];
  if (st.tagAt !== undefined && st.tagAt !== null) {
    if (st.tagAt !== 'top' && st.tagAt !== 'bottom') c.fail(`${f}.tagAt`, 'must be "top" or "bottom"');
    else tagAt = st.tagAt;
  }
  const text = c.text(st.text, `${f}.text`, 200);
  const detail = c.text(st.detail, `${f}.detail`, SHAPE_LIMITS.line, false);
  const signature = c.text(st.signature, `${f}.signature`, SHAPE_LIMITS.exampleCode);
  if (signature && !/^[\w$.]+\s*\(/.test(signature)) c.fail(`${f}.signature`, 'must start with the function\'s name and its parameters: name(a: A): R');

  const inputs: ShapeExampleInput[] = [];
  const ins = c.list(st.inputs, `${f}.inputs`, SHAPE_LIMITS.exampleRows);
  (ins ?? []).forEach((v, i) => {
    const vf = `${f}.inputs[${i}]`;
    if (!isRecord(v)) return c.fail(vf, 'must be { name, value, type, reading, from }');
    const name = c.text(v.name, `${vf}.name`, 80);
    const val = c.text(v.value, `${vf}.value`, 200);
    const type = c.text(v.type, `${vf}.type`, 120, false);
    const reading = c.text(v.reading, `${vf}.reading`, 60, false);
    const from = checkExampleSource(c, v.from, `${vf}.from`, index);
    if (name && val !== undefined && from !== undefined) inputs.push({ name, value: val, ...(type ? { type } : {}), ...(reading ? { reading } : {}), from });
  });

  const checks: ShapeExampleCheck[] = [];
  const cl = c.list(st.checks, `${f}.checks`, SHAPE_LIMITS.exampleRows);
  let failed = false;
  (cl ?? []).forEach((k, i) => {
    const kf = `${f}.checks[${i}]`;
    if (!isRecord(k)) return c.fail(kf, 'must be { code, constant, saw, result, decides, short }');
    const code = c.text(k.code, `${kf}.code`, SHAPE_LIMITS.exampleCode);
    const constant = c.text(k.constant, `${kf}.constant`, 60, false);
    const result = EXAMPLE_RESULTS.includes(k.result as ShapeExampleResult) ? (k.result as ShapeExampleResult) : undefined;
    if (!result) c.fail(`${kf}.result`, 'must be "pass", "fail" or "not-reached"');
    const saw = c.text(k.saw, `${kf}.saw`, 120, result !== 'not-reached');
    if (k.decides !== undefined && k.decides !== null && typeof k.decides !== 'boolean') c.fail(`${kf}.decides`, 'must be true or false');
    const decides = k.decides === true;
    if (decides && result === 'not-reached') c.fail(`${kf}.decides`, 'a check that was not reached cannot decide the step');
    const short = c.text(k.short, `${kf}.short`, 80, false);
    if (short && result !== 'fail') c.fail(`${kf}.short`, 'only a failing check has a shortfall');
    if (failed && result && result !== 'not-reached') c.fail(`${kf}.result`, 'must be "not-reached": an earlier check failed, so the code never got here');
    if (result === 'fail') failed = true;
    if (code && result) checks.push({ code, ...(constant ? { constant } : {}), ...(saw ? { saw } : {}), result, ...(decides ? { decides } : {}), ...(short ? { short } : {}) });
  });
  const deciding = (cl ?? []).filter((k) => isRecord(k) && k.decides === true).length;
  if (cl?.length && deciding !== 1) c.fail(`${f}.checks`, `mark exactly one check "decides": true, the one that settled the step (${deciding} are marked)`);

  let output: ShapeExampleStep['output'] | undefined;
  if (!isRecord(st.output)) c.fail(`${f}.output`, 'must be { name, value, type }');
  else {
    const name = c.text(st.output.name, `${f}.output.name`, 80);
    const val = c.text(st.output.value, `${f}.output.value`, 200);
    const type = c.text(st.output.type, `${f}.output.type`, 120);
    const note = c.text(st.output.note, `${f}.output.note`, 120, false);
    if (name && val !== undefined && type) output = { name, value: val, type, ...(note ? { note } : {}) };
  }
  let code: ShapeExampleStep['code'] | undefined;
  if (!isRecord(st.code)) c.fail(`${f}.code`, "must be { path, line }: the function's line");
  else {
    const path = c.path(st.code.path, `${f}.code.path`);
    const line = c.int(st.code.line, `${f}.code.line`, 1, 10_000_000);
    if (path && line) code = { path, line };
  }
  if (c.errors.length > before || !tag || !text || !signature || !output || !code) return undefined;
  return {
    ...(part ? { part } : {}),
    ...(arrow ? { arrow } : {}),
    tag,
    ...(tagAt ? { tagAt } : {}),
    text,
    ...(detail ? { detail } : {}),
    inputs,
    signature,
    checks,
    output,
    code,
  };
}

function checkExampleSource(c: Checker, from: unknown, f: string, index: number): ShapeExampleSource | undefined {
  if (typeof from === 'string') return c.text(from, f, 80);
  if (!isRecord(from)) {
    c.fail(f, 'must be { path, line } (where it is read in the code), { step: n } (an earlier step\'s output) or a few words');
    return undefined;
  }
  if (from.step !== undefined) {
    if (!index) {
      c.fail(`${f}.step`, 'the first step has no earlier step; name the code it is read from: { path, line }');
      return undefined;
    }
    const step = c.int(from.step, `${f}.step`, 1, index);
    return step === undefined ? undefined : { step };
  }
  const path = c.path(from.path, `${f}.path`);
  const line = c.int(from.line, `${f}.line`, 1, 10_000_000);
  return path && line ? { path, line } : undefined;
}

/** `views.know`'s paragraphs: blank lines part them. Only the check reads them now. */
export function shapeKnowParagraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function checkKnow(c: Checker, value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    c.fail(field, 'must be a string of Markdown');
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    c.fail(field, 'is empty');
    return undefined;
  }
  const cut = 'Cut it to what the person needs to know.';
  if (text.length > SHAPE_LIMITS.know) c.fail(field, `is ${text.length} characters; at most ${SHAPE_LIMITS.know}. ${cut}`);
  const paragraphs = shapeKnowParagraphs(text).length;
  if (paragraphs > SHAPE_LIMITS.knowParagraphs) c.fail(field, `is ${paragraphs} paragraphs; at most ${SHAPE_LIMITS.knowParagraphs}. ${cut}`);
  return text;
}

function checkCode(c: Checker, value: unknown, field: string): ShapeCodeView | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    c.fail(field, 'must be an object with stage and guide');
    return undefined;
  }
  const stage = value.stage === 'before' || value.stage === 'after' ? value.stage : undefined;
  if (!stage) c.fail(`${field}.stage`, 'must be "before" or "after"');
  const g = value.guide;
  let guide: CodeGuideOutput | undefined;
  if (!isRecord(g)) c.fail(`${field}.guide`, 'must be a guide: { title, intent, sections }');
  else {
    const title = c.text(g.title, `${field}.guide.title`, 200);
    const intent = c.text(g.intent, `${field}.guide.intent`, 1000, false) ?? '';
    const sections = c.list(g.sections, `${field}.guide.sections`, SHAPE_LIMITS.sections);
    if (g.sections === undefined) c.fail(`${field}.guide.sections`, 'is required');
    const outSections: CodeGuideOutput['sections'] = [];
    (sections ?? []).forEach((s, i) => {
      const f = `${field}.guide.sections[${i}]`;
      if (!isRecord(s)) return c.fail(f, 'must be { title, overview, diffs }');
      const st = c.text(s.title, `${f}.title`, 200);
      const ov = c.text(s.overview, `${f}.overview`, 8000, false) ?? '';
      const diffs = c.list(s.diffs, `${f}.diffs`, SHAPE_LIMITS.files) ?? [];
      const outDiffs: CodeGuideOutput['sections'][number]['diffs'] = [];
      diffs.forEach((d, j) => {
        if (!isRecord(d)) return c.fail(`${f}.diffs[${j}]`, 'must be { file, summary }');
        const file = c.path(d.file, `${f}.diffs[${j}].file`);
        const summary = c.text(d.summary, `${f}.diffs[${j}].summary`, 600, false);
        if (file) outDiffs.push({ file, ...(summary ? { summary } : {}) });
      });
      if (st) outSections.push({ title: st, overview: ov, diffs: outDiffs });
    });
    const unplaced = c.list(g.unplacedFiles, `${field}.guide.unplacedFiles`, 500);
    const unplacedFiles = unplaced?.filter((p, i): p is string => typeof p === 'string' && c.path(p, `${field}.guide.unplacedFiles[${i}]`) !== undefined);
    if (title) guide = { title, intent, sections: outSections, ...(unplacedFiles?.length ? { unplacedFiles } : {}) };
  }
  const patch = c.text(value.patch, `${field}.patch`, SHAPE_LIMITS.patch, false);
  let planned: ShapePlannedFile[][] | undefined;
  const pl = c.list(value.planned, `${field}.planned`, SHAPE_LIMITS.sections);
  if (pl) {
    planned = pl.map((step, i) => {
      const files = c.list(step, `${field}.planned[${i}]`, SHAPE_LIMITS.files) ?? [];
      return files.flatMap((f, j) => {
        const ff = `${field}.planned[${i}][${j}]`;
        if (!isRecord(f)) {
          c.fail(ff, 'must be { path, kind }');
          return [];
        }
        const path = c.path(f.path, `${ff}.path`);
        if (f.kind !== 'new' && f.kind !== 'change') c.fail(`${ff}.kind`, 'must be "new" or "change"');
        return path && (f.kind === 'new' || f.kind === 'change') ? [{ path, kind: f.kind }] : [];
      });
    });
  }
  const source = c.text(value.source, `${field}.source`, SHAPE_LIMITS.line, false);
  let files: ShapeCodeView['files'];
  const fl = c.list(value.files, `${field}.files`, SHAPE_LIMITS.files);
  if (fl) {
    files = fl.flatMap((f, i) => {
      if (!isRecord(f)) {
        c.fail(`${field}.files[${i}]`, 'must be { path, line? }');
        return [];
      }
      const path = c.path(f.path, `${field}.files[${i}].path`);
      const line = c.int(f.line, `${field}.files[${i}].line`, 1, 10_000_000, false);
      return path ? [{ path, ...(line ? { line } : {}) }] : [];
    });
  }
  if (!stage || !guide) return undefined;
  return {
    stage,
    guide,
    ...(patch ? { patch } : {}),
    ...(planned ? { planned } : {}),
    ...(source ? { source } : {}),
    ...(files?.length ? { files } : {}),
  };
}

function checkCodePlace(c: Checker, value: unknown, field: string): string | undefined {
  const text = c.text(value, field, 520);
  if (text === undefined) return undefined;
  if (!parseShapeCodeTarget(text)) {
    c.fail(field, `"${text.slice(0, 80)}" must be path:line (src/a.ts:42), a path in the project`);
    return undefined;
  }
  return text;
}

const CITE_RE = /\[\^\d{1,3}\]/;

function plainText(c: Checker, value: string | undefined, field: string): string | undefined {
  if (value !== undefined && CITE_RE.test(value)) {
    c.fail(field, 'shows a [^n] as written: cite a reference in a title, a note, the summary or also');
    return undefined;
  }
  return value;
}

function checkDiffLines(c: Checker, value: unknown, field: string): string | string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const lines = c.list(value, field, SHAPE_LIMITS.changeLines);
    if (!lines) return undefined;
    if (!lines.length) {
      c.fail(field, 'is empty');
      return undefined;
    }
    const out = lines.map((line, i) => plainText(c, c.text(line, `${field}[${i}]`, SHAPE_LIMITS.line), `${field}[${i}]`));
    return out.every((line): line is string => line !== undefined) ? out : undefined;
  }
  return plainText(c, c.text(value, field, SHAPE_LIMITS.line), field);
}

function checkFlowEnd(c: Checker, value: unknown, field: string): ShapeFlowEnd | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    c.fail(field, 'must be { was?, now }');
    return undefined;
  }
  const was = plainText(c, c.text(value.was, `${field}.was`, SHAPE_LIMITS.line, false), `${field}.was`);
  const now = plainText(c, c.text(value.now, `${field}.now`, SHAPE_LIMITS.line), `${field}.now`);
  return now === undefined ? undefined : { ...(was !== undefined ? { was } : {}), now };
}

const FLOW_IS: readonly ShapeFlowStep['is'][] = ['new', 'gone', 'changed', 'same'];

function checkFlowSteps(c: Checker, value: unknown, field: string): ShapeFlowStep[] | undefined {
  const steps = c.list(value, field, SHAPE_LIMITS.flowSteps);
  if (!steps) return undefined;
  return steps.flatMap((s, i) => {
    const f = `${field}[${i}]`;
    if (!isRecord(s)) {
      c.fail(f, 'must be { call, is, note?, at? }');
      return [];
    }
    const call = plainText(c, c.text(s.call, `${f}.call`, 200), `${f}.call`);
    const is = FLOW_IS.includes(s.is as ShapeFlowStep['is']) ? (s.is as ShapeFlowStep['is']) : undefined;
    if (!is) c.fail(`${f}.is`, `must be one of ${FLOW_IS.join(', ')}`);
    const note = plainText(c, c.text(s.note, `${f}.note`, SHAPE_LIMITS.line, false), `${f}.note`);
    const at = s.at === undefined || s.at === null ? undefined : checkCodePlace(c, s.at, `${f}.at`);
    return call !== undefined && is ? [{ call, is, ...(note !== undefined ? { note } : {}), ...(at !== undefined ? { at } : {}) }] : [];
  });
}

const CHANGE_FIELDS_NOT_DRAWN: Record<ShapeChangeKind, readonly ('was' | 'now' | 'from' | 'to' | 'lines')[]> = {
  behaviour: ['from', 'to', 'lines'],
  contract: ['from', 'to', 'lines'],
  removed: ['from', 'to', 'lines'],
  moved: ['was', 'now'],
  check: ['was', 'now', 'from', 'to', 'lines'],
};
const CHANGE_FIELDS_DRAWN: Record<ShapeChangeKind, string> = {
  behaviour: 'it shows was and now',
  contract: 'it shows was and now',
  removed: 'it shows was and now',
  moved: 'it shows from, to and lines',
  check: 'it shows its note',
};

function checkChanged(c: Checker, value: unknown, field: string): ShapeChanged | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    c.fail(field, 'must be an object with items');
    return undefined;
  }
  const ids = new Set<string>();
  const ownId = (v: unknown, f: string) => {
    const id = c.id(v, f);
    if (id !== undefined && ids.has(id)) c.fail(f, `"${id}" is used twice`);
    if (id !== undefined) ids.add(id);
    return id;
  };
  const summary = c.text(value.summary, `${field}.summary`, SHAPE_LIMITS.line, false);
  const also = c.text(value.also, `${field}.also`, 600, false);
  const list = c.list(value.items, `${field}.items`, SHAPE_LIMITS.changes);
  if (value.items === undefined || value.items === null) c.fail(`${field}.items`, 'is required');
  const items: ShapeChangeItem[] = [];
  (list ?? []).forEach((it, i) => {
    const f = `${field}.items[${i}]`;
    if (!isRecord(it)) return c.fail(f, 'must be { id, kind, title, … }');
    const id = ownId(it.id, `${f}.id`);
    const kind = SHAPE_CHANGE_KINDS.includes(it.kind as ShapeChangeKind) ? (it.kind as ShapeChangeKind) : undefined;
    if (!kind) c.fail(`${f}.kind`, `must be one of ${SHAPE_CHANGE_KINDS.join(', ')}`);
    const title = c.text(it.title, `${f}.title`, 200);
    const was = checkDiffLines(c, it.was, `${f}.was`);
    const now = checkDiffLines(c, it.now, `${f}.now`);
    const from = plainText(c, c.text(it.from, `${f}.from`, 500, false), `${f}.from`);
    const to = plainText(c, c.text(it.to, `${f}.to`, 500, false), `${f}.to`);
    const lines = c.int(it.lines, `${f}.lines`, 1, 10_000_000, false);
    const note = c.text(it.note, `${f}.note`, 1000, false);
    const absent = (name: string) => it[name] === undefined || it[name] === null;
    if (kind === 'moved' && (absent('from') || absent('to'))) c.fail(f, 'a moved change needs from and to');
    if (kind === 'removed' && absent('was')) c.fail(`${f}.was`, 'a removed change needs was: what is gone');
    if (kind === 'check' && absent('note')) c.fail(`${f}.note`, 'a check needs a note: what to look at, and why');
    if ((kind === 'behaviour' || kind === 'contract') && absent('was') && absent('now')) c.fail(f, `a ${kind} change needs was, now or both`);
    if (kind) {
      for (const name of CHANGE_FIELDS_NOT_DRAWN[kind]) if (!absent(name)) c.fail(`${f}.${name}`, `is not shown on a ${kind} change (${CHANGE_FIELDS_DRAWN[kind]})`);
    }
    const codeList = c.list(it.code, `${f}.code`, 8);
    const code = codeList && [...new Set(codeList.map((p, j) => checkCodePlace(c, p, `${f}.code[${j}]`)).filter((p): p is string => p !== undefined))];
    const step = c.int(it.step, `${f}.step`, 1, SHAPE_LIMITS.sections, false);
    if (id === undefined || !kind || title === undefined) return;
    items.push({
      id,
      kind,
      title,
      ...(was !== undefined ? { was } : {}),
      ...(now !== undefined ? { now } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(lines !== undefined ? { lines } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(code?.length ? { code } : {}),
      ...(step !== undefined ? { step } : {}),
    });
  });
  if (list && !list.length) c.fail(`${field}.items`, 'is empty: name at least one change');
  const flowList = c.list(value.flows, `${field}.flows`, SHAPE_LIMITS.flows);
  const flows: ShapeChangeFlow[] = [];
  (flowList ?? []).forEach((fl, i) => {
    const f = `${field}.flows[${i}]`;
    if (!isRecord(fl)) return c.fail(f, 'must be { id, title, start, steps?, forks?, end? }');
    const id = ownId(fl.id, `${f}.id`);
    const title = c.text(fl.title, `${f}.title`, 200);
    const start = plainText(c, c.text(fl.start, `${f}.start`, SHAPE_LIMITS.line), `${f}.start`);
    const steps = checkFlowSteps(c, fl.steps, `${f}.steps`);
    const forkList = c.list(fl.forks, `${f}.forks`, SHAPE_LIMITS.forks);
    const forks = (forkList ?? []).flatMap((k, j) => {
      const ff = `${f}.forks[${j}]`;
      if (!isRecord(k)) {
        c.fail(ff, 'must be { when, steps?, end? }');
        return [];
      }
      const when = plainText(c, c.text(k.when, `${ff}.when`, 200), `${ff}.when`);
      const kSteps = checkFlowSteps(c, k.steps, `${ff}.steps`);
      const end = checkFlowEnd(c, k.end, `${ff}.end`);
      return when === undefined ? [] : [{ when, ...(kSteps ? { steps: kSteps } : {}), ...(end ? { end } : {}) }];
    });
    const end = checkFlowEnd(c, fl.end, `${f}.end`);
    if (id === undefined || title === undefined || start === undefined) return;
    flows.push({ id, title, start, ...(steps ? { steps } : {}), ...(forkList ? { forks } : {}), ...(end ? { end } : {}) });
  });
  if (!list) return undefined;
  return { ...(summary !== undefined ? { summary } : {}), items, ...(flowList ? { flows } : {}), ...(also !== undefined ? { also } : {}) };
}

function checkRefs(c: Checker, value: unknown): ShapeRef[] | undefined {
  const refs = c.list(value, 'refs', SHAPE_LIMITS.refs);
  if (!refs) return undefined;
  const seen = new Set<number>();
  const out: ShapeRef[] = [];
  refs.forEach((r, i) => {
    const f = `refs[${i}]`;
    if (!isRecord(r)) return c.fail(f, 'must be an object');
    const n = c.int(r.n, `${f}.n`, 1, SHAPE_LIMITS.refN);
    if (n !== undefined && seen.has(n)) c.fail(`${f}.n`, `${n} is used twice`);
    if (n !== undefined) seen.add(n);
    const kind = SHAPE_REF_KINDS.includes(r.kind as ShapeRefKind) ? (r.kind as ShapeRefKind) : undefined;
    if (!kind) c.fail(`${f}.kind`, `must be one of ${SHAPE_REF_KINDS.join(', ')}`);
    const title = c.text(r.title, `${f}.title`, SHAPE_LIMITS.refText);
    const sub = c.text(r.sub, `${f}.sub`, SHAPE_LIMITS.refText, false);
    const target = c.text(r.target, `${f}.target`, SHAPE_LIMITS.target);
    if (target && (kind === 'pr' || kind === 'link') && !shapeLinkUrl(target)) c.fail(`${f}.target`, 'must be an http(s) URL');
    if (target && /^\s*javascript:/i.test(target)) c.fail(`${f}.target`, 'javascript: is not allowed');
    if (target && (kind === 'file' || kind === 'diff') && !isShapeProjectPath(target)) c.fail(`${f}.target`, `"${target.slice(0, 80)}" ${PROJECT_PATH_RULE}`);
    const line = c.int(r.line, `${f}.line`, 1, 10_000_000, false);
    let images: ShapeRef['images'];
    const imgs = c.list(r.images, `${f}.images`, SHAPE_LIMITS.images);
    if (imgs) {
      images = imgs.flatMap((im, j) => {
        if (!isRecord(im)) {
          c.fail(`${f}.images[${j}]`, 'must be { src, alt }');
          return [];
        }
        const src = c.text(im.src, `${f}.images[${j}].src`, SHAPE_LIMITS.target);
        const alt = c.text(im.alt, `${f}.images[${j}].alt`, SHAPE_LIMITS.refText, false) ?? '';
        const crop = im.crop;
        const goodCrop = Array.isArray(crop) && crop.length === 4 && crop.every((v) => typeof v === 'number' && v >= 0 && v <= 1) && crop[2] > 0 && crop[3] > 0 && crop[0] + crop[2] <= 1 && crop[1] + crop[3] <= 1;
        if (crop !== undefined && !goodCrop) c.fail(`${f}.images[${j}].crop`, 'must be [x, y, width, height], each from 0 to 1');
        return src ? [{ src, alt, ...(goodCrop ? { crop: crop as [number, number, number, number] } : {}) }] : [];
      });
    }
    if (n !== undefined && kind && title && target) {
      out.push({ n, kind, title, ...(sub ? { sub } : {}), target, ...(line ? { line } : {}), ...(images?.length ? { images } : {}) });
    }
  });
  return out.sort((a, b) => a.n - b.n);
}

function drawnMarks(views: ShapeBoard['views']): Set<string> {
  const marks = new Set<string>();
  for (const v of [views.picture, views.how]) {
    if (!v) continue;
    for (const html of [v.html, v.tall?.html, v.more?.html]) if (html) for (const m of shapeHtmlMarks(html)) marks.add(m.id);
  }
  return marks;
}

function checkStack(c: Checker, value: unknown, views: ShapeBoard['views']): ShapeStack | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    c.fail('stack', 'must be { pulls, changes }');
    return undefined;
  }
  const pullList = c.list(value.pulls, 'stack.pulls', SHAPE_LIMITS.stackPulls);
  if (!pullList) {
    if (value.pulls === undefined || value.pulls === null) c.fail('stack.pulls', 'is required: the stack\'s pull requests, in landing order');
    return undefined;
  }
  const pulls: ShapeStackPull[] = [];
  const numbers = new Set<number>();
  pullList.forEach((p, i) => {
    const f = `stack.pulls[${i}]`;
    if (!isRecord(p)) return c.fail(f, 'must be { n, title, url?, step? }');
    const n = c.int(p.n, `${f}.n`, 1, Number.MAX_SAFE_INTEGER);
    if (n !== undefined && numbers.has(n)) c.fail(`${f}.n`, `#${n} is listed twice`);
    const title = c.text(p.title, `${f}.title`, SHAPE_LIMITS.title);
    const url = c.text(p.url, `${f}.url`, SHAPE_LIMITS.target, false);
    if (url && !shapeLinkUrl(url)) c.fail(`${f}.url`, 'must be an http(s) URL');
    const step = c.int(p.step, `${f}.step`, 1, SHAPE_LIMITS.sections, false);
    if (n === undefined || !title || numbers.has(n)) return;
    numbers.add(n);
    pulls.push({ n, title, ...(url && shapeLinkUrl(url) ? { url } : {}), ...(step ? { step } : {}) });
  });
  const marks = drawnMarks(views);
  const changeList = c.list(value.changes, 'stack.changes', SHAPE_LIMITS.stackChanges) ?? [];
  const changes: ShapeStackChange[] = [];
  const pairs = new Set<string>();
  changeList.forEach((ch, i) => {
    const f = `stack.changes[${i}]`;
    if (!isRecord(ch)) return c.fail(f, 'must be { part, pr, said, files }');
    const part = c.id(ch.part, `${f}.part`);
    if (part && !marks.has(part)) c.fail(`${f}.part`, `"${part}" is not a data-mark on the Picture or How it works`);
    const pr = c.int(ch.pr, `${f}.pr`, 1, Number.MAX_SAFE_INTEGER);
    if (pr !== undefined && !numbers.has(pr)) c.fail(`${f}.pr`, `#${pr} is not in stack.pulls`);
    const pair = `${part}#${pr}`;
    if (part && pr !== undefined && pairs.has(pair)) c.fail(f, `#${pr} on "${part}" is written twice; one entry per PR and part`);
    const said = plainText(c, c.text(ch.said, `${f}.said`, SHAPE_LIMITS.line), `${f}.said`);
    const fileList = c.list(ch.files, `${f}.files`, SHAPE_LIMITS.stackFiles);
    if (!fileList) {
      if (ch.files === undefined || ch.files === null) c.fail(`${f}.files`, 'is required: the files this PR changed in this part');
      return;
    }
    if (!fileList.length) return c.fail(`${f}.files`, 'needs at least one file');
    const files: ShapeStackFile[] = [];
    fileList.forEach((file, j) => {
      const ff = `${f}.files[${j}]`;
      if (!isRecord(file)) return c.fail(ff, 'must be { path, additions?, deletions?, lines? }');
      const path = c.path(file.path, `${ff}.path`);
      const additions = c.int(file.additions, `${ff}.additions`, 0, 10_000_000, false);
      const deletions = c.int(file.deletions, `${ff}.deletions`, 0, 10_000_000, false);
      let lines: [number, number][] | undefined;
      const ranges = c.list(file.lines, `${ff}.lines`, SHAPE_LIMITS.stackLines);
      if (ranges) {
        lines = [];
        ranges.forEach((r, k) => {
          const ok = Array.isArray(r) && r.length === 2 && r.every((v) => Number.isInteger(v) && v >= 1 && v <= 10_000_000) && r[0] <= r[1];
          if (!ok) c.fail(`${ff}.lines[${k}]`, 'must be [from, to]: whole line numbers, from <= to');
          else lines!.push([r[0], r[1]]);
        });
      }
      if (path) files.push({ path, ...(additions !== undefined ? { additions } : {}), ...(deletions !== undefined ? { deletions } : {}), ...(lines?.length ? { lines } : {}) });
    });
    if (!part || pr === undefined || !said || !marks.has(part) || !numbers.has(pr) || pairs.has(pair) || files.length !== fileList.length) return;
    pairs.add(pair);
    changes.push({ part, pr, said, files });
  });
  if (!pulls.length) return undefined;
  return { pulls, changes };
}

/** A stack's badges, part by part: the PRs that changed it, in landing order. None for a board of one PR or none. */
export function shapeStackBadges(stack: ShapeStack | undefined): Map<string, number[]> {
  const badges = new Map<string, number[]>();
  if (!stack || stack.pulls.length < 2) return badges;
  const order = new Map(stack.pulls.map((p, i) => [p.n, i]));
  for (const ch of stack.changes) {
    if (!order.has(ch.pr)) continue;
    const list = badges.get(ch.part) ?? [];
    if (!list.includes(ch.pr)) list.push(ch.pr);
    badges.set(ch.part, list);
  }
  for (const list of badges.values()) list.sort((a, b) => order.get(a)! - order.get(b)!);
  return badges;
}

const STACK_HUES = [186, 72, 357, 125, 235, 33, 155, 330, 99, 209, 15, 51, 171, 140, 344, 112, 86, 221, 197, 24] as const;

/** The hues of a stack of `count` PRs, in landing order (`STACK_HUES`): the first `count` of one fixed sequence. */
export function shapeStackHues(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => STACK_HUES[i % STACK_HUES.length]!);
}

/** A PR's hue on the board (`shapeStackHues`, by its place in the stack); null when it is not in it. */
export function shapeStackHue(stack: ShapeStack, n: number): number | null {
  const i = stack.pulls.findIndex((p) => p.n === n);
  return i < 0 ? null : STACK_HUES[i % STACK_HUES.length]!;
}

export function checkShapeDrawnView(input: unknown, field = 'view'): ShapeCheck<ShapeDrawnView> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: [`${field}: must be an object with html`] };
  const view = checkDrawn(c, input, field);
  if (c.errors.length || !view) return { ok: false, errors: c.errors.length ? c.errors : [`${field}.html: is required`] };
  return { ok: true, value: view };
}

const SHAPE_SCENE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

function checkScenes(c: Checker, input: unknown, views: ShapeBoard['views']): Record<string, ShapeScene> | undefined {
  const htmlOf = (v: 'picture' | 'how') => {
    const view = views[v];
    return view ? [view.html, view.tall?.html ?? '', view.more?.html ?? ''] : [];
  };
  const playedIn = new Map<string, ('picture' | 'how')[]>();
  for (const v of ['picture', 'how'] as const) {
    const slots = htmlOf(v).flatMap(shapeHtmlSceneSlots);
    for (const slot of slots) {
      if (slot.tag !== 'div') c.fail(`views.${v}.html`, `data-scene="${slot.id}" is on a <${slot.tag}>; put it on a <div> around your SVG: <div data-scene="${slot.id}"><svg>…</svg></div>`);
    }
    for (const id of new Set(slots.filter((s) => s.tag === 'div').map((s) => s.id))) {
      playedIn.set(id, [...(playedIn.get(id) ?? []), v]);
      if (isRecord(input) && Object.hasOwn(input, id)) continue;
      c.fail(`views.${v}.html`, `has data-scene="${id}", but ${isRecord(input) ? `scenes has no "${id}"` : 'the board has no scenes'}`);
    }
  }
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input)) {
    c.fail('scenes', 'must be an object of scenes by id: { "pool": { … } }');
    return undefined;
  }
  const entries = Object.entries(input);
  if (entries.length > SHAPE_LIMITS.scenes) c.fail('scenes', `has ${entries.length}; at most ${SHAPE_LIMITS.scenes}`);
  const partsOf = { picture: new Set(htmlOf('picture').flatMap(shapeHtmlParts)), how: new Set(htmlOf('how').flatMap(shapeHtmlParts)) };
  const out: Record<string, ShapeScene> = {};
  for (const [id, value] of entries.slice(0, SHAPE_LIMITS.scenes)) {
    if (!SHAPE_SCENE_ID.test(id)) {
      c.fail(`scenes.${id}`, 'the id must be a short word: letters, digits, _ and -, starting with a letter or digit, at most 40');
      continue;
    }
    const checked = checkShapeScene(value, `scenes.${id}`);
    if (checked.ok === false) {
      c.errors.push(...checked.errors);
      continue;
    }
    const where = playedIn.get(id) ?? [];
    if (where.length === 0) {
      c.fail(`scenes.${id}`, `no drawing plays it; put <div data-scene="${id}"><svg>…</svg></div> in the Picture or How it works`);
      continue;
    }
    for (const ref of shapeScenePieceRefs(checked.value, `scenes.${id}`)) {
      if (where.some((v) => !partsOf[v].has(ref.id))) c.fail(ref.at, `the drawing has no data-part="${ref.id}"; put data-part="${ref.id}" on that piece of your SVG in <div data-scene="${id}">`);
    }
    out[id] = checked.value;
  }
  return entries.length ? out : undefined;
}

export function checkShapeBoard(input: unknown): ShapeCheck<ShapeBoard> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: ['the board must be a JSON object: { title, claim, views, refs }'] };
  const title = c.text(input.title, 'title', SHAPE_LIMITS.title);
  const claim = c.text(input.claim, 'claim', SHAPE_LIMITS.claim);
  const note = c.text(input.note, 'note', SHAPE_LIMITS.note, false);
  let asOf: string | undefined;
  if (input.asOf !== undefined && input.asOf !== null) {
    if (typeof input.asOf !== 'string' || Number.isNaN(Date.parse(input.asOf))) c.fail('asOf', 'must be an ISO 8601 date and time');
    else asOf = new Date(input.asOf).toISOString();
  }
  const views: ShapeBoard['views'] = {};
  if (!isRecord(input.views)) c.fail('views', 'is required: { picture, how, code }, at least one');
  else {
    for (const key of Object.keys(input.views)) {
      if (key === 'reqs') c.fail('views.reqs', 'Requirements are gone. Put a caveat behind a numbered mark (a ref\'s sub), or say it in your message to the person');
      else if (!SHAPE_VIEWS.some((v) => v.id === key)) c.fail(`views.${key}`, 'is not a view (picture, how, code)');
    }
    const picture = checkDrawn(c, input.views.picture, 'views.picture');
    const how = checkDrawn(c, input.views.how, 'views.how', true);
    const changed = checkChanged(c, input.views.changed, 'views.changed');
    const know = checkKnow(c, input.views.know, 'views.know');
    const code = checkCode(c, input.views.code, 'views.code');
    if (picture) views.picture = picture;
    if (how) views.how = how;
    if (changed) views.changed = changed;
    if (know) views.know = know;
    if (code) views.code = code;
    if (!input.views.picture && !input.views.how && !input.views.changed && !input.views.know && !input.views.reqs && !input.views.code) c.fail('views', 'needs at least one view');
  }
  const refs = checkRefs(c, input.refs);
  const stack = checkStack(c, input.stack, views);
  const scenes = checkScenes(c, input.scenes, views);
  if (c.errors.length || !title || !claim) return { ok: false, errors: c.errors.length ? c.errors : ['title and claim are required'] };
  const board: ShapeBoard = { title, claim, ...(asOf ? { asOf } : {}), ...(note ? { note } : {}), views, ...(refs?.length ? { refs } : {}), ...(scenes ? { scenes } : {}), ...(stack ? { stack } : {}) };
  // Every cited reference must exist.
  const known = new Set((refs ?? []).map((r) => r.n));
  const cited = shapeCitedRefs(board);
  const missing = [...cited].filter((n) => !known.has(n)).sort((a, b) => a - b);
  if (missing.length) return { ok: false, errors: [`refs: the board cites ${missing.map((n) => `[${n}]`).join(', ')} but refs has no entry with that n`] };
  return { ok: true, value: board };
}

const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'input', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop']);

const NAMED_REFS: Readonly<Record<string, string>> = { nbsp: '\u00a0', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'", amp: '&', AMP: '&', rarr: '→' };

function decodeEntities(text: string): string {
  return text
    .replace(/\0/g, '\ufffd')
    .replace(/&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*);)/g, (whole, d: string | undefined, h: string | undefined, name: string | undefined) =>
      d !== undefined ? numericRef(Number(d).toString(16)) : h !== undefined ? numericRef(h) : (NAMED_REFS[name!] ?? whole),
    );
}

/** 128–159 as windows-1252 (the HTML standard's table; the five it leaves out stay as they are). */
const WINDOWS_1252_C1 = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

function numericRef(hex: string): string {
  const n = parseInt(hex, 16);
  return n >= 0x80 && n <= 0x9f ? WINDOWS_1252_C1[n - 0x80]! : codePoint(hex);
}

const fold = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The marked parts of a drawn view's HTML, in document order: each element with `data-mark`, and
 * the words inside it (a nested mark's words count for both).
 */
export function shapeHtmlMarks(html: string): { id: string; text: string }[] {
  const out = new Map<string, string>();
  const stack: { tag: string; mark: string | null; text: string[] }[] = [];
  const re = /<[!]--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  const close = (frame: { mark: string | null; text: string[] }) => {
    if (frame.mark && !out.has(frame.mark)) out.set(frame.mark, fold(frame.text.join(' ')));
  };
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[5] !== undefined) {
      const text = decodeEntities(m[5]);
      for (const f of stack) if (f.mark) f.text.push(text);
      continue;
    }
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      const at = stack.map((f) => f.tag).lastIndexOf(tag);
      if (at < 0) continue;
      while (stack.length > at) close(stack.pop()!);
      continue;
    }
    const attrs = m[3] ?? '';
    const mark = /\sdata-mark\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(` ${attrs}`);
    const id = mark ? (mark[1] ?? mark[2] ?? mark[3] ?? '').trim() : '';
    const selfClosing = !!m[4] || VOID.has(tag);
    const frame = { tag, mark: id || null, text: [] as string[] };
    if (selfClosing) close(frame);
    else stack.push(frame);
  }
  while (stack.length) close(stack.pop()!);
  return [...out].map(([id, text]) => ({ id, text }));
}

/** Every part of a board, by view. The diff and the redraw key on `view` + `id`. */
export function shapeParts(board: ShapeBoard): ShapePart[] {
  const parts: ShapePart[] = [
    { view: 'header', id: 'title', text: fold(board.title) },
    { view: 'header', id: 'claim', text: fold(board.claim) },
  ];
  for (const view of ['picture', 'how'] as const) {
    const drawn = board.views[view];
    if (!drawn) continue;
    const seen = new Set<string>();
    for (const html of [drawn.html, drawn.tall?.html ?? '', drawn.more?.html ?? '']) {
      for (const mark of shapeHtmlMarks(html)) {
        if (seen.has(mark.id)) continue;
        seen.add(mark.id);
        parts.push({ view, id: mark.id, text: mark.text });
      }
    }
  }
  // `views.changed`, `views.know` (and an old board's Requirements) are never shown, so they have no parts: a change in
  // them marks nothing.
  board.views.code?.guide.sections.forEach((section, i) => {
    parts.push({ view: 'code', id: `step-${i + 1}`, text: fold(`${section.title}. ${section.overview} ${section.diffs.map((d) => d.file).join(' ')}`) });
  });
  return parts;
}

/** A place in code a drawn part points at. */
export interface ShapeCodeTarget {
  path: string;
  line: number;
  lineEnd?: number;
}

/** Reads a part's `data-code` ("src/snooze.ts#L42", "src/snooze.ts#L42-L48" or "src/snooze.ts:42"). */
export function parseShapeCodeTarget(value: string | null | undefined): ShapeCodeTarget | null {
  const m = (value ?? '').trim().match(/^([^#:\s][^#:]*?)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?)$/);
  if (!m) return null;
  const path = m[1]!;
  if (!isShapeProjectPath(path)) return null;
  const line = Number(m[2] ?? m[4]);
  const end = m[3] ?? m[5];
  if (!Number.isSafeInteger(line) || line < 1) return null;
  const lineEnd = end ? Number(end) : undefined;
  return lineEnd && lineEnd > line ? { path, line, lineEnd } : { path, line };
}

/** The reference numbers a board cites: `data-ref` in drawn views, `[^n]` in text. */
export function shapeCitedRefs(board: ShapeBoard): Set<number> {
  const out = new Set<number>();
  const fromText = (text: string | undefined) => {
    for (const m of (text ?? '').matchAll(/\[\^(\d{1,3})\]/g)) out.add(Number(m[1]));
  };
  const fromHtml = (html: string | undefined) => {
    for (const m of (html ?? '').matchAll(/\sdata-ref\s*=\s*["']?(\d{1,3})/g)) out.add(Number(m[1]));
  };
  fromText(board.claim);
  for (const view of ['picture', 'how'] as const) {
    fromHtml(board.views[view]?.html);
    fromHtml(board.views[view]?.tall?.html);
    fromHtml(board.views[view]?.more?.html);
  }
  fromText(board.views.changed?.summary);
  fromText(board.views.changed?.also);
  for (const item of board.views.changed?.items ?? []) {
    fromText(item.title);
    fromText(item.note);
  }
  for (const flow of board.views.changed?.flows ?? []) fromText(flow.title);
  fromText(board.views.know);
  for (const group of board.views.reqs?.groups ?? []) for (const item of group.items) fromText(item.text);
  for (const foot of board.views.reqs?.foot ?? []) fromText(foot.text);
  fromText(board.views.code?.source);
  return out;
}

export interface ShapeChange {
  view: ShapePartView;
  id: string;
  kind: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
}

export interface ShapeDiff {
  from: number;
  to: number;
  changes: ShapeChange[];
  /** Views whose content changed at all (a part, or anything else in the view). In the dock's order. Never `know` or `changed`: they are not shown. */
  views: ShapeViewId[];
  refs: { added: number[]; removed: number[]; changed: number[] };
}

/** A view, part or note saved when `know` was Requirements says "reqs": it is `know` now. */
export function shapeViewNow<T>(view: T): T | 'know' {
  return (view as unknown) === 'reqs' ? 'know' : view;
}

/** What a view holds on this version. `know` is the words, or an old board's Requirements. */
export function shapeViewContent(views: ShapeBoard['views'], view: ShapeViewId): unknown {
  return view === 'know' ? views.know ?? views.reqs : views[view];
}

type Diffable = Pick<ShapeVersion, 'n' | 'views' | 'parts' | 'refs'> & Partial<Pick<ShapeVersion, 'title' | 'claim'>>;

/** What changed from `a` to `b`, by part ids. Snapshots, so any two versions compare. */
export function diffShapeVersions(a: Diffable, b: Diffable): ShapeDiff {
  const key = (p: ShapePart) => `${p.view}\u0000${p.id}`;
  const now = (p: ShapePart): ShapePart => ({ ...p, view: shapeViewNow(p.view) });
  const shown = (p: ShapePart) => !SHAPE_HIDDEN_VIEWS.has(p.view);
  const partsA = a.parts.map(now).filter(shown);
  const partsB = b.parts.map(now).filter(shown);
  const before = new Map(partsA.map((p) => [key(p), p]));
  const after = new Map(partsB.map((p) => [key(p), p]));
  const changes: ShapeChange[] = [];
  for (const p of partsB) {
    const old = before.get(key(p));
    if (!old) changes.push({ view: p.view, id: p.id, kind: 'added', after: p.text });
    else if (old.text !== p.text) changes.push({ view: p.view, id: p.id, kind: 'changed', before: old.text, after: p.text });
  }
  for (const p of partsA) if (!after.has(key(p))) changes.push({ view: p.view, id: p.id, kind: 'removed', before: p.text });

  const views = SHAPE_VIEWS.map((v) => v.id).filter((view) => !SHAPE_HIDDEN_VIEWS.has(view)).filter((view) => {
    if (changes.some((c) => c.view === view)) return true;
    return JSON.stringify(shapeViewContent(a.views, view) ?? null) !== JSON.stringify(shapeViewContent(b.views, view) ?? null);
  });

  const refsA = new Map((a.refs ?? []).map((r) => [r.n, JSON.stringify(r)]));
  const refsB = new Map((b.refs ?? []).map((r) => [r.n, JSON.stringify(r)]));
  const refs = {
    added: [...refsB.keys()].filter((n) => !refsA.has(n)),
    removed: [...refsA.keys()].filter((n) => !refsB.has(n)),
    changed: [...refsB.keys()].filter((n) => refsA.has(n) && refsA.get(n) !== refsB.get(n)),
  };
  return { from: a.n, to: b.n, changes, views, refs };
}

/** "What changed since you looked", as short lines: one per view, then references. */
export function summarizeShapeDiff(diff: ShapeDiff): string[] {
  const lines: string[] = [];
  const header = diff.changes.filter((c) => c.view === 'header');
  if (header.some((c) => c.id === 'title')) lines.push('The title changed');
  if (header.some((c) => c.id === 'claim')) lines.push('The claim changed');
  for (const view of diff.views) {
    const here = diff.changes.filter((c) => c.view === view);
    const count = (kind: ShapeChange['kind']) => here.filter((c) => c.kind === kind).length;
    const bits = [
      count('changed') && `${count('changed')} changed`,
      count('added') && `${count('added')} added`,
      count('removed') && `${count('removed')} removed`,
    ].filter(Boolean);
    lines.push(`${shapeViewLabel(view)}: ${bits.length ? bits.join(', ') : 'redrawn'}`);
  }
  const r = diff.refs;
  const refBits = [r.added.length && `${r.added.length} added`, r.removed.length && `${r.removed.length} removed`, r.changed.length && `${r.changed.length} changed`].filter(Boolean);
  if (refBits.length) lines.push(`References: ${refBits.join(', ')}`);
  return lines;
}

export interface ShapeNoteInput {
  kind: 'change' | 'ask';
  v: number;
  view?: ShapeViewId | null;
  part?: string | null;
  quote?: string | null;
  text: string;
  box?: ShapeNoteBox;
  code?: string[];
  picture?: string;
}

const NOTE_PICTURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

function checkNoteBox(c: Checker, input: unknown): ShapeNoteBox | undefined {
  if (input === undefined) return undefined;
  const b = isRecord(input) ? input : {};
  const at = [b.x, b.y, b.w, b.h];
  if (!at.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) {
    c.fail('box', 'must be x, y, w and h, each from 0 to 1');
    return undefined;
  }
  const [x, y, w, h] = at as number[];
  return { x: x!, y: y!, w: w!, h: h!, ...(b.tall === true ? { tall: true as const } : {}), ...(b.more === true ? { more: true as const } : {}) };
}

/** Validate a person's Change it or Ask. No part: a general comment (on a view, or the whole board). */
export function checkShapeNoteInput(input: unknown): ShapeCheck<ShapeNoteInput> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: ['a note must be an object'] };
  const kind = input.kind === 'change' || input.kind === 'ask' ? input.kind : undefined;
  if (!kind) c.fail('kind', 'must be "change" or "ask"');
  const v = c.int(input.v, 'v', 1, 1_000_000);
  let view: ShapeViewId | null = null;
  if (input.view !== undefined && input.view !== null) {
    const now = shapeViewNow(input.view);
    if (!SHAPE_VIEWS.some((x) => x.id === now)) c.fail('view', 'must be picture, how, know or code');
    else view = now as ShapeViewId;
  }
  let part: string | null = null;
  if (input.part !== undefined && input.part !== null) {
    if (typeof input.part !== 'string' || !input.part.trim() || input.part.length > 200) c.fail('part', 'must be a part id');
    else part = input.part;
  }
  if (part && !view) c.fail('view', 'is required with a part');
  const quote = c.text(input.quote, 'quote', SHAPE_LIMITS.quote, false) ?? null;
  const text = c.text(input.text, 'text', SHAPE_LIMITS.noteText);
  const box = checkNoteBox(c, input.box);
  if (box && !view) c.fail('view', 'is required with a box');
  const code = input.code === undefined ? undefined : Array.isArray(input.code) && input.code.length <= 40 && input.code.every((t) => typeof t === 'string' && parseShapeCodeTarget(t)) ? (input.code as string[]) : undefined;
  if (input.code !== undefined && !code) c.fail('code', 'must be up to 40 data-code places');
  const picture = input.picture === undefined ? undefined : typeof input.picture === 'string' && input.picture.length <= SHAPE_LIMITS.notePicture && NOTE_PICTURE_RE.test(input.picture) ? input.picture : undefined;
  if (input.picture !== undefined && !picture) c.fail('picture', 'must be a PNG data: URL within the limit');
  if (c.errors.length || !kind || !v || !text) return { ok: false, errors: c.errors };
  return { ok: true, value: { kind, v, view, part, quote, text, ...(box ? { box } : {}), ...(code ? { code } : {}), ...(picture ? { picture } : {}) } };
}

/** The words a person reads on a drawing. */
export function shapeDrawnWords(html: string): number {
  html = html.replace(/<title\b[^>]*>.*?<\/title>/gis, ' ');
  const text = html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** How much of an SVG's viewBox its boxes and words span. Null when it cannot tell (no viewBox, transforms, HTML). */
function shapeDrawingSpan(html: string): { w: number; h: number } | null {
  const box = html.match(/<svg[^>]*viewBox="([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)"/);
  if (!box || !Number(box[3]) || !Number(box[4])) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const m of html.matchAll(/<(rect|text)\b([^>]*)>/g)) {
    const a = (k: string) => Number(m[2]?.match(new RegExp(`\\s${k}="([-\\d.]+)"`))?.[1] ?? NaN);
    if (![a('x'), a('y')].every(Number.isFinite)) continue;
    xs.push(a('x'), a('x') + (a('width') || 0));
    ys.push(a('y'), a('y') + (a('height') || 0));
  }
  if (xs.length < 4) return null;
  return { w: (Math.max(...xs) - Math.min(...xs)) / Number(box[3]), h: (Math.max(...ys) - Math.min(...ys)) / Number(box[4]) };
}

/** What `shape update` tells the agent about a stored board: how it will behave, not a verdict. */
export function shapeBoardNotes(board: Pick<ShapeBoard, 'views' | 'refs'>): string[] {
  const notes: string[] = [];
  const picture = board.views.picture;
  if (!picture) return notes;
  const words = shapeDrawnWords(picture.html);
  if (words > 240) notes.push(`The Picture has ${words} words. Read at a glance, about 200 is the most. Move the rest behind numbers (a ref's sub and images) or to your message to the person.`);
  const scene = shapeHtmlScenes(picture.html).length > 0;
  if (scene) {
    if (picture.width !== undefined) notes.push('The Picture plays a scene, so leave its width and height off: the player fits the drawing and its controls to the screen.');
  } else if (picture.width === undefined) notes.push('The Picture has no width and height, so it scrolls like a page. Give it a fixed canvas: it then always fits one screen.');
  else if (!picture.tall) notes.push('The Picture has no tall drawing, so a phone pans it sideways. That works. For a board you expect on a phone, add views.picture.tall.');
  const cited = [...picture.html.matchAll(/\sdata-ref\s*=\s*["']?(\d{1,3})/g)].map((m) => Number(m[1]));
  const onPicture = (board.refs ?? []).filter((r) => cited.includes(r.n));
  if (!onPicture.length) notes.push('The Picture has no numbers. Put data-ref="n" on the things that have more behind them: the person hovers a number to see its picture and line.');
  const bare = onPicture.filter((r) => !r.sub && !r.images?.length && r.kind !== 'image').map((r) => r.n);
  if (bare.length === 1) notes.push(`Bubble ${bare[0]} shows only a title. Give that ref a sub (one line) or images (a small real picture).`);
  else if (bare.length) notes.push(`Bubbles ${bare.join(', ')} show only a title. Give those refs a sub (one line) or images (a small real picture).`);
  if (!/\sdata-mark\s*=/.test(picture.html)) notes.push('The Picture has no data-mark, so the person cannot point at a part. Put data-mark="id" on each part.');
  const seen = shapeDrawingSpan(picture.html);
  if (seen && (seen.w < 0.6 || seen.h < 0.6)) notes.push(`The drawing fills ${Math.round(seen.w * 100)}% of the canvas's width and ${Math.round(seen.h * 100)}% of its height. Spread it out, or make the viewBox fit it.`);
  const how = board.views.how;
  for (const view of [picture, picture.tall, picture.more, how, how?.tall, how?.more])
    for (const m of (view?.html ?? '').matchAll(/\sdata-missing="([^"]*)"/g)) {
      const note = m[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      if (!notes.includes(note)) notes.push(note);
    }
  const colours = [picture.html.replace(/<svg data-brand\b.*?<\/svg>/gs, ''), picture.css ?? ''].join(' ').match(/#[0-9a-f]{3,8}\b(?=[^<>]*[;"'}])|\brgba?\(/gi);
  if (colours?.length) notes.push(`The Picture has ${colours.length} fixed colours (such as ${colours[0]}), which break in light or dark. Use var(--ink), var(--grey), var(--mark) and the rest.`);
  return notes;
}
