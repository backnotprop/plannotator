/**
 * door.json and VERSION (the door's contract number, DOOR_CONTRACT). door.json: every route of the Inbox's device door (/api/inbox/device/), read
 * from the door's own table (packages/server/inbox-devices.ts:
 * doorRouteTable, the one source `health.door.routes` also reads) and the
 * outbox's write kinds (packages/server/inbox-outbox.ts: DOOR_WRITES).
 *
 *   bun scripts/mobile/all.ts [--check]
 *
 * One entry per row of the door's table. For each: its name (what
 * `health.door.routes` lists), the path with named parameters, the window
 * route it reaches, who may call it (`grant`), what a write is (`kind`),
 * where its idempotency key goes, and whether the relay carries it. swift.ts
 * builds the app's route table from this file, so the app cannot call a route
 * the door does not have.
 */
import { doorRouteOf, doorRouteTable } from '../../packages/server/inbox-devices';
import { DOOR_CONTRACT } from '../../packages/server/inbox-door-version';
import { DOOR_WRITES } from '../../packages/server/inbox-outbox';
import { OUT, VERSION_FILE, cli, jsonText, type Output } from './lib';

/**
 * The contract's number: the door's own (packages/server/inbox-door-version.ts DOOR_CONTRACT), which rises only for
 * a breaking wire change. generateDoor writes it to VERSION; Wire.swift compiles it in as `wireContract`.
 */
export function contractVersion(): number {
  return DOOR_CONTRACT;
}

/** The name a collection's id takes in a path (`threads/:id` -> `{thread}`), and its word in a call's name. */
const COLLECTIONS: Record<string, { word: string; param: string }> = {
  threads: { word: 'thread', param: 'thread' },
  messages: { word: 'message', param: 'message' },
  attachments: { word: 'attachment', param: 'attachment' },
  projects: { word: 'project', param: 'project' },
  annotations: { word: 'annotation', param: 'annotation' },
  markups: { word: 'markup', param: 'name' },
  uploads: { word: 'upload', param: 'upload' },
  'html-assets': { word: 'htmlAsset', param: 'token' },
  initiatives: { word: 'initiative', param: 'initiative' },
  launch: { word: 'launch', param: 'launch' },
  cards: { word: 'card', param: 'card' },
  combine: { word: 'combine', param: 'combine' },
  actions: { word: 'action', param: 'action' },
};

/**
 * The GET routes that answer bytes (a picture, a file, a download), and those
 * that honour `Range`. Every other GET answers JSON, but `events`, a stream.
 */
const BYTES = new Set([
  'GET whats-new/image', 'GET projects/:id/picture', 'GET threads/:id/decisions', 'GET attachments/:id/image', 'GET attachments/:id/video',
  'GET attachments/:id/audio', 'GET attachments/:id/download', 'GET attachments/:id/markdown-image', 'GET attachments/:id/linked-page',
  'GET markups/:id', 'GET messages/:id/image', 'GET html-assets/:id/:path', 'GET uploads/:id/image', 'GET open-in/file/raw',
]);
const RANGE = new Set(['GET attachments/:id/video', 'GET attachments/:id/audio', 'GET attachments/:id/download', 'GET messages/:id/image', 'GET open-in/file/raw']);
const STREAM = new Set(['GET events']);

export type DoorEntry = {
  /** `GET threads/:id`: what `health.door.routes` lists for it. */
  name: string;
  method: 'GET' | 'POST';
  /** Relative to /api/inbox/device/, parameters in braces: `threads/{thread}/seen`. */
  path: string;
  params: string[];
  /** The route's name in the app's code: `postThreadSeen`. */
  call: string;
  /** The window route it reaches, parameters in braces; null for the door's own routes. */
  window: string | null;
  /** `phone`: a paired phone's token reaches it (a linked computer's too); `machine`: a linked computer's only. */
  grant: 'phone' | 'machine';
  /** `token`: `Authorization: Bearer tok_…`; `none`: pairing. */
  auth: 'token' | 'none';
  /**
   * `read`: a GET. `hold`: a write that may wait offline and be sent later (a second copy changes nothing).
   * `now`: a write that is sent now or never. `bytes`: a file's bytes as the body.
   */
  kind: 'read' | 'hold' | 'now' | 'bytes';
  /** The outbox's kind for a write (DOOR_WRITES), null for a read and the door's own routes. */
  write: string | null;
  /** Where the idempotency key goes: the JSON body, the query (a raw body), or nowhere. */
  key: 'body' | 'query' | null;
  /** What a GET answers. */
  answer: 'json' | 'bytes' | 'stream';
  /** The GET honours `Range` and `If-Range`. */
  range: boolean;
  /** The sealed relay path carries it (the door's own `relay`). */
  relay: boolean;
};

const camel = (words: string[]) => words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join('');

/** The outbox's kind for a write to this concrete path (DOOR_WRITES, `local` included). */
function writeKind(path: string): string | null {
  for (const [name, kind] of Object.entries(DOOR_WRITES)) {
    const pattern = new RegExp(`^${name.slice('POST '.length).replaceAll(':id', '[^/]+')}$`);
    if (pattern.test(path)) return kind;
  }
  return null;
}

/** A sample a parameter accepts, from the door's own pattern: asks the door which window route a path reaches. */
const SAMPLES = ['id_SAMPLE', 'crd_SAMPLE', 'cmb_SAMPLE', 'a-0123abcd', 'path/SAMPLE'];

export function doorEntries(): DoorEntry[] {
  const entries = doorRouteTable().map((row): DoorEntry => {
    const parts = row.route.split('/');
    const params: string[] = [];
    const words: string[] = [row.method.toLowerCase()];
    const segments = parts.map((part, i) => {
      if (part === ':path') return (params.push('path'), '{path}');
      if (part === ':id') {
        const name = COLLECTIONS[parts[i - 1]!]?.param;
        if (!name) throw new Error(`door.ts: no parameter name after "${parts[i - 1]}" in ${row.name}`);
        params.push(name);
        return `{${name}}`;
      }
      const next = parts[i + 1];
      words.push(...(next === ':id' && COLLECTIONS[part] ? [COLLECTIONS[part]!.word] : part.split('-')));
      return part;
    });
    const path = segments.join('/');
    const pattern = new RegExp(row.pattern);
    const sample = SAMPLES.find((x) => pattern.test(parts.map((p) => (p.startsWith(':') ? x : p)).join('/')));
    if (sample === undefined) throw new Error(`door.ts: no sample fits ${row.name} (${row.pattern})`);
    const concrete = parts.map((p) => (p.startsWith(':') ? sample : p)).join('/');
    const found = doorRouteOf(row.method, concrete, true);
    const window = found ? params.reduce((t, name) => t.replace(sample, `{${name}}`), found.windowPath) : null;
    // The outbox's kind (DOOR_WRITES) names the door's own writes too (a linked computer holds them); pair and revoke have none.
    const write = row.method === 'POST' ? writeKind(concrete) : null;
    if (row.method === 'POST' && window && !write) throw new Error(`door.ts: ${row.name} has no DOOR_WRITES kind`);
    return {
      name: row.name,
      method: row.method,
      path,
      params,
      call: camel(words),
      window,
      grant: row.grant,
      auth: row.name === 'POST pair' ? 'none' : 'token',
      kind: row.method === 'GET' ? 'read' : row.raw ? 'bytes' : write === 'append' || write === 'set' ? 'hold' : 'now',
      write,
      key: row.method === 'GET' || !write ? null : row.raw ? 'query' : 'body',
      answer: STREAM.has(row.name) ? 'stream' : BYTES.has(row.name) ? 'bytes' : 'json',
      range: RANGE.has(row.name),
      relay: row.relay,
    };
  });
  const seen = new Set<string>();
  for (const e of entries) {
    for (const key of [e.name, e.call]) {
      if (seen.has(key)) throw new Error(`door.ts: two routes named ${key}`);
      seen.add(key);
    }
  }
  for (const name of [...BYTES, ...RANGE, ...STREAM]) if (!seen.has(name)) throw new Error(`door.ts: ${name} is not a door route any more`);
  return entries;
}

export function generateDoor(): Output[] {
  return [{ path: VERSION_FILE, text: `${contractVersion()}\n` }, {
    path: OUT.door,
    text: jsonText({
      about: 'GENERATED by scripts/mobile/door.ts from packages/server/inbox-devices.ts (doorRouteTable) and inbox-outbox.ts. Do not edit.',
      prefix: '/api/inbox/device/',
      routes: doorEntries(),
    }),
  }];
}

if (import.meta.main) cli('door', generateDoor);
