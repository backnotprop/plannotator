/**
 * One composer's dictation with no microphone, no timers and no browser: a scripted recorder, a scripted field, and a
 * clock the test moves.
 *
 * What regresses: anything that sends by itself; a late answer writing into a box that was cancelled or closed; a hold
 * that turns into a tap (or the other way round); a clip dropped when the design keeps it for Retry; a silent clip
 * posted; a recording running past 2:00; two recordings at once.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createVoiceSession, VOICE_CAP_MS, VOICE_OPENING_SLOW_MS, VOICE_QUIET_STOP_MS, type VoiceAnswer, type VoiceDeps, type VoiceField, type VoiceSession } from './voiceSession';
import type { VoiceRecorder } from './voiceRecorder';

const LOUD = -20;
const ROOM = -70;
const TICK = 33;

function script(options: { prompts?: boolean; refuseMic?: string } = {}) {
  const log: string[] = [];
  const posted: Blob[] = [];
  const signals: AbortSignal[] = [];
  let clock = 1000;
  let db = LOUD;
  let ticker: (() => void) | null = null;
  const timers: { at: number; run: () => void }[] = [];
  let answers: (VoiceAnswer | Error | Promise<VoiceAnswer>)[] = [{ text: 'hello there' }];
  let ended: (() => void) | null = null;
  const pending: { resolve: (recorder: VoiceRecorder) => void }[] = [];
  let holdMic = false;
  const recorder = (): VoiceRecorder => ({
    rate: 24_000,
    db: () => db,
    stop: async () => {
      log.push('mic stopped');
      return [new Float32Array(2400).fill(0.2)];
    },
    abort: () => {
      log.push('mic aborted');
    },
    onEnded: (listener) => {
      ended = listener;
    },
  });
  const deps: VoiceDeps = {
    open: () => {
      log.push('mic opened');
      if (options.refuseMic) return Promise.reject(Object.assign(new Error('no'), { name: options.refuseMic }));
      if (holdMic) return new Promise((resolve) => pending.push({ resolve }));
      return Promise.resolve(recorder());
    },
    prompts: async () => options.prompts ?? false,
    transcribe: async (clip, signal) => {
      posted.push(clip);
      signals.push(signal);
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    notReady: (state) => log.push(`not ready: ${state}`),
    now: () => clock,
    every: (_ms, run) => {
      ticker = run;
      return () => {
        ticker = null;
      };
    },
    after: (ms, run) => {
      const timer = { at: clock + ms, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  };
  let value = 'Draft ';
  let caret = value.length;
  let onInput: (() => void) | null = null;
  let locked = false;
  const field: VoiceField = {
    selection: () => ({ start: caret, end: caret }),
    text: () => value,
    readOnly: () => locked,
    focus: () => log.push('focus'),
    select: (start) => {
      caret = start;
    },
    insert: (words) => {
      const start = caret;
      value = value.slice(0, caret) + words + value.slice(caret);
      caret += words.length;
      return { start, end: caret };
    },
    watch: (_onCaret, input) => {
      onInput = input;
      return () => {
        onInput = null;
      };
    },
  };
  const session = createVoiceSession(deps);
  return {
    log,
    posted,
    signals,
    session,
    detach: session.attach(field),
    value: () => value,
    type: (text: string) => {
      value += text;
      caret = value.length;
      onInput?.();
    },
    level: (next: number) => {
      db = next;
    },
    answer: (...next: (VoiceAnswer | Error | Promise<VoiceAnswer>)[]) => {
      answers = next;
    },
    holdMic: () => {
      holdMic = true;
    },
    lock: (next: boolean) => {
      locked = next;
    },
    openMic: () => pending.shift()!.resolve(recorder()),
    micEnded: () => ended?.(),
    /** Move the clock, with the session's ticker running. */
    pass: (ms: number) => {
      for (let left = ms; left > 0; left -= TICK) {
        clock += Math.min(TICK, left);
        ticker?.();
      }
      for (const timer of [...timers]) {
        if (timer.at <= clock) {
          timers.splice(timers.indexOf(timer), 1);
          timer.run();
        }
      }
    },
    ticking: () => ticker !== null,
  };
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/** A press that became a tap: recording, nothing held. */
async function tapped(world: ReturnType<typeof script>) {
  world.session.press();
  world.session.release();
  await settle();
  expect(world.session.view()).toMatchObject({ phase: 'listening', mode: 'tap' });
}

async function held(world: ReturnType<typeof script>, ms = 500) {
  world.session.press();
  await settle();
  world.pass(ms);
  expect(world.session.view()).toMatchObject({ phase: 'listening', mode: 'hold' });
}

let last: VoiceSession | null = null;
afterEach(() => {
  last?.cancel();
  last = null;
});
const world = (options?: Parameters<typeof script>[0]) => {
  const made = script(options);
  last = made.session;
  return made;
};

describe('hold and tap', () => {
  test('held past the threshold: letting go stops and the words land at the cursor; nothing is sent', async () => {
    const w = world();
    await held(w);
    expect(w.session.view().phase).toBe('listening');
    w.session.release();
    expect(w.session.view().phase).toBe('sending');
    await settle();
    expect(w.value()).toBe('Draft hello there');
    expect(w.session.view()).toMatchObject({ phase: 'idle', wash: { start: 6, end: 17 } });
    expect(w.posted).toHaveLength(1);
  });

  test('let go quickly: it keeps listening, and the second press stops it when released', async () => {
    const w = world();
    await tapped(w);
    w.pass(800);
    w.session.press();
    expect(w.session.view().phase).toBe('listening');
    w.session.release();
    expect(w.session.view().phase).toBe('sending');
  });

  test('a slow microphone: the time it took to open is not held time', async () => {
    const w = world();
    w.holdMic();
    w.session.press();
    w.pass(400);
    w.openMic();
    await settle();
    w.pass(100);
    w.session.release();
    expect(w.session.view()).toMatchObject({ phase: 'listening', mode: 'tap' });
  });

  test('released before the microphone opened: a tap, recording once it does', async () => {
    const w = world();
    w.holdMic();
    w.session.press();
    w.session.release();
    w.openMic();
    await settle();
    expect(w.session.view()).toMatchObject({ phase: 'listening', mode: 'tap' });
  });

  test('the browser asked first: the prompt took the press, so it is a tap', async () => {
    const w = world({ prompts: true });
    w.holdMic();
    w.session.press();
    await settle();
    expect(w.session.view()).toMatchObject({ phase: 'opening', prompting: true });
    w.openMic();
    await settle();
    expect(w.session.view()).toMatchObject({ phase: 'listening', mode: 'tap', prompting: false });
  });

  test('one letting go is one transcription, whatever the pointer does after it', async () => {
    const w = world();
    await held(w);
    w.session.release();
    w.session.release();
    w.session.lost();
    await settle();
    expect(w.posted).toHaveLength(1);
  });

  test('the system taking the pointer ends a hold with nothing sent, and leaves a tap running with its Cancel', async () => {
    const w = world();
    await held(w);
    w.session.lost();
    expect(w.session.view().phase).toBe('idle');
    await settle();
    expect(w.posted).toHaveLength(0);
    const tap = world();
    await tapped(tap);
    tap.session.lost();
    expect(tap.session.view().phase).toBe('listening');
    // Pressed again to stop, and the system took that pointer: still a tap, not a press waiting for a release.
    tap.session.press();
    tap.session.lost();
    expect(tap.session.view()).toMatchObject({ phase: 'listening', mode: 'tap' });
  });

  test('the system taking the pointer while the microphone opens: a tap, not a hold waiting for a release', async () => {
    const w = world();
    w.holdMic();
    w.session.press();
    w.session.lost();
    w.openMic();
    await settle();
    expect(w.session.view()).toMatchObject({ phase: 'listening', mode: 'tap' });
  });

  test('from the keyboard: starts and stops by toggle, and leaves focus on the button', async () => {
    const w = world();
    w.session.toggle();
    await settle();
    expect(w.session.view()).toMatchObject({ phase: 'listening', mode: 'tap' });
    expect(w.log).not.toContain('focus');
    w.pass(300);
    w.session.toggle();
    expect(w.session.view().phase).toBe('sending');
  });
});

describe('limits', () => {
  test('stops itself at 2:00 and sends what it has, and a hold cannot run past it', async () => {
    const w = world();
    await held(w);
    w.pass(VOICE_CAP_MS);
    expect(w.session.view().phase).toBe('sending');
    expect(w.ticking()).toBe(false);
    await settle();
    expect(w.value()).toBe('Draft hello there');
  });

  test('tap mode stops after quiet that follows speech', async () => {
    const w = world();
    await tapped(w);
    w.pass(500);
    w.level(ROOM);
    w.pass(VOICE_QUIET_STOP_MS - 1000);
    expect(w.session.view().phase).toBe('listening');
    w.pass(1500);
    expect(w.session.view().phase).toBe('sending');
  });

  test('a hold never stops for quiet', async () => {
    const w = world();
    await held(w);
    w.level(ROOM);
    w.pass(VOICE_QUIET_STOP_MS + 5000);
    expect(w.session.view().phase).toBe('listening');
  });

  test('a clip with no voice is not posted', async () => {
    const w = world();
    w.level(ROOM);
    await held(w);
    w.session.release();
    await settle();
    expect(w.session.view()).toMatchObject({ phase: 'idle', trouble: 'notheard', kept: false });
    expect(w.posted).toHaveLength(0);
    expect(w.log).toContain('mic aborted');
  });

  test('a microphone that goes away ends the take with what was heard', async () => {
    const w = world();
    await held(w);
    w.micEnded();
    expect(w.session.view().phase).toBe('sending');
  });
});

describe('cancel', () => {
  test('while listening: the mic closes, nothing is posted, the text stands', async () => {
    const w = world();
    await tapped(w);
    w.pass(200);
    w.session.cancel();
    await settle();
    expect(w.session.view().phase).toBe('idle');
    expect(w.log).toContain('mic aborted');
    expect(w.posted).toHaveLength(0);
    expect(w.value()).toBe('Draft ');
  });

  test('while transcribing: the post is aborted and a late answer writes nothing', async () => {
    const w = world();
    let answer: (value: VoiceAnswer) => void = () => {};
    w.answer(new Promise<VoiceAnswer>((resolve) => (answer = resolve)));
    await held(w);
    w.session.release();
    await settle();
    expect(w.posted).toHaveLength(1);
    w.session.cancel();
    expect(w.signals[0]!.aborted).toBe(true);
    answer({ text: 'too late' });
    await settle();
    expect(w.value()).toBe('Draft ');
    expect(w.session.view().phase).toBe('idle');
  });

  test('the field going away ends the run, a kept clip included', async () => {
    const w = world();
    let answer: (value: VoiceAnswer) => void = () => {};
    w.answer(new Promise<VoiceAnswer>((resolve) => (answer = resolve)));
    await held(w);
    w.session.release();
    await settle();
    w.detach();
    answer({ text: 'too late' });
    await settle();
    expect(w.value()).toBe('Draft ');
  });

  test('something covering the box ends the take: nothing is posted, and focus stays out of the covered box', async () => {
    const w = world();
    await tapped(w);
    w.pass(200);
    const before = w.log.filter((line) => line === 'focus').length;
    w.session.covered();
    await settle();
    w.pass(VOICE_CAP_MS);
    await settle();
    expect(w.session.view().phase).toBe('idle');
    expect(w.log).toContain('mic aborted');
    expect(w.posted).toHaveLength(0);
    expect(w.log.filter((line) => line === 'focus')).toHaveLength(before);
  });

  test('being covered leaves a clip kept for Retry alone', async () => {
    const w = world();
    w.answer({ code: 'voice_unreachable' }, { text: 'second try' });
    await held(w);
    w.session.release();
    await settle();
    expect(w.session.view().kept).toBe(true);
    w.session.covered();
    w.session.retry();
    await settle();
    expect(w.value()).toBe('Draft second try');
  });

  test('a mic that never opens: a line with Cancel after a moment, and Cancel frees the box', async () => {
    const w = world();
    w.holdMic();
    w.session.press();
    await settle();
    w.pass(VOICE_OPENING_SLOW_MS - 100);
    expect(w.session.view().slow).toBe(false);
    w.pass(200);
    expect(w.session.view()).toMatchObject({ phase: 'opening', slow: true });
    w.session.cancel();
    expect(w.session.view()).toMatchObject({ phase: 'idle', slow: false });
    w.session.press();
    expect(w.session.view().phase).toBe('opening');
  });

  test('a slow mic that does open goes straight to listening, and a fast one never says it was slow', async () => {
    const w = world();
    w.holdMic();
    w.session.press();
    await settle();
    w.pass(VOICE_OPENING_SLOW_MS + 100);
    w.openMic();
    await settle();
    expect(w.session.view()).toMatchObject({ phase: 'listening', slow: false });
    const fast = world();
    await held(fast);
    fast.pass(VOICE_OPENING_SLOW_MS + 100);
    expect(fast.session.view().slow).toBe(false);
  });

  test('a mic that opens after a cancel is closed at once', async () => {
    const w = world();
    w.holdMic();
    w.session.press();
    w.session.cancel();
    w.openMic();
    await settle();
    expect(w.session.view().phase).toBe('idle');
    expect(w.log).toContain('mic aborted');
    expect(w.ticking()).toBe(false);
  });
});

describe('failures', () => {
  test.each([
    [{ code: 'voice_expired' }, 'expired'],
    [{ code: 'voice_refused' }, 'refused'],
    [{ code: 'voice_key_refused' }, 'keyrefused'],
    [{ code: 'voice_unreachable' }, 'offline'],
    [{ code: 'voice_codex_failed' }, 'codexfailed'],
    [new Error('the Inbox went away'), 'inboxgone'],
    [{ code: null }, 'inboxgone'],
  ] as const)('%p keeps the clip: only a press retries, and the same clip goes again', async (answer, trouble) => {
    const w = world();
    w.answer(answer as VoiceAnswer | Error, { text: 'second try' });
    await held(w);
    w.session.release();
    await settle();
    expect(w.session.view()).toMatchObject({ phase: 'idle', trouble, kept: true });
    expect(w.posted).toHaveLength(1);
    w.pass(5000);
    expect(w.posted).toHaveLength(1);
    w.session.retry();
    await settle();
    expect(w.posted).toHaveLength(2);
    expect(w.posted[1]).toBe(w.posted[0]!);
    expect(w.value()).toBe('Draft second try');
    expect(w.session.view()).toMatchObject({ trouble: null, kept: false });
  });

  test('Discard drops the clip, and Retry then does nothing', async () => {
    const w = world();
    w.answer({ code: 'voice_unreachable' });
    await held(w);
    w.session.release();
    await settle();
    w.session.discard();
    expect(w.session.view()).toMatchObject({ trouble: null, kept: false });
    w.session.retry();
    await settle();
    expect(w.posted).toHaveLength(1);
  });

  test('Retry waits while the box is read-only: the clip stays and no words land', async () => {
    const w = world();
    w.answer({ code: 'voice_unreachable' }, { text: 'second try' });
    await held(w);
    w.session.release();
    await settle();
    w.lock(true);
    w.session.retry();
    await settle();
    expect(w.posted).toHaveLength(1);
    expect(w.session.view().kept).toBe(true);
    w.lock(false);
    w.session.retry();
    await settle();
    expect(w.value()).toBe('Draft second try');
  });

  test('a clip the Inbox could not read is its own trouble, not silence, with nothing to retry', async () => {
    const w = world();
    w.answer({ code: 'voice_bad_clip' });
    await held(w);
    w.session.release();
    await settle();
    expect(w.session.view()).toMatchObject({ trouble: 'badclip', kept: false });
  });

  test('an empty transcript is said, with nothing to retry and nothing inserted; typing clears the line', async () => {
    const w = world();
    w.answer({ code: 'voice_empty' });
    await held(w);
    w.session.release();
    await settle();
    expect(w.session.view()).toMatchObject({ trouble: 'nothing', kept: false });
    expect(w.value()).toBe('Draft ');
    w.type('x');
    expect(w.session.view().trouble).toBeNull();
  });

  test('typing leaves a line that still holds a clip', async () => {
    const w = world();
    w.answer({ code: 'voice_unreachable' });
    await held(w);
    w.session.release();
    await settle();
    w.type('x');
    expect(w.session.view()).toMatchObject({ trouble: 'offline', kept: true });
  });

  test('not ready: the mic learns it too, and the clip waits', async () => {
    const w = world();
    w.answer({ code: 'voice_not_ready', reason: 'signedout', engine: 'codex' });
    await held(w);
    w.session.release();
    await settle();
    expect(w.session.view()).toMatchObject({ trouble: 'notready', kept: true });
    expect(w.log).toContain('not ready: signedout');
  });

  test.each([
    ['NotAllowedError', 'blocked'],
    ['NotFoundError', 'micfailed'],
    ['InvalidStateError', 'micfailed'],
  ])('the microphone refusing with %s: %s, and the next press can start', async (name, trouble) => {
    const w = world({ refuseMic: name });
    w.session.press();
    await settle();
    expect(w.session.view()).toMatchObject({ phase: 'idle', trouble });
    w.session.release();
    expect(w.session.view().phase).toBe('idle');
  });
});

describe('the words', () => {
  test('the wash fades, then goes; typing takes it away at once', async () => {
    const w = world();
    await held(w);
    w.session.release();
    await settle();
    w.pass(1400);
    expect(w.session.view().wash?.fading).toBe(true);
    w.pass(1000);
    expect(w.session.view().wash).toBeNull();

    const typed = world();
    await held(typed);
    typed.session.release();
    await settle();
    typed.type('x');
    expect(typed.session.view().wash).toBeNull();
  });
});

test('starting in one composer cancels a recording in another', async () => {
  const one = world();
  await tapped(one);
  const two = world();
  await tapped(two);
  expect(one.session.view().phase).toBe('idle');
  expect(one.log).toContain('mic aborted');
  expect(two.session.view().phase).toBe('listening');
});
