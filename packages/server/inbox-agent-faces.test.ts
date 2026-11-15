/**
 * The agent icons' faces file (packages/shared/inbox/agent-faces.ts) and its route (inbox-agent-faces.ts).
 *
 * What this catches: a face not kept for its agent or not found by one of its sessions; a choice of the agent's own
 * mark kept on disk; a continued session (a poll's `continues`) or a launch's session not linked to the face, so its
 * threads lose it after it ends; a link that writes on every poll; the file growing past its cap; this browser's
 * faces from before written over another window's choice, or adopted twice; a newer file written over; a write
 * with no event for the other windows; another site reading the faces. Given names: one lost on a restart, a face
 * change, a removed picture or a continued session; a reset or blank name kept on disk; a name over the cap or with a
 * control character taken. No Inbox is started: the route is called directly with a temp folder.
 */
import { beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INBOX_AGENT_FACES_KEPT, INBOX_AGENT_NAME_MAX, readInboxAgentFaces, type InboxAgentFacesWire } from '@plannotator/core/inbox-types';
import { checkInboxAgentFaceChange, createInboxAgentFacesFile, INBOX_AGENT_FACES_FILE } from '@plannotator/shared/inbox/agent-faces';
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

test('the cap drops the oldest unnamed entries before a named one, and named entries alone stay bounded', () => {
  const faces = file();
  faces.change({ agent: 'ses_named', name: 'Retry worker' });
  for (let i = 0; i < INBOX_AGENT_FACES_KEPT + 5; i++) faces.change({ agent: `ses_${i}`, face: 'glass' });
  const kept = faces.wire().faces;
  expect(Object.keys(kept).length).toBe(INBOX_AGENT_FACES_KEPT);
  expect(kept.ses_named!.name).toBe('Retry worker');
  expect(kept.ses_0).toBeUndefined();
  expect(kept.ses_5).toBeUndefined();
  expect(kept.ses_6).toBeDefined();

  dir = join(mkdtempSync(join(tmpdir(), 'pn-agent-faces-')), 'inbox');
  const named = file();
  for (let i = 0; i < INBOX_AGENT_FACES_KEPT + 3; i++) named.change({ agent: `nam_${i}`, name: `Agent ${i}` });
  const keys = Object.keys(named.wire().faces);
  expect(keys.length).toBe(INBOX_AGENT_FACES_KEPT);
  expect(keys[0]).toBe('nam_3');
});

test('a given name is kept beside the face, survives a restart, and a reset or blank name forgets it', () => {
  const faces = file();
  faces.change({ agent: 'lnc_1', sessions: ['ses_a', 'launch:lnc_1'], name: 'Retry worker' });
  expect(faces.wire().faces.lnc_1).toEqual({ face: 'agent', sessions: ['ses_a', 'launch:lnc_1'], name: 'Retry worker' });
  expect(heard.map((w) => w.rev)).toEqual([1]);
  // The Inbox after a restart reads it back.
  expect(createInboxAgentFacesFile(dir, () => {}).wire().faces.lnc_1!.name).toBe('Retry worker');
  // A face change keeps the name; a name change keeps the face; the agent's own mark again keeps the name.
  faces.change({ agent: 'lnc_1', face: 'glass-blue' });
  expect(faces.wire().faces.lnc_1).toEqual({ face: 'glass-blue', sessions: ['ses_a', 'launch:lnc_1'], name: 'Retry worker' });
  faces.change({ agent: 'lnc_1', name: 'Release notes' });
  expect(faces.wire().faces.lnc_1).toEqual({ face: 'glass-blue', sessions: ['ses_a', 'launch:lnc_1'], name: 'Release notes' });
  faces.change({ agent: 'lnc_1', face: 'agent' });
  expect(faces.wire().faces.lnc_1).toEqual({ face: 'agent', sessions: ['ses_a', 'launch:lnc_1'], name: 'Release notes' });
  // Reset with no face kept: the entry goes.
  faces.change(checkInboxAgentFaceChange({ agent: 'lnc_1', name: '   ' }));
  expect(faces.wire().faces).toEqual({});
  // Reset of an agent never named writes nothing.
  const rev = faces.wire().rev;
  faces.change({ agent: 'ses_z', name: null });
  expect(faces.wire().rev).toBe(rev);
});

test('a continued session keeps its name: a choice for the new id takes the old entry, and a poll links it', () => {
  const faces = file();
  faces.change({ agent: 'ses_old', face: 'totman' });
  faces.change({ agent: 'ses_old', name: 'Retry worker' });
  // Named from the new session: one entry, the old face and session kept.
  faces.change({ agent: 'ses_new', sessions: ['ses_old'], name: 'Retry worker 2' });
  expect(faces.wire().faces).toEqual({ ses_new: { face: 'totman', sessions: ['ses_old'], name: 'Retry worker 2' } });
  // A face chosen from a newer session keeps the name.
  faces.change({ agent: 'ses_newer', sessions: ['ses_new'], face: 'yellow' });
  expect(faces.wire().faces).toEqual({ ses_newer: { face: 'yellow', sessions: ['ses_new'], name: 'Retry worker 2' } });
  // A poll from a continuing session links it, the name kept.
  faces.link('ses_last', () => ['ses_newer']);
  expect(faces.wire().faces.ses_newer).toEqual({ face: 'yellow', sessions: ['ses_new', 'ses_last'], name: 'Retry worker 2' });
});

test('a removed picture leaves a named agent with its own mark; names follow a project name’s rules', () => {
  const faces = file();
  const own = `own:${'a'.repeat(64)}`;
  faces.change({ agent: 'ses_1', face: own as never });
  faces.change({ agent: 'ses_1', name: 'Pictured' });
  faces.change({ agent: 'ses_2', face: own as never });
  faces.dropFace(own);
  expect(faces.wire().faces).toEqual({ ses_1: { face: 'agent', sessions: [], name: 'Pictured' } });
  expect(faces.shown().has('agent')).toBe(false);
  // A project name's rules.
  expect(checkInboxAgentFaceChange({ agent: 'ses_1', name: '  Retry   worker ' })).toEqual({ agent: 'ses_1', name: 'Retry worker', sessions: [] });
  expect(() => checkInboxAgentFaceChange({ agent: 'ses_1', name: 'x'.repeat(INBOX_AGENT_NAME_MAX + 1) })).toThrow();
  expect(checkInboxAgentFaceChange({ agent: 'ses_1', name: 'x'.repeat(INBOX_AGENT_NAME_MAX) })).toMatchObject({ name: 'x'.repeat(INBOX_AGENT_NAME_MAX) });
  expect(() => checkInboxAgentFaceChange({ agent: 'ses_1', name: 'one\u0007two' })).toThrow();
  expect(() => checkInboxAgentFaceChange({ agent: 'ses_1', name: 7 })).toThrow();
  // Read from a wire: an entry with neither face nor name goes; a refused name is dropped.
  expect(readInboxAgentFaces({ ses_a: { face: 'agent', sessions: [] }, ses_b: { face: 'agent', sessions: [], name: 'B' }, ses_c: { face: 'glass', sessions: [], name: 'x'.repeat(INBOX_AGENT_NAME_MAX + 1) } })).toEqual({
    ses_b: { face: 'agent', sessions: [], name: 'B' },
    ses_c: { face: 'glass', sessions: [] },
  });
});

test('the route takes a name under the page session and tells every window', async () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const route = createInboxAgentFaces({ file: file(), serverSession: 'srv_1', readBody: async (req) => (await req.json()) as Record<string, unknown>, json }).route;
  const url = new URL('http://localhost/api/inbox/agent-faces');
  const post = (body: unknown) => route(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url);
  const saved = await (await post({ agent: 'ses_1', sessions: ['ses_0'], name: 'Retry worker', serverSession: 'srv_1' }))!.json();
  expect(saved).toEqual({ faces: { ses_1: { face: 'agent', sessions: ['ses_0'], name: 'Retry worker' } }, rev: 1 });
  expect(heard.at(-1)!.faces.ses_1!.name).toBe('Retry worker');
  expect((await post({ agent: 'ses_1', name: 'Other', serverSession: 'srv_old' }))!.status).toBe(409);
  const reset = await (await post({ agent: 'ses_1', name: null, serverSession: 'srv_1' }))!.json();
  expect(reset).toEqual({ faces: {}, rev: 2 });
});
