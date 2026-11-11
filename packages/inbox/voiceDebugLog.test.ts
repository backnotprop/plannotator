/** DOM (DOM_TESTS=1): the recorder stores in localStorage and wraps `fetch`, both restored after. */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanWindowRecord, INBOX_DEBUG_ON_HEADER } from '../shared/inbox/debug-log';
import { learnDebugLog } from './debugLog';
import { browserDeps } from './voice';
import { createVoiceSession, VOICE_TROUBLE_CODES, type VoiceField } from './voiceSession';

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

const debugOff = () => learnDebugLog(new Response('{}', { status: 200 }));

const restore: (() => void)[] = [];
afterEach(() => {
  debugOff();
  for (const undo of restore.splice(0).reverse()) undo();
});

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
      ['voice_phase', 'idle'],
    ]);
    expect(lines[5]!.trouble).toBeUndefined();
    expect(lines[0]).toMatchObject({ input: 'press', phase: 'idle' });
    expect(lines[2]).toMatchObject({ step: 'context', ok: false, error: 'InvalidStateError' });
    expect(lines[3]).toMatchObject({ input: 'release', phase: 'opening' });
    expect(lines[4]).toMatchObject({ phase: 'idle', trouble: 'micfailed', prompting: false, slow: false });
    expect(JSON.stringify(lines)).not.toContain('private words');
    expect(JSON.stringify(lines)).not.toContain('said');

    for (const line of lines) {
      const { page: _page, seq: _seq, ...fields } = line;
      expect(cleanWindowRecord(line)).toMatchObject({ side: 'window', ...fields });
    }
  });
});

describe.skipIf(!hasDom)('a pointer press in the debug log', () => {
  test("the session stores a press's and a release's offset from the mic's centre on their voice_press lines", async () => {
    const realFetch = globalThis.fetch;
    const realAudio = (window as unknown as { AudioContext?: unknown }).AudioContext;
    restore.push(() => {
      globalThis.fetch = realFetch;
      (window as unknown as { AudioContext?: unknown }).AudioContext = realAudio;
      window.localStorage.removeItem(BUFFER);
    });
    globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    (window as unknown as { AudioContext: unknown }).AudioContext = class {
      constructor() {
        throw new DOMException('refused', 'InvalidStateError');
      }
    };
    learnDebugLog(new Response('{}', { status: 200, headers: { [INBOX_DEBUG_ON_HEADER]: '1' } }));
    const session = createVoiceSession(browserDeps);
    const detach = session.attach(field());
    session.press({ dx: 3, dy: -2 });
    session.release({ dx: -5, dy: 7 });
    await wait(0);
    detach();
    await wait(400);
    const presses = voiceLines().filter((r) => r.ev === 'voice_press');
    expect(presses.map((r) => [r.input, r.dx, r.dy])).toEqual([
      ['press', 3, -2],
      ['release', -5, 7],
    ]);
    for (const line of presses) expect(cleanWindowRecord(line)).toMatchObject({ dx: line.dx, dy: line.dy });
  });
});

test('every reason a take can end without words survives the Inbox\'s filter', () => {
  for (const trouble of VOICE_TROUBLE_CODES) {
    expect(cleanWindowRecord({ t: 1, ev: 'voice_phase', phase: 'idle', prompting: false, slow: false, trouble })).toMatchObject({ trouble });
  }
});
