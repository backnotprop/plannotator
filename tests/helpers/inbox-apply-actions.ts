import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { parseInboxThreadPullRef, type InboxThreadPullRef } from '../../packages/core/inbox-thread-pulls';
import { recordInboxAttachments } from '../../packages/shared/inbox/attachments';
import { inboxApi } from '../../packages/inbox/api';
import { keepSavedQuestions } from '../../packages/inbox/data/actions/picks';
import { putThread } from '../../packages/inbox/data/queries/thread';
import { agent, type ApplyWorld } from './inbox-apply-world';

export const ACTIONS = [
  'agent-new',
  'agent-reply',
  'agent-ask',
  'agent-files',
  'agent-supersede',
  'agent-action',
  'agent-name',
  'person-start',
  'person-reply',
  'open',
  'pick',
  'unpick',
  'seen',
  'read',
  'unread',
  'ack',
  'resolve',
  'comment-message',
  'comment-file',
  'uncomment',
  'action-mark',
  'project-rename',
  'project-new',
  'snooze',
  'card',
  'initiative',
  'steps',
  'pulls',
  'delivery',
  'agent-checked',
] as const;

export type ActionKind = (typeof ACTIONS)[number];
export interface Action {
  kind: ActionKind;
  n: readonly [number, number, number];
}

const ASK = (n: number) => ['Which way?', '', ':::question', `Option set ${n}?`, '', '- [ ] Cards', '- [ ] Table', ':::'].join('\n');
const TODO = (n: number) => ['Two things for you.', '', ':::action', `Rotate key ${n}`, ':::'].join('\n');
const comment = (id: string, originalText: string) => ({ id, blockId: 'block-0', startOffset: 0, endOffset: 4, type: 'COMMENT', text: `Note ${id}`, originalText, createdA: 1 });

const at = <T>(items: readonly T[], n: number): T | undefined => (items.length === 0 ? undefined : items[n % items.length]);

function threadIds(w: ApplyWorld): string[] {
  return w.server.store.threadIds().filter((id) => w.server.store.windowThread(id) !== null);
}

function messagesOf(w: ApplyWorld, threadId: string): InboxMessageWire[] {
  return (w.server.store.windowThread(threadId)?.messages ?? []) as InboxMessageWire[];
}

const agentMessages = (w: ApplyWorld, threadId: string) => messagesOf(w, threadId).filter((m) => m.author.kind === 'agent');
const sessionOf = (w: ApplyWorld, threadId: string) => {
  const message = agentMessages(w, threadId)[0];
  if (message?.author.kind === 'agent') return message.author.session ?? 'ses_a';
  return (w.server.store.message(threadId) as { to?: { session?: string } | null } | undefined)?.to?.session ?? 'ses_a';
};

function openQuestions(w: ApplyWorld, threadId: string): { message: string; question: InboxQuestion }[] {
  return agentMessages(w, threadId).flatMap((m) => w.server.store.questionsOf(m.id).filter((q) => q.state === 'open' && !q.action).map((question) => ({ message: m.id, question })));
}

function pickedQuestions(w: ApplyWorld, threadId: string): { message: string; question: InboxQuestion }[] {
  return agentMessages(w, threadId).flatMap((m) => w.server.store.questionsOf(m.id).filter((q) => q.state === 'picked').map((question) => ({ message: m.id, question })));
}

function agentSend(w: ApplyWorld, threadId: string, extra: Record<string, unknown>) {
  const latest = messagesOf(w, threadId).at(-1)!;
  return w.server.store.sendMessage({ project_id: latest.project_id, author: agent(sessionOf(w, threadId)), reply_to: latest.id, body: 'Done with that part.', ...extra });
}

export async function runAction(w: ApplyWorld, action: Action, step: number): Promise<void> {
  const [a, b, c] = action.n;
  const store = w.server.store;
  const threads = threadIds(w);
  const held = w.window.held().filter((id) => threads.includes(id));
  const t = a % 3 === 0 ? at(threads, a >> 2) : (at(held, a >> 2) ?? at(threads, a >> 2));
  const project = at(w.projects, b)!;
  switch (action.kind) {
    case 'agent-new': {
      const sent = store.sendMessage({ project_id: project.id, author: agent(`ses_${c % 4}`), body: c % 2 === 0 ? ASK(step) : `Built step ${step}.`, subject: c % 3 === 0 ? null : `Thread ${step}` });
      if (!w.window.open || c % 3 === 0) await w.window.openThread(sent.message.thread_id);
      return;
    }
    case 'person-start': {
      const started = store.startPersonThread({ project_id: project.id, body: `Please look at ${step}.`, to: { host: 'claude-code', session: `ses_p${c % 3}` }, idempotency_key: `start-${step}`, ...(c % 4 === 0 ? { thread_name: `Named ${step}` } : {}) });
      if (c % 2 === 0) await w.window.openThread(started.message.thread_id);
      return;
    }
    case 'open':
      if (t) await w.window.openThread(t);
      return;
  }
  if (!t) return;
  const resolved = store.windowThread(t)?.resolved_at !== null;
  const latestAgent = agentMessages(w, t).at(-1);
  switch (action.kind) {
    case 'agent-reply':
      agentSend(w, t, { body: `Progress ${step}.` });
      return;
    case 'agent-ask':
      agentSend(w, t, { body: ASK(step) });
      return;
    case 'agent-files': {
      const name = `file-${step}-${c % 3}.md`;
      const folder = w.server.store.project(messagesOf(w, t)[0]!.project_id)?.root ?? project.root;
      writeFileSync(join(folder, name), `# File ${step}\n\nText ${step}.\n`);
      agentSend(w, t, { body: `See the file ${step}.`, attachments: await recordInboxAttachments(store.dir, [name], { base: folder, at: new Date().toISOString() }) });
      return;
    }
    case 'agent-supersede': {
      const open = at(openQuestions(w, t), b);
      if (open) agentSend(w, t, { body: ASK(step), supersedes: [`${open.message}/${open.question.key}`] });
      return;
    }
    case 'agent-action':
      agentSend(w, t, { body: TODO(step) });
      return;
    case 'agent-name':
      try {
        const named = at(held.filter((id) => messagesOf(w, id)[0]?.author.kind === 'person'), b) ?? t;
        agentSend(w, named, { body: `Naming ${step}.`, thread: `Agent name ${step}` });
      } catch {}
      return;
    case 'person-reply': {
      if (!latestAgent || resolved) return;
      const picked = pickedQuestions(w, t).filter((p) => p.message === latestAgent.id || c % 2 === 0);
      const notes = c % 2 === 0 ? store.pendingAnnotations(t) : [];
      const answer = await inboxApi.reply(latestAgent.id, {
        idempotency_key: `reply-${step}`,
        words: `Reply ${step}.`,
        questions: picked.map((p) => ({ message_id: p.message, key: p.question.key, revision: p.question.revision })),
        ...(notes.length > 0 ? { annotation_ids: notes.map((r) => r.id), feedback: 'Notes.' } : {}),
        with_thread: true,
      }).catch(() => null);
      if (answer?.thread_read) putThread(w.window.client, t, answer.thread_read);
      return;
    }
    case 'pick':
    case 'unpick': {
      const pool = action.kind === 'pick' ? openQuestions(w, t) : pickedQuestions(w, t);
      const target = at(pool, b);
      if (!target) return;
      const q = target.question;
      const answer = action.kind === 'pick' ? ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [q.choices[c % q.choices.length]?.label ?? 'Cards'] } as never) : null;
      const saved = await inboxApi.pick(target.message, q.key, q.revision, answer, { unsentOnly: true }).catch(() => null);
      if (saved) keepSavedQuestions(w.window.client, target.message, saved.questions);
      return;
    }
    case 'seen':
      await inboxApi.seen(t, messagesOf(w, t).at(-1)?.seq ?? null).catch(() => null);
      return;
    case 'read':
      await inboxApi.markRead(t, c % 2 === 0).catch(() => null);
      return;
    case 'unread':
      await inboxApi.markUnread(t).catch(() => null);
      return;
    case 'ack':
      if (latestAgent) await inboxApi.ack(latestAgent.id, c % 3 !== 0, c % 2 === 0 ? null : { emoji: '🎉' }).catch(() => null);
      return;
    case 'resolve':
      await inboxApi.resolve(t, !resolved).catch(() => null);
      return;
    case 'comment-message':
      if (latestAgent) await inboxApi.saveMessageAnnotation(latestAgent.id, comment(`m-${step}`, latestAgent.body.slice(0, 8))).catch(() => null);
      return;
    case 'comment-file': {
      const file = at(messagesOf(w, t).flatMap((m) => m.attachments ?? []), b);
      if (file) await inboxApi.saveAnnotation(file.id, 'current', comment(`f-${step}`, 'File')).catch(() => null);
      return;
    }
    case 'uncomment': {
      const note = at(store.pendingAnnotations(t), b);
      if (note) await inboxApi.removeAnnotation(note.id).catch(() => null);
      return;
    }
    case 'action-mark': {
      const item = at(agentMessages(w, t).flatMap((m) => store.questionsOf(m.id).filter((q) => q.action).map((q) => ({ m: m.id, q }))), b);
      if (item) await inboxApi.markAction(item.m, item.q.key, c % 3 === 0 ? null : { outcome: c % 2 === 0 ? 'done' : 'cant', note: `Why ${step}` }).catch(() => null);
      return;
    }
    case 'project-rename':
      await inboxApi.renameProject(project.id, c % 3 === 0 ? null : `Renamed ${step}`).catch(() => null);
      return;
    case 'project-new':
      store.ensureProject({ name: 'web', root: join(w.root, 'elsewhere/web') });
      return;
    case 'snooze':
      await inboxApi.snooze(t, c % 2 === 0 ? new Date(Date.now() + 3_600_000).toISOString() : null).catch(() => null);
      return;
    case 'card':
      store.createCard({ project_id: messagesOf(w, t)[0]!.project_id, by: { kind: 'person' }, title: `Card ${step}`, threads: [t] });
      return;
    case 'initiative':
      store.createInitiative({ name: `Initiative ${step}`, by: { kind: 'person' } });
      return;
    case 'steps':
      store.setThreadSteps({ thread_id: t, agent: agent(sessionOf(w, t)), steps: [{ step: `Step ${step}`, status: c % 2 === 0 ? 'doing' : 'done' }] });
      return;
    case 'pulls':
      store.changeThreadPulls({ thread_id: t, add: [parseInboxThreadPullRef(`acme/web#${(c % 5) + 1}`) as InboxThreadPullRef], by: { kind: 'person' } });
      return;
    case 'delivery': {
      const reply = at(messagesOf(w, t).filter((m) => m.author.kind === 'person' && m.reply_to !== null), b);
      if (reply) {
        try {
          store.recordDelivery(reply.id, { host: 'claude-code', session: sessionOf(w, t) });
        } catch {}
      }
      return;
    }
    case 'agent-checked':
      store.markAgentChecked(t);
      return;
  }
}
