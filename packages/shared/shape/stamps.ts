/**
 * Things a drawing names instead of drawing: the store fills them in before it
 * checks the board, so an agent writing SVG by hand gets a real icon, logo or
 * drawn object by name, and the stored board holds plain SVG (no lookup when it
 * is shown, nothing fetched).
 *
 *   <svg data-icon="database" x="40" y="40" width="28" height="28"/>   a Lucide icon, in the ink (or `style="color:…"`)
 *   <svg data-logo="stripe" x="40" y="40" width="40" height="40"/>     a product's real logo, in its own colour
 *   <svg data-draw="database" x="40" y="40" width="160" height="120" data-label="Postgres"/>   a drawn object
 *
 * `data-to="x y"` on any of them sends it from where it is to that point, again
 * and again (an envelope crossing a wire); with reduced motion it stays still, halfway.
 * An empty element only: one that already holds a drawing (a board read back) is
 * left as it is. A name we do not have is left empty with `data-missing` saying
 * so, which `shape update` passes on as a note (`shapeBoardNotes`).
 */
import { STAMP_CODEX, STAMP_ICON_ALIASES, STAMP_ICONS, STAMP_LOGOS, STAMP_MARKS } from './stamp-data';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : d;
};
const r = (n: number) => Math.round(n * 10) / 10;

/** An empty `<svg … data-icon|data-logo|data-draw="…" …/>` (or `…></svg>`), its attributes kept whole. */
const STAMP_RE = /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>(?:\s*<\/svg>)?/g;
const ATTR_RE = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'`=<]+)))?/g;

function attrsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(ATTR_RE)) out.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function attrText(attrs: Map<string, string>): string {
  return [...attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
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

function near(name: string, names: readonly string[]): string[] {
  const n = name.toLowerCase();
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
  const found = STAMP_ICONS[key] ?? STAMP_ICONS[STAMP_ICON_ALIASES[key] ?? ''] ?? STAMP_ICONS[ICON_WORDS[key] ?? ''];
  return found ?? null;
}

/** The logo's inner SVG and its viewBox, or null. */
export function stampLogo(name: string): { box: string; body: string; title: string } | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, '');
  const slug = LOGO_WORDS[key] ?? key;
  if (slug === 'codex') return { box: '0 0 72 72', body: `<image width="72" height="72" href="${STAMP_CODEX}"/>`, title: 'Codex' };
  const mark = STAMP_MARKS[slug];
  // The plain marks (github, gitlab, opencode) draw in the ink, as the kit's mark() does, so they hold on a dark board.
  if (mark) return { box: mark.box, body: `<g style="fill:var(--ink);color:var(--ink)">${mark.body}</g>`, title: slug };
  const logo = STAMP_LOGOS[slug];
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

function drawObject(kind: string, attrs: Map<string, string>): string | null {
  const key = kind.trim().toLowerCase();
  const o = OBJECTS[OBJECT_WORDS[key] ?? key];
  if (!o) return null;
  const w = Math.max(10, num(attrs.get('width'), o.w)), h = Math.max(10, num(attrs.get('height'), o.h));
  attrs.set('width', String(w));
  attrs.set('height', String(h));
  const { body, face } = o.draw(w, h);
  const label = attrs.get('data-label');
  if (label && BELOW.has(OBJECT_WORDS[key] ?? key)) {
    // Its slots, cells or flap fill the face, so the label goes under it, where nothing is drawn.
    const size = 17;
    const under = `<text x="${r(num(attrs.get('x'), 0) + w / 2)}" y="${r(num(attrs.get('y'), 0) + h + size * 1.35)}" font-size="${size}" font-weight="600" text-anchor="middle">${esc(label)}</text>`;
    return `<g><svg${attrText(attrs)} viewBox="0 0 ${w} ${h}">${body}</svg>${under}</g>`;
  }
  let words = '';
  if (label) {
    const size = Math.max(12, Math.min(26, face[3] * 0.32, (face[2] * 1.7) / Math.max(4, label.length)));
    words = `<text x="${r(face[0] + face[2] / 2)}" y="${r(face[1] + face[3] / 2 + size * 0.36)}" font-size="${r(size)}" font-weight="600" text-anchor="middle">${esc(label)}</text>`;
  }
  return `<svg${attrText(attrs)} viewBox="0 0 ${w} ${h}">${body}${words}</svg>`;
}

/** The moving wrapper for `data-to`: from the element's x, y to the point, again and again (the frame's `.shp-go`). */
function moving(svg: string, attrs: Map<string, string>): string {
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

/** Fills in every empty `data-icon`, `data-logo` and `data-draw` element. */
export function expandShapeStamps(html: string): ShapeStampResult {
  const missing: string[] = [];
  if (!/data-(?:icon|logo|draw)\b/i.test(html)) return { html, missing };
  const out = html.replace(STAMP_RE, (whole, text: string) => {
    if (!/data-(?:icon|logo|draw)\b/i.test(text)) return whole;
    // Already filled (a board read back and stored again): `/>` or `></svg>` with nothing between is all we fill.
    if (!/\/>$/.test(whole) && !/>\s*<\/svg>$/.test(whole)) return whole;
    const attrs = attrsOf(text);
    attrs.delete('data-missing');
    let filled: string | null = null;
    const miss = (line: string) => {
      missing.push(line);
      attrs.set('data-missing', line);
      return `<svg${attrText(attrs)}/>`;
    };
    const icon = attrs.get('data-icon'), logo = attrs.get('data-logo'), draw = attrs.get('data-draw');
    if (draw !== undefined) {
      filled = drawObject(draw, attrs);
      if (!filled) return miss(`data-draw="${draw}": no such drawn object. There are: ${SHAPE_DRAWN_OBJECTS.join(', ')}.`);
    } else if (logo !== undefined) {
      const l = stampLogo(logo);
      if (l) {
        if (!attrs.has('width')) attrs.set('width', '40');
        if (!attrs.has('height')) attrs.set('height', '40');
        attrs.delete('data-brand');
        filled = `<svg data-brand${attrText(attrs)} viewBox="${l.box}"><title>${esc(l.title)}</title>${l.body}</svg>`;
      } else {
        const close = near(logo, LOGO_NAMES());
        return miss(`data-logo="${logo}": no logo by that name${close.length ? `; close: ${close.join(', ')}` : ''}. Write the product's name as words, and give it an icon.`);
      }
    } else if (icon !== undefined) {
      const body = stampIcon(icon);
      if (body) {
        if (!attrs.has('width')) attrs.set('width', '24');
        if (!attrs.has('height')) attrs.set('height', '24');
        for (const [k, v] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) if (!attrs.has(k!)) attrs.set(k!, v!);
        filled = `<svg${attrText(attrs)} viewBox="0 0 24 24">${body}</svg>`;
      } else {
        const close = near(icon, [...Object.keys(STAMP_ICONS), ...Object.keys(ICON_WORDS)]);
        return miss(`data-icon="${icon}": no icon by that name${close.length ? `; close: ${close.join(', ')}` : ''}. Icons are Lucide's names (lucide.dev).`);
      }
    }
    if (!filled) return whole;
    return attrs.has('data-to') ? moving(filled, attrs) : filled;
  });
  return { html: out, missing };
}

type Drawn = { html?: unknown; tall?: { html?: unknown }; more?: { html?: unknown } };

/** The board with its drawn views' stamps filled in, and what could not be. The board's shape is otherwise untouched. */
export function expandBoardStamps(board: unknown): { board: unknown; missing: string[] } {
  if (!board || typeof board !== 'object') return { board, missing: [] };
  const views = (board as { views?: Record<string, unknown> }).views;
  if (!views || typeof views !== 'object') return { board, missing: [] };
  const missing: string[] = [];
  const fill = <T extends { html?: unknown }>(part: T | undefined): T | undefined => {
    if (!part || typeof part !== 'object' || typeof part.html !== 'string') return part;
    const r = expandShapeStamps(part.html);
    for (const m of r.missing) if (!missing.includes(m)) missing.push(m);
    return r.html === part.html ? part : { ...part, html: r.html };
  };
  const nextViews: Record<string, unknown> = { ...views };
  for (const id of ['picture', 'how']) {
    const v = views[id] as Drawn | undefined;
    if (!v || typeof v !== 'object') continue;
    const top = fill(v) as Drawn;
    nextViews[id] = { ...top, ...(v.tall ? { tall: fill(v.tall) } : {}), ...(v.more ? { more: fill(v.more) } : {}) };
  }
  return { board: { ...(board as object), views: nextViews }, missing };
}
