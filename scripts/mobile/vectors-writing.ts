/**
 * The writing suite: tagging agents with `@` in the reply box (approval "inbox-tag-agents"), 👍 Looks good's line
 * (approval "inbox-acknowledge", "inbox-reaction-tray") and Take back (issue #3229). The phone draws and decides
 * the same as the window; this suite holds it to the window's own functions:
 *
 * - `tagOptions` and `tagPickedWords` (packages/inbox/tags.ts): the picker's rows, their groups, labels and second
 *   lines, and what VoiceOver says on a pick. The time words are `T(<iso>)` here; the phone puts its own in.
 * - `mentionTrigger`, `applyMentionPick`, `survivingMentions`, `sanitizeMentionLabel` (packages/ui/utils/mentions.ts):
 *   when `@` opens the list, what a pick writes and where the caret lands (UTF-16 offsets, as the window counts),
 *   and which tags a draft still holds.
 * - `tagName` (packages/inbox/tags.ts): who a sent reply's tags name.
 * - `tagDeliveryLine` (packages/inbox/tags.ts): the line under a sent reply for each agent it tagged, the session's
 *   connection not known (the phone reads none).
 * - `ackPillLine` (packages/inbox/thread/ackLine.ts): the line under a 👍, its session's connection not known (the
 *   phone reads none).
 * - `takeBackOffered` (packages/inbox/takeBack.ts): which of the person's messages Take back is offered on.
 * - `reactionSpeech` (packages/inbox/components/ReactionTray.tsx): what a screen reader says for a reaction that
 *   shows its emoji alone, by the emoji's name in the window's own list (`emojiRow`).
 *
 * scripts/mobile/vectors.ts writes vectors/writing.json from it.
 */
import type { InboxAck, InboxMessageWire, InboxTag } from '../../packages/core/inbox-types';
import type { TaggableModel } from '../../packages/inbox/api';
import { tagDeliveryLine, tagName, tagOptions, tagPickedWords, tagsToSend } from '../../packages/inbox/tags';
import { ackPillLine } from '../../packages/inbox/thread/ackLine';
import { takeBackOffered } from '../../packages/inbox/takeBack';
import { reactionSpeech } from '../../packages/inbox/components/ReactionTray';
import { applyMentionPick, mentionTrigger, sanitizeMentionLabel, survivingMentions, type MentionPerson } from '../../packages/ui/utils/mentions';
import { readRepoText } from './lib';

export const WRITING_FIXTURE = 'apps/mobile/contract/fixtures/writing.json';

type Fixture = {
  taggable: { name: string; owner: string | null; project: string | null; model: TaggableModel }[];
  triggers: { text: string; caret: number }[];
  picks: { text: string; caret: number; label: string }[];
  surviving: { text: string; labels: string[] }[];
  tagNames: { tag: Pick<InboxTag, 'host' | 'session' | 'label' | 'name'>; ownerHost: string | null; ownerSession: string | null }[];
  tagLines: { name: string; tag: InboxTag }[];
  acks: { agent: string; wakes: boolean; ack: InboxAck }[];
  takeBack: { name: string; threads: [string, Record<string, unknown>?][]; at: number }[];
  speech: string[];
};

/** The time words, marked: the phone's own go where `T(…)` stands. */
const time = (iso: string) => `T(${iso})`;

const person = (label: string): MentionPerson => ({ id: label, kind: 'agent', label });

export function writingVectors(about: string): unknown {
  const fixture = JSON.parse(readRepoText(WRITING_FIXTURE)) as Fixture;
  const taggable = fixture.taggable.map((input) => {
    const options = tagOptions(input.model, input.owner, input.project, time);
    // Each row tagged in turn, the owner among them: the reply's tags leave the owner out, in the order typed.
    const owner = input.owner ?? input.model.owner?.session ?? null;
    const send = tagsToSend([...options.map((o) => o.id)].reverse(), options, owner);
    return { ...input, options: options.map((o) => ({ ...o, picked: tagPickedWords(o) })), send: { order: [...options.map((o) => o.id)].reverse(), owner, tags: send } };
  });
  const triggers = fixture.triggers.map((input) => ({ ...input, trigger: mentionTrigger(input.text, input.caret) }));
  const picks = fixture.picks.map((input) => {
    const trigger = mentionTrigger(input.text, input.caret);
    return { ...input, token: sanitizeMentionLabel(input.label), result: trigger ? applyMentionPick(input.text, trigger, person(input.label)) : null };
  });
  const surviving = fixture.surviving.map((input) => ({ ...input, kept: survivingMentions(input.text, input.labels.map(person)).map((p) => p.label) }));
  const tagNames = fixture.tagNames.map((input) => ({ ...input, name: tagName(input.tag, input.ownerHost, input.ownerSession) }));
  const tagLines = fixture.tagLines.map((input) => {
    const line = tagDeliveryLine(input.tag, input.name, undefined, time);
    return { ...input, line: { state: line.state, text: line.text } };
  });
  const acks = fixture.acks.map((input) => ({ ...input, line: ackPillLine(input.ack, input.agent, input.wakes, time, undefined, Date.parse('2026-11-23T10:05:00.000Z')) }));
  const takeBack = fixture.takeBack.map((input) => {
    const messages = input.threads.map(([kind, extra], i) => ({ id: `msg_T${i}`, thread_id: 'msg_T0', author: kind === 'person' ? { kind: 'person' } : { kind: 'agent', host: 'pi', session: 'ses_a' }, body: 'words', ...(extra ?? {}) }) as unknown as InboxMessageWire);
    return { ...input, offered: takeBackOffered(messages[input.at]!, messages.length === 1, messages) };
  });
  const speech = fixture.speech.map((emoji) => ({ emoji, said: reactionSpeech({ emoji }) }));
  return { about, time: 'T(<iso>)', taggable, triggers, picks, surviving, tagNames, tagLines, acks, takeBack, speech };
}
