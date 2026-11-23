/**
 * The Inbox's own endpoints, read from the server's code as text (no server
 * module is imported, and nothing here runs in the server). It is Inbox code:
 * tests/inbox-api-table.test.ts holds docs/agent-guides/server-and-storage.md's
 * Inbox API table to it, and a new route module is added to ROUTE_FILES here.
 * The native app's parity surface reads the same list (`window:` entries,
 * scripts/mobile/surface.ts); keeping that in step is the mobile contract's
 * job, never an Inbox pull request's.
 *
 * The Inbox answers a request through one long chain of checks in
 * packages/server/inbox.ts and the route modules it calls. What is read:
 *  - a path compared whole (`path === "/api/inbox/health"`, or a constant
 *    holding one), an exact route;
 *  - a route pattern (`/^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/seen$/`),
 *    an exact route with its parameters as `:id`, and each alternative of a
 *    group of plain words its own route;
 *  - a prefix a module takes whole (`path.startsWith("/api/shapes/")`), a
 *    family `<prefix>/*`, listed only when no exact route is read under it:
 *    the module splits the rest itself, and those routes are not read.
 * Methods are not read: the chain decides them in many ways (an early 405, a
 * method in the same check), so an entry is a path.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

/** A repository file's text, by its path from the root. */
export function readSource(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/**
 * The files that answer the Inbox's requests: inbox.ts and every route module
 * it calls. tests/inbox-api-table.test.ts fails when a module inbox.ts
 * imports compares request paths and is not listed here.
 */
export const ROUTE_FILES = [
  'packages/server/inbox.ts',
  'packages/ai/endpoints.ts',
  'packages/server/inbox-acted.ts',
  'packages/server/inbox-agent-door.ts',
  'packages/server/inbox-agent-faces.ts',
  'packages/server/inbox-agent-icons.ts',
  'packages/server/inbox-app-icons.ts',
  'packages/server/inbox-artifact-pins.ts',
  'packages/server/inbox-ask.ts',
  'packages/server/inbox-attachments.ts',
  'packages/server/inbox-cf-access-routes.ts',
  'packages/server/inbox-combine.ts',
  'packages/server/inbox-comment-drafts.ts',
  'packages/server/inbox-compose.ts',
  'packages/server/inbox-decision-export.ts',
  'packages/server/inbox-decision-post.ts',
  'packages/server/inbox-devices.ts',
  'packages/server/inbox-embeds.ts',
  'packages/server/inbox-feedback.ts',
  'packages/server/inbox-guides.ts',
  'packages/server/inbox-icon-sets.ts',
  'packages/server/inbox-launch.ts',
  'packages/server/inbox-linear-key.ts',
  'packages/server/inbox-linear-cards.ts',
  'packages/server/inbox-live-review.ts',
  'packages/server/inbox-live.ts',
  'packages/server/inbox-machines.ts',
  'packages/server/inbox-message-images.ts',
  'packages/server/inbox-open-in.ts',
  'packages/server/inbox-pages.ts',
  'packages/server/inbox-pins.ts',
  'packages/server/inbox-priority.ts',
  'packages/server/inbox-project-tags.ts',
  'packages/server/inbox-reply-drafts.ts',
  'packages/server/inbox-run-routes.ts',
  'packages/server/inbox-scheduled-routes.ts',
  'packages/server/inbox-search.ts',
  'packages/server/inbox-sessions.ts',
  'packages/server/inbox-skills.ts',
  'packages/server/inbox-snooze.ts',
  'packages/server/inbox-steps.ts',
  'packages/server/inbox-system.ts',
  'packages/server/inbox-tags.ts',
  'packages/server/inbox-tailscale.ts',
  'packages/server/inbox-take-back.ts',
  'packages/server/inbox-thread-pulls.ts',
  'packages/server/inbox-thread-tags.ts',
  'packages/server/inbox-tidy.ts',
  'packages/server/inbox-tour.ts',
  'packages/server/inbox-voice.ts',
  'packages/server/inbox-whats-new-images.ts',
  'packages/shared/html-assets.ts',
  'packages/shared/inbox/connection.ts',
  'packages/shared/inbox/debug-log.ts',
  'packages/shared/plans/routes.ts',
  'packages/shared/sem-diff-assets.ts',
  'packages/shared/shape/routes.ts',
] as const;

/** A path is a route of the Inbox when it starts with one of these. */
const ROUTE_START = /^\/(api\/|mcp$|favicon\.(png|ico)$|manifest\.webmanifest$|apple-touch-icon\.png$|plannotator-themes\.js$|app-icon\/|assets\/|$)/;

const PARAM = ':id';

/**
 * One route pattern's body (between `^` and `$`) as the routes it matches. A
 * group is split at its top-level `|`: an alternative of plain path text stays
 * as written, any other (an id's shape, a class) is a parameter; a group
 * marked `?` also gives the route without it. A bare class or `.+` is a
 * parameter too.
 */
export function routesOfPattern(body: string): string[] {
  const out = alternatives(body, 0, body.length);
  // A segment with a parameter in it (`att_:id`, `:id.png`) is one parameter.
  return [...new Set(out.map((r) => r.split('/').map((seg) => (seg.includes(PARAM) ? PARAM : seg)).join('/')))];
}

const PLAIN = /^[A-Za-z0-9_./-]*$/;

/** The texts body[from, to) matches, one per combination of its groups' alternatives. */
function alternatives(body: string, from: number, to: number): string[] {
  // Split at top-level `|` first.
  const parts: [number, number][] = [];
  let depth = 0;
  let inClass = false;
  let at = from;
  for (let i = from; i < to; i++) {
    const c = body[i]!;
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) { parts.push([at, i]); at = i + 1; }
  }
  parts.push([at, to]);
  if (parts.length > 1) return parts.flatMap(([a, b]) => alternatives(body, a, b).map((t) => (PLAIN.test(t) ? t : PARAM)));
  return sequence(body, from, to);
}

/** A sequence with no top-level `|`. */
function sequence(body: string, from: number, to: number): string[] {
  let results = [''];
  const append = (options: string[]) => { results = results.flatMap((r) => options.map((o) => r + o)); };
  for (let i = from; i < to; ) {
    const c = body[i]!;
    if (c === '\\') {
      // `\d`, `\w`, `\s` are classes; any other escape is its character.
      const cls = /[dwsDWS]/.test(body[i + 1]!);
      const q = skipQuantifier(body, i + 2, to);
      append(cls || q.quantifier ? [PARAM] : [body[i + 1]!]);
      i = q.end;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      while (j < to && body[j] !== ']') j += body[j] === '\\' ? 2 : 1;
      i = skipQuantifier(body, j + 1, to).end;
      append([PARAM]);
      continue;
    }
    if (c === '(') {
      let depth = 1;
      let j = i + 1;
      let inClass = false;
      for (; j < to && depth > 0; j++) {
        const d = body[j]!;
        if (d === '\\') { j++; continue; }
        if (inClass) { if (d === ']') inClass = false; continue; }
        if (d === '[') inClass = true;
        else if (d === '(') depth++;
        else if (d === ')') depth--;
      }
      const close = j - 1;
      const inner = body.startsWith('?:', i + 1) ? i + 3 : i + 1;
      const q = skipQuantifier(body, close + 1, to);
      const options = alternatives(body, inner, close);
      const many = q.quantifier === '+' || q.quantifier === '*' || q.quantifier.startsWith('{');
      append(many ? [PARAM] : q.quantifier === '?' ? ['', ...options] : options);
      i = q.end;
      continue;
    }
    if (c === '.') { i = skipQuantifier(body, i + 1, to).end; append([PARAM]); continue; }
    const q = skipQuantifier(body, i + 1, to);
    append(q.quantifier ? [PARAM] : [c]);
    i = q.end;
  }
  return results;
}

function skipQuantifier(body: string, at: number, to: number): { quantifier: string; end: number } {
  if (at >= to) return { quantifier: '', end: at };
  const c = body[at]!;
  if (c === '?' || c === '+' || c === '*') return { quantifier: c, end: body[at + 1] === '?' ? at + 2 : at + 1 };
  if (c === '{') {
    const close = body.indexOf('}', at);
    return { quantifier: body.slice(at, close + 1), end: close + 1 };
  }
  return { quantifier: '', end: at };
}

/** Modules inbox.ts imports that compare request paths without serving them, each with why. */
export const NOT_ROUTE_MODULES: Record<string, string> = {
  'packages/server/inbox-perf.ts': 'sorts requests into waiting ones for the timings; serves nothing',
  'packages/server/inbox-rex-far.ts': "reads a linked machine's answer to a forwarded Show in Rex (`/api/inbox/m/<machine>/rex/show`, which inbox-machines.ts serves); serves nothing",
  'packages/shared/star-ask.ts': "the plan, review and annotate servers' `/api/star-ask/*`; the Inbox takes only its helpers and serves `/api/inbox/star-ask`",
};

/**
 * Paths a pattern above matches that the server refuses with a 404, each with
 * where it says so. tests/inbox-api-table.test.ts fails when one is no longer
 * read from the code, so the list never outlives its reason.
 */
export const NOT_SERVED: Record<string, string> = {
  '/api/inbox/launch/:id': 'a launch with no action falls out of the switch: `return null` (inbox-launch.ts)',
  '/api/inbox/launch/settings/delete': '`settings` takes no action: `if (match[2]) return null` (inbox-launch.ts)',
  '/api/inbox/launch/settings/open': '`settings` takes no action (inbox-launch.ts)',
  '/api/inbox/launch/settings/retry': '`settings` takes no action (inbox-launch.ts)',
  '/api/inbox/launch/settings/stop': '`settings` takes no action (inbox-launch.ts)',
  '/api/inbox/launch/settings/trust': '`settings` takes no action (inbox-launch.ts)',
  '/api/ai/bridge/event': 'Ask AI\'s route skips the bridge paths (inbox-ask.ts `aiRoute`); the agent reaches them under /api/inbox/ask/:session',
  '/api/ai/bridge/poll': 'Ask AI\'s route skips the bridge paths (inbox-ask.ts `aiRoute`)',
};

/** `read`: every path the code matches, NOT_SERVED included. */
export type WindowRoutes = { routes: string[]; families: string[]; read: string[] };

/** The Inbox's routes and families, read from ROUTE_FILES. */
export function windowRoutesFromCode(): WindowRoutes {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  const texts = ROUTE_FILES.map((file) => readSource(file));
  const consts = new Map<string, string>();
  const lists: [string, string][] = [];
  for (const text of texts) {
    for (const m of text.matchAll(/\bconst ([A-Z][A-Z0-9_]*) = (["'])(\/[^"'\s]*)\2/g)) consts.set(m[1]!, m[3]!);
    // A list of whole paths: `const SYSTEM_READ_PATHS = ["/api/…", …]`, read by `.includes(path)`.
    for (const m of text.matchAll(/\bconst ([A-Z][A-Z0-9_]*) = \[((?:\s*"\/[^"\s]*",?)+)\s*\]/g)) {
      for (const p of m[2]!.matchAll(/"(\/[^"\s]*)"/g)) lists.push([m[1]!, p[1]!]);
    }
  }
  const isRoute = (p: string) => ROUTE_START.test(p);
  for (const text of texts) {
    // A whole path compared: `x === "/api/…"`, `"/api/…" === x`, `!==` too.
    for (const m of text.matchAll(/(?:===|!==)\s*"(\/[^"\s]*)"|"(\/[^"\s]*)"\s*(?:===|!==)/g)) {
      const p = m[1] ?? m[2]!;
      if (isRoute(p)) exact.add(p);
    }
    for (const [name, value] of consts) {
      if (!isRoute(value)) continue;
      if (new RegExp(`(?:===|!==)\\s*${name}\\b|\\b${name}\\s*(?:===|!==)`).test(text)) exact.add(value);
      if (new RegExp(`startsWith\\(${name}\\b|\\$\\{${name}\\}/`).test(text)) prefixes.add(value);
    }

    // A route pattern, anchored at both ends.
    for (const m of text.matchAll(/\/\^(\\\/(?:\[(?:[^\]\n\\]|\\.)*\]|[^/\n\\[]|\\.)*?)\$\/[a-z]*/g)) {
      for (const p of routesOfPattern(m[1]!)) if (isRoute(p)) exact.add(p);
    }
    // A prefix taken whole.
    for (const m of text.matchAll(/startsWith\("(\/[^"\s]*)"\)/g)) if (isRoute(m[1]!)) prefixes.add(m[1]!);
  }
  // A list is served when a route file reads it (`.includes(path)`, `new Set(LIST)`), not only where it is made.
  for (const [name, value] of lists) {
    if (isRoute(value) && texts.some((t) => (t.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length > (t.includes(`const ${name} =`) ? 1 : 0))) exact.add(value);
  }
  const routes = [...exact].map((p) => (p.length > 1 ? p.replace(/\/$/, '') : p));
  const families = [...prefixes]
    .map((p) => p.replace(/\/$/, ''))
    .filter((p) => p !== '/api' && p !== '' && !routes.some((r) => r.startsWith(`${p}/`)));
  return { routes: [...new Set(routes)].filter((r) => !(r in NOT_SERVED)).sort(), families: [...new Set(families)].sort(), read: [...new Set(routes)].sort() };
}

/** Every entry the surface lists: the routes, then each family as `<prefix>/*`. */
export function windowEntries(read = windowRoutesFromCode()): string[] {
  return [...new Set([...read.routes, ...read.families.map((f) => `${f}/*`)])].sort();
}

export const API_DOC = 'docs/agent-guides/server-and-storage.md';

/** The Inbox table's rows: each route its endpoint cell names, with the cell and its line. */
export function docTableRows(): { route: string; cell: string; line: number }[] {
  const text = readSource(API_DOC);
  const start = text.indexOf('### Inbox Server (');
  const end = text.indexOf('\n### ', start + 1);
  if (start < 0 || end < 0) throw new Error(`inbox-window-routes.ts: no Inbox Server table in ${API_DOC}`);
  const first = text.slice(0, start).split('\n').length;
  const rows: { route: string; cell: string; line: number }[] = [];
  text.slice(start, end).split('\n').forEach((l, i) => {
    if (!l.startsWith('| `/')) return;
    const cell = l.slice(2, l.indexOf(' | ', 2));
    for (const route of routesOfDocCell(cell)) rows.push({ route, cell, line: first + i });
  });
  return rows;
}

/**
 * An endpoint cell as the routes it names, in the code's form (`:id`
 * parameters, no query). A cell may name several (`` `/a`, `/b` ``); one that
 * starts with a parameter (`` `/:id/undo` ``) continues the one before it,
 * taking the place of as many segments; `[/x\\|/y]` is optional, each way;
 * a trailing `*` or `…` stays: the row speaks for everything under it.
 */
export function routesOfDocCell(cell: string): string[] {
  const spans = [...cell.matchAll(/`(\/[^`]*)`/g)].map((m) => m[1]!);
  const out: string[] = [];
  let last = '';
  for (const span of spans) {
    let full = span;
    if (/^\/:/.test(span) && last) {
      const segs = span.split('/').length - 1;
      full = last.split('/').slice(0, -segs).join('/') + span;
    }
    last = full;
    out.push(...expandDocRoute(full));
  }
  return [...new Set(out)];
}

function expandDocRoute(route: string): string[] {
  const opt = /\[(\/[^\]]*)\]/.exec(route);
  if (opt) {
    const rest = (alt: string) => route.slice(0, opt.index) + alt + route.slice(opt.index + opt[0].length);
    return [...expandDocRoute(rest('')), ...opt[1]!.split(/\\?\|/).flatMap((alt) => expandDocRoute(rest(alt)))];
  }
  const p = route
    .replace(/\?.*$/, '')
    .split('/')
    .map((seg) => (/(<[^>]+>|^:[A-Za-z_]|\{[^}]+\})/.test(seg) ? PARAM : seg))
    .join('/');
  return [p.length > 1 ? p.replace(/\/$/, '') : p];
}

/** A route lies under a family (`<prefix>`, or a doc route ending in `*` or `…`). */
export function underFamily(route: string, families: readonly string[]): boolean {
  const bare = route.replace(/\/?(…|\*)$/, '');
  return families.some((f) => {
    const fam = f.replace(/\/?(…|\*)$/, '');
    return bare === fam || bare.startsWith(`${fam}/`) || (f.endsWith('…') && bare.startsWith(fam));
  });
}
