/**
 * The onboarding tour's state machine, coach cards and fixture (approval
 * "inbox-onboarding-tour", v2). Pure: no DOM. The fixture is the shipped one
 * (packages/inbox/tour/content/fixture.json), checked as the brief asks:
 * every question block parses with core's parser, every referenced asset
 * ships and is in the server's manifest, the content stays under its budget,
 * and nothing private ships.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import { readInboxAttachmentKind } from '@plannotator/core/inbox-types';
import { selectionOnPhrase } from '../fileSource';
import {
  TOUR_FILM_REPLY_ID,
  TOUR_FILM_THREAD,
  TOUR_NEW_THREAD,
  TOUR_REPLY_ID,
  TOUR_START,
  TOUR_STEPS,
  TOUR_THREAD,
  TOUR_WARM_REPLY_ID,
  filmTimings,
  newThreadTimings,
  parseTourFixture,
  pickDiffers,
  replayTimings,
  tourAttachments,
  tourCanBack,
  tourCanForward,
  tourCoach,
  tourCoachSpeech,
  tourMessages,
  tourQuestion,
  tourRecord,
  tourReducer,
  tourSections,
  tourStateAt,
  tourSuggestionFor,
  tourTime,
  tourWarmAnswer,
  tourWarmQuestion,
  tourYourTurn,
  warmDiffers,
  warmTimings,
  type TourAction,
  type TourState,
  type TourUi,
} from './model';

const CONTENT = join(import.meta.dir, 'content');
const raw = JSON.parse(readFileSync(join(CONTENT, 'fixture.json'), 'utf8'));
const fixture = parseTourFixture(raw);
const REAL = fixture.threads.find((t) => t.id === TOUR_THREAD)!.real_answer!;
const WARM = tourWarmAnswer(fixture)!;
const names = { developer: fixture.developer, agent: 'Claude Code' };
const run = (actions: TourAction[], from: TourState = TOUR_START) => actions.reduce(tourReducer, from);
const sectionOf = (state: TourState, id: string) => tourSections(fixture, state).find((s) => s.threads.some((r) => r.thread_id === id))?.id;
const files = tourAttachments(fixture, tourStateAt(TOUR_STEPS, REAL, fixture));
const fileNamed = (name: string) => files.find((a) => a.name === name)!;
const ask = tourQuestion(fixture)!.message;

/** A comment the person saves in a viewer, as the tour's file source records it. */
function fileComment(name: string, annotation: Record<string, unknown> = {}) {
  const a = fileNamed(name);
  const thread = fixture.threads.find((t) => t.messages.some((m) => m.id === a.message_id))!.id;
  return tourRecord({ id: `ann-${name}`, thread, message: a.message_id, attachment: a, annotation: { id: `ann-${name}`, type: 'COMMENT', text: 'x', ...annotation } });
}
const wordsComment = tourRecord({ id: 'ann-words', thread: TOUR_THREAD, message: ask.id, messageAt: '2026-10-24T12:03:00Z', annotation: { id: 'ann-words', type: 'COMMENT', text: 'x', originalText: 'x' } });

describe('the walk', () => {
  test('1 to 10 advance on the real actions; Next only where the brief puts it', () => {
    let s = TOUR_START;
    // Step 1 opens on "How it's organised", then the question's row.
    expect(tourCoach(s, names)).toMatchObject({ key: '1-orient', picture: 'orient', next: true });
    s = tourReducer(s, { type: 'next' });
    expect(tourCoach(s, names)).toMatchObject({ key: '1', target: 'row' });
    s = tourReducer(s, { type: 'open', thread: TOUR_THREAD });
    expect(s).toMatchObject({ step: 2, route: TOUR_THREAD });
    // Crawl: a plain question first. The picture question is not in the thread yet.
    expect(tourCoach(s, names)).toMatchObject({ key: '2', target: 'warm-choices' });
    expect(tourMessages(fixture, TOUR_THREAD, s).some((v) => v.fixture?.asks)).toBe(false);
    expect(tourReducer(s, { type: 'next' })).toBe(s);
    expect(tourReducer(s, { type: 'pick', label: REAL })).toBe(s);
    s = tourReducer(s, { type: 'warmPick', label: WARM });
    expect(s).toMatchObject({ step: 2, warmPicked: WARM });
    expect(tourCoach(s, names)).toMatchObject({ key: '2-send', target: 'warm-send' });
    s = tourReducer(s, { type: 'warmSend' });
    expect(s).toMatchObject({ step: 2, warmSent: true });
    expect(tourCoach(s, names)!.wait).toBe(true);
    // The answer arrives with the picture question: step 3 starts on it (walk).
    expect(tourReducer(s, { type: 'warmArrive' })).toBe(s);
    s = run([{ type: 'warmDelivered' }, { type: 'warmArrive' }], s);
    expect(s).toMatchObject({ step: 3, warmArrived: true });
    expect(tourCoach(s, names)!.target).toBe('choices');
    s = tourReducer(s, { type: 'pick', label: REAL });
    expect(s).toMatchObject({ step: 4, picked: REAL });
    expect(tourCoach(s, names)!.target).toBe('phrase');
    expect(tourCoach(s, names, {}, { composing: true })!.key).toBe('4-box');
    s = tourReducer(s, { type: 'comment', record: wordsComment });
    expect(s.step).toBe(5);
    expect(tourCoach(s, names)!.target).toBe('eval-tile');
    s = tourReducer(s, { type: 'openFile', id: fileNamed('EVALUATION.md').id, full: false });
    expect(tourCoach(s, names)!.target).toBe('eval-line');
    s = tourReducer(s, { type: 'comment', record: fileComment('EVALUATION.md') });
    expect(s.step).toBe(6);
    expect(tourCoach(s, names)!.target).toBe('reply');
    s = tourReducer(s, { type: 'reply', open: true });
    expect(tourCoach(s, names)!.key).toBe('6-box');
    s = tourReducer(s, { type: 'send' });
    expect(s).toMatchObject({ step: 7, sent: true, delivered: false, arrived: 0 });
    expect(s.comments.every((r) => r.sent_reply_id === TOUR_REPLY_ID)).toBe(true);
    expect(tourCoach(s, names)!.wait).toBe(true);
    s = run([{ type: 'delivered' }, { type: 'arrive' }, { type: 'arrive' }], s);
    expect(tourCoach(s, names)).toMatchObject({ key: '7', target: 'inline-img' });
    s = tourReducer(s, { type: 'openFile', id: fileNamed('a1.png').id, full: true });
    expect(tourCoach(s, names)!.key).toBe('7-file');
    // While the drawing surface is open, the card points at nothing (it stands clear of the drawing tools).
    expect(tourCoach(s, names, {}, { annotating: true })).toMatchObject({ key: '7-drawing', target: null });
    expect(tourCoach(s, names, {}, { drawn: true })!.key).toBe('7-drawn-unsaved');
    s = tourReducer(s, { type: 'comment', record: fileComment('a1.png') });
    expect(tourCoach(s, names)).toMatchObject({ key: '7-drawn', next: true });
    // The Artifacts part: the card, the grid, a tile, Next.
    s = tourReducer(s, { type: 'next' });
    expect(tourCoach(s, names)).toMatchObject({ key: '7-art', target: 'art-button' });
    s = tourReducer(s, { type: 'artifacts', open: true });
    expect(tourCoach(s, names)!.key).toBe('7-art-grid');
    s = tourReducer(s, { type: 'openFile', id: fileNamed('EVALUATION.md').id, full: false });
    expect(tourCoach(s, names)).toMatchObject({ key: '7-art-open', next: true });
    s = tourReducer(s, { type: 'next' });
    expect(s).toMatchObject({ step: 8, artifactsOpen: false, file: null });
    expect(tourCoach(s, names)!.target).toBe('film-row');
    s = tourReducer(s, { type: 'open', thread: TOUR_FILM_THREAD });
    expect(tourCoach(s, names)!.target).toBe('film-tile');
    s = tourReducer(s, { type: 'openFile', id: fileNamed('guides-vscode.mp4').id, full: false });
    expect(tourCoach(s, names, {}, { pinnedAt: '0:07' } satisfies TourUi)!.text).toContain('Pinned at 0:07');
    s = tourReducer(s, { type: 'comment', record: fileComment('guides-vscode.mp4', { inboxVideo: { time: 7.2 } }) });
    expect(tourCoach(s, names)!.key).toBe('8-send');
    s = tourReducer(s, { type: 'filmSend' });
    expect(s.comments.find((r) => r.thread_id === TOUR_FILM_THREAD)!.sent_reply_id).toBe(TOUR_FILM_REPLY_ID);
    s = run([{ type: 'filmDelivered' }, { type: 'filmArrive' }], s);
    expect(tourCoach(s, names)).toMatchObject({ key: '8-done', next: true });
    s = tourReducer(s, { type: 'next' });
    expect(s.step).toBe(9);
    expect(tourCoach(s, names)!.target).toBe('compose-btn');
    s = tourReducer(s, { type: 'compose', open: true });
    expect(tourCoach(s, names)!.target).toBe('compose-to');
    expect(tourCoach(s, names, {}, { toChosen: true })!.target).toBe('compose-send');
    s = tourReducer(s, { type: 'composeSend' });
    expect(s).toMatchObject({ compose: 'sent', route: TOUR_NEW_THREAD });
    s = run([{ type: 'newDelivered' }, { type: 'newArrive' }], s);
    expect(tourCoach(s, names)).toMatchObject({ key: '9-loop', next: true });
    s = tourReducer(s, { type: 'next' });
    expect(tourCoach(s, names)).toMatchObject({ key: '9-also', nextLabel: 'Connect my agents' });
    expect(tourCoach(s, names)!.items!.map((i) => i.title)).toEqual(['Pin a thread', 'Looks good', 'Re-ask', 'Send now']);
    s = tourReducer(s, { type: 'next' });
    expect(s.step).toBe(TOUR_STEPS);
    expect(tourCoach(s, names)).toBeNull();
  });

  test('Back on steps 2 (before its Send), 4, 5 and 8 before its Send; none on 3, 6, 7, 9 or after a Send', () => {
    expect(tourCanBack(TOUR_START)).toBe(false);
    for (const step of [2, 4, 5, 8]) expect(tourCanBack(tourStateAt(step, REAL, fixture)), String(step)).toBe(true);
    for (const step of [3, 6, 7, 9, 10]) expect(tourCanBack(tourStateAt(step, REAL, fixture)), String(step)).toBe(false);
    expect(tourCanBack({ ...tourStateAt(2, REAL, fixture), warmPicked: WARM, warmSent: true })).toBe(false);
    expect(tourCanBack({ ...tourStateAt(8, REAL, fixture), filmSent: true })).toBe(false);
    expect(tourReducer(tourStateAt(5, REAL, fixture), { type: 'back' }).step).toBe(4);
    expect(tourReducer(tourStateAt(2, REAL, fixture), { type: 'back' })).toMatchObject({ step: 1, route: 'list' });
    expect(tourReducer(tourStateAt(8, REAL, fixture), { type: 'back' })).toMatchObject({ step: 7, route: TOUR_THREAD });
  });

  test('Send needs a pick and its step; never twice; a pick after Send changes nothing', () => {
    // The warm-up: no Send without a pick, and only on step 2.
    const s2 = tourStateAt(2, REAL, fixture);
    expect(tourReducer(s2, { type: 'warmSend' })).toBe(s2);
    const s3 = tourStateAt(3, REAL, fixture);
    expect(tourReducer(s3, { type: 'warmPick', label: 'Evaluate only, no mockups yet' })).toBe(s3);
    expect(tourReducer(tourStateAt(5, REAL, fixture), { type: 'send' }).sent).toBe(false);
    const s7 = tourStateAt(7, REAL, fixture);
    expect(tourReducer(s7, { type: 'send' })).toBe(s7);
    expect(tourReducer(s7, { type: 'pick', label: 'B · Our reader beside a live native diff' })).toBe(s7);
    // The film's Send needs a comment waiting.
    const s8 = tourStateAt(8, REAL, fixture);
    expect(tourReducer(s8, { type: 'filmSend' })).toBe(s8);
  });

  test('the replays arrive only after delivery; reduced motion is about 60% of each', () => {
    const warmSent = run([{ type: 'open', thread: TOUR_THREAD }, { type: 'warmPick', label: WARM }, { type: 'warmSend' }]);
    expect(tourReducer(warmSent, { type: 'warmArrive' }).warmArrived).toBe(false);
    const sent = run([{ type: 'warmDelivered' }, { type: 'warmArrive' }, { type: 'pick', label: REAL }, { type: 'comment', record: wordsComment }, { type: 'comment', record: fileComment('EVALUATION.md') }, { type: 'send' }], warmSent);
    expect(tourReducer(sent, { type: 'arrive' }).arrived).toBe(0);
    expect(run([{ type: 'delivered' }, { type: 'arrive' }, { type: 'arrive' }, { type: 'arrive' }], sent).arrived).toBe(2);
    expect(warmTimings(false)).toEqual({ delivered: 1100, reply: 2600 });
    expect(replayTimings(false)).toEqual({ delivered: 1100, first: 3000, second: 5600 });
    expect(filmTimings(false)).toEqual({ delivered: 1100, reply: 2400 });
    expect(newThreadTimings(false)).toEqual({ delivered: 1100, reply: 3200 });
    for (const [full, reduced] of [
      [warmTimings(false), warmTimings(true)],
      [replayTimings(false), replayTimings(true)],
      [filmTimings(false), filmTimings(true)],
      [newThreadTimings(false), newThreadTimings(true)],
    ] as const)
      for (const key of Object.keys(full) as (keyof typeof full)[]) expect(Math.abs(reduced[key] / full[key] - 0.6)).toBeLessThan(0.02);
  });

  test('tourStateAt(n) is the walk with every suggestion kept, for 1 to 10 (and out of range)', () => {
    expect(tourStateAt(1, REAL, fixture)).toEqual(TOUR_START);
    expect(tourStateAt(2, REAL, fixture)).toMatchObject({ warmPicked: null, warmSent: false });
    expect(tourStateAt(3, REAL, fixture)).toMatchObject({ warmPicked: WARM, warmArrived: true, picked: null });
    expect(tourStateAt(4, REAL, fixture)).toMatchObject({ picked: REAL, comments: [] });
    expect(tourStateAt(5, REAL, fixture).comments.map((r) => r.annotation.text)).toEqual([ask.suggest!.comment]);
    expect(tourStateAt(6, REAL, fixture).comments).toHaveLength(2);
    expect(tourStateAt(7, REAL, fixture)).toMatchObject({ sent: true, arrived: 2 });
    expect(tourStateAt(8, REAL, fixture)).toMatchObject({ artifactsTour: 2 });
    expect(tourStateAt(9, REAL, fixture)).toMatchObject({ filmArrived: true, step: 9 });
    expect(tourStateAt(10, REAL, fixture)).toMatchObject({ compose: 'sent', newArrived: true, step: 10 });
    for (let n = 1; n <= TOUR_STEPS; n++) {
      const s = tourStateAt(n, REAL, fixture);
      expect(s.step).toBe(n);
      // Every state reached directly draws a coach card (10 none) and its lists.
      if (n < TOUR_STEPS) expect(tourCoach(s, names)).not.toBeNull();
      expect(tourSections(fixture, s).length).toBeGreaterThan(0);
    }
    expect(tourStateAt(99, REAL, fixture).step).toBe(TOUR_STEPS);
    expect(tourStateAt(-3, REAL, fixture).step).toBe(1);
  });

  test('step 10 is the person’s own Inbox: nothing of the tour moves, Fast-forward included', () => {
    const s10 = tourStateAt(10, REAL, fixture);
    for (const action of [{ type: 'open', thread: TOUR_THREAD }, { type: 'list' }, { type: 'next' }, { type: 'compose', open: true }, { type: 'forward', realAnswer: REAL, fixture }] as TourAction[])
      expect(tourReducer(s10, action)).toBe(s10);
  });
});

describe('fast-forward', () => {
  const forward = (s: TourState) => tourReducer(s, { type: 'forward', realAnswer: REAL, fixture });

  test('each step forwards to the next step’s start, as the walk would leave it; 9 ends on the loop', () => {
    expect(forward(TOUR_START)).toMatchObject({ step: 1, orient: false });
    for (let n = 1; n < TOUR_STEPS - 1; n++) {
      const s = { ...tourStateAt(n, REAL, fixture), orient: false };
      const f = forward(s);
      const want = tourStateAt(n + 1, REAL, fixture);
      expect(f.step, String(n)).toBe(n + 1);
      expect({ ...f, comments: [] }, String(n)).toEqual({ ...want, comments: [] });
      expect(f.comments.map((r) => r.id).sort(), String(n)).toEqual(want.comments.map((r) => r.id).sort());
    }
    const end9 = forward(tourStateAt(9, REAL, fixture));
    expect(end9).toMatchObject({ step: 9, compose: 'sent', newArrived: true, also: false, route: TOUR_NEW_THREAD });
    expect(tourCoach(end9, names)).toMatchObject({ key: '9-loop', next: true });
  });

  test('mid-step (a replay running, a box open) forwards to the end of the step', () => {
    const replaying = run([{ type: 'warmPick', label: WARM }, { type: 'warmSend' }], tourStateAt(2, REAL, fixture));
    expect(forward(replaying)).toMatchObject({ step: 3, warmArrived: true });
    const sending = { ...tourStateAt(7, REAL, fixture), delivered: false, arrived: 0 };
    expect(forward(sending)).toMatchObject({ step: 8 });
    const composing = tourReducer(tourStateAt(9, REAL, fixture), { type: 'compose', open: true });
    expect(forward(composing)).toMatchObject({ compose: 'sent', newArrived: true });
  });

  test('the person’s own picks and comments are kept; only what is missing is filled in', () => {
    const B = 'B · Our reader beside a live native diff';
    const other = 'Evaluate only, no mockups yet';
    let s = run([{ type: 'warmPick', label: other }], tourStateAt(2, REAL, fixture));
    s = forward(s);
    expect(s).toMatchObject({ step: 3, warmPicked: other });
    expect(warmDiffers(s, WARM)).toBe(true);
    s = tourReducer(s, { type: 'pick', label: B });
    expect(s).toMatchObject({ step: 4, picked: B });
    const mine = tourRecord({ id: 'mine', thread: TOUR_THREAD, message: ask.id, messageAt: '2026-10-24T12:03:00Z', annotation: { id: 'mine', type: 'COMMENT', text: 'my own words', originalText: 'x' } });
    s = tourReducer(s, { type: 'comment', record: mine });
    expect(s.step).toBe(5);
    s = forward(s);
    expect(s.step).toBe(6);
    expect(s.picked).toBe(B);
    expect(s.comments.filter((r) => r.message).map((r) => r.id)).toEqual(['mine']);
    // Past the Send, the person's unsent comments were sent with it.
    s = forward(s);
    expect(s.step).toBe(7);
    expect(s.comments.find((r) => r.id === 'mine')!.sent_reply_id).toBe(TOUR_REPLY_ID);
    expect(s.picked).toBe(B);
  });

  test('offered on every card that asks or waits; never with Next or on step 10', () => {
    for (let n = 1; n < TOUR_STEPS; n++) {
      const s = tourStateAt(n, REAL, fixture);
      const c = tourCoach(s, names)!;
      expect(tourCanForward(s, c), `${n} ${c.key}`).toBe(!c.next);
    }
    expect(tourCanForward(TOUR_START, tourCoach(TOUR_START, names))).toBe(false);
    expect(tourCanForward(tourStateAt(10, REAL, fixture), null)).toBe(false);
  });
});

describe('suggestions', () => {
  test('a comment box opens with its suggestion only for a selection on the phrase, never a stray word of it', () => {
    const phrase = 'a 2-day check that hover feels instant';
    for (const yes of [phrase, `after ${phrase}.`, 'check that hover feels instant', 'Cost: medium, after a 2-day check that hover', 'hover feels instant. And more'])
      expect(selectionOnPhrase(phrase, yes), yes).toBe(true);
    for (const no of ['the', 'hover', 'feels', 'a 2-day', 'Recommended: A, our own guide reader', '']) expect(selectionOnPhrase(phrase, no), no).toBe(false);
    const line = 'It is also the cheapest direction, because the reader and its hooks already exist.';
    expect(selectionOnPhrase(line, '**It is also** the cheapest direction, because the reader')).toBe(true);
    expect(selectionOnPhrase(line, 'the reader')).toBe(false);
  });

  test('the warm-up is the tour’s own question: nothing about it claims a real answer, and the fixture says it was added', () => {
    const replaying = run([{ type: 'warmPick', label: WARM }, { type: 'warmSend' }], tourStateAt(2, REAL, fixture));
    for (const s of [replaying, { ...replaying, warmDelivered: true }]) expect(tourCoach(s, names)!.text).not.toMatch(/real thread/i);
    expect(raw.note).toContain('added by the tour');
  });
});

describe('your turn', () => {
  test('every card that asks for an action says "Your turn"; Next and replay cards do not', () => {
    const turn = tourCoach(tourReducer(TOUR_START, { type: 'next' }), names)!;
    expect(tourYourTurn(turn)).toBe(true);
    expect(tourCoachSpeech(turn, 1)).toContain('Your turn: Open the question it came back with.');
    expect(tourYourTurn(tourCoach(TOUR_START, names)!)).toBe(false);
    const waiting = tourCoach(run([{ type: 'warmPick', label: WARM }, { type: 'warmSend' }], tourStateAt(2, REAL, fixture)), names)!;
    expect(tourYourTurn(waiting)).toBe(false);
  });
});

describe('the coach', () => {
  test('every card is at most two sentences plus its action, and only positive', () => {
    const ui: TourUi[] = [{}, { composing: true }, { annotating: true }, { drawn: true }, { pinnedAt: '0:07' }, { toChosen: true }];
    const states: TourState[] = [];
    for (let n = 1; n < TOUR_STEPS; n++) {
      const s = tourStateAt(n, REAL, fixture);
      states.push(s, { ...s, route: 'list' }, { ...s, file: { id: 'x', full: false } }, { ...s, replyOpen: true }, { ...s, artifactsOpen: true });
    }
    states.push(
      TOUR_START,
      { ...tourStateAt(2, REAL, fixture), warmPicked: WARM },
      { ...tourStateAt(2, REAL, fixture), warmPicked: WARM, warmSent: true },
      { ...tourStateAt(7, REAL, fixture), arrived: 0, delivered: false },
      { ...tourStateAt(9, REAL, fixture), compose: 'sent' },
      { ...tourStateAt(10, REAL, fixture), step: 9, also: false },
    );
    const seen = new Set<string>();
    for (const s of states)
      for (const u of ui) {
        const c = tourCoach(s, names, {}, u);
        if (!c || seen.has(c.key)) continue;
        seen.add(c.key);
        expect(c.text.split(/(?<=[.!?])\s+/).filter(Boolean).length, c.key).toBeLessThanOrEqual(2);
        expect(`${c.title} ${c.text} ${c.action ?? ''}`, c.key).not.toMatch(/could not|couldn’t|error|failed|missing|try again|nothing (here )?is sent/i);
      }
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe('what the window draws', () => {
  test('A: Waiting → Sent → Waiting (the pictures) → Sent → New; B: New → Sent → New; C appears in Sent once sent, then New', () => {
    expect(sectionOf(TOUR_START, TOUR_THREAD)).toBe('waiting');
    const warmSent = { ...tourStateAt(2, REAL, fixture), warmPicked: WARM, warmSent: true };
    expect(sectionOf(warmSent, TOUR_THREAD)).toBe('sent');
    expect(sectionOf(tourStateAt(3, REAL, fixture), TOUR_THREAD)).toBe('waiting');
    expect(sectionOf(TOUR_START, TOUR_FILM_THREAD)).toBe('new');
    expect(sectionOf(TOUR_START, TOUR_NEW_THREAD)).toBeUndefined();
    const s7 = tourStateAt(7, REAL, fixture);
    expect(sectionOf({ ...s7, delivered: false, arrived: 0 }, TOUR_THREAD)).toBe('sent');
    expect(sectionOf(s7, TOUR_THREAD)).toBe('new');
    const s8 = tourStateAt(8, REAL, fixture);
    expect(sectionOf({ ...s8, filmSent: true }, TOUR_FILM_THREAD)).toBe('sent');
    const s9 = tourStateAt(9, REAL, fixture);
    expect(sectionOf({ ...s9, compose: 'sent' }, TOUR_NEW_THREAD)).toBe('sent');
    expect(sectionOf(tourStateAt(10, REAL, fixture), TOUR_NEW_THREAD)).toBe('new');
    // A pick and comments not sent read as a draft on the row; so does the warm-up's pick.
    const row = tourSections(fixture, tourStateAt(6, REAL, fixture)).flatMap((s) => s.threads).find((r) => r.thread_id === TOUR_THREAD)!;
    expect(row.unsent).toEqual({ reply_at: null, picks: 1, comments: 2 });
    const warmRow = tourSections(fixture, { ...tourStateAt(2, REAL, fixture), warmPicked: WARM }).flatMap((s) => s.threads).find((r) => r.thread_id === TOUR_THREAD)!;
    expect(warmRow.unsent).toEqual({ reply_at: null, picks: 1, comments: 0 });
  });

  test('the messages follow the walk; the replayed reply carries the pick and its comments', () => {
    const ids = (s: TourState) => tourMessages(fixture, TOUR_THREAD, s).map((v) => (v.reply ? 'reply' : v.replay ? 'replay' : v.wire.id));
    // Crawl, walk, run: the plain question alone first; the rich message (pictures, files) arrives after its Send.
    expect(ids(TOUR_START)).toEqual(['tour-vscode-1', 'tour-vscode-2']);
    expect(ids(tourStateAt(3, REAL, fixture))).toEqual(['tour-vscode-1', 'tour-vscode-2', 'reply', 'replay']);
    expect(ids(tourStateAt(7, REAL, fixture))).toEqual(['tour-vscode-1', 'tour-vscode-2', 'reply', 'replay', 'reply', 'replay', 'replay']);
    const warmQ = tourMessages(fixture, TOUR_THREAD, tourStateAt(3, REAL, fixture)).find((v) => v.fixture?.warmup)!;
    expect(warmQ.wire.questions![0]).toMatchObject({ state: 'sent', sent_reply_id: TOUR_WARM_REPLY_ID, answer: expect.objectContaining({ selected: [WARM] }) });
    expect(warmQ.wire.questions![0]!.choices.some((c) => (c as { image?: unknown }).image)).toBe(false);
    const rich = tourMessages(fixture, TOUR_THREAD, tourStateAt(3, REAL, fixture)).find((v) => v.fixture?.asks)!;
    expect(rich.wire.questions![0]!.state).toBe('open');
    expect(rich.wire.attachments!.map((a) => a.name)).toEqual(['prototype.html', 'EVALUATION.md', 'd1-clean.png']);
    const reply = tourMessages(fixture, TOUR_THREAD, tourStateAt(7, REAL, fixture)).find((v) => v.reply && v.wire.id === TOUR_REPLY_ID)!;
    expect(reply.wire.sent_annotations).toBe(2);
    const asking = tourMessages(fixture, TOUR_THREAD, tourStateAt(7, REAL, fixture)).find((v) => v.fixture?.asks)!;
    expect(asking.wire.questions![0]).toMatchObject({ state: 'sent', sent_reply_id: TOUR_REPLY_ID });
    // The PR message shows its screenshots in its text, as captured images of the thread.
    const pr = tourMessages(fixture, TOUR_THREAD, tourStateAt(7, REAL, fixture)).at(-1)!;
    expect(pr.wire.body).toContain('](built-a1.webp)');
    expect(pr.wire.inline_images!.map((i) => i.id)).toEqual(['tour-img-built-a1', 'tour-img-built-a2']);
    // C: the person's message, then the agent's answer.
    const c = tourMessages(fixture, TOUR_NEW_THREAD, tourStateAt(10, REAL, fixture));
    expect(c.map((v) => v.wire.author.kind)).toEqual(['person', 'agent']);
  });

  test('files: every kind the fixture writes is one the window reads; current is what was sent', () => {
    expect(files.map((a) => a.name)).toEqual(['prototype.html', 'EVALUATION.md', 'd1-clean.png', 'a1.png', 'a2.png', 'guides-vscode.mp4']);
    for (const a of files) {
      expect(readInboxAttachmentKind(a.kind)).toBe(a.kind);
      expect(a.changed_since_sent).toBe(false);
      expect(a.current!.size).toBe(a.size);
    }
    expect(tourSuggestionFor(fixture, fileNamed('guides-vscode.mp4'))!.at).toBe(7.2);
    expect(tourSuggestionFor(fixture, fileNamed('a1.png'))!.comment).toContain('should go on the site');
  });

  test('the times are the real ones', () => {
    expect(tourTime('11:47')).toBe('11:47 AM');
    expect(tourTime('13:25')).toBe('1:25 PM');
    expect(tourTime('18:11')).toBe('6:11 PM');
  });

  test('a pick other than the real answer is replayed with a note, as a fact', () => {
    expect(pickDiffers(tourStateAt(7, REAL, fixture), REAL)).toBe(false);
    expect(pickDiffers({ ...tourStateAt(7, REAL, fixture), picked: 'B · Our reader beside a live native diff' }, REAL)).toBe(true);
    expect(warmDiffers(tourStateAt(3, REAL, fixture), WARM)).toBe(false);
    expect(warmDiffers({ ...tourStateAt(3, REAL, fixture), warmPicked: 'Evaluate only, no mockups yet' }, WARM)).toBe(true);
  });
});

describe('the fixture', () => {
  test('every question block parses with core’s parser; the tour question has picture choices and its real answer', () => {
    for (const thread of fixture.threads)
      for (const m of thread.messages) expect(parseInboxQuestionBlocks(m.body ?? '').length).toBe((m.body ?? '').match(/:::question/g)?.length ?? 0);
    const q = tourQuestion(fixture)!;
    expect(q.question.parsed.choices.map((c) => c.label)).toContain(REAL);
    expect(q.question.parsed.choices.filter((c) => c.image).length).toBe(3);
    // The warm-up is plain text (crawl): no pictures, its real answer one of its choices.
    const w = tourWarmQuestion(fixture)!;
    expect(w.question.kind).toBe('single');
    expect(w.question.parsed.choices.map((c) => c.label)).toContain(WARM);
    expect(w.question.parsed.choices.every((c) => !c.image)).toBe(true);
    // The suggestions name words that are on screen.
    expect(ask.body).toContain(ask.suggest!.phrase!);
    expect(readFileSync(join(CONTENT, 'evaluation.md'), 'utf8')).toContain(ask.attachments!.find((a) => a.name === 'EVALUATION.md')!.suggest!.phrase!);
  });

  test('every v2 asset ships and is in the manifest; the content stays under its 1.25 MB budget (cap 1.3 MB)', () => {
    const shipped = new Set(readdirSync(CONTENT));
    const referenced = new Set<string>(Object.entries(fixture.full).flat());
    for (const t of fixture.threads)
      for (const m of t.messages) {
        for (const a of m.attachments ?? []) [a.asset, a.poster].filter(Boolean).forEach((x) => referenced.add(x!));
        for (const i of m.inline_images ?? []) referenced.add(i.ref);
        for (const img of (m.body ?? '').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) referenced.add(img[1]!);
      }
    for (const name of referenced) expect(shipped.has(name), name).toBe(true);
    const manifest = readFileSync(join(import.meta.dir, '../../server/inbox-tour-content.ts'), 'utf8');
    for (const name of shipped) if (name !== 'fixture.json' && name !== 'README') expect(manifest, name).toContain(`"${name}"`);
    for (const name of ['film-clip.mp4', 'film-poster.webp', 'evaluation.md']) expect(shipped.has(name), name).toBe(true);
    for (const gone of ['g1-thumb.webp', 'graphite-inbox.webp']) expect(shipped.has(gone)).toBe(false);
    const total = [...shipped].reduce((n, f) => n + statSync(join(CONTENT, f)).size, 0);
    expect(total).toBeLessThan(1.3 * 1024 * 1024);
  });

  test('privacy: no paths, ids, local addresses or emails in anything that ships (EVALUATION.md included)', () => {
    for (const name of readdirSync(CONTENT)) {
      if (/\.(webp|mp4)$/.test(name)) continue;
      const text = readFileSync(join(CONTENT, name), 'utf8');
      expect(text, name).not.toMatch(/\/Users\/|~\/|\bmsg_[0-9A-Z]{6,}|\batt_[0-9A-Z]{6,}|localhost:|127\.0\.0\.1|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      expect(text, name).not.toMatch(/ramos|michael/i);
    }
  });

  test('a fixture that is not the tour’s is refused, never half drawn', () => {
    expect(() => parseTourFixture(null)).toThrow();
    expect(() => parseTourFixture({ ...raw, v: 1 })).toThrow();
    expect(() => parseTourFixture({ ...raw, threads: raw.threads.slice(0, 2) })).toThrow();
    const bad = structuredClone(raw);
    bad.threads[0].messages[2].attachments[0].asset = '../../etc/passwd';
    expect(() => parseTourFixture(bad)).toThrow();
    const badKind = structuredClone(raw);
    badKind.threads[0].messages[2].attachments[0].kind = 'spreadsheet';
    expect(() => parseTourFixture(badKind)).toThrow();
  });
});
