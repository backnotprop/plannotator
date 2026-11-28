/**
 * The `@` picker in a thread whose list spans linked computers (packages/server/inbox-far-tags.ts). What regresses:
 * another computer's agent not offered, offered without its computer, or picked without the computer its tag must
 * name (the thread's computer then refuses it as "not live"); an agent that named itself by its host's id ("gemini")
 * shown in lower case.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MentionMenuState } from '@plannotator/ui/hooks/useMentionAutocomplete';
import type { TaggableModel } from './api';

const hasDom = typeof document !== 'undefined';
const { TagPicker } = (hasDom ? await import('./components/TagPicker') : {}) as typeof import('./components/TagPicker');
const { tagOptions, tagPeople, tagsToSend } = (hasDom ? await import('./tags') : {}) as typeof import('./tags');

const row = (session: string, host: string | null, kind: 'live' | 'mcp', extra: Record<string, unknown> = {}) => ({
  session,
  host,
  kind,
  name: null,
  project: { id: 'prj_api', name: 'api', root: null },
  started_at: '2026-11-24T09:14:00.000Z',
  last_at: '2026-11-24T09:20:00.000Z',
  busy: false,
  idle_since: null,
  taggable: true,
  owner: false,
  wrote_thread: false,
  ...extra,
});
const LAPTOP = 'ibx_01JZ0000000000000000000001';

const spanning = {
  serverSession: 's',
  owner: { host: 'claude-code', session: 'owner-1' },
  machine: { id: 'ibx_01JZ0000000000000000000002', name: 'Studio' },
  sessions: [
    row('owner-1', 'claude-code', 'live', { owner: true }),
    row('pi-1', 'pi', 'live'),
    row('far-1', 'claude-code', 'live', { machine: LAPTOP, machine_name: 'Laptop', project: { id: null, name: 'web', root: null } }),
    row('mcp-1', 'gemini', 'mcp'),
  ],
} as unknown as TaggableModel;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function draw(model: TaggableModel) {
  const options = tagOptions(model, null, 'prj_api', (iso) => iso.slice(11, 16));
  const menu = { items: tagPeople(options), emptyNotice: null, heading: null, activeIndex: null, anchor: null, query: '' } as unknown as MentionMenuState;
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<TagPicker id="tp" menu={menu} options={options} onSelect={() => {}} />));
  return options;
}

const text = (session: string) => document.querySelector(`[data-tag-option="${session}"]`)?.textContent ?? '';

test.skipIf(!hasDom)('another computer’s agent is offered with its computer, and its tag names that computer', () => {
  const options = draw(spanning);
  expect(text('far-1')).toContain('Claude Code (Laptop)');
  expect(text('far-1')).toContain('web · Laptop');
  // This computer's own rows say theirs too, once the list spans computers.
  expect(text('pi-1')).toContain('api · Studio');
  expect(tagsToSend(['far-1', 'pi-1'], options, 'owner-1')).toEqual([
    { host: 'claude-code', session: 'far-1', label: 'Claude Code (Laptop)', machine: LAPTOP },
    { host: 'pi', session: 'pi-1', label: 'Pi' },
  ]);
});

test.skipIf(!hasDom)('one computer only: no computer is named and no tag carries one', () => {
  const one = { ...spanning, machine: undefined, sessions: (spanning.sessions as unknown[]).slice(0, 2) } as unknown as TaggableModel;
  const options = draw(one);
  expect(text('pi-1')).not.toContain('Studio');
  expect(tagsToSend(['pi-1'], options, 'owner-1')).toEqual([{ host: 'pi', session: 'pi-1', label: 'Pi' }]);
});

test.skipIf(!hasDom)('an agent named by its host id reads by its product name', () => {
  draw(spanning);
  expect(text('mcp-1')).toContain('Gemini CLI');
  expect(text('mcp-1')).not.toContain('gemini');
});
