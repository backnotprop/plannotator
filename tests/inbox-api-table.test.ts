/**
 * docs/agent-guides/server-and-storage.md's Inbox table lists every endpoint
 * the Inbox serves, and only those. The served list is read from the server's
 * code as text (packages/server/inbox-window-routes.ts), the same list the
 * app's parity surface uses.
 *
 * What can regress, and the test that says so:
 *  - an endpoint added to the Inbox with no doc row, or a doc row left for an
 *    endpoint that is gone ("the table and the server");
 *  - a new route module the reader does not read ("the reader reads every
 *    route module");
 *  - the reader misreading a pattern or a doc cell ("the reader").
 *
 * Reads source files as text; imports no server module and starts nothing.
 */
import { describe, expect, test } from 'bun:test';
import {
  API_DOC,
  NOT_ROUTE_MODULES,
  NOT_SERVED,
  ROUTE_FILES,
  docTableRows,
  readSource,
  routesOfDocCell,
  routesOfPattern,
  underFamily,
  windowRoutesFromCode,
} from '../packages/server/inbox-window-routes';

const isFamily = (route: string) => /(\*|…)$/.test(route);

describe('the table and the server', () => {
  const code = windowRoutesFromCode();
  const rows = docTableRows();

  test('every endpoint the Inbox serves has a row', () => {
    const exact = new Set(rows.filter((r) => !isFamily(r.route)).map((r) => r.route));
    const docFamilies = rows.filter((r) => isFamily(r.route)).map((r) => r.route);
    const missing = code.routes.filter((r) => !exact.has(r) && !underFamily(r, docFamilies));
    const bare = code.families.filter((f) => !rows.some((r) => underFamily(r.route, [f]) || underFamily(f, [r.route])));
    const lines = [
      ...missing.map((r) => `The Inbox serves \`${r}\`, and ${API_DOC}'s Inbox Server table has no row for it. Add one: | \`${r}\` | <method> | <what it answers> |`),
      ...bare.map((f) => `The Inbox serves everything under \`${f}/\`, and ${API_DOC}'s Inbox Server table has no row there. Add one per endpoint.`),
    ];
    if (lines.length) throw new Error(lines.join('\n'));
  });

  test('every row names an endpoint the Inbox serves', () => {
    const served = new Set(code.routes);
    const stale = rows.filter((r) =>
      isFamily(r.route)
        ? !code.routes.some((c) => underFamily(c, [r.route])) && !code.families.some((f) => underFamily(f, [r.route]) || underFamily(r.route, [f]))
        : !served.has(r.route) && !underFamily(r.route, code.families),
    );
    if (stale.length) {
      throw new Error(stale.map((r) => `${API_DOC}:${r.line} names \`${r.route}\` (\`${r.cell}\`), which the Inbox does not serve. Fix the row or remove it.`).join('\n'));
    }
  });

  test('every path listed as not served is still one the code matches', () => {
    expect(Object.keys(NOT_SERVED).filter((p) => !code.read.includes(p))).toEqual([]);
  });
});

describe('the reader reads every route module', () => {
  test('a module inbox.ts imports that compares request paths is in ROUTE_FILES', () => {
    const inbox = readSource('packages/server/inbox.ts');
    const imported = [...inbox.matchAll(/from "(\.\/[a-z0-9-]+|@plannotator\/shared\/[a-z0-9/-]+)"/g)].map((m) =>
      m[1]!.startsWith('./') ? `packages/server/${m[1]!.slice(2)}.ts` : `packages/shared/${m[1]!.slice('@plannotator/shared/'.length)}.ts`,
    );
    const listed = new Set<string>(ROUTE_FILES);
    const routing = /(?:===|!==) "\/api\/|\/\^\\\/api\\\//;
    const unread = [...new Set(imported)].filter((file) => {
      if (listed.has(file) || file in NOT_ROUTE_MODULES) return false;
      let text: string;
      try {
        text = readSource(file);
      } catch {
        return false; // a folder's index or a non-.ts module: not a route module
      }
      return routing.test(text);
    });
    expect(unread, 'add each to ROUTE_FILES in packages/server/inbox-window-routes.ts (or, serving nothing, to NOT_ROUTE_MODULES)').toEqual([]);
    expect(Object.keys(NOT_ROUTE_MODULES).filter((f) => !imported.includes(f)), 'NOT_ROUTE_MODULES names a module inbox.ts no longer imports').toEqual([]);
  });
});

describe('the reader', () => {
  test('a pattern gives one route per alternative, parameters as :id, an optional part both ways', () => {
    expect(routesOfPattern('\\/api\\/inbox\\/threads\\/([A-Za-z0-9_]+)\\/(read|unread)')).toEqual([
      '/api/inbox/threads/:id/read',
      '/api/inbox/threads/:id/unread',
    ]);
    expect(routesOfPattern('\\/api\\/inbox\\/launch\\/(settings|lch_[0-9A-Z]{26})(?:\\/(stop|open))?').sort()).toEqual([
      '/api/inbox/launch/:id',
      '/api/inbox/launch/:id/open',
      '/api/inbox/launch/:id/stop',
      '/api/inbox/launch/settings',
      '/api/inbox/launch/settings/open',
      '/api/inbox/launch/settings/stop',
    ]);
    expect(routesOfPattern('\\/api\\/inbox\\/attachments\\/(att_[A-Za-z0-9]+)\\/(video|audio)')).toEqual([
      '/api/inbox/attachments/:id/video',
      '/api/inbox/attachments/:id/audio',
    ]);
  });

  test('a doc cell gives every route it names, a continuation taking the place of the last segments', () => {
    expect(routesOfDocCell('`/api/inbox/combine/:id/cancel`, `/:id/undo`')).toEqual(['/api/inbox/combine/:id/cancel', '/api/inbox/combine/:id/undo']);
    expect(routesOfDocCell('`/api/inbox/control/machines[/offer\\|/link]`')).toEqual([
      '/api/inbox/control/machines',
      '/api/inbox/control/machines/offer',
      '/api/inbox/control/machines/link',
    ]);
    expect(routesOfDocCell('`/api/inbox/cards/:id/favicon?url=<link>`')).toEqual(['/api/inbox/cards/:id/favicon']);
    expect(routesOfDocCell('`/api/inbox/m/:machine/*`')).toEqual(['/api/inbox/m/:id/*']);
  });
});
