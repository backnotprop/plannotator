/**
 * The Inbox's sound in Settings and around the page: the one row (what rings
 * it, switch, volume, Play), the "Click once in this tab to allow sound."
 * line before the first click, the notification ask's "Sound is on.",
 * and the hook itself against a recording AudioContext: nothing rings before
 * the first click or with the tab in front, a burst rings once, Play always
 * plays the Ding-dong; "every agent message" (the default, also with
 * nothing chosen) rings the Ding-dong for a plain reply, "when an agent asks
 * you or starts a thread" nothing; off stays off.
 * Never audible: the AudioContext is a stub that only counts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxSoundSettings } from '@plannotator/core/inbox-types';
import type { InboxSound } from './sound';
import type { SettingsModel } from './api';
import { newAudioRecord, recordingAudioContext, timesPlayed, type AudioRecord } from '../../tests/helpers/recording-audio';

const hasDom = typeof document !== 'undefined';
const { SettingsPage } = (hasDom ? await import('./components/Settings') : {}) as typeof import('./components/Settings');
const { NotificationAsk } = (hasDom ? await import('./components/NotificationAsk') : {}) as typeof import('./components/NotificationAsk');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { useInboxSound, endRingHold, DING_DONG } = (hasDom ? await import('./sound') : {}) as typeof import('./sound');
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
  return host;
}

const settingsModel = {
  serverSession: 's',
  version: '0.29.0',
  port: 1,
  url: 'http://localhost:1/',
  mcp_url: 'http://127.0.0.1:1/mcp',
  mcp_command: ['plannotator', 'inbox', 'mcp'],
  home: '/home/u',
  data_dir: '/home/u/.plannotator',
  inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null },
  notifications: { enabled: true, dismissed: false, allowed_origin: null },
  sound: { enabled: true, volume: 60, dialog_shown_for: null },
  phones: false,
  store_dir: '/home/u/.plannotator/inbox',
} as unknown as SettingsModel;

function fakeSound(over: Partial<InboxSound> = {}) {
  const seen: string[] = [];
  const sound: InboxSound = {
    settings: { enabled: true, volume: 60, when: 'messages', dialog_shown_for: null },
    armed: true,
    playing: false,
    preview: (volume) => void seen.push(`preview:${volume ?? 'saved'}`),
    arrived: () => ({ asks: false, plain: false, fresh: false }),
    hear: () => {},
    otherTabInFront: () => false,
    setEnabled: async (next) => (seen.push(`enabled:${next}`), true),
    setVolume: async (next) => (seen.push(`volume:${next}`), true),
    setWhen: async (next) => (seen.push(`when:${next}`), true),
    ...over,
  };
  return { sound, seen };
}

function renderSettings(sound: InboxSound) {
  const noop = () => {};
  const el = mount(
    <SidebarProvider>
      <SettingsPage
        settings={settingsModel}
        context={null}
        error={null}
        onToggleTool={noop}
        onToggleTailscale={noop}
        tailscaleBusy={false}
        permission="granted"
        onToggleNotifications={noop}
        onDeleteThread={async () => {}}
        onDeleteProject={async () => {}}
        sound={sound}
      />
    </SidebarProvider>,
  );
  return el.querySelector('[data-settings-notifications]') as HTMLElement;
}

/** Set a range input's value the way a drag does: input events while moving, change on release. */
function drag(slider: HTMLInputElement, value: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(slider, String(value));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe.if(hasDom)('Settings: the sound row', () => {
  test('one row under the notifications switch: label, what rings it, when, volume, Play, switch', () => {
    const { sound } = fakeSound();
    const block = renderSettings(sound);
    const row = block.querySelector('[data-settings-sound]') as HTMLElement;
    expect(row.getAttribute('data-settings-sound')).toBe('on');
    // The label, then the owner's two choices in their order, "every agent message" chosen, then what it rings for.
    expect(row.querySelector('#ib-sound-label')?.textContent).toBe('Play a sound');
    // The section it sits in (the owner, 2026-11-18): named for what reaches the person now, not only questions.
    expect(document.getElementById('ib-g-attention')?.textContent).toBe('When an agent sends you something');
    const group = row.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute('aria-label')).toBe('When to play a sound');
    // The description says what the chosen one rings for, and screen readers hear it with the choice.
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toBe('A reply, a new thread or a question, while no Inbox tab is in front');
    const radios = [...group.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(radios.map((r) => r.parentElement!.textContent)).toEqual(['questions and new threads', 'every agent message']);
    expect(radios.map((r) => r.checked)).toEqual([false, true]);
    expect(row.querySelector('.ib-desc')?.textContent).toBe('A reply, a new thread or a question, while no Inbox tab is in front');
    const slider = row.querySelector('input[type="range"]') as HTMLInputElement;
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['10', '100', '10', '60']);
    expect(slider.getAttribute('aria-label')).toBe('Volume');
    expect(slider.getAttribute('aria-valuetext')).toBe('60 percent');
    expect(row.querySelector('[data-sound-play]')?.getAttribute('aria-label')).toBe('Play the sound');
    const sw = row.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById(sw.getAttribute('aria-labelledby')!)?.textContent).toBe('Play a sound');
  });

  test('picking a choice saves it; "questions and new threads" says when it rings', () => {
    const every = fakeSound();
    let block = renderSettings(every.sound);
    act(() => (block.querySelector('[data-sound-when-o="asks"] input') as HTMLInputElement).click());
    expect(every.seen).toEqual(['when:asks']);
    act(() => root?.unmount());
    const asks = fakeSound({ settings: { enabled: true, volume: 60, when: 'asks', dialog_shown_for: null } });
    block = renderSettings(asks.sound);
    expect(block.querySelector('[data-sound-when]')?.getAttribute('data-sound-when')).toBe('asks');
    expect((block.querySelector('[data-sound-when-o="asks"] input') as HTMLInputElement).checked).toBe(true);
    expect(block.querySelector('[data-settings-sound] .ib-desc')?.textContent).toBe('While no Inbox tab is in front');
    act(() => (block.querySelector('[data-sound-when-o="messages"] input') as HTMLInputElement).click());
    expect(asks.seen).toEqual(['when:messages']);
  });

  test('the switch saves; off, the slider is disabled and Play still plays', () => {
    const on = fakeSound();
    let block = renderSettings(on.sound);
    act(() => (block.querySelector('[data-settings-sound] [role="switch"]') as HTMLButtonElement).click());
    expect(on.seen).toEqual(['enabled:false']);
    act(() => root?.unmount());
    const off = fakeSound({ settings: { enabled: false, volume: 40, when: 'messages', dialog_shown_for: null } });
    block = renderSettings(off.sound);
    expect((block.querySelector('input[type="range"]') as HTMLInputElement).disabled).toBe(true);
    act(() => (block.querySelector('[data-sound-play]') as HTMLButtonElement).click());
    expect(off.seen).toEqual(['preview:40']);
  });

  test('letting go of the slider saves the volume and plays it once at the new level; moving it does neither', () => {
    const { sound, seen } = fakeSound();
    const block = renderSettings(sound);
    const slider = block.querySelector('input[type="range"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(slider, '80');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seen).toEqual([]);
    expect(slider.getAttribute('aria-valuetext')).toBe('80 percent');
    drag(slider, 30);
    expect(seen).toEqual(['preview:30', 'volume:30']);
  });

  test('"Click once in this tab to allow sound." only while the sound is on and the tab has had no click', () => {
    const hint = (over: Partial<InboxSound>) => {
      const block = renderSettings(fakeSound(over).sound);
      const text = block.querySelector('[data-sound-click-hint]')?.textContent ?? null;
      act(() => root?.unmount());
      return text;
    };
    expect(hint({ armed: false })).toBe('Click once in this tab to allow sound.');
    expect(hint({ armed: true })).toBeNull();
    expect(hint({ armed: false, settings: { enabled: false, volume: 60, when: 'messages', dialog_shown_for: null } })).toBeNull();
  });
});

describe.if(hasDom)('around the page', () => {
  test('the notification ask says "Sound is on." while it is', () => {
    const noop = () => {};
    let el = mount(<NotificationAsk kind="ask" soundOn onTurnOn={noop} onNotNow={noop} />);
    expect(el.textContent).toContain('Your browser asks once. Sound is on.');
    act(() => root!.render(<NotificationAsk kind="ask" soundOn={false} onTurnOn={noop} onNotNow={noop} />));
    expect(el.textContent).not.toContain('Sound is on.');
  });
});

// ───────────────────────────── The hook, against a recording AudioContext ─────────────────────────────

let recorder: AudioRecord;
let front = { visible: true, focused: true };
const saved: { ctx?: unknown; hasFocus?: () => boolean; visibility?: PropertyDescriptor } = {};

function installStubs() {
  recorder = newAudioRecord();
  const StubContext = recordingAudioContext(recorder);
  saved.ctx = (window as unknown as { AudioContext?: unknown }).AudioContext;
  (window as unknown as { AudioContext: unknown }).AudioContext = StubContext;
  saved.hasFocus = document.hasFocus;
  saved.visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (front.visible ? 'visible' : 'hidden') });
  document.hasFocus = () => front.focused;
}

function restoreStubs() {
  // The ring lock this file's tabs took (module state): the next test starts with none held.
  endRingHold();
  (window as unknown as { AudioContext: unknown }).AudioContext = saved.ctx;
  document.hasFocus = saved.hasFocus!;
  if (saved.visibility) Object.defineProperty(document, 'visibilityState', saved.visibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
  try {
    window.localStorage.clear();
  } catch {}
}

const rings = () => timesPlayed(recorder, DING_DONG[0]!.freq);

let api: InboxSound;
/** As the Inbox sends it: no `when` is how an update finds everyone who had the sound and never chose. */
let probeSettings: InboxSoundSettings = { enabled: true, volume: 60, dialog_shown_for: null };
/** What the hook last handed the page to keep (a save's answer, or another window's `event: sound`). */
let kept: InboxSoundSettings | null = null;
function Probe() {
  api = useInboxSound({ settings: probeSettings, onSettings: (next) => void (kept = next) });
  return <span data-armed={api.armed ? 'yes' : 'no'} />;
}

const QUESTION = { asks: true, plain: false };
const REPLY = { asks: false, plain: true };

describe.if(hasDom)('useInboxSound', () => {
  beforeEach(() => {
    front = { visible: true, focused: true };
    probeSettings = { enabled: true, volume: 60, dialog_shown_for: null };
    kept = null;
    installStubs();
  });
  afterEach(() => restoreStubs());

  test('before the first click a question rings nothing; the first click arms it; then a hidden tab rings once per burst', () => {
    const el = mount(<Probe />);
    front = { visible: false, focused: false };
    act(() => api.arrived(QUESTION));
    expect(rings()).toBe(0);
    expect(el.querySelector('[data-armed]')?.getAttribute('data-armed')).toBe('no');
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(el.querySelector('[data-armed]')?.getAttribute('data-armed')).toBe('yes');
    // That question was this burst's first: a burst of three more rings nothing until 30 s pass.
    // A fresh burst: back in front, then away again.
    front = { visible: true, focused: true };
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    front = { visible: false, focused: false };
    act(() => api.arrived(QUESTION));
    act(() => api.arrived(QUESTION));
    act(() => api.arrived(QUESTION));
    expect(rings()).toBe(1);
  });

  test('a key press the browser does not count as an activation (Escape) does not arm; the next click that does, arms', () => {
    const activation = { isActive: false, hasBeenActive: false };
    const before = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => activation });
    try {
      const el = mount(<Probe />);
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(el.querySelector('[data-armed]')?.getAttribute('data-armed')).toBe('no');
      activation.isActive = true;
      activation.hasBeenActive = true;
      act(() => {
        window.dispatchEvent(new Event('click'));
      });
      expect(el.querySelector('[data-armed]')?.getAttribute('data-armed')).toBe('yes');
    } finally {
      if (before) Object.defineProperty(navigator, 'userActivation', before);
      else delete (navigator as unknown as Record<string, unknown>).userActivation;
    }
  });

  test('the tab in front: nothing rings; Play always plays, in front or not', () => {
    mount(<Probe />);
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    act(() => api.arrived(QUESTION));
    expect(rings()).toBe(0);
    act(() => api.preview());
    expect(rings()).toBe(1);
    expect(api.playing).toBe(true);
  });

  /** Armed, then a fresh burst away from the tab. */
  function armedAndAway() {
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    front = { visible: true, focused: true };
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    front = { visible: false, focused: false };
  }

  /** Runs `body` with Date.now reading `clock.t` (the ring lock and the bursts count time with it). */
  function onClock(body: (clock: { t: number }) => void) {
    const real = Date.now;
    const clock = { t: 1_000_000 };
    Date.now = () => clock.t;
    try {
      body(clock);
    } finally {
      Date.now = real;
    }
  }

  test('nothing chosen (an update): "every agent message"; a plain reply away rings the Ding-dong, five agents at once ring once, in front nothing', () => {
    mount(<Probe />);
    expect(api.settings.when).toBe('messages');
    armedAndAway();
    let rang = api.arrived(REPLY);
    expect(rings()).toBe(1);
    expect(rang).toEqual({ asks: false, plain: true, fresh: false });
    // Five agents posting at once: one burst, one ring, and all of it the bell's (their notices silent: one sound).
    for (let i = 0; i < 5; i++) act(() => void (rang = api.arrived(REPLY)));
    expect(rings()).toBe(1);
    expect(rang).toEqual({ asks: false, plain: true, fresh: false });
    // The tab in front: nothing rings, and the burst ends.
    front = { visible: true, focused: true };
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    act(() => api.arrived(REPLY));
    expect(rings()).toBe(1);
  });

  test('agent chatter never swallows a question: A replies at 0 s (rings) and 20 s (quiet), B asks at 40 s and it rings', () => {
    onClock((clock) => {
      mount(<Probe />);
      armedAndAway();
      act(() => api.arrived(REPLY));
      clock.t += 20_000;
      act(() => api.arrived(REPLY));
      expect(rings()).toBe(1);
      clock.t += 20_000;
      let rang = api.arrived(QUESTION);
      expect(rings()).toBe(2);
      // The bell rang for the question, so its notice is silent; a question in that question burst rings nothing and is
      // the bell's too (its notice silent: one sound per burst).
      expect(rang).toEqual({ asks: true, plain: false, fresh: false });
      clock.t += 5_000;
      act(() => void (rang = api.arrived(QUESTION)));
      expect(rings()).toBe(2);
      expect(rang).toEqual({ asks: true, plain: false, fresh: false });
    });
  });

  test('a question two seconds after a reply rang still rings (this tab holds the ring lock, so it rings it itself)', async () => {
    mount(<Probe />);
    armedAndAway();
    act(() => api.arrived(REPLY));
    await act(async () => {
      await Promise.resolve();
    });
    expect(rings()).toBe(1);
    const real = Date.now;
    const at = real();
    Date.now = () => at + 2_000;
    try {
      let rang = api.arrived(QUESTION);
      await act(async () => {
        await Promise.resolve();
      });
      expect(rings()).toBe(2);
      expect(rang).toEqual({ asks: true, plain: false, fresh: false });
    } finally {
      Date.now = real;
    }
  });

  test('"questions and new threads": a plain reply plays nothing and starts no burst; a question then rings', () => {
    probeSettings = { enabled: true, volume: 60, when: 'asks', dialog_shown_for: null };
    mount(<Probe />);
    armedAndAway();
    let rang = api.arrived(REPLY);
    expect(rings()).toBe(0);
    expect(rang).toEqual({ asks: false, plain: false, fresh: false });
    act(() => void (rang = api.arrived(QUESTION)));
    expect(rings()).toBe(1);
    expect(rang).toEqual({ asks: true, plain: false, fresh: false });
  });

  test("another window's save (event: sound) reaches this one at once: it rings by the new choice; a frame that is not settings is ignored", () => {
    mount(<Probe />);
    armedAndAway();
    act(() => api.hear({ nonsense: true }));
    expect(kept).toBeNull();
    act(() => api.hear({ enabled: true, volume: 40, when: 'asks', dialog_shown_for: '0.29.0' }));
    expect(kept).toEqual({ enabled: true, volume: 40, when: 'asks', dialog_shown_for: '0.29.0' });
    // The page keeps it (App's setSettings): this window now stays quiet for a plain reply.
    probeSettings = kept!;
    act(() => root!.render(<Probe />));
    act(() => api.arrived(REPLY));
    expect(rings()).toBe(0);
    // And the switch turned off elsewhere silences a question here too.
    act(() => api.hear({ enabled: false, volume: 40, when: 'messages', dialog_shown_for: null }));
    probeSettings = kept!;
    act(() => root!.render(<Probe />));
    act(() => api.arrived(QUESTION));
    expect(rings()).toBe(0);
  });

  test("a double-clicked switch never flicks back: an older save's frame, or one landing while this window's save is on its way, is not shown over the newer", async () => {
    mount(<Probe />);
    const realSave = inboxApi.saveSound;
    const answers: ((value: { sound: InboxSoundSettings; sound_rev: number }) => void)[] = [];
    inboxApi.saveSound = () => new Promise((resolve) => answers.push(resolve));
    try {
      const off = { enabled: false, volume: 60, when: 'messages' as const, dialog_shown_for: null };
      const on = { ...off, enabled: true };
      let first!: Promise<boolean>;
      let second!: Promise<boolean>;
      act(() => {
        first = api.setEnabled(false);
      });
      act(() => {
        second = api.setEnabled(true);
      });
      expect(kept?.enabled).toBe(true);
      // The first save's frame lands while both are on their way: held, not shown.
      act(() => api.hear(off, 101));
      expect(kept?.enabled).toBe(true);
      await act(async () => {
        answers[0]!({ sound: off, sound_rev: 101 });
        await first;
      });
      // The first answer is not the last save's: not shown either.
      expect(kept?.enabled).toBe(true);
      await act(async () => {
        answers[1]!({ sound: on, sound_rev: 102 });
        await second;
      });
      expect(kept?.enabled).toBe(true);
      // The first save's frame again, late: older than what this window knows.
      act(() => api.hear(off, 101));
      expect(kept?.enabled).toBe(true);
      // Another window's later save is shown.
      act(() => api.hear({ ...off, when: 'asks' }, 103));
      expect(kept).toMatchObject({ enabled: false, when: 'asks' });
    } finally {
      inboxApi.saveSound = realSave;
    }
  });

  test('the sound turned off before the choice existed stays off: nothing rings for any news, and no notice is made silent', () => {
    probeSettings = { enabled: false, volume: 60, dialog_shown_for: null };
    mount(<Probe />);
    armedAndAway();
    const rang = [api.arrived(REPLY), api.arrived(QUESTION)];
    expect(rings()).toBe(0);
    expect(api.settings.enabled).toBe(false);
    expect(rang).toEqual([{ asks: false, plain: false, fresh: false }, { asks: false, plain: false, fresh: false }]);
  });

  test('after a reload in a browser that still allows sound (no click yet), a question rings and its notice is the bell\'s', () => {
    recorder.autoplay = true;
    const activation = { isActive: false, hasBeenActive: false };
    const before = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => activation });
    try {
      mount(<Probe />);
      front = { visible: false, focused: false };
      let rang: unknown;
      act(() => {
        rang = api.arrived(QUESTION);
      });
      expect(rang).toEqual({ asks: true, plain: false, fresh: false });
      expect(rings()).toBe(1);
    } finally {
      if (before) Object.defineProperty(navigator, 'userActivation', before);
      else delete (navigator as unknown as Record<string, unknown>).userActivation;
    }
  });

  test('a question while locked, a click, then another question 10 s later: no ring, so its notice keeps the system sound', () => {
    const activation = { isActive: false, hasBeenActive: false };
    const before = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => activation });
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      mount(<Probe />);
      front = { visible: false, focused: false };
      act(() => void api.arrived(QUESTION));
      activation.isActive = true;
      activation.hasBeenActive = true;
      act(() => {
        window.dispatchEvent(new Event('pointerdown'));
      });
      clock += 10_000;
      let rang: unknown;
      act(() => {
        rang = api.arrived(QUESTION);
      });
      expect(rings()).toBe(0);
      expect(rang).toEqual({ asks: false, plain: false, fresh: false });
    } finally {
      Date.now = realNow;
      if (before) Object.defineProperty(navigator, 'userActivation', before);
      else delete (navigator as unknown as Record<string, unknown>).userActivation;
    }
  });

  test('before the first click nothing rings, so no notice is made silent', () => {
    const activation = { isActive: false, hasBeenActive: false };
    const before = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => activation });
    try {
      mount(<Probe />);
      front = { visible: false, focused: false };
      expect(api.arrived(QUESTION)).toEqual({ asks: false, plain: false, fresh: false });
      expect(rings()).toBe(0);
    } finally {
      if (before) Object.defineProperty(navigator, 'userActivation', before);
      else delete (navigator as unknown as Record<string, unknown>).userActivation;
    }
  });
});
