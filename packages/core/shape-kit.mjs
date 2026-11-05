// Optional helpers for a Shape board: sharp boxes, lines, labels, numbers. They follow the person's theme. No dependencies; run it with node or bun.
// You can do all of this by hand. Same input, same picture: nothing here is random.
//
//   plannotator shape kit > kit.mjs
//
//   import { box, line, text, part, pin, svg, board } from './kit.mjs';
//   // Draw the thing itself: here, a page and what is on it.
//   const wide = box(40, 40, 820, 400)
//     + part('list', 1, box(40, 40, 220, 400), text(60, 84, 'Reviews'))
//     + part('diff', 2, line([[300, 110], [800, 110]], { tone: 'soft' }), line([[300, 150], [720, 150]], { tone: 'soft' }), text(300, 84, 'PR diff'))
//     + pin(1, 260, 40);
//   board({
//     out: 'board.json', title: 'One review', claim: 'Built. Nothing waits on you.',
//     picture: svg(900, 480, wide),
//     refs: [{ n: 1, kind: 'image', title: 'The list', sub: 'One line.', target: 'list.png', images: [{ src: 'list.png', alt: 'The list', crop: [0, 0, 0.3, 0.4] }] }],
//   });
//   plannotator shape update --file board.json
//
// A board of real objects: dots(w, h) the board; pic(x, y, w, h, 'crop.png', { dark: 'crop-dark.png' }) pastes a real picture;
// tile('claude', x, y) a real mark; card and sticky are objects; later ones sit on earlier ones, so let them overlap a little.
//
// A flow with branches: wrap what belongs to a path in on(['a'], ...), put pick('a', x, y, w, h, 'Case A') and pick('all', x, y, w, h, 'All paths', { of: ['a', 'b'], checked: true })
// on the board, and give the view followCss(['a', 'b']): how: { ...svg(w, h, body), css: followCss(['a', 'b']) }. Picking one lights its path. No script.

import { writeFileSync } from 'node:fs';

const STROKE = 2.5;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const strokeClass = { ink: 'line', soft: 'grey', accent: 'acc', alert: 'alert' };
const paint = (tone, dash) => `class="${strokeClass[tone] ?? 'line'}${dash ? ' dash' : ''}" fill="none" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"`;

/** A rectangle. tone: ink, soft, accent, alert. dash: not built yet. */
export const box = (x, y, w, h, { tone = 'ink', dash = false, r = 8 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ${paint(tone, dash).replace('fill="none"', 'style="fill:var(--paper)"')}/>`;

/** Straight segments with rounded elbows. Points are [x, y]. */
export function line(points, { tone = 'ink', dash = false, arrow = false, head = 12, r = 12 } = {}) {
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const k = Math.min(r, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(c[0] - b[0], c[1] - b[1]) / 2);
    const to = (p) => { const L = Math.hypot(p[0] - b[0], p[1] - b[1]); return `${b[0] + ((p[0] - b[0]) / L) * k} ${b[1] + ((p[1] - b[1]) / L) * k}`; };
    d += `L${to(a)}Q${b[0]} ${b[1]} ${to(c)}`;
  }
  const end = points[points.length - 1];
  d += `L${end[0]} ${end[1]}`;
  let out = `<path d="${d}" ${paint(tone, dash)}/>`;
  if (arrow) {
    const prev = points[points.length - 2];
    const a = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
    const wing = (t) => `${(end[0] + Math.cos(a + t) * head).toFixed(1)} ${(end[1] + Math.sin(a + t) * head).toFixed(1)}`;
    out += `<path d="M${wing(2.55)}L${end[0]} ${end[1]}L${wing(-2.55)}" ${paint(tone)}/>`;
  }
  return out;
}

/** A line with an arrowhead, when the point really is a direction. */
export const arrow = (points, options = {}) => line(points, { arrow: true, ...options });

/** A label. size in canvas units; mono for anything code-like. */
export const text = (x, y, words, { size = 26, weight = 500, tone = 'ink', anchor = 'start', mono = false } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" class="${{ soft: 't-grey', accent: 't-acc', alert: 't-alert' }[tone] ?? ''}${mono ? ' t-mono' : ''}">${esc(words)}</text>`;

/** A part the person can point at (data-mark). step: when it arrives. */
export const part = (id, step, ...drawn) => `<g data-mark="${esc(id)}" data-step="${step}">${drawn.join('')}</g>`;

/** A number on the board, for reference n in refs. The board does the rest: hover, tap, picture, full view. */
export const pin = (n, x, y, { size = 15, alert = false, glyph } = {}) =>
  `<g data-ref="${n}"><circle cx="${x}" cy="${y}" r="${size + 9}" fill="transparent"/><circle cx="${x}" cy="${y}" r="${size}" style="fill:var(--${alert ? 'alert' : 'mark'})"/><text x="${x}" y="${y + size * 0.38}" font-size="${size * 1.1}" font-weight="700" text-anchor="middle" style="fill:var(--paper)">${esc(glyph ?? n)}</text></g>`;

/** A small mark for a way that is closed. */
export const cross = (x, y, s = 9, tone = 'alert') => line([[x - s, y - s], [x + s, y + s]], { tone, arrow: false }) + line([[x - s, y + s], [x + s, y - s]], { tone, arrow: false });

/** The whole drawing, on a fixed canvas w by h. x, y: where the canvas starts. */
export const svg = (w, h, body, { x = 0, y = 0, label } = {}) => ({
  html: `<svg viewBox="${x} ${y} ${w} ${h}" width="100%"${label ? ` aria-label="${esc(label)}"` : ''}>${body}</svg>`, width: w, height: h,
});

/** Writes the board's JSON. picture: svg(…); tall (a phone), more (Show more): svg(…) too. */
export function board({ out = 'board.json', title, claim, note, picture, tall, more, css, how, know, refs = [] }) {
  const pic = { ...picture };
  if (css) pic.css = css;
  if (tall) pic.tall = { html: tall.html };
  if (more) pic.more = { html: more.html };
  writeFileSync(out, JSON.stringify({ title, claim, ...(note ? { note } : {}), views: { picture: pic, ...(how ? { how } : {}), ...(know ? { know } : {}) }, refs }, null, 1));
}

/** Drawn things that belong to these paths. Drawn with no `on`, a thing never fades. */
export const on = (paths, ...drawn) => `<g class="d ${paths.map((p) => `on-${p}`).join(' ')}">${drawn.join('')}</g>`;

/** A control on the board: pick it and only its path stays lit. of: the paths it stays lit on. checked: picked at the start. */
export const pick = (path, x, y, w, h, words, { of = [path], dash = false, size = 22, checked = false } = {}) =>
  `<foreignObject x="${x}" y="${y}" width="${w}" height="${h}"><label xmlns="http://www.w3.org/1999/xhtml" class="pick${dash ? ' dash' : ''} ${of.map((p) => `on-${p}`).join(' ')}" style="font-size:${size}px"><input type="radio" name="follow" class="f-${path}"${checked ? ' checked=""' : ''}/><span>${esc(words)}</span></label></foreignObject>`;

/** The view's css for on and pick. paths: every path you drew. */
export const followCss = (paths) => `
.d { transition: opacity .22s ease; }
.pick { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 100%; height: 100%; border-radius: 999px; border: 2px solid var(--ink2); background: var(--surface); color: var(--ink); font-weight: 600; cursor: pointer; white-space: nowrap; user-select: none; }
.pick.dash { border-style: dashed; border-color: var(--mark); color: var(--mark); }
.pick input { appearance: none; margin: 0; width: 0; height: 0; }
.pick:hover { background: var(--mark-soft); }
.pick:has(input:checked) { background: var(--mark); border-color: var(--mark); color: var(--paper); }
.pick:has(input:focus-visible) { outline: 3px solid var(--mark); outline-offset: 2px; }
${paths.map((p) => `.board:has(.f-${p}:checked) .d:not(.on-${p}) { opacity: .12; }\n.board:has(.f-${p}:checked) .pick:not(.on-${p}):not(:has(input:checked)) { color: var(--grey); border-color: var(--rule); }\n.board:has(.f-${p}:checked) .on-${p} path.grey { stroke: var(--mark); }`).join('\n')}
.board.reduce .d { transition: none; }
@media (prefers-reduced-motion: reduce) { .d { transition: none; } }
`;

// The product's own marks, the ones beside Copy prompt, plus GitHub and GitLab. A script in any language can lift these.
const MARKS = {"claude": {"box": "0 0 32 32", "body": "<path d=\"m6.283 21.28 6.293-3.531.106-.306-.106-.171h-.307l-1.051-.065-3.596-.097-3.118-.13-3.021-.162-.761-.161-.712-.94.073-.469.639-.429.916.08 2.023.138 3.037.209 2.203.13 3.263.339h.518l.073-.21-.177-.129-.138-.13-3.142-2.129-3.401-2.25-1.782-1.296-.963-.656-.486-.616-.21-1.343.875-.963 1.175.08.3.08 1.19.915 2.542 1.967 3.319 2.445.486.404.194-.138.024-.097-.218-.365-1.806-3.263-1.926-3.32-.857-1.375-.227-.825c-.08-.339-.138-.624-.138-.972L8.384.177 8.935 0l1.328.177.56.486.824 1.887 1.337 2.972 2.073 4.04.607 1.199.324 1.11.121.339h.21v-.194l.17-2.276.315-2.795.307-3.596.106-1.012.501-1.214.995-.657.778.372.639.916-.088.591-.381 2.471-.745 3.87-.485 2.591h.282l.324-.324 1.311-1.74 2.203-2.754.972-1.093 1.133-1.207.728-.574h1.376l1.013 1.505-.454 1.555-1.416 1.797-1.175 1.522-1.685 2.268-1.051 1.814.097.144.25-.023 3.805-.81 2.056-.372 2.454-.421 1.11.518.12.527-.436 1.078-2.624.648-3.077.615-4.582 1.084-.057.041.065.08 2.065.195.883.047h2.162l4.025.3 1.052.696.63.851-.106.647-1.619.825-2.186-.518-5.1-1.214-1.75-.436h-.242v.145l1.458 1.425 2.671 2.412 3.346 3.11.17.769-.43.607-.453-.065-2.939-2.211-1.134-.996-2.568-2.162h-.17v.227l.591.866 3.125 4.697.162 1.441-.226.468-.81.283-.89-.162-1.829-2.568-1.888-2.891-1.522-2.592-.186.106-.898 9.677-.421.495-.972.371-.81-.615-.43-.996.43-1.967.518-2.568.422-2.041.38-2.535.226-.842-.015-.056-.185.023-1.912 2.624-2.906 3.928-2.3 2.462-.551.218-.954-.494.088-.883.533-.787 3.184-4.049 1.919-2.509 1.24-1.449-.009-.21h-.073l-8.455 5.49-1.505.194-.648-.607.08-.995.307-.324 2.542-1.749-.009.008z\" fill=\"#d97757\"/>"}, "pi": {"box": "130 130 540 540", "body": "<path fill=\"#F09082\" d=\"M165.29 165.29H517.36V400H400V282.65H165.29Z\"/><path fill=\"#4D9ABF\" d=\"M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z\"/><path fill=\"#F1BE58\" d=\"M517.36 400H634.72V634.72H517.36Z\"/>"}, "opencode": {"box": "0 0 32 32", "body": "<path d=\"M3 32V0h26v32zM22 7H10v18h12z\" fill=\"currentColor\"/><path d=\"M10 13h12v12H10z\" fill=\"currentColor\" opacity=\"0.4\"/>"}, "github": {"box": "0 0 16 16", "body": "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z\"/>"}, "gitlab": {"box": "90 90 200 195", "body": "<path d=\"M282.83 170.73l-.27-.69-26.14-68.22a6.81 6.81 0 00-2.69-3.24 7 7 0 00-8 .43 7 7 0 00-2.32 3.52l-17.65 54h-71.47l-17.65-54a6.86 6.86 0 00-2.32-3.53 7 7 0 00-8-.43 6.87 6.87 0 00-2.69 3.24L97.44 170l-.26.69a48.54 48.54 0 0016.1 56.1l.09.07.24.17 39.82 29.82 19.7 14.91 12 9.06a8.07 8.07 0 009.76 0l12-9.06 19.7-14.91 40.06-30 .1-.08a48.56 48.56 0 0016.08-56.04z\"/><path d=\"M282.83 170.73l-.27-.69a88.3 88.3 0 00-35.15 15.8L190 229.25c19.55 14.79 36.57 27.64 36.57 27.64l40.06-30 .1-.08a48.56 48.56 0 0016.1-56.08z\" opacity=\"0.7\"/><path d=\"M153.43 256.89l19.7 14.91 12 9.06a8.07 8.07 0 009.76 0l12-9.06 19.7-14.91s-17.04-12.89-36.59-27.64c-19.55 14.75-36.57 27.64-36.57 27.64z\" opacity=\"0.85\"/><path d=\"M132.58 185.84A88.19 88.19 0 0097.44 170l-.26.69a48.54 48.54 0 0016.1 56.1l.09.07.24.17 39.82 29.82s17-12.85 36.57-27.64z\" opacity=\"0.7\"/>"}};
const CODEX = "data:image/png;base64,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";

/** A real mark: claude, codex, pi, opencode, github, gitlab. Keeps its own colours; the plain ones follow the theme. */
export function mark(name, x, y, size = 40) {
  if (name === 'codex') return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="${CODEX}"/>`;
  const m = MARKS[name];
  if (!m) throw new Error(`${name} is not in the kit (${['codex', ...Object.keys(MARKS)].join(', ')}). Write its name as plain text.`);
  return `<svg data-brand x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${m.box}" style="fill:var(--ink);color:var(--ink)">${m.body}</svg>`;
}

/** A mark on a little tile, an object you can overlap. */
export const tile = (name, x, y, size = 56) =>
  `<g class="obj"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${size * 0.22}" style="fill:var(--surface);stroke:var(--rule)" stroke-width="1.5"/>${mark(name, x + size * 0.2, y + size * 0.2, size * 0.6)}</g>`;

/** A real picture pasted on the board, framed so a white screenshot holds on a dark board. dark: its dark twin. */
export function pic(x, y, w, h, src, { dark, r = 10, alt = '', anchor = 'xMinYMin' } = {}) {
  const id = `c${Math.abs([...`${x},${y},${w},${h},${src}`].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7))}`;
  const image = (href, cls) => `<image${cls ? ` class="${cls}"` : ''} x="${x}" y="${y}" width="${w}" height="${h}" href="${esc(href)}" preserveAspectRatio="${anchor} slice" clip-path="url(#${id})"><title>${esc(alt)}</title></image>`;
  return `<g class="obj"><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" style="fill:var(--surface)"/>${dark ? image(src, 'if-light') + image(dark, 'if-dark') : image(src)}<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" style="stroke:var(--rule)" stroke-width="1.5"/></g>`;
}

/** A small name tag on an object, like a frame's name. dash: not built yet. */
export function tag(x, y, words, { size = 20, dash = false, tone = 'accent' } = {}) {
  const w = String(words).length * size * 0.56 + size * 1.1;
  const h = size * 1.7;
  const on = dash ? `style="fill:var(--paper);stroke:var(--mark)" stroke-width="2" stroke-dasharray="6 5"` : `style="fill:var(--${tone === 'alert' ? 'alert' : tone === 'ink' ? 'ink' : 'mark'})"`;
  const ink = dash ? 'var(--mark)' : 'var(--paper)';
  return `<g class="tag"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h * 0.3}" ${on}/><text x="${x + w / 2}" y="${y + h * 0.69}" font-size="${size}" font-weight="600" text-anchor="middle" style="fill:${ink}">${esc(words)}</text></g>`;
}

/** The board itself: faint dots behind everything. Draw it first. */
export const dots = (w, h, { x = 0, y = 0, gap = 28 } = {}) =>
  `<defs><pattern id="dots" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse"><circle cx="${gap / 2}" cy="${gap / 2}" r="1.4" style="fill:var(--rule)"/></pattern></defs><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#dots)"/>`;

/** A solid card, an object rather than an outline. */
export const card = (x, y, w, h, { r = 12 } = {}) =>
  `<rect class="obj" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" style="fill:var(--surface);stroke:var(--rule)" stroke-width="1.5"/>`;

/** A sticky note: someone's own words. lines: one string per line. */
export function sticky(x, y, w, h, lines, { size = 24 } = {}) {
  const words = lines.map((l, i) => `<text x="${x + size * 0.9}" y="${y + size * 1.7 + i * size * 1.35}" font-size="${size}" font-weight="500">${esc(l)}</text>`).join('');
  return `<g class="obj"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" style="fill:color-mix(in oklab, var(--mark) 22%, var(--surface));stroke:var(--mark)" stroke-width="1.5"/>${words}</g>`;
}
