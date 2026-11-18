/**
 * door.json: every route of the Inbox's device door (/api/inbox/device/), read
 * from the door's own code (packages/server/inbox-devices.ts: doorRouteNames,
 * doorRouteOf, doorWriteRoutes) and the outbox's write kinds
 * (packages/server/inbox-outbox.ts: DOOR_WRITES).
 *
 *   bun scripts/mobile/door.ts [--check]
 *
 * One entry per route a client can call, alternations written out
 * (`POST threads/:id/(read|unread|mark-unread)` is three). For each: the
 * method, the path with named parameters, the window route it reaches, who may
 * call it (`grant`), what a write is (`kind`), where its idempotency key goes,
 * and whether the relay carries it. swift.ts builds the app's route table from
 * this file, so the app cannot call a route the door does not have.
 */
import { doorRouteNames, doorRouteOf, doorWriteRoutes } from '../../packages/server/inbox-devices';
import { DOOR_WRITES } from '../../packages/server/inbox-outbox';
import { OUT, cli, contractVersion, jsonText, type Output } from './lib';

/** A route's parameter: its name, and a value the door's own pattern accepts (to ask the door which entry it is). */
type Param = { name: string; sample: string };
type Segment = { text: string } | { param: Param };

/** The word a collection segment gives the route's name, and the name of the id that follows it. */
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

/** A parameter group of the door's patterns, by its source: a value it accepts. */
const PARAM_GROUPS: Record<string, string> = {
  ':id': 'id_SAMPLE',
  '(crd_[^/]+)': 'crd_SAMPLE',
  '(cmb_[^/]+)': 'cmb_SAMPLE',
  '(a-[0-9a-f]{8}(?:-\\d{1,3})?)': 'a-0123abcd',
  '(.+)': 'path_SAMPLE',
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
const RANGE = new Set(['GET attachments/:id/video', 'GET attachments/:id/audio', 'GET attachments/:id/download', 'GET open-in/file/raw']);
const STREAM = new Set(['GET events']);

export type DoorEntry = {
  /** `GET threads/:id`: the route in the door's words, one alternative. */
  name: string;
  /** The door's own name for its entry (`doorRouteNames()`), alternations and all: what `health.door.routes` lists. */
  door_name: string;
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
  /** The relay carries it as a sealed command. */
  relay: boolean;
};

/** `GET attachments/:id/(image|video)` -> one list of segments per alternative. */
function expand(name: string): { method: 'GET' | 'POST'; alternatives: Segment[][] } {
  const [method, path] = name.split(' ') as ['GET' | 'POST', string];
  // Split at slashes outside groups.
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of path) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '/' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  let alternatives: Segment[][] = [[]];
  let prev = '';
  for (const part of parts) {
    const sample = PARAM_GROUPS[part];
    let options: Segment[][];
    if (sample !== undefined) {
      const pname = part === "(.+)" ? "path" : COLLECTIONS[prev]?.param;
      if (!pname) throw new Error(`door.ts: no parameter name for ${part} after "${prev}" in ${name}`);
      options = [[{ param: { name: pname, sample } }]];
    } else if (/^\([a-z/|-]+\)$/.test(part)) {
      options = part.slice(1, -1).split('|').map((word) => word.split('/').map((text) => ({ text })));
    } else if (/^[a-z][a-z-]*$/.test(part)) {
      options = [[{ text: part }]];
    } else {
      throw new Error(`door.ts: a part of ${name} it cannot read: ${part}`);
    }
    alternatives = alternatives.flatMap((head) => options.map((tail) => [...head, ...tail]));
    prev = part;
  }
  return { method, alternatives };
}

const camel = (words: string[]) => words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join('');
const wordsOf = (text: string) => text.split('-');

/** `POST threads/{thread}/seen` -> `postThreadSeen`. */
function callName(method: string, segments: Segment[]): string {
  const words: string[] = [method.toLowerCase()];
  segments.forEach((seg, i) => {
    if ('param' in seg) return;
    const next = segments[i + 1];
    const collection = COLLECTIONS[seg.text];
    words.push(...(next && 'param' in next && collection ? [collection.word] : wordsOf(seg.text)));
  });
  return camel(words);
}

function entryOf(doorName: string, method: 'GET' | 'POST', segments: Segment[], rawRoutes: Set<string>): DoorEntry {
  const params = segments.flatMap((s) => ('param' in s ? [s.param.name] : []));
  const path = segments.map((s) => ('param' in s ? `{${s.param.name}}` : s.text)).join('/');
  const sample = segments.map((s) => ('param' in s ? s.param.sample : s.text)).join('/');
  const name = `${method} ${segments.map((s) => ('param' in s ? (s.param.name === 'path' ? ':path' : ':id') : s.text)).join('/')}`;
  const own = ['GET accounts', 'POST link-back', 'POST unlink', 'POST update'].includes(doorName);
  // Ask the door which entry the path reaches, as a phone and as a linked computer.
  const phone = own ? null : doorRouteOf(method, sample, false);
  const machine = own ? null : doorRouteOf(method, sample, true);
  if (!own && !machine) throw new Error(`door.ts: the door does not answer ${method} ${sample} (from ${doorName})`);
  const unsample = (text: string) => segments.reduce((t, s) => ('param' in s ? t.replace(s.param.sample, `{${s.param.name}}`) : t), text);
  const raw = method === 'POST' && rawRoutes.has(`^${sample.replaceAll('/', '\\/')}$`);
  const write = method === 'POST' ? writeKind(sample) : null;
  if (method === 'POST' && !write) throw new Error(`door.ts: ${name} has no DOOR_WRITES kind`);
  return {
    name,
    door_name: doorName,
    method,
    path,
    params,
    call: callName(method, segments),
    window: machine ? unsample(machine.windowPath) : null,
    grant: phone ? 'phone' : 'machine',
    auth: 'token',
    kind: method === 'GET' ? 'read' : write === 'file' ? 'bytes' : write === 'append' || write === 'set' ? 'hold' : 'now',
    write,
    key: method === 'GET' ? null : raw ? 'query' : 'body',
    answer: STREAM.has(name) ? 'stream' : BYTES.has(name) ? 'bytes' : 'json',
    range: RANGE.has(name),
    relay: !STREAM.has(name) && !raw,
  };
}

/** The outbox's kind for a write to this concrete path (DOOR_WRITES, `local` included). */
function writeKind(path: string): string | null {
  for (const [name, kind] of Object.entries(DOOR_WRITES)) {
    const pattern = new RegExp(`^${name.slice('POST '.length).replaceAll(':id', '[^/]+')}$`);
    if (pattern.test(path)) return kind;
  }
  return null;
}

/** The door's two routes of its own, outside the allowlist: pairing (no token) and a phone removing itself. */
const OWN: DoorEntry[] = [
  {
    name: 'POST pair', door_name: 'POST pair', method: 'POST', path: 'pair', params: [], call: 'postPair', window: null,
    grant: 'phone', auth: 'none', kind: 'now', write: null, key: null, answer: 'json', range: false, relay: false,
  },
  {
    name: 'POST revoke', door_name: 'POST revoke', method: 'POST', path: 'revoke', params: [], call: 'postRevoke', window: null,
    grant: 'phone', auth: 'token', kind: 'now', write: null, key: null, answer: 'json', range: false, relay: true,
  },
];

export function doorEntries(): DoorEntry[] {
  const rawRoutes = new Set(doorWriteRoutes().filter((r) => r.raw).map((r) => r.route));
  const entries = [...OWN];
  for (const doorName of doorRouteNames()) {
    const { method, alternatives } = expand(doorName);
    for (const segments of alternatives) entries.push(entryOf(doorName, method, segments, rawRoutes));
  }
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
  return [{
    path: OUT.door,
    text: jsonText({
      about: 'GENERATED by scripts/mobile/door.ts from packages/server/inbox-devices.ts and inbox-outbox.ts. Do not edit.',
      contract: contractVersion(),
      prefix: '/api/inbox/device/',
      routes: doorEntries(),
    }),
  }];
}

if (import.meta.main) cli('door', generateDoor);
