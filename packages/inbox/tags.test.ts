/**
 * Tag agents (approval "inbox-tag-agents"): the picker's rows, labels and
 * groups, who a reply goes to, the per-agent lines and the Sent row's words.
 */
import { describe, expect, test } from 'bun:test';
import type { TaggableModel, TaggableSession } from './api';
import {
  TAG_READERS_GROUP,
  effectiveTagMode,
  sendTagsByTarget,
  sentRecipientsWords,
  tagDeliveryLine,
  tagHeadsUp,
  tagModeLine,
  tagName,
  tagOptions,
  tagPeople,
  tagsToSend,
  type TagOption,
} from './tags';
import { tagTokenSpans } from './tagHighlight';

const time = (iso: string) => iso.slice(11, 16);
const live = (session: string, host: string, project: { id: string; name: string }, extra: Partial<TaggableSession> = {}): TaggableSession => ({
  session,
  host,
  kind: 'live',
  name: null,
  project: { ...project, root: `/w/${project.name}` },
  started_at: '2026-10-19T09:14:00.000Z',
  last_at: '2026-10-19T19:00:00.000Z',
  busy: false,
  idle_since: null,
  taggable: true,
  owner: false,
  wrote_thread: false,
  ...extra,
});
const billing = { id: 'prj_billing', name: 'billing-api' };
const infra = { id: 'prj_infra', name: 'infra' };
const plan = { id: 'prj_plan', name: 'plannotator' };

const model: TaggableModel = {
  serverSession: 's',
  owner: { host: 'claude-code', session: 'cc-owner' },
  sessions: [
    live('cc-owner', 'claude-code', billing, { owner: true, wrote_thread: true, busy: true }),
    live('cc-two', 'claude-code', billing),
    live('pi-1', 'pi', infra),
    live('cc-plan', 'claude-code', plan),
    live('oc-1', 'opencode', plan, { busy: true }),
    live('pi-old', 'pi', infra, { taggable: false }),
    { ...live('codex-1', 'codex', { id: 'prj_docs', name: 'docs-site' }), kind: 'mcp', name: 'Codex', started_at: null, busy: null },
  ],
};

describe('the picker', () => {
  test('rows: the owner first in its agent group, then the agents as they come, the readers last; labels say which session', () => {
    const options = tagOptions(model, 'cc-owner', billing.id, time);
    expect(options.map((o) => [o.group, o.label, o.owner, o.wakes, o.taggable])).toEqual([
      ['Claude Code', 'Claude Code', true, true, true],
      ['Claude Code', 'Claude Code (another session)', false, true, true],
      ['Claude Code', 'Claude Code (plannotator)', false, true, true],
      ['Pi', 'Pi', false, true, true],
      // A Pi on an older Plannotator never makes the taggable Pi read "Pi (infra)"; it reads so itself.
      ['Pi', 'Pi (infra)', false, true, false],
      ['OpenCode', 'OpenCode', false, true, true],
      [TAG_READERS_GROUP, 'Codex', false, false, true],
    ]);
    expect(options[0]!.detail).toBe('billing-api · working · since 09:14');
    expect(options[6]!.detail).toBe('docs-site · seen 19:00');
    // As ui's mention people: agents, grouped, the older one blocked.
    expect(tagPeople(options).find((p) => p.id === 'pi-old')).toMatchObject({ kind: 'agent', canOpen: false, group: 'Pi' });
  });

  test('labels never collide: two other Claude Code sessions in this project read apart', () => {
    const twins: TaggableModel = { ...model, sessions: [model.sessions[0]!, live('a', 'claude-code', billing), live('b', 'claude-code', billing)] };
    expect(tagOptions(twins, 'cc-owner', billing.id, time).map((o) => o.label)).toEqual([
      'Claude Code',
      'Claude Code (another session)',
      'Claude Code (another session 2)',
    ]);
  });

  test('what a Send carries: the tagged sessions with their labels, never the owner, each once', () => {
    const options = tagOptions(model, 'cc-owner', billing.id, time);
    expect(tagsToSend(['pi-1', 'cc-owner', 'pi-1', 'codex-1', 'gone'], options, 'cc-owner')).toEqual([
      { host: 'pi', session: 'pi-1', label: 'Pi' },
      { host: 'codex', session: 'codex-1', label: 'Codex' },
      { session: 'gone' },
    ]);
  });

  test('one Send tags once, on its last reply: a comment tag on an earlier target and the same agent in the words are one tag', () => {
    const options = tagOptions(model, 'cc-owner', billing.id, time);
    const targets = [
      { id: 'msg-a', owner: 'cc-two' },
      { id: 'msg-b', owner: 'cc-owner' },
    ];
    // Pi tagged in a comment on A's file and again in the words; Codex only in a comment on A.
    const plan = sendTagsByTarget(targets, ['pi-1'], new Map([['msg-a', ['pi-1', 'codex-1']]]), options);
    expect(plan.get('msg-a')).toEqual([]);
    expect(plan.get('msg-b')).toEqual([
      { host: 'pi', session: 'pi-1', label: 'Pi' },
      { host: 'codex', session: 'codex-1', label: 'Codex' },
    ]);
    // A comment tag on a non-last target, with nothing in the words, still goes with the whole Send.
    const onlyComment = sendTagsByTarget(targets, [], new Map([['msg-a', ['pi-1']]]), options);
    expect(onlyComment.get('msg-a')).toEqual([]);
    expect(onlyComment.get('msg-b')).toEqual([{ host: 'pi', session: 'pi-1', label: 'Pi' }]);
    // The earlier target's owner tagged in a comment is tagged on the last reply; the last reply's owner never is.
    expect(sendTagsByTarget(targets, ['cc-owner'], new Map([['msg-a', ['cc-two']]]), options).get('msg-b')!.map((t) => t.session)).toEqual(['cc-two']);
  });

  test('the heads-ups: one for a session that does not own the thread, another for one that cannot be woken', () => {
    const options = tagOptions(model, 'cc-owner', billing.id, time);
    expect(tagHeadsUp(options.find((o) => o.id === 'cc-two')!, 'reply')).toBe(
      "Claude Code (another session) doesn't own this thread. It gets your reply and a pointer to this thread.",
    );
    expect(tagHeadsUp(options.find((o) => o.id === 'codex-1')!, 'reply')).toBe(
      "Codex can't be woken: it reads the Inbox through MCP. It sees your reply the next time it reads this thread.",
    );
    expect(tagHeadsUp(options.find((o) => o.id === 'pi-1')!, 'comment')).toBe(
      "Pi doesn't own this thread. It gets this comment with your next Send, and a pointer to this thread.",
    );
  });
});

describe('a sent reply', () => {
  test('each tagged session has its own line: queued with Send now, delivered, saved, and read for an MCP agent', () => {
    const base = { host: 'pi', session: 'pi-1', wakes: true };
    expect(tagDeliveryLine(base, 'Pi', { busy: true, idle_since: null, send_now: true }, time)).toEqual({
      state: 'queued',
      text: 'Queued · Pi is working; it gets this when its turn ends.',
      sendNow: true,
    });
    expect(tagDeliveryLine({ ...base, delivery: { state: 'delivered', host: 'pi', session: 'pi-1', at: '2026-10-19T19:24:00.000Z' } }, 'Pi', null, time).text).toBe(
      'Delivered to Pi, 19:24',
    );
    const codex = { host: 'codex', session: 'c', wakes: false };
    expect(tagDeliveryLine(codex, 'Codex', undefined, time).text).toBe('Saved for Codex. It sees it the next time it reads this thread.');
    expect(tagDeliveryLine({ ...codex, read_at: '2026-10-19T19:30:00.000Z' }, 'Codex', undefined, time).text).toBe('Codex read this thread, 19:30');
    // A woken Codex tag whose `codex queue` ran out of time may not have gone: saved, not queued.
    const woken = { host: 'codex', session: 'c', wakes: true };
    const connection = { busy: null, idle_since: null, send_now: false, uncertain: ['msg_R'] };
    expect(tagDeliveryLine(woken, 'Codex', connection, time, 'msg_R').text).toBe('Saved for Codex. It sees it the next time it reads this thread.');
    expect(tagDeliveryLine(woken, 'Codex', connection, time, 'msg_other').text).toBe('Queued for Codex; it gets this as its next turn.');
  });

  test('a tag is named by the label it was sent with, else as another session of the owner agent', () => {
    expect(tagName({ host: 'pi', session: 'p', label: 'Pi (infra)' }, 'claude-code', 'o')).toBe('Pi (infra)');
    expect(tagName({ host: 'claude-code', session: 'x' }, 'claude-code', 'o')).toBe('Claude Code (another session)');
    expect(tagName({ host: 'codex', session: 'c', name: 'Codex' }, 'claude-code', 'o')).toBe('Codex');
  });

  test("the Sent row's words: how many have it, who is queued", () => {
    expect(
      sentRecipientsWords([
        { host: 'claude-code', delivered_at: '2026-10-19T19:24:00.000Z', wakes: true },
        { host: 'pi', delivered_at: null, wakes: true },
        { host: 'codex', name: 'Codex', delivered_at: null, wakes: false },
      ]),
    ).toBe('1 of 3 delivered · Pi queued');
    expect(sentRecipientsWords([{ host: 'codex', name: 'Codex', delivered_at: null, wakes: false }])).toBe('0 of 1 delivered · Codex not woken');
  });

  test('the painted tokens: at a word start, the longest label first, never inside a longer word', () => {
    const text = 'Ok. @Claude Code (another session) re-run it. @Pi raise it; @Pilot no; a@Pi no; (@Pi) yes.';
    const spans = tagTokenSpans(text, ['Pi', 'Claude Code', 'Claude Code (another session)']).map((s) => text.slice(s.start, s.end));
    expect(spans).toEqual(['@Claude Code (another session)', '@Pi', '@Pi']);
  });
});

describe('the reply box line (approval "inbox-tag-handoff", A2)', () => {
  const opt = (id: string, label: string, extra: Partial<TagOption> = {}): TagOption => ({
    id,
    host: 'claude-code',
    label,
    agent: 'Claude Code',
    detail: '',
    group: 'Claude Code',
    owner: false,
    wakes: true,
    taggable: true,
    project: null,
    ...extra,
  });
  const herdr = opt('ses_herdr', 'Claude Code (herdr)');
  const pi = opt('ses_pi', 'Pi', { host: 'pi', agent: 'Pi' });
  const codex = opt('ses_codex', 'Codex', { host: 'codex', agent: 'Codex', wakes: false });
  const owner = opt('ses_owner', 'Claude Code', { owner: true });

  test('one live agent: an Ask by default, with both switches; each switch reads back with Ask instead', () => {
    expect(tagModeLine([herdr], 'ask')).toEqual({
      mode: 'ask',
      lead: 'Asks',
      names: 'Claude Code (herdr)',
      after: '',
      links: [
        { mode: 'add', label: 'Add instead' },
        { mode: 'handoff', label: 'Hand off instead' },
      ],
    });
    expect(tagModeLine([herdr], 'handoff')).toMatchObject({ mode: 'handoff', lead: 'Hands this thread to', names: 'Claude Code (herdr)', links: [{ mode: 'ask', label: 'Ask instead' }] });
    expect(tagModeLine([herdr], 'add')).toMatchObject({ mode: 'add', lead: 'Adds', after: ' to this thread', links: [{ mode: 'ask', label: 'Ask instead' }] });
  });

  test('no line for the owner alone; Hand off only for one agent; neither switch while an agent is not woken', () => {
    expect(tagModeLine([owner], 'ask')).toBeNull();
    expect(tagModeLine([herdr, pi], 'ask')!.links.map((l) => l.mode)).toEqual(['add']);
    expect(tagModeLine([pi, codex], 'ask')).toMatchObject({ names: 'Pi and Codex', links: [] });
    expect(tagModeLine([pi, codex], 'ask')!.after).toBe(" · Codex isn't woken: it sees your reply the next time it reads this thread");
  });

  test('a mode no longer offered (a second tag, an agent not woken) sends as an Ask', () => {
    expect(effectiveTagMode([herdr], 'handoff')).toBe('handoff');
    expect(effectiveTagMode([herdr, pi], 'handoff')).toBe('ask');
    expect(effectiveTagMode([herdr, pi], 'add')).toBe('add');
    expect(effectiveTagMode([pi, codex], 'add')).toBe('ask');
    expect(effectiveTagMode([], 'handoff')).toBe('ask');
  });

  test("the mode rides only the words' tags; an Ask is sent with no mode, as before; a comment's tag stays an Ask", () => {
    const options = [herdr, pi];
    const ask = sendTagsByTarget([{ id: 'm1', owner: 'ses_owner' }], ['ses_herdr'], new Map(), options);
    expect(ask.get('m1')).toEqual([{ host: 'claude-code', session: 'ses_herdr', label: 'Claude Code (herdr)' }]);
    const handed = sendTagsByTarget([{ id: 'm1', owner: 'ses_owner' }], ['ses_herdr'], new Map([['m1', ['ses_pi']]]), options, 'handoff');
    expect(handed.get('m1')).toEqual([
      { host: 'claude-code', session: 'ses_herdr', label: 'Claude Code (herdr)', mode: 'handoff' },
      { host: 'pi', session: 'ses_pi', label: 'Pi' },
    ]);
  });
});
