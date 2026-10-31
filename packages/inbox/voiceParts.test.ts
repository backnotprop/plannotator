/**
 * Voice dictation's small parts: the WAV the Inbox receives, the gate, the spacing at the cursor, the gesture's reach,
 * the announcement's gate, and the transcribe call's address. What regresses: a clip the endpoint can't read (wrong
 * rate or a truncated header), speech missed or silence taken for speech, words glued to their neighbours, a slide that
 * cancels from too near, the announcement sharing a load with another dialog, audio sent to a linked machine.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { inboxApi } from './api';
import { setSelfMachine } from './inboxUrl';
import { voiceBlock } from './voice';
import { createVoiceGate, encodeWav, voiceClock } from './voiceAudio';
import { spaced } from './voiceField';
import { voiceIntroMayAsk, voiceIntroWanted, type VoiceIntroLoad } from './voiceIntro';
import { voiceLine } from './voiceLine';
import { DRAG_OFF_PX, slidOff } from './voicePress';
import { VOICE_BARS, VOICE_COUNTDOWN_MS, type VoiceMeter, type VoiceView } from './voiceSession';

describe('encodeWav', () => {
  test('48 kHz in, 24 kHz mono 16-bit out, with a header that matches the data', async () => {
    const blob = encodeWav([new Float32Array(2400).fill(0.5), new Float32Array(2400).fill(-0.5)], 48_000);
    expect(blob.type).toBe('audio/wav');
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);
    const text = (at: number, length: number) => String.fromCharCode(...new Uint8Array(bytes, at, length));
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(2400 * 2);
    // Both chunks made it, at their level.
    expect(view.getInt16(44 + 100, true)).toBeCloseTo(16383, -1);
    expect(view.getInt16(44 + 2 * 2000, true)).toBeCloseTo(-16383, -1);
  });

  test('44.1 kHz keeps the clip its length, and a rate under 24 kHz does not run out of samples', async () => {
    const seconds = async (rate: number) => {
      const view = new DataView(await encodeWav([new Float32Array(rate).fill(0.25)], rate).arrayBuffer());
      return { length: view.getUint32(40, true) / 2 / 24_000, last: view.getInt16(44 + view.getUint32(40, true) - 2, true) };
    };
    expect((await seconds(44_100)).length).toBeCloseTo(1, 2);
    const low = await seconds(16_000);
    expect(low.length).toBeCloseTo(1, 2);
    expect(low.last).toBeGreaterThan(8000);
  });

  test('a loud sample clips rather than wrapping around', async () => {
    const view = new DataView(await encodeWav([new Float32Array(10).fill(3)], 24_000).arrayBuffer());
    expect(view.getInt16(44, true)).toBe(32767);
  });
});

describe('the gate', () => {
  test('a quiet room is not voice; speech over it is', () => {
    const gate = createVoiceGate();
    for (let i = 0; i < 30; i++) expect(gate(-65).voice).toBe(false);
    expect(gate(-35).voice).toBe(true);
  });

  test('a clip that opens on speech finds the floor at the first dip', () => {
    const gate = createVoiceGate();
    expect(gate(-25).voice).toBe(true);
    gate(-60);
    expect(gate(-58).voice).toBe(false);
    expect(gate(-40).voice).toBe(true);
  });

  test('digital zero as the stream starts does not pin the floor', () => {
    const gate = createVoiceGate();
    for (let i = 0; i < 10; i++) gate(-120);
    gate(-45);
    expect(gate(-45).voice).toBe(false);
  });

  test('a loud room still gates at -30 dB', () => {
    const gate = createVoiceGate();
    gate(-38);
    expect(gate(-36).voice).toBe(false);
    expect(gate(-29).voice).toBe(true);
  });
});

test('the clock', () => {
  expect(voiceClock(7_400)).toBe('0:07');
  expect(voiceClock(105_000)).toBe('1:45');
});

describe('spaces at the cursor', () => {
  test.each([
    [undefined, undefined, 'hi'],
    ['a', undefined, ' hi'],
    [' ', undefined, 'hi'],
    ['\n', undefined, 'hi'],
    [undefined, 'a', 'hi '],
    ['a', 'b', ' hi '],
    ['a', '.', ' hi'],
    ['a', ' ', ' hi'],
  ])('after %p, before %p: %p', (before, after, out) => {
    expect(spaced(before, after, 'hi')).toBe(out);
  });
});

test('the slide arms only well outside the button', () => {
  const box = { left: 100, right: 136, top: 100, bottom: 136 };
  expect(slidOff(box, 120, 120)).toBe(false);
  expect(slidOff(box, 136 + DRAG_OFF_PX, 120)).toBe(false);
  expect(slidOff(box, 136 + DRAG_OFF_PX + 1, 120)).toBe(true);
  expect(slidOff(box, 120, 100 - DRAG_OFF_PX - 1)).toBe(true);
});

test('the mic dims only for what a press cannot get past', () => {
  expect(voiceBlock('ready', false)).toBe('nomic');
  expect(voiceBlock('ready', true)).toBeNull();
  expect(voiceBlock(undefined, true)).toBeNull();
  expect(voiceBlock('unknown', true)).toBeNull();
  for (const state of ['missing', 'signedout', 'apikey', 'other', 'nokey'] as const) expect(voiceBlock(state, true)).toBe('notready');
});

describe('the status line', () => {
  const view = (over: Partial<VoiceView>): VoiceView => ({ phase: 'listening', prompting: false, slow: false, mode: 'hold', armed: false, trouble: null, engine: null, kept: false, clipMs: 0, caret: 0, wash: null, said: '', ...over });
  const meter = (over: Partial<VoiceMeter>): VoiceMeter => ({ elapsedMs: 3000, level: 0.5, voice: true, voiceSeen: true, quietMs: 0, bars: Array.from({ length: VOICE_BARS }, () => ({ height: 0.1, voice: false })), ...over });

  test('a held recording has no Cancel, a running one does: its finger is on the button, and nothing else stops it', () => {
    expect(voiceLine(view({ mode: 'hold' }), meter({}), false)).toMatchObject({ state: 'hold', cancel: false });
    expect(voiceLine(view({ mode: 'tap' }), meter({}), false)).toMatchObject({ state: 'tap', cancel: true });
    expect(voiceLine(view({ phase: 'sending', mode: null }), meter({}), false)).toMatchObject({ state: 'sending', cancel: true });
  });

  test('says no voice only after a moment of nothing, and never once it heard some', () => {
    expect(voiceLine(view({}), meter({ elapsedMs: 800, voice: false, voiceSeen: false }), false)?.state).toBe('hold');
    expect(voiceLine(view({}), meter({ elapsedMs: 2000, voice: false, voiceSeen: false }), false)?.state).toBe('quiet');
    expect(voiceLine(view({}), meter({ elapsedMs: 9000, voice: false, voiceSeen: true }), false)?.state).toBe('hold');
  });

  test('warns of the silence stop in tap mode only', () => {
    expect(voiceLine(view({ mode: 'tap' }), meter({ voice: false, quietMs: 11_000 }), false)?.state).toBe('silencestop');
    expect(voiceLine(view({ mode: 'hold' }), meter({ voice: false, quietMs: 11_000 }), false)?.state).toBe('hold');
  });

  test('counts down from 1:45', () => {
    expect(voiceLine(view({ mode: 'tap' }), meter({ elapsedMs: VOICE_COUNTDOWN_MS - 1000 }), false)?.time).toBe('1:44');
    expect(voiceLine(view({ mode: 'tap' }), meter({ elapsedMs: VOICE_COUNTDOWN_MS + 3000 }), false)).toMatchObject({ state: 'nearcap', time: '0:12 left' });
  });

  test('armed wins over everything', () => {
    expect(voiceLine(view({ armed: true }), meter({ elapsedMs: VOICE_COUNTDOWN_MS + 1 }), true)).toMatchObject({ state: 'armed', cancel: false, danger: true });
  });

  test('says nothing in the moment the mic opens, then a stuck mic gets a line with Cancel', () => {
    expect(voiceLine(view({ phase: 'opening', mode: null }), meter({}), false)).toBeNull();
    expect(voiceLine(view({ phase: 'opening', mode: null, prompting: true }), meter({}), false)?.state).toBe('asking');
    for (const phone of [false, true]) expect(voiceLine(view({ phase: 'opening', mode: null, slow: true }), meter({}), phone)).toMatchObject({ state: 'opening', cancel: true });
    expect(voiceLine(view({ phase: 'opening', mode: null, slow: true, prompting: true }), meter({}), false)?.state).toBe('asking');
  });
});

describe('when the announcement may ask', () => {
  const load: VoiceIntroLoad = { due: true, local: true, listLoaded: true, firstRun: false, listIntroDue: false, tourThisLoad: false, otherDialogThisLoad: false, othersSettled: true, updating: false };

  test('due, on this computer, nothing else on this load, settled', () => {
    expect(voiceIntroMayAsk(load, true)).toBe(true);
    expect(voiceIntroMayAsk(load, false)).toBe(false);
  });

  test.each([
    ['not due', { due: false }],
    ['over the tailnet', { local: false }],
    ['before the list', { listLoaded: false }],
    ['first run', { firstRun: true }],
    ['the list options dialog is due', { listIntroDue: true }],
    ['the tour was on screen', { tourThisLoad: true }],
    ['another dialog showed', { otherDialogThisLoad: true }],
  ])('never: %s', (_name, over) => {
    expect(voiceIntroWanted({ ...load, ...over })).toBe(false);
  });

  test('waits for the others to settle and for an update to finish', () => {
    expect(voiceIntroMayAsk({ ...load, othersSettled: false }, true)).toBe(false);
    expect(voiceIntroMayAsk({ ...load, updating: true }, true)).toBe(false);
  });
});

describe('the clip goes to the Inbox serving this window', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('with no machine in the address, even with a linked machine known; a failure is an answer, and only a dead Inbox throws', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return Response.json({ code: 'voice_refused', engine: 'codex', error: 'x' }, { status: 502 });
    }) as typeof fetch;
    setSelfMachine('ibx_01J00000000000000000000000');
    const answer = await inboxApi.transcribeVoice(new Blob(['x']), new AbortController().signal);
    expect(answer).toEqual({ code: 'voice_refused', engine: 'codex', reason: undefined });
    expect(asked[0]).toStartWith('/api/inbox/voice/transcribe');
    expect(asked[0]).not.toContain('/m/');

    globalThis.fetch = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await expect(inboxApi.transcribeVoice(new Blob(['x']), new AbortController().signal)).rejects.toThrow();
  });

  test('anything else answered, a session mismatch among them, has no voice code', async () => {
    globalThis.fetch = (async () => Response.json({ error: 'stale', code: 'server_session_mismatch' }, { status: 409 })) as unknown as typeof fetch;
    expect(await inboxApi.transcribeVoice(new Blob(['x']), new AbortController().signal)).toMatchObject({ code: null });
  });
});
