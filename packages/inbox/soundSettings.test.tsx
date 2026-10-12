/**
 * The question sound in Settings and around the page: the one row (switch,
 * volume, Play), the "Click once in this tab to allow sound." line before
 * the first click, the sidebar hint, the notification ask's "Sound is on.",
 * and the hook itself against a recording AudioContext: nothing rings before
 * the first click or with the tab in front, a burst rings once, Play always
 * plays. Never audible: the AudioContext is a stub that only counts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxSound } from './sound';
import type { SettingsModel } from './api';

const hasDom = typeof document !== 'undefined';
const { SettingsPage } = (hasDom ? await import('./components/Settings') : {}) as typeof import('./components/Settings');
const { NotificationAsk } = (hasDom ? await import('./components/NotificationAsk') : {}) as typeof import('./components/NotificationAsk');
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { useInboxSound } = (hasDom ? await import('./sound') : {}) as typeof import('./sound');

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
  store: { dir: '/home/u/.plannotator/inbox', bytes: 0, projects: [] },
} as unknown as SettingsModel;

function fakeSound(over: Partial<InboxSound> = {}) {
  const seen: string[] = [];
  const sound: InboxSound = {
    settings: { enabled: true, volume: 60, dialog_shown_for: null },
    armed: true,
    playing: false,
    preview: (volume) => void seen.push(`preview:${volume ?? 'saved'}`),
    questionsArrived: () => {},
    setEnabled: async (next) => (seen.push(`enabled:${next}`), true),
    setVolume: async (next) => (seen.push(`volume:${next}`), true),
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
  test('one row under the notifications switch: label, when, volume, Play, switch', () => {
    const { sound } = fakeSound();
    const block = renderSettings(sound);
    const row = block.querySelector('[data-settings-sound]') as HTMLElement;
    expect(row.getAttribute('data-settings-sound')).toBe('on');
    // The label, then when it rings (Settings in sections: the row's description, .product/approved/inbox-settings-tabs/).
    expect(row.querySelector('#ib-sound-label')?.textContent).toBe('Play a sound');
    expect(row.textContent).toContain('When an agent asks you');
    const slider = row.querySelector('input[type="range"]') as HTMLInputElement;
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['10', '100', '10', '60']);
    expect(slider.getAttribute('aria-label')).toBe('Volume');
    expect(slider.getAttribute('aria-valuetext')).toBe('60 percent');
    expect(row.querySelector('[data-sound-play]')?.getAttribute('aria-label')).toBe('Play the sound');
    const sw = row.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById(sw.getAttribute('aria-labelledby')!)?.textContent).toBe('Play a sound');
  });

  test('the switch saves; off, the slider is disabled and Play still plays', () => {
    const on = fakeSound();
    let block = renderSettings(on.sound);
    act(() => (block.querySelector('[data-settings-sound] [role="switch"]') as HTMLButtonElement).click());
    expect(on.seen).toEqual(['enabled:false']);
    act(() => root?.unmount());
    const off = fakeSound({ settings: { enabled: false, volume: 40, dialog_shown_for: null } });
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
    expect(hint({ armed: false, settings: { enabled: false, volume: 60, dialog_shown_for: null } })).toBeNull();
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

  test('the sidebar shows "Click to turn on sound" only when asked to', () => {
    const noop = () => {};
    const sidebar = (soundNeedsClick: boolean) => (
      <SidebarProvider>
        <Sidebar
          page="inbox"
          projectId={null}
          inboxCount={0}
          decisionsCount={0}
          projects={[]}
          projectCounts={new Map()}
          update={null}
          restarting={false}
          updated={null}
          onInbox={noop}
          onProject={noop}
          onSettings={noop}
          onDecisions={noop}
          onUpdate={noop}
          onWhatsNew={noop}
          soundNeedsClick={soundNeedsClick}
        />
      </SidebarProvider>
    );
    const el = mount(sidebar(true));
    expect(el.querySelector('[data-sound-hint]')?.textContent).toBe('Click to turn on sound');
    act(() => root!.render(sidebar(false)));
    expect(el.querySelector('[data-sound-hint]')).toBeNull();
  });
});

// ───────────────────────────── The hook, against a recording AudioContext ─────────────────────────────

interface Recorder {
  contexts: number;
  oscillators: number;
  gains: number[];
}

let recorder: Recorder;
let front = { visible: true, focused: true };
const saved: { ctx?: unknown; hasFocus?: () => boolean; visibility?: PropertyDescriptor } = {};

function installStubs() {
  recorder = { contexts: 0, oscillators: 0, gains: [] };
  const rec = recorder;
  const param = () => ({ value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class StubContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    constructor() {
      rec.contexts++;
    }
    resume() {
      return Promise.resolve();
    }
    createGain() {
      const gain = { gain: param(), connect: (to: unknown) => to };
      return gain;
    }
    createOscillator() {
      rec.oscillators++;
      return { type: 'sine', frequency: param(), connect: (to: unknown) => to, start() {}, stop() {} };
    }
  }
  saved.ctx = (window as unknown as { AudioContext?: unknown }).AudioContext;
  (window as unknown as { AudioContext: unknown }).AudioContext = StubContext;
  saved.hasFocus = document.hasFocus;
  saved.visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (front.visible ? 'visible' : 'hidden') });
  document.hasFocus = () => front.focused;
}

function restoreStubs() {
  (window as unknown as { AudioContext: unknown }).AudioContext = saved.ctx;
  document.hasFocus = saved.hasFocus!;
  if (saved.visibility) Object.defineProperty(document, 'visibilityState', saved.visibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
  try {
    window.localStorage.clear();
  } catch {}
}

/** Rings so far: the sound is four oscillators. */
const rings = () => recorder.oscillators / 4;

let api: InboxSound;
function Probe() {
  api = useInboxSound({ settings: { enabled: true, volume: 60, dialog_shown_for: null }, onSettings: () => {} });
  return <span data-armed={api.armed ? 'yes' : 'no'} />;
}

describe.if(hasDom)('useInboxSound', () => {
  beforeEach(() => {
    front = { visible: true, focused: true };
    installStubs();
  });
  afterEach(() => restoreStubs());

  test('before the first click a question rings nothing; the first click arms it; then a hidden tab rings once per burst', () => {
    const el = mount(<Probe />);
    front = { visible: false, focused: false };
    act(() => api.questionsArrived());
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
    act(() => api.questionsArrived());
    act(() => api.questionsArrived());
    act(() => api.questionsArrived());
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
    act(() => api.questionsArrived());
    expect(rings()).toBe(0);
    act(() => api.preview());
    expect(rings()).toBe(1);
    expect(api.playing).toBe(true);
  });
});
