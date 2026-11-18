/**
 * The Run and Secret cards as drawn (server markup, no DOM). What regresses: a refused command getting a Run, a
 * Copy or a terminal button; a run that needs a secret losing its inline field; a running command without Stop; a
 * prompt that waits for typing not saying so; a secret's field that a password manager cannot fill, or a saved one
 * showing more than its last 4 characters.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseInboxRunBlocks, parseInboxSecretBlocks } from '@plannotator/core/inbox-run-blocks';
import type { RunStateWire, RunView } from './data/runApi';
import { RunCard } from './parts/RunBlocks/RunCard';
import { SecretCard } from './parts/RunBlocks/SecretCard';

const block = (command: string) => parseInboxRunBlocks([':::run', 'Check the deploy', 'One line of why.', '', '```sh', command, '```', ':::'].join('\n'))[0]!;
const state = (key: string, extra: Partial<RunStateWire['blocks'][string]> = {}, run?: Partial<RunView>): RunStateWire => ({
  computer: 'your Mac',
  store: 'saved in your Keychain',
  blocks: { [key]: { folder: '~/projects/site', folder_missing: false, hidden: null, needs: [], ...extra } },
  runs: run
    ? { [key]: { key, run_id: 'run_1', state: 'running', exit_code: null, signal: null, started_at: '', ended_at: null, duration_ms: 4200, lines: ['building…'], total_lines: 1, partial: '', waiting_for_input: false, needs_terminal: false, error: null, ...run } }
    : {},
  secrets: [],
});
const draw = (command: string, extra?: Partial<RunStateWire['blocks'][string]>, run?: Partial<RunView>) => {
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
    const command = 'echo safe‮ txt.sh';
    const hidden = { what: 'a text-direction mark', code: 'U+202E', line: 1, column: 10, words: 'This command has a text-direction mark (U+202E) at line 1, character 10.' };
    const html = draw(command, { hidden });
    expect(html).toContain('data-run-state="refused"');
    expect(html).not.toContain('data-run-start');
    expect(html).not.toContain('data-run-copy');
    expect(html).not.toContain('data-run-terminal');
    expect(html).toContain('⟨U+202E⟩');
    expect(html).toContain('Ask Claude to send it again without it.');
  });

  test('a secret it needs: the field inline, a password field a manager can fill', () => {
    const html = draw('curl -H "Bearer $API_TOKEN" x', { needs: ['API_TOKEN'] });
    expect(html).toContain('data-run-needs="API_TOKEN"');
    expect(html).toContain('type="password"');
    expect(html).toMatch(/autocomplete="current-password"/i);
  });

  test('running: its output and Stop, no Run', () => {
    const html = draw('bun run build', {}, { state: 'running' });
    expect(html).toContain('Running · 4 s');
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

  test('saved: when, the last 4 at most, Replace and Remove, no field', () => {
    const saved = { ...state('r-x'), secrets: [{ name: 'API_TOKEN', saved_at: '2026-11-18T10:00:00.000Z', last4: '_123', store: 'keychain' }] };
    const html = renderToStaticMarkup(<SecretCard messageId="msg_1" secret={secret} state={saved} agent="Claude" />);
    expect(html).toContain('data-secret-state="saved"');
    expect(html).toContain('ends in _123');
    expect(html).toContain('data-secret-replace=""');
    expect(html).toContain('data-secret-remove=""');
    expect(html).not.toContain('type="password"');
  });
});
