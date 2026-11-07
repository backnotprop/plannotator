/**
 * Things a drawing names instead of drawing: `plannotator shape update` fills them
 * in before it checks the board, so an agent writing SVG by hand gets a real icon,
 * logo or drawn object by name, and the stored board holds plain SVG (no lookup
 * when it is shown, nothing fetched).
 *
 *   <svg data-icon="database" x="40" y="40" width="28" height="28"/>   a Lucide icon, in the ink (or `style="color:…"`)
 *   <svg data-logo="stripe" x="40" y="40" width="40" height="40"/>     a product's real logo, in its own colour
 *   <svg data-draw="database" x="40" y="40" width="160" height="120" data-label="Postgres"/>   a drawn object
 *
 * `data-to="x y"` on any of them sends it from where it is to that point, again
 * and again (an envelope crossing a wire); with reduced motion it stays still, halfway.
 * A filled one carries `data-stamped`, a short hash of what it was drawn from (the
 * name, size, place, label and `data-to`): a board read back and stored again is
 * left as it is, and one whose name, size, place, label or `data-to` was edited is
 * drawn again. A name we do not have is left empty with `data-missing` saying so,
 * which `shape update` passes on as a note (`shapeBoardNotes`).
 */
import { STAMP_CODEX, STAMP_ICON_ALIASES, STAMP_ICONS, STAMP_LOGOS, STAMP_MARKS } from './stamp-data';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Source text as written, made safe inside double quotes or between tags. Its entities are left as they are, so it means the same and a second pass changes nothing. */
const keep = (raw: string) => raw.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
/** What an attribute's source text says: the basic named entities and numeric ones decoded, any other left as written. */
const decode = (raw: string) =>
  raw.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g, (e, d?: string, h?: string, name?: string) => {
    if (name !== undefined) return own(ENTITIES, name) ?? e;
    const c = d !== undefined ? Number(d) : parseInt(h!, 16);
    return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : e;
  });
/** A table's own entry: `constructor`, `__proto__` and the rest of Object's are no names. */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : d;
};
const r = (n: number) => Math.round(n * 10) / 10;

/** A `<svg … data-icon|data-logo|data-draw="…" …>` start tag (empty when `/>` or `></svg>` follows), its attributes kept whole. */
const STAMP_RE = /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>(?:\s*<\/svg>)?/g;
const ATTR_RE = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`=<]+)))?/g;

/** An element's attributes: what each says (decoded), and its source text when it came from the drawing. */
class Attrs {
  private readonly m = new Map<string, { v: string; raw?: string }>();
  constructor(text: string) {
    for (const a of text.matchAll(ATTR_RE)) {
      const raw = a[2] ?? a[3] ?? a[4] ?? '';
      this.m.set(a[1]!.toLowerCase(), { v: decode(raw), raw });
    }
  }
  get(k: string) {
    return this.m.get(k)?.v;
  }
  has(k: string) {
    return this.m.has(k);
  }
  set(k: string, v: string) {
    this.m.set(k, { v });
  }
  delete(k: string) {
    this.m.delete(k);
  }
  /** The value as words between tags: the agent's own text kept as written (so `R&amp;D` stays one ampersand), ours escaped. */
  words(k: string) {
    const a = this.m.get(k);
    return a === undefined ? '' : a.raw !== undefined ? keep(a.raw) : esc(a.v);
  }
  /** The attributes again, each in double quotes. */
  text() {
    return [...this.m].map(([k, a]) => ` ${k}="${a.raw !== undefined ? keep(a.raw) : esc(a.v)}"`).join('');
  }
}

/** What a stamp is drawn from, hashed short (FNV-1a): a filled element whose inputs no longer give this is drawn again. */
function stampKey(attrs: Attrs): string {
  const what = ['data-icon', 'data-logo', 'data-draw', 'width', 'height', 'x', 'y', 'data-label', 'data-to'].map((k) => attrs.get(k) ?? '\u0000').join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < what.length; i++) h = Math.imul(h ^ what.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** A few names agents reach for that Lucide spells another way. */
const ICON_WORDS: Record<string, string> = {
  db: 'database', phone: 'smartphone', mobile: 'smartphone', email: 'mail', envelope: 'mail', person: 'user', people: 'users',
  browser: 'app-window', page: 'file-text', document: 'file-text', doc: 'file-text', payment: 'credit-card', card: 'credit-card', money: 'banknote',
  robot: 'bot', agent: 'bot', ai: 'sparkles', storage: 'hard-drive', disk: 'hard-drive', chip: 'cpu', branch: 'git-branch', pr: 'git-pull-request',
  notification: 'bell', message: 'message-square', chat: 'message-circle', shop: 'store', cart: 'shopping-cart', basket: 'shopping-basket',
  internet: 'globe', web: 'globe', offline: 'wifi-off', location: 'map-pin', desktop: 'monitor', queue: 'list-ordered', retry: 'rotate-cw',
  sync: 'refresh-cw', cron: 'clock', schedule: 'calendar-clock', error: 'circle-x', warning: 'triangle-alert', success: 'circle-check',
  ok: 'circle-check', no: 'ban', never: 'ban', secret: 'key-round', token: 'key-round', password: 'key-round', session: 'cookie', api: 'plug',
  worker: 'cog', function: 'square-function', bucket: 'archive', files: 'folder', file: 'file', home: 'house', search: 'search', settings: 'settings',
};

/** Product names agents write that Simple Icons spells another way. */
const LOGO_WORDS: Record<string, string> = {
  postgres: 'postgresql', pg: 'postgresql', nextjs: 'nextdotjs', next: 'nextdotjs', node: 'nodedotjs', nodejs: 'nodedotjs',
  gcp: 'googlecloud', fly: 'flydotio', golang: 'go', k8s: 'kubernetes', mongo: 'mongodb', elastic: 'elasticsearch',
  twitter: 'x', jwt: 'jsonwebtokens', workers: 'cloudflareworkers', 'cloudflare-workers': 'cloudflareworkers', 'apple-pay': 'applepay',
  'google-pay': 'googlepay', 'github-actions': 'githubactions', chrome: 'googlechrome', 'google-maps': 'googlemaps', ts: 'typescript',
  'socket.io': 'socketdotio', 'fly.io': 'flydotio', 'next.js': 'nextdotjs', 'node.js': 'nodedotjs', 'react-native': 'react',
  playstore: 'googleplay', 'google-play': 'googleplay', 'app-store': 'appstore', iphone: 'apple', 'claude-code': 'claude',
};

const LOGO_NAMES = () => ['claude', 'codex', ...Object.keys(STAMP_MARKS).filter((k) => k !== 'claude'), ...Object.keys(STAMP_LOGOS)];

/** Longer than any real name: no suggestions, which would cost its length times every name. */
const NEAR_MAX = 64;

function near(name: string, names: readonly string[]): string[] {
  const n = name.toLowerCase();
  if (n.length > NEAR_MAX) return [];
  const hits = names.filter((x) => x.includes(n) || (n.length > 3 && n.includes(x)));
  if (hits.length) return hits.sort((a, b) => a.length - b.length).slice(0, 4);
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
  };
  return names.map((x) => [x, dist(n, x)] as const).filter(([, d]) => d <= Math.max(2, n.length / 3)).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([x]) => x);
}

export function stampIcon(name: string): string | null {
  const key = name.trim().toLowerCase();
  return own(STAMP_ICONS, key) ?? own(STAMP_ICONS, own(STAMP_ICON_ALIASES, key) ?? '') ?? own(STAMP_ICONS, own(ICON_WORDS, key) ?? '') ?? null;
}

/** The logo's inner SVG and its viewBox, or null. */
export function stampLogo(name: string): { box: string; body: string; title: string } | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, '');
  const slug = own(LOGO_WORDS, key) ?? key;
  if (slug === 'codex') return { box: '0 0 72 72', body: `<image width="72" height="72" href="${STAMP_CODEX}"/>`, title: 'Codex' };
  const mark = own(STAMP_MARKS, slug);
  // The plain marks (github, gitlab, opencode) draw in the ink, as the kit's mark() does, so they hold on a dark board.
  if (mark) return { box: mark.box, body: `<g style="fill:var(--ink);color:var(--ink)">${mark.body}</g>`, title: slug };
  const logo = own(STAMP_LOGOS, slug);
  if (!logo) return null;
  const paint = logo.c ? `fill="${logo.c}"` : 'style="fill:var(--ink)"';
  return { box: '0 0 24 24', body: `<path ${paint} d="${logo.d}"/>`, title: logo.t };
}

/** Drawn objects: the outline in the current colour (the ink unless `style="color:…"`), filled with a tint of it. */
const OBJECTS: Record<string, { w: number; h: number; draw: (w: number, h: number) => { body: string; face: [number, number, number, number] } }> = {
  database: {
    w: 140, h: 120,
    draw: (w, h) => {
      const rx = w / 2 - 1.5, ry = Math.min(h * 0.13, w * 0.16), top = ry + 1.5, bot = h - ry - 1.5, cx = w / 2;
      const band = (y: number) => `<path d="M1.5 ${r(y)}A${r(rx)} ${r(ry)} 0 0 0 ${r(w - 1.5)} ${r(y)}" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45"/>`;
      const third = (bot - top) / 3;
      return {
        body: `<path d="M1.5 ${r(top)}V${r(bot)}A${r(rx)} ${r(ry)} 0 0 0 ${r(w - 1.5)} ${r(bot)}V${r(top)}" style="fill:color-mix(in oklab, currentColor 7%, var(--surface))" stroke="currentColor" stroke-width="2"/>`
          + band(top + third) + band(top + 2 * third)
          + `<ellipse cx="${r(cx)}" cy="${r(top)}" rx="${r(rx)}" ry="${r(ry)}" style="fill:color-mix(in oklab, currentColor 16%, var(--surface))" stroke="currentColor" stroke-width="2"/>`,
        face: [0, top + ry, w, bot - top - ry],
      };
    },
  },
  server: {
    w: 120, h: 130,
    draw: (w, h) => {
      const n = Math.max(2, Math.min(4, Math.round(h / 45))), gap = 6, uh = (h - 3 - gap * (n - 1)) / n;
      let body = '';
      for (let i = 0; i < n; i++) {
        const y = 1.5 + i * (uh + gap);
        body += `<rect x="1.5" y="${r(y)}" width="${r(w - 3)}" height="${r(uh)}" rx="7" style="fill:color-mix(in oklab, currentColor 7%, var(--surface))" stroke="currentColor" stroke-width="2"/>`
          + `<circle cx="${r(w - 18)}" cy="${r(y + uh / 2)}" r="3.5" style="fill:var(--green, currentColor)"/><path d="M14 ${r(y + uh / 2)}H${r(w * 0.45)}" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".5"/>`;
      }
      return { body, face: [0, 0, w, h] };
    },
  },
  phone: {
    w: 110, h: 200,
    draw: (w, h) => {
      const rr = Math.min(w, h) * 0.16, inset = Math.max(6, w * 0.07);
      return {
        body: `<rect x="1.5" y="1.5" width="${r(w - 3)}" height="${r(h - 3)}" rx="${r(rr)}" style="fill:var(--surface)" stroke="currentColor" stroke-width="2.5"/>`
          + `<rect x="${r(inset)}" y="${r(inset * 2.6)}" width="${r(w - inset * 2)}" height="${r(h - inset * 4.2)}" rx="${r(rr * 0.4)}" style="fill:color-mix(in oklab, currentColor 6%, var(--paper))"/>`
          + `<rect x="${r(w / 2 - w * 0.13)}" y="${r(inset * 1.05)}" width="${r(w * 0.26)}" height="${r(inset * 0.75)}" rx="${r(inset * 0.375)}" style="fill:currentColor" opacity=".7"/>`,
        face: [inset, inset * 2.6, w - inset * 2, h - inset * 4.2],
      };
    },
  },
  laptop: {
    w: 200, h: 130,
    draw: (w, h) => {
      const sh = h * 0.84, bezel = Math.max(6, w * 0.035);
      return {
        body: `<rect x="${r(w * 0.08)}" y="1.5" width="${r(w * 0.84)}" height="${r(sh - 1.5)}" rx="9" style="fill:var(--surface)" stroke="currentColor" stroke-width="2.5"/>`
          + `<rect x="${r(w * 0.08 + bezel)}" y="${r(1.5 + bezel)}" width="${r(w * 0.84 - bezel * 2)}" height="${r(sh - 1.5 - bezel * 2)}" rx="4" style="fill:color-mix(in oklab, currentColor 6%, var(--paper))"/>`
          + `<path d="M1.5 ${r(sh + 3)}H${r(w - 1.5)}L${r(w - 10)} ${r(h - 1.5)}H10Z" style="fill:color-mix(in oklab, currentColor 12%, var(--surface))" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>`,
        face: [w * 0.08 + bezel, 1.5 + bezel, w * 0.84 - bezel * 2, sh - 1.5 - bezel * 2],
      };
    },
  },
  browser: {
    w: 260, h: 170,
    draw: (w, h) => {
      const bar = Math.min(30, h * 0.2);
      return {
        body: `<rect x="1.5" y="1.5" width="${r(w - 3)}" height="${r(h - 3)}" rx="10" style="fill:var(--surface)" stroke="currentColor" stroke-width="2"/>`
          + `<path d="M1.5 ${r(bar)}H${r(w - 1.5)}" stroke="currentColor" stroke-width="1.5" opacity=".5"/>`
          + [0, 1, 2].map((i) => `<circle cx="${r(15 + i * 13)}" cy="${r(bar / 2 + 0.75)}" r="4" style="fill:currentColor" opacity=".35"/>`).join('')
          + `<rect x="${r(58)}" y="${r(bar * 0.24)}" width="${r(Math.max(20, w - 76))}" height="${r(bar * 0.52)}" rx="${r(bar * 0.26)}" style="fill:color-mix(in oklab, currentColor 8%, var(--paper))"/>`,
        face: [0, bar, w, h - bar],
      };
    },
  },
  envelope: {
    w: 56, h: 40,
    draw: (w, h) => ({
      body: `<rect x="1.5" y="1.5" width="${r(w - 3)}" height="${r(h - 3)}" rx="5" style="fill:var(--surface)" stroke="currentColor" stroke-width="2"/>`
        + `<path d="M3 4L${r(w / 2)} ${r(h * 0.58)}L${r(w - 3)} 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
      face: [0, h * 0.58, w, h * 0.42],
    }),
  },
  queue: {
    w: 220, h: 60,
    draw: (w, h) => {
      const n = Math.max(3, Math.min(8, Math.round(w / 48))), pad = 8, cw = (w - pad * 2 - 6 * (n - 1)) / n;
      let cells = '';
      for (let i = 0; i < n; i++) cells += `<rect x="${r(pad + i * (cw + 6))}" y="${r(pad)}" width="${r(cw)}" height="${r(h - pad * 2)}" rx="4" style="fill:color-mix(in oklab, currentColor ${i < n - 2 ? 22 : 6}%, var(--surface))" stroke="currentColor" stroke-width="1.5" opacity="${i < n - 2 ? 1 : 0.55}"/>`;
      return { body: `<rect x="1.5" y="1.5" width="${r(w - 3)}" height="${r(h - 3)}" rx="10" style="fill:var(--surface)" stroke="currentColor" stroke-width="2"/>${cells}`, face: [0, 0, w, h] };
    },
  },
};
const OBJECT_WORDS: Record<string, string> = { db: 'database', cylinder: 'database', smartphone: 'phone', mobile: 'phone', computer: 'laptop', window: 'browser', page: 'browser', web: 'browser', mail: 'envelope', email: 'envelope', message: 'envelope', letter: 'envelope', rack: 'server' };

/** Things whose face is full (slots, cells, a flap): a label goes under them. */
const BELOW = new Set(['server', 'queue', 'envelope']);

/** What `data-draw` can be. */
export const SHAPE_DRAWN_OBJECTS: readonly string[] = Object.keys(OBJECTS);

/** The wrapper that holds a server's, queue's or envelope's label under it. */
const LABEL_UNDER = '<g class="shp-lb">';

function drawObject(kind: string, attrs: Attrs): string | null {
  const key = kind.trim().toLowerCase();
  const name = own(OBJECT_WORDS, key) ?? key;
  const o = own(OBJECTS, name);
  if (!o) return null;
  const w = Math.max(10, num(attrs.get('width'), o.w)), h = Math.max(10, num(attrs.get('height'), o.h));
  attrs.set('width', String(w));
  attrs.set('height', String(h));
  attrs.set('data-stamped', stampKey(attrs));
  const { body, face } = o.draw(w, h);
  const label = attrs.get('data-label');
  if (label && BELOW.has(name)) {
    // Its slots, cells or flap fill the face, so the label goes under it, where nothing is drawn.
    const size = 17;
    const under = `<text x="${r(num(attrs.get('x'), 0) + w / 2)}" y="${r(num(attrs.get('y'), 0) + h + size * 1.35)}" font-size="${size}" font-weight="600" text-anchor="middle">${attrs.words('data-label')}</text>`;
    return `${LABEL_UNDER}<svg${attrs.text()} viewBox="0 0 ${w} ${h}">${body}</svg>${under}</g>`;
  }
  let words = '';
  if (label) {
    const size = Math.max(12, Math.min(26, face[3] * 0.32, (face[2] * 1.7) / Math.max(4, label.length)));
    words = `<text x="${r(face[0] + face[2] / 2)}" y="${r(face[1] + face[3] / 2 + size * 0.36)}" font-size="${r(size)}" font-weight="600" text-anchor="middle">${attrs.words('data-label')}</text>`;
  }
  return `<svg${attrs.text()} viewBox="0 0 ${w} ${h}">${body}${words}</svg>`;
}

/** The moving wrapper for `data-to`: from the element's x, y to the point, again and again (the frame's `.shp-go`). */
function moving(svg: string, attrs: Attrs): string {
  const to = (attrs.get('data-to') ?? '').trim().split(/[\s,]+/).map(Number);
  if (to.length !== 2 || !to.every(Number.isFinite)) return svg;
  const dx = r(to[0]! - num(attrs.get('x'), 0)), dy = r(to[1]! - num(attrs.get('y'), 0));
  return `<g class="shp-go" style="--dx:${dx}px;--dy:${dy}px">${svg}</g>`;
}

export interface ShapeStampResult {
  html: string;
  /** One line per name we do not have, with names we do. */
  missing: string[];
}

/** One element's drawing from its attributes, or the element left empty with `data-missing` (the line goes in `missing`). */
function stamp(attrs: Attrs, missing: string[]): string {
  // Ours from an earlier drawing: drawn again from the inputs alone.
  for (const k of ['data-missing', 'data-stamped', 'data-brand', 'viewbox']) attrs.delete(k);
  const miss = (line: string) => {
    missing.push(line);
    attrs.set('data-missing', line);
    return `<svg${attrs.text()}/>`;
  };
  const icon = attrs.get('data-icon'), logo = attrs.get('data-logo'), draw = attrs.get('data-draw');
  let filled: string;
  if (draw !== undefined) {
    const drawn = drawObject(draw, attrs);
    if (!drawn) return miss(`data-draw="${draw}": no such drawn object. There are: ${SHAPE_DRAWN_OBJECTS.join(', ')}.`);
    filled = drawn;
  } else if (logo !== undefined) {
    const l = stampLogo(logo);
    if (!l) {
      const close = near(logo, LOGO_NAMES());
      return miss(`data-logo="${logo}": no logo by that name${close.length ? `; close: ${close.join(', ')}` : ''}. Use its real logo as a picture (<image href="https://…"/>, or a file), or write the product's name as words with an icon.`);
    }
    if (!attrs.has('width')) attrs.set('width', '40');
    if (!attrs.has('height')) attrs.set('height', '40');
    attrs.set('data-stamped', stampKey(attrs));
    filled = `<svg data-brand${attrs.text()} viewBox="${l.box}"><title>${esc(l.title)}</title>${l.body}</svg>`;
  } else {
    const body = stampIcon(icon ?? '');
    if (!body) {
      const close = near(icon ?? '', [...Object.keys(STAMP_ICONS), ...Object.keys(ICON_WORDS)]);
      return miss(`data-icon="${icon}": no icon by that name${close.length ? `; close: ${close.join(', ')}` : ''}. Icons are Lucide's names (lucide.dev).`);
    }
    if (!attrs.has('width')) attrs.set('width', '24');
    if (!attrs.has('height')) attrs.set('height', '24');
    for (const [k, v] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']] as const) if (!attrs.has(k)) attrs.set(k, v);
    attrs.set('data-stamped', stampKey(attrs));
    filled = `<svg${attrs.text()} viewBox="0 0 24 24">${body}</svg>`;
  }
  return attrs.has('data-to') ? moving(filled, attrs) : filled;
}

const MOVING_BEFORE = /<g class="shp-go" style="--dx:-?[\d.]+px;--dy:-?[\d.]+px">$/;
const LABEL_AFTER = /<text\b[^>]*>[^<]*<\/text><\/g>/y;

/**
 * Where an earlier stamp's drawing ends, and how far before its `<svg` it starts (its label and
 * moving wrappers), or null when it is not as we drew it (hand-made, or edited inside): left as it is.
 */
function stampedSpan(html: string, from: number, openStart: number, openEnd: number): { start: number; end: number } | null {
  const close = html.indexOf('</svg>', openEnd);
  if (close < 0 || html.slice(openEnd, close).includes('<svg')) return null;
  let start = openStart, end = close + '</svg>'.length;
  const before = html.slice(from, openStart);
  if (before.endsWith(LABEL_UNDER)) {
    LABEL_AFTER.lastIndex = end;
    const label = LABEL_AFTER.exec(html);
    if (!label) return null;
    start -= LABEL_UNDER.length;
    end += label[0].length;
  }
  const go = html.slice(from, start).match(MOVING_BEFORE);
  if (go) {
    if (!html.startsWith('</g>', end)) return null;
    start -= go[0].length;
    end += '</g>'.length;
  }
  return { start, end };
}

/**
 * Fills in every empty `data-icon`, `data-logo` and `data-draw` element, and draws again one we
 * filled before whose inputs were edited since (its `data-stamped` no longer matches them).
 */
export function expandShapeStamps(html: string): ShapeStampResult {
  const missing: string[] = [];
  if (!/data-(?:icon|logo|draw)\b/i.test(html)) return { html, missing };
  const re = new RegExp(STAMP_RE.source, 'g');
  let out = '', at = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const whole = m[0], text = m[1]!;
    if (!/data-(?:icon|logo|draw)\b/i.test(text)) continue;
    const attrs = new Attrs(text);
    if (!attrs.has('data-icon') && !attrs.has('data-logo') && !attrs.has('data-draw')) continue;
    const empty = /\/>$/.test(whole) || />\s*<\/svg>$/.test(whole);
    let start = m.index, end = m.index + whole.length;
    if (!empty) {
      // Filled: by hand (no data-stamped), or by us from the inputs it still has. Either way, left as it is.
      const was = attrs.get('data-stamped');
      if (!was || was === stampKey(attrs)) continue;
      const span = stampedSpan(html, at, m.index, end);
      if (!span) continue;
      ({ start, end } = span);
    }
    out += html.slice(at, start) + stamp(attrs, missing);
    at = end;
    re.lastIndex = end;
  }
  return { html: out + html.slice(at), missing };
}

type Drawn = { html?: unknown; tall?: { html?: unknown }; more?: { html?: unknown } };

/** The board with its drawn views' stamps filled in, and what could not be. The board's shape is otherwise untouched. */
export function expandBoardStamps(board: unknown): { board: unknown; missing: string[] } {
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  // Not a board's shape: left for the checks to refuse as written.
  if (!plain(board)) return { board, missing: [] };
  const views = board.views;
  if (!plain(views)) return { board, missing: [] };
  const missing: string[] = [];
  const fill = <T extends { html?: unknown }>(part: T | undefined): T | undefined => {
    if (!plain(part) || typeof part.html !== 'string') return part;
    const r = expandShapeStamps(part.html);
    for (const m of r.missing) if (!missing.includes(m)) missing.push(m);
    return r.html === part.html ? part : { ...part, html: r.html };
  };
  const nextViews: Record<string, unknown> = { ...views };
  for (const id of ['picture', 'how']) {
    const v = views[id] as Drawn | undefined;
    if (!plain(v)) continue;
    const top = fill(v) as Drawn;
    nextViews[id] = { ...top, ...(v.tall ? { tall: fill(v.tall) } : {}), ...(v.more ? { more: fill(v.more) } : {}) };
  }
  return { board: { ...board, views: nextViews }, missing };
}
