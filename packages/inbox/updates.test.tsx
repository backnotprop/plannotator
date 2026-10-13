/**
 * The update control as drawn: the sidebar button per state (Available shows
 * the filled Update at once), the update dialog (Update now in the first
 * step, the command instead for a binary the script does not manage, the
 * automatic-updates checkbox), and the failure dialog.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxUpdate } from '@plannotator/core/inbox-types';
import type { UpdateDetails } from './api';

const hasDom = typeof document !== 'undefined';
// Updates.tsx draws What's new with ui's Viewer, which reads `window` at module-eval time.
const { FailedDialog, UpdateButton, UpdateDialog } = (hasDom ? await import('./components/Updates') : {}) as typeof import('./components/Updates');
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
  return host;
}

const update = (state: InboxUpdate['state'], action: InboxUpdate['action'] = 'script'): InboxUpdate => ({
  available: true,
  state,
  version: '0.28.12',
  current: '0.28.10',
  action,
  releaseUrl: 'https://github.com/backnotprop/plannotator/releases/tag/v0.28.12',
});

const details = (over: Partial<UpdateDetails> = {}): UpdateDetails => ({
  update: update('available'),
  current: '0.28.10',
  updated: null,
  latest: { version: '0.28.12', fetched_at: '2026-10-10T09:14:00Z', published_at: '2026-10-09T12:00:00Z' },
  check: { on: true, env: null, last_attempt_at: '2026-10-10T09:14:00Z', error: null },
  auto_update: { on: false, env: null, supported: true },
  summary: 'A patch release for the Inbox.',
  flags: ['--skip-gemini'],
  command: 'curl -fsSL https://plannotator.ai/install.sh | bash -s -- --skip-gemini',
  plugin_command: null,
  sessions: [{ mode: 'review', project: 'billing-svc', label: 'review-billing-svc', started_at: '2026-10-10T09:02:00Z' }],
  failure: null,
  log: '/home/u/.plannotator/update.log',
  snoozed_until: null,
  ...over,
});

test.skipIf(!hasDom)('nothing when up to date; the What\'s new link after an update', () => {
  const el = render(<UpdateButton update={null} restarting={false} updated={null} onPress={() => {}} onWhatsNew={() => {}} />);
  expect(el.querySelector('button')).toBeNull();
  act(() => root!.render(<UpdateButton update={null} restarting={false} updated="0.28.12" onPress={() => {}} onWhatsNew={() => {}} />));
  expect(el.querySelector('[data-whats-new-link="0.28.12"]')?.textContent).toContain("What's new in 0.28.12");
});

test.skipIf(!hasDom)('available: the filled Update button, named for the version, pressable', () => {
  let pressed = 0;
  const el = render(<UpdateButton update={update('available')} restarting={false} updated={null} onPress={() => pressed++} onWhatsNew={() => {}} />);
  const button = el.querySelector('.ib-upd-btn') as HTMLButtonElement;
  expect(button.getAttribute('aria-label')).toBe('Update to Plannotator 0.28.12');
  expect(button.textContent).toBe('Update');
  expect(button.disabled).toBe(false);
  expect(button.classList.contains('ib-outline')).toBe(false);
  expect(el.querySelector('#ib-upd-tip')?.textContent).toBe('Plannotator 0.28.12 is available');
  act(() => button.click());
  expect(pressed).toBe(1);
});

test.skipIf(!hasDom)('updating and restarting are disabled; failed is the neutral outline', () => {
  const el = render(<UpdateButton update={update('updating')} restarting={false} updated={null} onPress={() => {}} onWhatsNew={() => {}} />);
  const button = () => el.querySelector('.ib-upd-btn') as HTMLButtonElement;
  expect(button().disabled).toBe(true);
  expect(button().textContent).toBe('Updating…');
  act(() => root!.render(<UpdateButton update={update('ready')} restarting updated={null} onPress={() => {}} onWhatsNew={() => {}} />));
  expect(button().textContent).toBe('Restarting…');
  expect(button().disabled).toBe(true);
  act(() => root!.render(<UpdateButton update={update('failed')} restarting={false} updated={null} onPress={() => {}} onWhatsNew={() => {}} />));
  expect(button().textContent).toBe('Update failed');
  expect(button().classList.contains('ib-outline')).toBe(true);
});

test.skipIf(!hasDom)('the update dialog: Update now in the first step, the remembered flags, the open sessions', () => {
  let now = 0;
  const el = render(
    <UpdateDialog
      details={details()}
      update={update('available')}
      error={null}
      busy={false}
      onUpdateNow={() => now++}
      onRemindTomorrow={() => {}}
      onCancel={() => {}}
      onWhatsNew={() => {}}
      onAutoUpdate={() => {}}
    />,
  );
  expect(el.textContent).toContain('Update to Plannotator 0.28.12');
  expect(el.textContent).toContain('--skip-gemini');
  expect(el.textContent).toContain('billing-svc · code review');
  act(() => (el.querySelector('[data-update-now]') as HTMLButtonElement).click());
  expect(now).toBe(1);
});

test.skipIf(!hasDom)('the automatic-updates checkbox reports the change; the env locks it', () => {
  const changes: boolean[] = [];
  const el = render(
    <UpdateDialog
      details={details()}
      update={update('available')}
      error={null}
      busy={false}
      onUpdateNow={() => {}}
      onRemindTomorrow={() => {}}
      onCancel={() => {}}
      onWhatsNew={() => {}}
      onAutoUpdate={(next) => changes.push(next)}
    />,
  );
  const box = el.querySelector('[data-auto-update-checkbox]') as HTMLInputElement;
  expect(box.checked).toBe(false);
  act(() => box.click());
  expect(changes).toEqual([true]);
  act(() =>
    root!.render(
      <UpdateDialog
        details={details({ auto_update: { on: true, env: true, supported: true } })}
        update={update('available')}
        error={null}
        busy={false}
        onUpdateNow={() => {}}
        onRemindTomorrow={() => {}}
        onCancel={() => {}}
        onWhatsNew={() => {}}
        onAutoUpdate={(next) => changes.push(next)}
      />,
    ),
  );
  expect((el.querySelector('[data-auto-update-checkbox]') as HTMLInputElement).disabled).toBe(true);
});

test.skipIf(!hasDom)('a binary the install script does not manage: the command, no Update now, no checkbox', () => {
  const el = render(
    <UpdateDialog
      details={details({ update: update('available', 'copy') })}
      update={update('available', 'copy')}
      error={null}
      busy={false}
      onUpdateNow={() => {}}
      onRemindTomorrow={() => {}}
      onCancel={() => {}}
      onWhatsNew={() => {}}
      onAutoUpdate={() => {}}
    />,
  );
  expect(el.querySelector('[data-update-now]')).toBeNull();
  expect(el.querySelector('[data-auto-update-checkbox]')).toBeNull();
  expect(el.textContent).toContain('curl -fsSL https://plannotator.ai/install.sh | bash -s -- --skip-gemini');
});

test.skipIf(!hasDom)('the failure dialog names the exit code and the log, and offers Try Again', () => {
  let retried = 0;
  const el = render(
    <FailedDialog
      update={update('failed')}
      details={details({ failure: { exit_code: 1, log: '/home/u/.plannotator/update.log' } })}
      home="/home/u"
      onRetry={() => retried++}
      onClose={() => {}}
    />,
  );
  expect(el.textContent).toContain('exited with code 1');
  expect(el.textContent).toContain('~/.plannotator/update.log');
  const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Try Again') as HTMLButtonElement;
  act(() => retry.click());
  expect(retried).toBe(1);
});
