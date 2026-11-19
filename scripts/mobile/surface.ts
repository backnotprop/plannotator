/**
 * parity/surface.json: everything the window and its server offer, as one
 * list of entries the parity ledger must each decide for the phone
 * (apps/mobile/contract/parity/ledger.json, tests/mobile-parity.test.ts).
 *
 *   bun scripts/mobile/surface.ts [--check]
 *
 * An entry is `<kind>:<name>`:
 *   door:<route>       a route of the phone's door (door.ts, read live from the door)
 *   window:<path>      an Inbox endpoint, read from the server's code (packages/server/inbox-window-routes.ts); `<prefix>/*`
 *                      a family a module splits itself; methods are not read
 *   frame:<name>       an event the Inbox's stream sends
 *   record:<kind>      a record kind (InboxRecordKind)
 *   enum:<Type>[.<field>…].<value>  a value of a wire enum (schema.ts), record kinds aside
 *   setting:<key>      a key the window's Settings write takes (`POST /api/inbox/settings`), the
 *                      capability switches (board, steps, scheduled_threads, code_review, shape, …) among them
 *   capability:<key>   a capability on the Inbox's capability seam (inbox-capability.ts)
 *   field:<Type>.<f>   a field of a wire type (schema.ts, read live from the TypeScript)
 *   block:<type>       a block the message parser makes (packages/ui/types.ts Block)
 *   directive:<name>   a `:::` block the Inbox acts on (questions, action items)
 *   settings:<id>      a section of the window's Settings
 *   check:<id>         a numbered check of a flow (flows/*.md)
 *
 * Every source is read by a path named here, so scripts/ci-affected.ts selects
 * the parity test when one changes; none of them imports the window.
 */
import { INBOX_ACTION_DIRECTIVE } from '../../packages/core/inbox-actions';
import { QUESTION_DIRECTIVE_KINDS } from '../../packages/core/question-block';
import { doorEntries } from './door';
import { windowEntries } from '../../packages/server/inbox-window-routes';
import { OUT, cli, jsonText, readRepoText, type Output } from './lib';
import { FLOW_FILES } from './flows';
import { buildSchema } from './schema';

export { FLOW_FILES } from './flows';

const SOURCES = {
  server: 'packages/server/inbox.ts',
  machines: 'packages/server/inbox-machines.ts',
  peerLink: 'packages/server/inbox-peer-link.ts',
  blocks: 'packages/ui/types.ts',
  settings: 'packages/inbox/settingsRoute.ts',
  capabilities: 'packages/server/inbox-capability.ts',
} as const;

/** The capabilities on the seam, one file each; settingWrites() fails when inbox-capability.ts makes another. */
const CAPABILITY_FILES = ['packages/server/plans-capability.ts'] as const;

/** A check line in a flow: `[list-04] What the phone does.` */
export const CHECK_LINE = /^- \[([a-z]+-\d{2})\]\s+\S/;

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** The keys `POST /api/inbox/settings` takes: the chain that refuses a body naming none of them (inbox.ts). */
function settingWrites(): string[] {
  const server = readRepoText(SOURCES.server);
  const start = server.indexOf('if (path === "/api/inbox/settings") {');
  const end = server.indexOf('throw new InboxError("validation_error", "body: ', start);
  if (start < 0 || end < 0) throw new Error(`surface.ts: no settings write in ${SOURCES.server}`);
  const keys = [...server.slice(start, end).matchAll(/body\.([a-z_]+) (?:===|!==) undefined/g)].map((m) => m[1]!);
  if (keys.length < 10) throw new Error(`surface.ts: read only ${keys.length} settings keys from ${SOURCES.server}`);
  return keys;
}

/** The keys of the capabilities on the seam. */
function capabilities(): string[] {
  const made = [...readRepoText(SOURCES.capabilities).matchAll(/create([A-Z][A-Za-z]*)Capability\(core\)/g)];
  if (made.length !== CAPABILITY_FILES.length) {
    throw new Error(`surface.ts: ${SOURCES.capabilities} makes ${made.length} capabilities; name each one's file in CAPABILITY_FILES`);
  }
  return CAPABILITY_FILES.map((file) => {
    const key = /\bkey: "([a-z_-]+)"/.exec(readRepoText(file));
    if (!key) throw new Error(`surface.ts: no key in ${file}`);
    return key[1]!;
  });
}

function frames(): string[] {
  const server = readRepoText(SOURCES.server);
  const machines = readRepoText(SOURCES.machines);
  const peer = readRepoText(SOURCES.peerLink);
  const names = [...server.matchAll(/event: ([a-z][a-z-]*)/g)].map((m) => m[1]!);
  names.push(...[...machines.matchAll(/event: "([a-z-]+)"/g)].map((m) => m[1]!));
  const reread = /PEER_REREAD_EVENTS = \[([^\]]*)\]/.exec(peer);
  if (!reread) throw new Error(`surface.ts: no PEER_REREAD_EVENTS in ${SOURCES.peerLink}`);
  names.push(...[...reread[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!));
  return names;
}

function blocks(): string[] {
  const types = readRepoText(SOURCES.blocks);
  const block = /export interface Block \{[\s\S]*?\n {2}type: ([^;]+);/.exec(types);
  if (!block) throw new Error(`surface.ts: no Block type in ${SOURCES.blocks}`);
  return [...block[1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
}

function settings(): string[] {
  const list = /SETTINGS_SECTIONS = \[([^\]]*)\]/.exec(readRepoText(SOURCES.settings));
  if (!list) throw new Error(`surface.ts: no SETTINGS_SECTIONS in ${SOURCES.settings}`);
  return [...list[1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
}

/** Every check id of every flow, each once. */
export function flowChecks(): string[] {
  const ids: string[] = [];
  for (const file of FLOW_FILES) {
    for (const line of readRepoText(file).split('\n')) {
      const m = CHECK_LINE.exec(line);
      if (!m) continue;
      if (ids.includes(m[1]!)) throw new Error(`surface.ts: check ${m[1]} twice (${file})`);
      ids.push(m[1]!);
    }
  }
  return ids;
}

type Def = { properties?: Record<string, Def>; enum?: unknown[]; items?: Def | Def[]; anyOf?: Def[]; oneOf?: Def[] };

/** Every string enum value of the schema, as `<Type>[.<field>…].<value>` (record kinds are `record:` entries). */
function enumValues(defs: Record<string, Def>): string[] {
  const out: string[] = [];
  const walk = (name: string, node: Def | undefined, at: string) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.enum) && node.enum.every((v) => typeof v === 'string')) out.push(...(node.enum as string[]).map((v) => `${name}${at}.${v}`));
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(name, v, `${at}.${k}`);
    for (const x of [node.items, node.anyOf, node.oneOf]) for (const y of Array.isArray(x) ? x : x ? [x] : []) walk(name, y, at);
  };
  for (const [name, def] of Object.entries(defs)) if (name !== 'InboxRecordKind') walk(name, def, '');
  return out;
}

/**
 * The surface, by kind, each list sorted. The door and the wire types come
 * from the product itself, not from door.json and the schema, so a route or a
 * field added without regenerating still reaches the ledger's check.
 */
export function buildSurface(): Record<string, string[]> {
  const door = { routes: doorEntries() };
  const defs = (buildSchema() as { $defs: Record<string, Def> }).$defs;
  const fields: string[] = [];
  for (const [name, def] of Object.entries(defs)) for (const field of Object.keys(def.properties ?? {})) fields.push(`${name}.${field}`);
  return {
    door: sorted(door.routes.map((r) => r.name)),
    window: sorted(windowEntries()),
    frame: sorted(frames()),
    record: sorted((defs.InboxRecordKind?.enum ?? []) as string[]),
    enum: sorted(enumValues(defs)),
    field: sorted(fields),
    block: sorted(blocks()),
    directive: sorted([...QUESTION_DIRECTIVE_KINDS, INBOX_ACTION_DIRECTIVE]),
    settings: sorted(settings()),
    setting: sorted(settingWrites()),
    capability: sorted(capabilities()),
    check: sorted(flowChecks()),
  };
}

/** Every entry as `<kind>:<name>`. */
export function surfaceEntries(surface = buildSurface()): string[] {
  return Object.entries(surface).flatMap(([kind, names]) => names.map((n) => `${kind}:${n}`));
}

export function generateSurface(): Output[] {
  return [{
    path: OUT.surface,
    text: jsonText({ about: 'GENERATED by scripts/mobile/surface.ts. Do not edit. Every entry needs a row in ledger.json.', surface: buildSurface() }),
  }];
}

if (import.meta.main) cli('surface', generateSurface);
