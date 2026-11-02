/**
 * Voice dictation in the opt-in debug log: the session's own `voice_press`, `voice_phase` and the recorder's
 * `voice_open`, written through the window's real recorder (`debugNote`), so they reach the Inbox's debug.log.
 *
 * What regresses: a voice line written while debug is off; a moment that a stuck mic would hide (the press it met,
 * the step opening reached); words, audio or free text in a line; a line the Inbox's filter drops.
 *
 * DOM (DOM_TESTS=1): the recorder stores in localStorage and wraps `fetch`, both restored after.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanWindowRecord, INBOX_DEBUG_ON_HEADER } from '../shared/inbox/debug-log';
import { learnDebugLog } from './debugLog';
import { browserDeps } from './voice';
import { createVoiceSession, type VoiceField } from './voiceSession';

const hasDom = typeof document !== 'undefined';
const BUFFER = 'plannotator-inbox-debug-buffer';

type Rec = Record<string, unknown>;
const stored = (): Rec[] => JSON.parse(window.localStorage.getItem(BUFFER) ?? '[]') as Rec[];
const voiceLines = () => stored().filter((r) => String(r.ev).startsWith('voice_'));
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

const field = (): VoiceField => ({
  selection: () => ({ start: 0, end: 0 }),
  text: () => 'private words',
  readOnly: () => false,
  focus: () => {},
  select: () => {},
  insert: () => ({ start: 0, end: 0 }),
  watch: () => () => {},
});

/** Debug off: a good answer without the mark ends recording and clears its store. */
const debugOff = () => learnDebugLog(new Response('{}', { status: 200 }));

const restore: (() => void)[] = [];
afterEach(() => {
  debugOff();
  for (const undo of restore.splice(0).reverse()) undo();
});

/** A press and its release on a phone whose AudioContext refuses: the take must end at rest, and say where. */
async function tapWithRefusingAudio() {
  const session = createVoiceSession(browserDeps);
  const detach = session.attach(field());
  session.press();
  session.release();
  await wait(0);
  expect(session.view()).toMatchObject({ phase: 'idle', trouble: 'micfailed' });
  detach();
}

describe.skipIf(!hasDom)('voice in the debug log', () => {
  test('off: nothing is written; on: the press, the step opening reached and each phase, with no words', async () => {
    const realFetch = globalThis.fetch;
    const realAudio = (window as unknown as { AudioContext?: unknown }).AudioContext;
    restore.push(() => {
      globalThis.fetch = realFetch;
      (window as unknown as { AudioContext?: unknown }).AudioContext = realAudio;
      window.localStorage.removeItem(BUFFER);
    });
    // The Inbox is never reached: the recorder's sends are refused, so its lines stay in the store to be read.
    globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    (window as unknown as { AudioContext: unknown }).AudioContext = class {
      constructor() {
        throw new DOMException('refused', 'InvalidStateError');
      }
    };

    debugOff();
    await tapWithRefusingAudio();
    await wait(400);
    expect(window.localStorage.getItem(BUFFER)).toBeNull();

    learnDebugLog(new Response('{}', { status: 200, headers: { [INBOX_DEBUG_ON_HEADER]: '1' } }));
    await tapWithRefusingAudio();
    await wait(400);
    const lines = voiceLines();
    expect(lines.map((r) => [r.ev, r.input ?? r.step ?? r.phase])).toEqual([
      ['voice_press', 'press'],
      ['voice_phase', 'opening'],
      ['voice_open', 'context'],
      ['voice_press', 'release'],
      ['voice_phase', 'idle'],
      // The box closed (detach): the note goes, and the log says so.
      ['voice_phase', 'idle'],
    ]);
    expect(lines[5]!.trouble).toBeUndefined();
    expect(lines[0]).toMatchObject({ input: 'press', phase: 'idle' });
    expect(lines[2]).toMatchObject({ step: 'context', ok: false, error: 'InvalidStateError' });
    // The release met the take still opening: the line a tap that "did nothing" would leave.
    expect(lines[3]).toMatchObject({ input: 'release', phase: 'opening' });
    expect(lines[4]).toMatchObject({ phase: 'idle', trouble: 'micfailed', prompting: false, slow: false });
    expect(JSON.stringify(lines)).not.toContain('private words');
    expect(JSON.stringify(lines)).not.toContain('said');

    // Every field survives the Inbox's filter: nothing it would drop is relied on.
    for (const line of lines) {
      const { page: _page, seq: _seq, ...fields } = line;
      expect(cleanWindowRecord(line)).toMatchObject({ side: 'window', ...fields });
    }
  });
});
