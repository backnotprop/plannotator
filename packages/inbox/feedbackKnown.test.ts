/**
 * The known answers (feedbackKnown.ts) against what people really type: each phrase must find its answer, and the
 * must-not phrases must find none, so the line under the Feedback box never answers something nobody asked. A new
 * entry adds phrases to both lists.
 */
import { describe, expect, test } from 'bun:test';
import { KNOWN_ANSWERS, hiddenKnownAnswers, knownAnswerFor } from './feedbackKnown';
import { FEEDBACK_FAQ } from './feedbackFaq';
import { SETTINGS_SECTIONS } from './settingsRoute';

const found = (text: string) => knownAnswerFor(text)?.id ?? null;

const MUST: [string, string][] = [
  // A fixed complaint.
  ['list moves too much', 'list-moves'],
  ['the list keeps jumping', 'list-moves'],
  ['rows move when I open a thread', 'list-moves'],
  ['threads reorder while I read', 'list-moves'],
  ['list shuffles', 'list-moves'],
  ['things keep moving around in the inbox', 'list-moves'],
  ['the inbox list jumps around and threads disappear', 'list-moves'],
  ['I click a thread and the list rearranges', 'list-moves'],
  ['The order keeps changing every time an agent writes', 'list-moves'],
  // Features.
  ['the groups are confusing', 'simple-list'],
  ['too many sections, I just want a list', 'simple-list'],
  ['can I sort by newest', 'simple-list'],
  ['I want it like gmail, chronological', 'simple-list'],
  ['rows are too cluttered', 'rows'],
  ['the list is too busy', 'rows'],
  ['I want compact rows', 'rows'],
  ['how do I mark a thread as done', 'done'],
  ['how do I archive a thread', 'done'],
  ['I want to delete old threads', 'done'],
  ['can I use this on my phone?', 'phone'],
  ['is there a mobile app', 'phone'],
  ['how do I set up tailscale', 'phone'],
  ['can agents start themselves', 'start-agents'],
  ['I want to start an agent from the inbox', 'start-agents'],
  ['can I launch Claude Code from here', 'start-agents'],
  ["I can't start an agent, where is the setting", 'start-agents'],
  ['I want notifications when an agent asks me something', 'notifications'],
  ["notifications don't show up", 'notifications'],
  ['dark mode please', 'theme'],
  ['the font size is too small', 'theme'],
  ['can I change the colors', 'theme'],
  ['I keep triggering shortcuts by accident while typing', 'keys'],
  ['please let me disable keyboard shortcuts', 'keys'],
  ['I want to reply by voice', 'voice'],
  ['speech to text would be great', 'voice'],
  ['can I see agents from my other computer', 'machines'],
  ['I run agents on two machines', 'machines'],
  ['let me snooze a thread', 'snooze'],
  ['remind me later about this thread', 'snooze'],
  ['I want to pin threads', 'star'],
  ['a way to favorite threads', 'star'],
  ['mark as unread please', 'unread'],
  ['I want to keep it unread', 'unread'],
  ['please add a todo list feature for agents', 'checklist'],
  ['show the agent checklist', 'checklist'],
  ['a kanban view of everything', 'board'],
  ['I want to see what all my agents are doing', 'board'],
  ['I want to turn off plan review in Claude Code', 'plan-review-off'],
  ["plan review over ssh doesn't work", 'plan-review-off'],
  ['how do I update plannotator', 'updates'],
  ['does it auto update?', 'updates'],
  ['can I edit the prompt the agents get', 'prompts'],
  ['custom instructions for the inbox reminder', 'prompts'],
  ['is there a tutorial', 'tour'],
  ['how does this work', 'tour'],
  // Experimental settings.
  ['the agents are way too verbose', 'bro-mode'],
  ['agent messages are full of jargon', 'bro-mode'],
  ['can you explain things in plain english', 'bro-mode'],
  ['I lose my reply when I switch threads', 'float-drafts'],
  ['keep my unsent reply somewhere', 'float-drafts'],
  ['too many questions at once', 'decision-mode'],
  ['let me answer the questions one at a time', 'decision-mode'],
];

const MUST_NOT = [
  'list',
  'moves',
  'too much',
  'it moves',
  'the list',
  'it crashed when I opened a plan',
  'love it',
  'the agent moves files around in my repo',
  'I want to remove a project',
  'the list no longer jumps, thanks for the fix',
  'shift+enter should send',
  'move the send button to the left',
  'the code review file list is long',
  'jump to the next question',
  'voice input does not work',
  'dark mode is broken in the diff',
  'group chat with multiple agents would be cool',
  'the plan diff shows moved lines wrong',
  'my favorite feature is the inbox',
  'I starred the repo',
  'the agent started deleting my files',
  'the update download stalls the inbox',
  'please support codex',
  'the review comments are hard to read',
  'great work, thanks',
  'Claude Code crashes when I start it',
];

describe('known answers', () => {
  for (const [text, id] of MUST) test(`"${text}" -> ${id}`, () => expect(found(text)).toBe(id));
  for (const text of MUST_NOT) test(`"${text}" -> nothing`, () => expect(found(text)).toBeNull());

  test('every entry has a phrase above that finds it', () => {
    const covered = new Set(MUST.map(([, id]) => id));
    for (const answer of KNOWN_ANSWERS) expect(covered.has(answer.id)).toBe(true);
  });

  test('an answer the Inbox hides is never shown, and the next one is not borrowed in its place', () => {
    expect(knownAnswerFor('can agents start themselves', ['start-agents'])).toBeNull();
    expect(knownAnswerFor('the agents are way too verbose', ['bro-mode'])).toBeNull();
  });

  test('only the first 4,000 characters are read', () => {
    expect(found(`${'x '.repeat(1990)}dark mode`)).toBe('theme');
    expect(found(`${'x '.repeat(2000)}dark mode`)).toBeNull();
  });

  test('each action opens a real Settings section or Simple list, and each link is public release notes or docs', () => {
    for (const { action, link } of KNOWN_ANSWERS) {
      if (action) expect(action.kind === 'simple-list' || action.kind === 'settings-experimental' || SETTINGS_SECTIONS.some((section) => action.kind === `settings-${section}`)).toBe(true);
      if (link) expect(link.href).toMatch(/^https:\/\/(plannotator\.ai\/docs\/|github\.com\/backnotprop\/plannotator\/releases\/tag\/v\d+\.\d+\.\d+$)/);
      expect(action || link).toBeTruthy();
    }
  });

  test('features held until 0.29 (heldSwitch: Code review, Shape, System) are never offered', () => {
    for (const answer of KNOWN_ANSWERS) expect(`${answer.answer} ${answer.faq?.answer ?? ''}`).not.toMatch(/code review|\bshape\b|\bsystem\b/i);
    for (const text of ['can I review code in the inbox', 'I want the shape boards', 'show me the system drawing']) expect(found(text)).toBeNull();
  });

  test('Common questions are the entries with a question, in the list\'s order', () => {
    expect(FEEDBACK_FAQ.map((item) => item.id)).toEqual(['list-moves', 'simple-list', 'rows', 'done', 'phone']);
  });

  test('the settings read hides what this Inbox does not offer', () => {
    expect(hiddenKnownAnswers(null)).toEqual([]);
    const all = { launch: { unsupported: false }, board: { on: true }, steps: { on: false }, bro: { on: false }, float_drafts: { on: false }, experimental: { decision_mode: { on: false } } };
    expect(hiddenKnownAnswers(all)).toEqual([]);
    expect(hiddenKnownAnswers({ ...all, launch: { unsupported: true } })).toEqual(['start-agents']);
    expect(hiddenKnownAnswers({ launch: { unsupported: false } })).toEqual(['board', 'checklist', 'bro-mode', 'float-drafts', 'decision-mode']);
  });
});
