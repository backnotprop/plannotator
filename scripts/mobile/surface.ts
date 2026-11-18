/**
 * parity/surface.json: everything the window and its server offer, as one
 * list of entries the parity ledger must each decide for the phone
 * (apps/mobile/contract/parity/ledger.json, tests/mobile-parity.test.ts).
 *
 *   bun scripts/mobile/surface.ts [--check]
 *
 * An entry is `<kind>:<name>`:
 *   door:<route>       a route of the phone's door (door.ts, read live from the door)
 *   window:<M> <path>  an Inbox endpoint in docs/agent-guides/server-and-storage.md's Inbox table
 *   frame:<name>       an event the Inbox's stream sends
 *   record:<kind>      a record kind (InboxRecordKind)
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
import { OUT, cli, jsonText, readRepoText, type Output } from './lib';
import { buildSchema } from './schema';

/** The flows, in order. A new flow file is added here (a folder is never listed). */
export const FLOW_FILES = [
  'apps/mobile/contract/flows/01-navigation.md',
  'apps/mobile/contract/flows/02-pairing.md',
  'apps/mobile/contract/flows/03-list.md',
  'apps/mobile/contract/flows/04-thread.md',
  'apps/mobile/contract/flows/05-answer.md',
  'apps/mobile/contract/flows/06-reply.md',
  'apps/mobile/contract/flows/07-attachment.md',
  'apps/mobile/contract/flows/08-plan.md',
  'apps/mobile/contract/flows/09-agents.md',
  'apps/mobile/contract/flows/10-run-and-secret.md',
  'apps/mobile/contract/flows/11-notifications.md',
  'apps/mobile/contract/flows/12-offline.md',
  'apps/mobile/contract/flows/13-computers.md',
  'apps/mobile/contract/flows/14-live-status.md',
  'apps/mobile/contract/flows/15-computer-settings.md',
] as const;

const SOURCES = {
  windowRoutes: 'docs/agent-guides/server-and-storage.md',
  server: 'packages/server/inbox.ts',
  machines: 'packages/server/inbox-machines.ts',
  peerLink: 'packages/server/inbox-peer-link.ts',
  blocks: 'packages/ui/types.ts',
  settings: 'packages/inbox/settingsRoute.ts',
} as const;

/** A check line in a flow: `[list-04] What the phone does.` */
export const CHECK_LINE = /^- \[([a-z]+-\d{2})\]\s+\S/;

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

function windowRoutes(): string[] {
  const text = readRepoText(SOURCES.windowRoutes);
  const start = text.indexOf('### Inbox Server (');
  const end = text.indexOf('\n### ', start + 1);
  if (start < 0 || end < 0) throw new Error(`surface.ts: no Inbox Server table in ${SOURCES.windowRoutes}`);
  const out: string[] = [];
  for (const line of text.slice(start, end).split('\n')) {
    const row = /^\| `([^`]+)` \| ([A-Z][A-Z ,/]*[A-Z]) \|/.exec(line);
    if (!row) continue;
    for (const method of row[2]!.split(/[ ,/]+/).filter(Boolean)) out.push(`${method} ${row[1]}`);
  }
  return out;
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

type Def = { properties?: Record<string, unknown>; enum?: string[] };

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
    window: sorted(windowRoutes()),
    frame: sorted(frames()),
    record: sorted(defs.InboxRecordKind?.enum ?? []),
    field: sorted(fields),
    block: sorted(blocks()),
    directive: sorted([...QUESTION_DIRECTIVE_KINDS, INBOX_ACTION_DIRECTIVE]),
    settings: sorted(settings()),
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
