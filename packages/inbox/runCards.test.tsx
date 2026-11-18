/**
 * The Run and Secret cards as drawn (server markup, no DOM). What regresses: a refused command getting a Run, a
 * Copy or a terminal button (also before the computer has answered); a run that needs a secret losing its inline
 * field; a run not showing which secrets it gets; a running command without Stop; a prompt that waits for typing not
 * saying so; a run the Inbox lost reading as never run; a secret's field the browser offers to save as a password;
 * a saved one showing any part of its value; a name programs start from getting a field.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseInboxRunBlocks, parseInboxSecretBlocks } from '@plannotator/core/inbox-run-blocks';
import type { RunBlockView, RunStateWire, RunView } from './data/runApi';
import { RunCard } from './parts/RunBlocks/RunCard';
import { SecretCard } from './parts/RunBlocks/SecretCard';

const block = (command: string, extraLines: string[] = []) => parseInboxRunBlocks([':::run', 'Check the deploy', 'One line of why.', ...extraLines, '', '```sh', command, '```', ':::'].join('\n'))[0]!;
const blockView = (extra: Partial<RunBlockView> = {}): RunBlockView => ({ folder: '~/projects/site', folder_missing: false, hidden: null, uses: [], needs: [], lookalike: null, shell_note: null, ...extra });
const runView = (key: string, run: Partial<RunView>): RunView => ({
  key,
  run_id: 'run_1',
  state: 'running',
  exit_code: null,
  signal: null,
  started_at: '',
  ended_at: null,
  duration_ms: 4200,
  lines: ['building…'],
  total_lines: 1,
  partial: '',
  waiting_for_input: false,
  needs_terminal: false,
  error: null,
  interrupted: null,
  ...run,
});
const state = (key: string, extra: Partial<RunBlockView> = {}, run?: Partial<RunView>): RunStateWire => ({
  computer: 'your Mac',
  store: 'saved in your Keychain',
  shell: 'zsh',
  blocks: { [key]: blockView(extra) },
  runs: run ? { [key]: runView(key, run) } : {},
  secrets: [],
});
const draw = (command: string, extra?: Partial<RunBlockView>, run?: Partial<RunView>) => {
  const b = block(command);
  return renderToStaticMarkup(<RunCard messageId="msg_1" block={b} state={state(b.key, extra, run)} agent="Claude" />);
};

describe('the run card', () => {
  test('idle: the command, where it runs, Run and Open in terminal', () => {
    const html = draw('bun run deploy:check');
    expect(html).toContain('bun run deploy:check');
    expect(html).toContain('On your Mac · in ~/projects/site');
    expect(html).toContain('data-run-start=""');
    expect(html).toContain('data-run-terminal=""');
    expect(html).toContain('data-run-copy=""');
  });

  test('a hidden character: no Run, no Copy, no terminal; the character shown and why', () => {
    const html = draw('echo safe‮ txt.sh');
    expect(html).toContain('data-run-state="refused"');
    expect(html).not.toContain('data-run-start');
    expect(html).not.toContain('data-run-copy');
    expect(html).not.toContain('data-run-terminal');
    expect(html).toContain('⟨U+202E⟩');
    expect(html).toContain('Ask Claude to send it again without it.');
  });

  test('a hidden character before the computer answered (or when it never does): still no Copy', () => {
    const b = block('rm -rf ./build​ /');
    const html = renderToStaticMarkup(<RunCard messageId="msg_1" block={b} state={null} agent="Claude" />);
    expect(html).toContain('data-run-state="refused"');
    expect(html).not.toContain('data-run-copy');
    expect(html).toContain('a zero-width space (U+200B)');
  });

  test('a hidden character in its folder: refused, the folder shown with it', () => {
    const b = block('ls', ['Folder: apps‮/x']);
    const html = renderToStaticMarkup(<RunCard messageId="msg_1" block={b} state={null} agent="Claude" />);
    expect(html).toContain('data-run-state="refused"');
    expect(html).toContain('Its folder has a text-direction mark');
    expect(html).toContain('Folder: apps⟨U+202E⟩/x');
  });

  test('the secrets it gets: a quiet "Uses" line for the saved, a field for the not yet saved', () => {
    const html = draw('STRIPE_KEY="$PAYMENTS_TEST_KEY" bun test', { uses: ['PAYMENTS_TEST_KEY', 'WEBHOOK_SECRET'], needs: ['WEBHOOK_SECRET'] });
    expect(html).toContain('Uses PAYMENTS_TEST_KEY');
    expect(html).not.toContain('Uses PAYMENTS_TEST_KEY, WEBHOOK_SECRET');
    expect(html).toContain('data-run-needs="WEBHOOK_SECRET"');
    expect(html).toContain('Needs WEBHOOK_SECRET');
  });

  test('a secret it needs: a password field, not one the browser saves as a sign-in', () => {
    const html = draw('curl -H "Bearer $API_TOKEN" x', { uses: ['API_TOKEN'], needs: ['API_TOKEN'] });
    expect(html).toContain('data-run-needs="API_TOKEN"');
    expect(html).toContain('type="password"');
    expect(html).toMatch(/autocomplete="off"/i);
    expect(html).not.toContain('<form');
    expect(html).not.toMatch(/<input[^>]*\sname=/);
  });

  test("a secret it couldn't read: said, with Run again", () => {
    const html = draw('echo "$API_TOKEN"', { uses: ['API_TOKEN'] }, { state: 'failed', error: "Couldn't read API_TOKEN from your Keychain. Unlock it if it asks, then run again", lines: [], total_lines: 0 });
    expect(html).toContain("Couldn&#x27;t start");
    expect(html).toContain("Couldn&#x27;t read API_TOKEN from your Keychain");
    expect(html).toContain('Claude was told why it couldn&#x27;t start.');
    expect(html).not.toContain('got the exit code');
    expect(html).toContain('Run again');
  });

  test('look-alike letters and a shell that may not read it: each said in a quiet line', () => {
    const html = draw('echo ok', { lookalike: 'This command has Cyrillic letters, which can look like Latin ones. Check it before you run it.', shell_note: 'This is written for a Unix shell…' });
    expect(html).toContain('data-run-lookalike=""');
    expect(html).toContain('data-run-shell-note=""');
    expect(html).toContain('data-run-start=""');
  });

  test('running: its output and Stop, no Run; the state heard by a screen reader, not each second', () => {
    const html = draw('bun run build', {}, { state: 'running' });
    expect(html).toContain('Running · 4 s');
    expect(html).toMatch(/aria-live="polite"[^>]*>Running</);
    expect(html).toContain('data-run-stop=""');
    expect(html).not.toContain('data-run-start');
    expect(html).toContain('building…');
  });

  test('waiting for typing: said plainly, Open in terminal first', () => {
    const html = draw('npx something', {}, { waiting_for_input: true, partial: 'Ok to proceed? (y) ' });
    expect(html).toContain('waiting for you to type something');
    expect(html).toMatch(/class="ib-btn ib-pri"[^>]*data-run-terminal/);
  });

  test('done and failed: how it ended, that the agent got it, Run again', () => {
    const done = draw('bun test', {}, { state: 'done', exit_code: 0, duration_ms: 12_400 });
    expect(done).toContain('Done · exit code 0 · 12 s');
    expect(done).toContain('Claude got the exit code and the last lines of output.');
    expect(done).toContain('Run again');
    const failed = draw('bun test', {}, { state: 'failed', exit_code: 1, duration_ms: 3_200, lines: Array.from({ length: 500 }, (_, i) => `l${i}`), total_lines: 1234 });
    expect(failed).toContain('Failed · exit code 1 · 3.2 s');
    expect(failed).toContain('Showing the last 500 of 1,234 lines');
  });

  test('the Inbox stopped while it ran: the card says so (not idle), and that the agent was told', () => {
    const lost = draw('bun test', {}, { state: 'stopped', interrupted: 'lost', lines: [] });
    expect(lost).toContain('data-run-state="stopped"');
    expect(lost).toContain('The Inbox stopped while this ran');
    expect(lost).toContain('Claude was told the Inbox stopped while it ran.');
    expect(lost).toContain('Run again');
    const closed = draw('bun test', {}, { state: 'stopped', interrupted: 'closed', duration_ms: 5_000 });
    expect(closed).toContain('Stopped: the Inbox closed after 5.0 s');
  });
});

describe('the secret card', () => {
  const secret = parseInboxSecretBlocks([':::secret', 'API_TOKEN', 'The deploy check needs it.', 'Where: https://example.com/tokens', ':::'].join('\n'))[0]!;
  test('empty: the field, where to find it, where it is kept', () => {
    const html = renderToStaticMarkup(<SecretCard messageId="msg_1" secret={secret} state={state('r-x')} agent="Claude" />);
    expect(html).toContain('data-secret-state="empty"');
    expect(html).toContain('type="password"');
    expect(html).toContain('Find it on example.com');
    expect(html).toContain('Stays on your Mac, saved in your Keychain. Claude gets only the name.');
  });

  test('saved: when and where, Replace and Remove, no field and no part of the value', () => {
    const saved = { ...state('r-x'), secrets: [{ name: 'API_TOKEN', saved_at: '2026-11-18T10:00:00.000Z', store: 'keychain' }] };
    const html = renderToStaticMarkup(<SecretCard messageId="msg_1" secret={secret} state={saved} agent="Claude" />);
    expect(html).toContain('data-secret-state="saved"');
    expect(html).not.toContain('ends in');
    expect(html).toContain('data-secret-replace=""');
    expect(html).toContain('data-secret-remove=""');
    expect(html).not.toContain('type="password"');
  });

  test('a name programs start from: no field, and why, in plain words', () => {
    const refused = parseInboxSecretBlocks([':::secret', 'NODE_OPTIONS', 'Paste your loader path.', ':::'].join('\n'))[0]!;
    const html = renderToStaticMarkup(<SecretCard messageId="msg_1" secret={refused} state={state('r-x')} agent="Claude" />);
    expect(html).toContain('data-secret-state="refused"');
    expect(html).not.toContain('type="password"');
    expect(html).toContain("NODE_OPTIONS can&#x27;t hold a secret");
    expect(html).toContain('Ask Claude for another name.');
  });
});
