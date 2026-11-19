/**
 * The Run and Secret cards as drawn (server markup, no DOM). What regresses: a refused command getting a Run, a
 * Copy or a terminal button (also before the computer has answered); a run that needs a secret losing its inline
 * field; a run not showing which secrets it gets; a running command without Stop; a prompt that waits for typing not
 * saying so; a run the Inbox lost reading as never run; a secret's field the browser offers to save as a password;
 * a saved one showing any part of its value; a name programs start from getting a field; Run offered while a secret
 * it needs is not saved; the same secret's field drawn on every card that needs it; a hint saying the agent got an
 * exit code when there was none; a lost run that still runs with no Stop; a Uses word dropped without a word.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseInboxRunBlocks, parseInboxSecretBlocks } from '@plannotator/core/inbox-run-blocks';
import type { RunBlockView, RunStateWire, RunView } from './data/runApi';
import { RunCard } from './parts/RunBlocks/RunCard';
import { SecretCard } from './parts/RunBlocks/SecretCard';

const block = (command: string, extraLines: string[] = []) => parseInboxRunBlocks([':::run', 'Check the deploy', 'One line of why.', ...extraLines, '', '```sh', command, '```', ':::'].join('\n'))[0]!;
const blockView = (extra: Partial<RunBlockView> = {}): RunBlockView => ({ folder: '~/projects/site', folder_missing: false, hidden: null, uses: [], needs: [], fields: extra.needs ?? [], lookalike: null, shell_note: null, ...extra });
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
  left_running: null,
  ...run,
});
const state = (key: string, extra: Partial<RunBlockView> = {}, run?: Partial<RunView>): RunStateWire => ({
  computer: 'your Mac',
  store: 'in your Keychain',
  kept: "Saved to your Mac's Keychain.",
  shell: 'zsh',
  blocks: { [key]: blockView(extra) },
  runs: run ? { [key]: runView(key, run) } : {},
  secrets: [],
});
/** The words under a secret field (data-secret-kept), as text. */
const keptLine = (html: string) => /<p[^>]*data-secret-kept=""[^>]*>([^<]*)<\/p>/.exec(html)?.[1]?.replace(/&#x27;/g, "'") ?? null;
const draw = (command: string, extra?: Partial<RunBlockView>, run?: Partial<RunView>, extraLines: string[] = []) => {
  const b = block(command, extraLines);
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
    expect(html).toContain('data-run-card-stop=""');
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
    // Where it is kept and that the agent never sees it: the store and the agent by name.
    expect(keptLine(html)).toContain("your Mac's Keychain");
    expect(keptLine(html)).toContain('Claude');
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

describe('the review\'s second round', () => {
  test('a needed secret not saved: Run waits (not pressable), the reason is the "Needs" line', () => {
    const html = draw('curl -H "Bearer $API_TOKEN" x', { uses: ['API_TOKEN'], needs: ['API_TOKEN'] });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*data-run-start=""/);
    expect(html).toContain('Needs API_TOKEN');
    expect(html).toContain('Save and run');
    // What Save does, under the field itself, naming the store the saved line names after.
    expect(keptLine(html)).toContain("your Mac's Keychain");
    expect(keptLine(html)).toContain('Claude');
  });

  test('seen from a phone, the field says the computer by name and its store', () => {
    const b = block('curl -H "Bearer $API_TOKEN" x');
    const named = { ...state(b.key, { uses: ['API_TOKEN'], needs: ['API_TOKEN'] }), computer: 'Studio Mac', store: 'in its Keychain', kept: "Saved to Studio Mac's Keychain." };
    const line = keptLine(renderToStaticMarkup(<RunCard messageId="msg_1" block={b} state={named} agent="Codex" />));
    expect(line).toContain("Studio Mac's Keychain");
    expect(line).toContain('Codex');
    // A linked machine on an older Inbox sends no `kept`: the line still says where, from its store words.
    const { kept: _kept, ...older } = named;
    expect(keptLine(renderToStaticMarkup(<RunCard messageId="msg_1" block={b} state={older} agent="Codex" />))).toContain('in its Keychain');
  });

  test('one field per secret: a card whose field is elsewhere says Needs and offers to go there', () => {
    const html = draw('curl -H "Bearer $API_TOKEN" x', { uses: ['API_TOKEN'], needs: ['API_TOKEN'], fields: [] });
    expect(html).toContain('Needs API_TOKEN');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('data-run-needs-go=""');
    // Its field is on no page drawn here: the button says so rather than "above" (the DOM test proves above and below).
    expect(html).toContain('Save it in its card');
  });

  test('each way a run ends says what the agent truly got', () => {
    const hint = (run: Partial<RunView>) => /data-run-hint="">([^<]*)</.exec(draw('bun test', {}, run))![1]!.replace(/&#x27;/g, "'");
    expect(hint({ state: 'done', exit_code: 0 })).toBe('Claude got the exit code and the last lines of output.');
    expect(hint({ state: 'stopped', interrupted: 'closed', lines: ['a'], total_lines: 1 })).toBe('Claude was told the Inbox closed while it ran, with the last lines of output.');
    expect(hint({ state: 'stopped', lines: [], total_lines: 0 })).toBe('Claude was told you stopped it.');
    expect(hint({ state: 'failed', error: "Couldn't read A", lines: [], total_lines: 0 })).toBe("Claude was told why it couldn't start.");
    expect(hint({ state: 'stopped', interrupted: 'lost', left_running: false, lines: [], total_lines: 0 })).toBe('It ended while the Inbox was away. Claude was told the Inbox stopped while it ran.');
    expect(hint({ state: 'stopped', interrupted: 'lost', left_running: false, signal: 'SIGTERM', lines: [], total_lines: 0 })).toBe('You stopped it. Claude was told the Inbox stopped while it ran.');
    expect(hint({ state: 'stopped', interrupted: 'lost', left_running: null, lines: [], total_lines: 0 })).toBe('It may still be running on your Mac. Claude was told the Inbox stopped while it ran.');
  });

  test('a lost run that still runs: the card says so, keeps its output, and offers Stop', () => {
    const html = draw('bun test', {}, { state: 'stopped', interrupted: 'lost', left_running: true, lines: ['QA started'], total_lines: 1 });
    expect(html).toContain('It is still running on your Mac: Stop ends it.');
    expect(html).toContain('QA started');
    expect(html).toContain('data-run-card-stop=""');
    expect(html).not.toContain('data-run-start');
  });

  test('a lost run the person stopped here reads "Stopped", not that the Inbox stopped while it ran', () => {
    const html = draw('bun test', {}, { state: 'stopped', interrupted: 'lost', left_running: false, signal: 'SIGTERM', lines: [], total_lines: 0 });
    expect(html).not.toContain('The Inbox stopped while this ran');
    expect(html).toMatch(/>Stopped</);
    expect(html).toContain('You stopped it.');
  });

  test('a Uses word it cannot use is said on the card', () => {
    const html = draw('bun test', {}, undefined, ['Uses: PAY_KEY; LD_PRELOAD']);
    expect(html).toContain('data-run-unusable=""');
    expect(html).toContain('LD_PRELOAD can&#x27;t hold a secret');
  });

  test('a long command scrolls inside its box (all of it stays reachable by keyboard)', () => {
    const html = draw(Array.from({ length: 80 }, (_, i) => `echo ${i}`).join('\n'));
    expect(html).toMatch(/<pre class="ib-rb-cmd"[^>]*tabindex="0"/);
    const css = readFileSync(join(import.meta.dir, 'parts/RunBlocks/runBlocks.css'), 'utf8');
    expect(css).toMatch(/\.ib-rb-cmd \{[^}]*max-height: [^;]+;[^}]*overflow: auto;/);
  });

  test("a name the person's shell already sets: no field, no wait; the card says the run uses theirs", () => {
    const html = draw('curl -H "Bearer $OPENAI_API_KEY" x', { uses: ['OPENAI_API_KEY'], from_shell: ['OPENAI_API_KEY'], needs: [] });
    expect(html).toContain('Uses OPENAI_API_KEY from your shell');
    expect(html).not.toContain('type="password"');
    expect(html).not.toMatch(/aria-disabled="true"[^>]*data-run-start/);
  });
});
