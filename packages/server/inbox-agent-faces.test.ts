/**
 * The agent icons' faces file (packages/shared/inbox/agent-faces.ts) and its route (inbox-agent-faces.ts).
 *
 * What this catches: a face not kept for its agent or not found by one of its sessions; a choice of the agent's own
 * mark kept on disk; a continued session (a poll's `continues`) or a launch's session not linked to the face, so its
 * threads lose it after it ends; a link that writes on every poll; the file growing past its cap; this browser's
 * faces from before written over another window's choice, or adopted twice; a newer file written over; a write
 * with no event for the other windows; another site reading the faces. No Inbox is started: the route is called
 * directly with a temp folder.
 */
import { beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INBOX_AGENT_FACES_KEPT, type InboxAgentFacesWire } from '@plannotator/core/inbox-agent-faces';
import { createInboxAgentFacesFile, INBOX_AGENT_FACES_FILE } from '@plannotator/shared/inbox/agent-faces';
import { createInboxAgentFaces } from './inbox-agent-faces';

let dir = '';
let heard: InboxAgentFacesWire[] = [];
const file = () => createInboxAgentFacesFile(dir, (wire) => heard.push(wire));

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'pn-agent-faces-')), 'inbox');
  heard = [];
});

test('a face is kept for its agent, found by its sessions, and its own mark forgets it', () => {
  const faces = file();
  faces.change({ agent: 'lnc_1', sessions: ['ses_a', 'launch:lnc_1'], face: 'glass-blue' });
  expect(faces.wire().faces.lnc_1).toEqual({ face: 'glass-blue', sessions: ['ses_a', 'launch:lnc_1'] });
  expect(heard.map((w) => w.rev)).toEqual([1]);
  // A second process reads the same file.
  expect(createInboxAgentFacesFile(dir, () => {}).wire()).toEqual({ faces: { lnc_1: { face: 'glass-blue', sessions: ['ses_a', 'launch:lnc_1'] } }, rev: 1 });
  expect(statSync(join(dir, INBOX_AGENT_FACES_FILE)).mode & 0o777).toBe(0o600);
  faces.change({ agent: 'lnc_1', face: 'agent' });
  expect(Object.keys(faces.wire().faces)).toEqual([]);
  expect(heard.map((w) => w.rev)).toEqual([1, 2]);
});

test('a choice for a conversation that went on takes over the old session entry', () => {
  const faces = file();
  faces.change({ agent: 'ses_old', face: 'totman' });
  faces.change({ agent: 'ses_new', sessions: ['ses_old'], face: 'yellow' });
  expect(faces.wire().faces).toEqual({ ses_new: { face: 'yellow', sessions: ['ses_old'] } });
});

test('a continued session and a launch session are linked once, by a poll', () => {
  const faces = file();
  faces.change({ agent: 'ses_1', face: 'glass-green' });
  faces.change({ agent: 'lnc_9', sessions: ['launch:lnc_9'], face: 'transparent' });
  const before = heard.length;
  let asked = 0;
  faces.link('ses_2', () => {
    asked++;
    return ['ses_1'];
  });
  faces.link('ses_9', () => ['lnc_9']);
  expect(faces.wire().faces.ses_1!.sessions).toEqual(['ses_2']);
  expect(faces.wire().faces.lnc_9!.sessions).toEqual(['launch:lnc_9', 'ses_9']);
  expect(heard.length).toBe(before + 2);
  // The next polls of a linked session, and of a session that is no agent with a face, write nothing.
  faces.link('ses_2', () => {
    asked++;
    return ['ses_1'];
  });
  faces.link('ses_other', () => []);
  expect(asked).toBe(1);
  expect(heard.length).toBe(before + 2);
});

test('the file keeps the latest choices only', () => {
  const faces = file();
  for (let i = 0; i < INBOX_AGENT_FACES_KEPT + 5; i++) faces.change({ agent: `ses_${i}`, face: 'glass' });
  const keys = Object.keys(faces.wire().faces);
  expect(keys.length).toBe(INBOX_AGENT_FACES_KEPT);
  expect(keys[0]).toBe('ses_5');
  // A choice again moves the agent last, so it is kept longest.
  faces.change({ agent: 'ses_5', face: 'glass-red' });
  expect(Object.keys(faces.wire().faces).at(-1)).toBe('ses_5');
  expect(readFileSync(join(dir, INBOX_AGENT_FACES_FILE), 'utf8').length).toBeLessThan(40_000);
});

test('this browser’s faces from before are adopted without writing over a choice, and only once', () => {
  const faces = file();
  faces.change({ agent: 'ses_1', face: 'yellow' });
  faces.change({ adopt: { ses_1: 'glass', ses_2: 'totman' } });
  expect(faces.wire().faces).toEqual({ ses_1: { face: 'yellow', sessions: [] }, ses_2: { face: 'totman', sessions: [] } });
  const rev = faces.wire().rev;
  faces.change({ adopt: { ses_2: 'glass' } });
  expect(faces.wire().rev).toBe(rev);
});

test('a newer file is never written over; an unreadable one is moved aside', () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, INBOX_AGENT_FACES_FILE), JSON.stringify({ v: 2, faces: {} }));
  expect(() => file().change({ agent: 'ses_1', face: 'glass' })).toThrow();
  renameSync(join(dir, INBOX_AGENT_FACES_FILE), join(dir, 'newer.json'));
  writeFileSync(join(dir, INBOX_AGENT_FACES_FILE), '{not json');
  file().change({ agent: 'ses_1', face: 'glass' });
  expect(file().wire().faces.ses_1!.face).toBe('glass');
});

test('the route: same-site reads, a checked write under the page session, and no other site', async () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const route = createInboxAgentFaces({ file: file(), serverSession: 'srv_1', readBody: async (req) => (await req.json()) as Record<string, unknown>, json }).route;
  const url = new URL('http://localhost/api/inbox/agent-faces');
  const post = (body: unknown) => route(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url);
  const saved = await (await post({ agent: 'ses_1', sessions: ['ses_0'], face: 'glass-pink', serverSession: 'srv_1' }))!.json();
  expect(saved).toEqual({ faces: { ses_1: { face: 'glass-pink', sessions: ['ses_0'] } }, rev: 1 });
  expect((await post({ agent: 'ses_1', face: 'glass-pink', serverSession: 'srv_old' }))!.status).toBe(409);
  await expect(post({ agent: 'ses_1', face: 'sparkles', serverSession: 'srv_1' })).rejects.toThrow();
  expect(await (await route(new Request(url), url))!.json()).toEqual(saved);
  const other = await route(new Request(url, { headers: { 'sec-fetch-site': 'cross-site' } }), url);
  expect(other!.status).toBe(403);
  expect(await route(new Request(new URL('http://localhost/api/inbox/pins')), new URL('http://localhost/api/inbox/pins'))).toBeNull();
});
