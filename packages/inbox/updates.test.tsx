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
import { UPDATE_EXIT_CHECKSUM_MISMATCH, UPDATE_EXIT_DOWNLOAD_FAILED } from '@plannotator/core/update-exit-codes';

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
  // A deliberate action label (approval inbox-whats-new-header): the sidebar's Update names its version,
  // and its accessible name contains those visible words (WCAG 2.5.3 Label in Name).
  expect(button.textContent).toBe('Update to 0.28.12');
  expect(button.getAttribute('aria-label')).toBe('Update to 0.28.12');
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
  act(() => root!.render(<UpdateButton update={update('ready')} restarting={false} updated={null} onPress={() => {}} onWhatsNew={() => {}} />));
  expect(button().textContent).toBe('Update to 0.28.12');
  expect(button().getAttribute('aria-label')).toBe('Update to 0.28.12');
  expect(button().disabled).toBe(false);
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

// Safe updates (step 1): after a mismatch (install.sh's pin check), or a
// download refused for a revoked certificate (a blocked key), the dialog must
// not hand the person the `curl | bash` line: it would go through the same
// connection, and curl trusts it.
for (const [name, failure, heading] of [
  ['exit 113', { exit_code: UPDATE_EXIT_CHECKSUM_MISMATCH }, 'The update stopped'],
  ['exit 75, a revoked certificate', { exit_code: UPDATE_EXIT_DOWNLOAD_FAILED, tls: 'revoked' as const }, "The update didn't install"],
] as const) {
  test.skipIf(!hasDom)(`${name}: no install-script line, the old version still works, Try Again stays`, () => {
    let retried = 0;
    const el = render(
      <FailedDialog
        update={update('failed')}
        details={details({ failure: { ...failure, log: '/home/u/.plannotator/update.log' } })}
        home="/home/u"
        onRetry={() => retried++}
        onClose={() => {}}
      />,
    );
    expect(el.querySelector('h2')?.textContent).toBe(heading);
    expect(el.textContent).not.toContain('curl -fsSL');
    expect(el.querySelector('[data-failed-release]')).toBeNull();
    expect(el.textContent).not.toContain('Or run the install script yourself');
    expect(el.textContent).not.toContain('exited with code');
    expect(el.textContent).toContain('Plannotator 0.28.10 still works');
    expect(el.textContent).toContain('~/.plannotator/update.log');
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Try Again') as HTMLButtonElement;
    act(() => retry.click());
    expect(retried).toBe(1);
  });
}

// A failed download can be lasting (a proxy, a network that inspects HTTPS):
// the dialog keeps a way out, and on an untrusted certificate says how to add
// the network's own.
for (const tls of [undefined, 'untrusted'] as const) {
  test.skipIf(!hasDom)(`exit 75${tls ? `, an ${tls} certificate` : ''}: the old version still works, and the way out is shown`, () => {
    const el = render(
      <FailedDialog
        update={update('failed')}
        details={details({ failure: { exit_code: UPDATE_EXIT_DOWNLOAD_FAILED, log: '/home/u/.plannotator/update.log', ...(tls && { tls }) } })}
        home="/home/u"
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );
    expect(el.textContent).toContain('Plannotator 0.28.10 still works');
    expect(el.textContent).toContain('If this keeps happening, install it yourself');
    expect(el.textContent).toContain('curl -fsSL https://plannotator.ai/install.sh | bash -s -- --skip-gemini');
    expect(el.querySelector('[data-failed-release]')?.getAttribute('href')).toBe('https://github.com/backnotprop/plannotator/releases/tag/v0.28.12');
    expect(el.textContent.includes('NODE_EXTRA_CA_CERTS=/path/to/its-root.pem plannotator update')).toBe(tls === 'untrusted');
  });
}

// macOS (the server sets release_first for an untrusted certificate there):
// the release page comes before the `curl | bash` line, since macOS curl
// still trusts emSign G3.
test.skipIf(!hasDom)('exit 75, untrusted on macOS: the release page comes before the install command', () => {
  const el = render(
    <FailedDialog
      update={update('failed')}
      details={details({ failure: { exit_code: UPDATE_EXIT_DOWNLOAD_FAILED, log: '/home/u/.plannotator/update.log', tls: 'untrusted', release_first: true } })}
      home="/home/u"
      onRetry={() => {}}
      onClose={() => {}}
    />,
  );
  const text = el.textContent ?? '';
  expect(text.indexOf('the release page')).toBeGreaterThan(-1);
  expect(text.indexOf('curl -fsSL')).toBeGreaterThan(text.indexOf('the release page'));
  expect(el.querySelector('[data-failed-release]')?.getAttribute('href')).toBe('https://github.com/backnotprop/plannotator/releases/tag/v0.28.12');
});

test.skipIf(!hasDom)('exit 75 that could not stage the update: the plain reason, no download wording, no install command', () => {
  const el = render(
    <FailedDialog
      update={update('failed')}
      details={details({ failure: { exit_code: UPDATE_EXIT_DOWNLOAD_FAILED, log: '/home/u/.plannotator/update.log', prepare: 'the temp folder /tmp is full (ENOSPC)' } })}
      home="/home/u"
      onRetry={() => {}}
      onClose={() => {}}
    />,
  );
  const text = el.textContent ?? '';
  expect(text).toContain("Plannotator couldn't prepare the update: the temp folder /tmp is full (ENOSPC).");
  expect(text).toContain('Plannotator 0.28.10 still works');
  expect(text).toContain('Free some space there, then try again.');
  expect(text).toContain('TMPDIR=/another/folder plannotator update');
  expect(text).not.toContain("couldn't download");
  expect(text).not.toContain('curl -fsSL');
  expect(el.querySelector('[data-failed-release]')).toBeNull();
});

// Freeing space does not fix permissions or a missing folder: the advice follows the cause.
for (const [prepare, advice] of [
  ["the temp folder /tmp can't be written (EACCES)", 'Make it writable, then try again.'],
  ['the temp folder /tmp does not exist (ENOENT)', 'Create it, then try again.'],
  ['could not write to the temp folder /tmp (boom)', 'Check that folder, then try again.'],
] as const) {
  test.skipIf(!hasDom)(`exit 75 that could not stage the update (${prepare}): advice for that cause, and another temp folder`, () => {
    const el = render(
      <FailedDialog
        update={update('failed')}
        details={details({ failure: { exit_code: UPDATE_EXIT_DOWNLOAD_FAILED, log: '/home/u/.plannotator/update.log', prepare } })}
        home="/home/u"
        onRetry={() => {}}
        onClose={() => {}}
      />,
    );
    const text = el.textContent ?? '';
    expect(text).toContain(`Plannotator couldn't prepare the update: ${prepare}.`);
    expect(text).toContain(advice);
    expect(text).not.toContain('Free some space');
    expect(text).toContain('TMPDIR=/another/folder plannotator update');
    expect(text).not.toContain('curl -fsSL');
  });
}

test.skipIf(!hasDom)('any other failure still offers the install script to run by hand', () => {
  const el = render(
    <FailedDialog
      update={update('failed')}
      details={details({ failure: { exit_code: 1, log: '/home/u/.plannotator/update.log' } })}
      home="/home/u"
      onRetry={() => {}}
      onClose={() => {}}
    />,
  );
  expect(el.textContent).toContain('curl -fsSL https://plannotator.ai/install.sh | bash -s -- --skip-gemini');
});
