/**
 * Skill references in the Inbox's composers (approval "inbox-skill-references",
 * Option B as amended, the Quiet look), as the window draws them: the whole
 * window (InboxApp) over a REAL Inbox server in a temp data dir (its own
 * process, tests/helpers/inbox-dom-server.ts), with two global skills written
 * under the test's own HOME. What is proved:
 *
 * - the reply box: `/` opens Plannotator's picker, a query filters it, an
 *   arrowed row inserts on Enter, Escape closes the menu before the box, a
 *   human-only skill is underlined and says its instructions go with the
 *   reply; the Send pastes its SKILL.md and names its folder at the end of
 *   the stored reply, and the thread folds that block into one quiet line (the box icon and the
 *   names as a comma list), kept after the agent answers;
 * - a comment on an attached file: its reference rides the same one block
 *   (the per-comment list is off in the Inbox);
 * - New message: a clicked row inserts, and the session's wake carries the
 *   block ("this message");
 * - compose (a message the person starts): the picker at the caret, portaled
 *   into the dialog out of the scrolling body, Escape (even on a bare `/`)
 *   closing the picker before the dialog, the block on the Send, and the new
 *   thread folding it behind "Skills:";
 * - an agent's message is never folded, whatever it says.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const READBACK_BODY = '# Readback\n\nState what I am asking for, in clear words, so I can confirm.\n';

type World = { project: string; stopped: string; waiting: string; filed: string; attachment: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', stopped: '', waiting: '', filed: '', attachment: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;

function loopback(path: string, method = 'GET', body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

type Message = { id: string; body: string; author: { kind: string } };
const threadOf = async (id: string) =>
  JSON.parse((await loopback(`/api/inbox/threads/${id}`)).text) as { thread: { project: { root: string }; messages: Message[] } };

/** The person's reply once the server has stored it: the box closes before the Send lands, so wait on the server. */
async function personReply(id: string): Promise<Message> {
  for (let i = 0; i < 300; i++) {
    const found = (await threadOf(id)).thread.messages.find((m) => m.author.kind === 'person');
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the reply never reached the server');
}

/** A Claude Code session's bridge poll: live in the project now, and what it would be woken with. */
async function poll(session: string, projectPath: string): Promise<{ commands: { body: string; type?: string }[] }> {
  const { token } = JSON.parse(readFileSync(join(dir!, 'data', 'inbox', 'inbox.json'), 'utf8')) as { token: string };
  const answer = await loopback(
    '/api/inbox/bridge/poll',
    'POST',
    JSON.stringify({ session, host: 'claude-code', project_path: projectPath, started_at: new Date().toISOString(), busy: false, waitMs: 0 }),
    { Authorization: `Bearer ${token}` },
  );
  return JSON.parse(answer.text);
}

async function readLine(): Promise<string> {
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await childOut!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

const TESTS = 7;
/** One test's budget: a slow runner must not time a test out, because Bun then kills the shared Inbox process and every later test cascades. */
const SLOW = 30_000;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-skills-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  // Two global skills under this test's HOME: one an agent invokes itself, one only a person can.
  const skills = join(dir, '.claude', 'skills');
  mkdirSync(join(skills, 'write-better'), { recursive: true });
  writeFileSync(join(skills, 'write-better', 'SKILL.md'), '---\nname: write-better\ndescription: Improve prose.\n---\n\n# Write better\n');
  mkdirSync(join(skills, 'readback'), { recursive: true });
  writeFileSync(join(skills, 'readback', 'SKILL.md'), `---\nname: readback\ndescription: State the request back.\ndisable-model-invocation: true\n---\n\n${READBACK_BODY}`);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await readLine()) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  world = worlds.shift()!;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('[data-message-id]') !== null, 'the thread');
  return host!;
}

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}"`);
  return found as HTMLButtonElement;
}

const textarea = (el: ParentNode) => el.querySelector('textarea.ib-rtext') as HTMLTextAreaElement;

/** Type as a person does: the value, the caret at its end, then the keyup React's select plugin reads. */
async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

async function press(el: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

/** The quiet skills line (approval "inbox-skills-line", option B): the names as a comma list, nothing to open, no size. */
function expectQuietSkillsLine(line: HTMLElement, names: string[]) {
  expect(line.tagName).not.toBe('DETAILS');
  expect(line.querySelector('summary, [data-skills-block]')).toBeNull();
  expect([...line.querySelectorAll('[data-skill-name]')].map((n) => n.textContent)).toEqual(names);
  expect(line.textContent!.replace(/^Skills:\s*/, '').trim()).toBe(names.join(', '));
  expect(line.textContent).not.toMatch(/\bKB\b|instructions went|Show|Hide/);
}

const menu = () => document.querySelector('[data-skill-menu]');
const rows = () => [...document.querySelectorAll('[data-skill-item]')].map((r) => r.getAttribute('data-skill-item'));

test.skipIf(!hasDom)('the reply box: the picker, the underline and its line, Escape; the Send pastes SKILL.md and the thread folds it', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  act(() => button(el, 'Reply').click());
  await until(() => textarea(el) !== null, 'the reply box');
  const box = textarea(el);

  // A bare `/` at the start of a word opens the whole catalog, nothing active.
  await type(box, '/');
  await until(() => menu() !== null, 'the picker');
  expect(rows()).toEqual(['readback', 'write-better']);
  expect(document.querySelector('[data-skill-item-active]')).toBeNull();
  // Not at the start of a word: no menu (`and/or`).
  await type(box, 'and/');
  expect(menu()).toBeNull();

  // A query filters; Escape after typing it closes the menu, not the box.
  await type(box, 'Please /re');
  await until(() => rows().join() === 'readback', 'the filtered picker');
  await press(box, 'Escape');
  expect(menu()).toBeNull();
  expect(textarea(el)).not.toBeNull();

  // Arrowed onto, Enter inserts it.
  await type(box, 'Please run /rea');
  await until(() => menu() !== null, 'the picker again');
  await press(box, 'ArrowDown');
  expect(document.querySelector('[data-skill-item-active]')?.getAttribute('data-skill-item')).toBe('readback');
  const enter = await press(box, 'Enter');
  expect(enter.defaultPrevented).toBe(true);
  expect(textarea(el).value).toBe('Please run /readback ');
  expect(menu()).toBeNull();

  // The reference is painted and underlined as human-only; the quiet line says where its instructions go.
  await type(textarea(el), 'Please run /readback first, then tighten with $write-better.');
  await until(() => el.querySelector('[data-skill-ref-token="readback"]') !== null, 'the painted token');
  expect(el.querySelector('[data-skill-ref-token="readback"]')?.getAttribute('data-skill-ref-human-only')).toBe('true');
  expect(el.querySelector('[data-skill-ref-token="write-better"]')?.getAttribute('data-skill-ref-human-only')).toBeNull();
  const notice = el.querySelector('[data-skill-human-only-notice]')!;
  expect(notice.textContent).toContain('Includes skill instructions');
  expect(notice.textContent).toContain('readback cannot be invoked by a model, so its instructions will be included with your reply.');

  act(() => button(el, 'Send').click());
  await until(() => textarea(el) === null, 'the Send');

  // What the agent reads: the words, the still-open line, then the block with the SKILL.md and its folder.
  const reply = await personReply(world.waiting);
  const skillDir = join(dir!, '.claude', 'skills', 'readback');
  expect(reply.body.startsWith('Please run /readback first, then tighten with $write-better.\n\n')).toBe(true);
  expect(reply.body).toContain(
    [
      '**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):',
      '- `readback` (cannot be invoked by a model; its instructions are included below at the person\'s request)',
      '- `write-better`',
      '',
      '--- BEGIN SKILL INSTRUCTIONS: readback ---',
    ].join('\n'),
  );
  expect(reply.body).toContain(`Skill directory: ${skillDir}`);
  expect(reply.body).toContain('State what I am asking for, in clear words, so I can confirm.');
  expect(reply.body.endsWith('--- END SKILL INSTRUCTIONS: readback ---')).toBe(true);

  // The window: the words read whole, the block folded behind one quiet line.
  await until(() => el.querySelector(`[data-message-id="${reply.id}"] [data-skills-line]`) !== null, 'the Skills line');
  const message = el.querySelector(`[data-message-id="${reply.id}"]`)!;
  const line = message.querySelector('[data-skills-line]') as HTMLElement;
  expectQuietSkillsLine(line, ['readback', 'write-better']);
  const viewerText = message.textContent!.replace(line.textContent!, '');
  expect(viewerText).toContain('Please run /readback first');
  expect(viewerText).not.toContain('State what I am asking for');
  expect(viewerText).not.toContain('Skills referenced');
  // The sent words paint the references the block names, as the composer did (never inside the folded block).
  const { skillReferenceRanges } = await import('./skillHighlight');
  const { splitInboxSkillsBlock } = await import('@plannotator/core/skill-reference-block');
  const ranges = skillReferenceRanges(message, splitInboxSkillsBlock(reply.body)!.skills);
  expect(ranges.human.map((r) => r.toString())).toEqual(['/readback']);
  expect(ranges.plain.map((r) => r.toString())).toEqual(['$write-better']);
}, SLOW);

test.skipIf(!hasDom)('Mod+Enter still sends with the picker open; a bare trigger leaves Enter a newline', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  act(() => button(el, 'Reply').click());
  await until(() => textarea(el) !== null, 'the reply box');
  await type(textarea(el), 'It costs $');
  await until(() => menu() !== null, 'the picker');
  const enter = await press(textarea(el), 'Enter');
  expect(enter.defaultPrevented).toBe(false);
  await press(textarea(el), 'Enter', { metaKey: true });
  await until(() => textarea(el) === null, 'the Send');
  const reply = await personReply(world.waiting);
  // No skill referenced: no block.
  expect(reply.body).not.toContain('Skills referenced');
  expect(el.querySelector('[data-skills-line]')).toBeNull();
}, SLOW);

// Moved from the in-thread New message box (off since approval "inbox-acknowledge") to compose, which shares the field.
test.skipIf(!hasDom)('compose: a clicked $ row inserts; the session is woken with the block, "this message"', async () => {
  const projectRoot = (await threadOf(world.stopped)).thread.project.root;
  await poll('ses_live', projectRoot);
  const el = await renderApp(`#thread=${world.stopped}`);
  act(() => (el.querySelector('[data-open-compose]') as HTMLButtonElement).click());
  const dialog = () => document.querySelector('dialog[data-compose]');
  await until(() => !!dialog()?.querySelector('.ib-cp-tobtn:not([data-loading])'), 'compose');
  act(() => (dialog()!.querySelector('.ib-cp-tobtn') as HTMLButtonElement).click());
  await until(() => dialog()!.querySelector('[data-compose-session="ses_live"]') !== null, 'the To picker');
  act(() => (dialog()!.querySelector('[data-compose-session="ses_live"]') as HTMLElement).click());
  const field = () => dialog()!.querySelector('[data-compose-text] textarea.ib-rtext') as HTMLTextAreaElement;
  await type(field(), 'Before you post, ');
  await type(field(), 'Before you post, $w');
  await until(() => rows().join() === 'write-better', 'the picker');
  await act(async () => {
    document.querySelector('[data-skill-item="write-better"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  expect(field().value).toBe('Before you post, $write-better ');
  await type(field(), 'Before you post, $write-better and /readback it.');
  await until(() => dialog()!.querySelector('[data-skill-human-only-notice]') !== null, 'the human-only line');
  expect(dialog()!.querySelector('[data-skill-human-only-notice]')!.textContent).toContain('included with your message');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'the Send');

  const woken = await poll('ses_live', projectRoot);
  const command = woken.commands.find((c) => c.body.includes('Before you post'))!;
  expect(command.body.startsWith('Before you post, $write-better and /readback it.\n\n**Skills referenced** (the person is asking you to invoke these skills when acting on this message):')).toBe(true);
  expect(command.body).toContain('Follow them when acting on this message.');
  expect(command.body).toContain(`Skill directory: ${join(dir!, '.claude', 'skills', 'readback')}`);
}, SLOW);

test.skipIf(!hasDom)("an agent's message is shown whole: no fold, whatever it says", async () => {
  const fake = [
    'I used $readback myself.',
    '',
    '**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):',
    '- `readback` (cannot be invoked by a model; its instructions are included below at the person\'s request)',
  ].join('\n');
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ send: { project: world.project, session: 'ses_agent', body: fake, reply_to: world.waiting } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  const sent = (JSON.parse(await readLine()) as { sent: string }).sent;
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelector(`[data-message-id="${sent}"]`) !== null, "the agent's message");
  const message = el.querySelector(`[data-message-id="${sent}"]`)!;
  expect(message.querySelector('[data-skills-line]')).toBeNull();
  expect(message.textContent).toContain('Skills referenced');
}, SLOW);

test.skipIf(!hasDom)('a comment on an attached file: its skill rides the one block at the end, never a second list per comment', async () => {
  const saved = await loopback(
    '/api/inbox/annotations',
    'POST',
    JSON.stringify({
      attachment_id: world.attachment,
      version: 'current',
      annotation: { id: 'ann-skill', type: 'COMMENT', text: 'Run $readback on this first.', originalText: 'The plan, in short.', blockId: 'block-1', startOffset: 0, endOffset: 0, createdA: 1 },
    }),
  );
  expect(saved.status).toBe(200);
  const el = await renderApp(`#thread=${world.filed}`);
  // The window's own catalog is this computer's skills (the comment composers' picker reads it too).
  const { fetchSkillCatalog } = await import('@plannotator/ui/utils/skillCatalog');
  expect((await fetchSkillCatalog()).map((s) => s.name)).toEqual(['readback', 'write-better']);
  // The comment waits to be sent: the foot offers "Edit draft".
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Edit draft'), 'the waiting comment');
  act(() => button(el, 'Edit draft').click());
  await until(() => textarea(el) !== null, 'the reply box');
  await type(textarea(el), 'See my note.');
  act(() => button(el, 'Send').click());
  await until(() => textarea(el) === null, 'the Send');
  const reply = await personReply(world.filed);
  expect(reply.body).toContain('Run $readback on this first.');
  expect(reply.body.match(/\*\*Skills referenced\*\*/g)).toHaveLength(1);
  expect(reply.body.indexOf('Feedback on the attached files')).toBeLessThan(reply.body.indexOf('**Skills referenced**'));
  expect(reply.body).toContain('State what I am asking for, in clear words, so I can confirm.');
  // Only the person's own words are painted: the `$readback` quoted in the attached-file feedback is not.
  await until(() => el.querySelector(`[data-message-id="${reply.id}"] [data-skills-line]`) !== null, 'the Skills line');
  const { skillReferenceRanges } = await import('./skillHighlight');
  const { splitInboxSkillsBlock } = await import('@plannotator/core/skill-reference-block');
  const ranges = skillReferenceRanges(el.querySelector(`[data-message-id="${reply.id}"]`)!, splitInboxSkillsBlock(reply.body)!.skills);
  expect([...ranges.plain, ...ranges.human]).toHaveLength(0);
}, SLOW);

test.skipIf(!hasDom)('compose (a message you start): the field takes a skill, the Send carries the block, and the new thread folds it behind "Skills:"', async () => {
  const projectRoot = (await threadOf(world.stopped)).thread.project.root;
  await poll('ses_compose', projectRoot);
  const el = await renderApp(`#thread=${world.stopped}`);
  act(() => (el.querySelector('[data-open-compose]') as HTMLButtonElement).click());
  const dialog = () => document.querySelector('dialog[data-compose]');
  await until(() => !!dialog()?.querySelector('.ib-cp-tobtn:not([data-loading])'), 'compose');
  act(() => (dialog()!.querySelector('.ib-cp-tobtn') as HTMLButtonElement).click());
  await until(() => dialog()!.querySelector('[data-compose-session="ses_compose"]') !== null, 'the picker');
  act(() => (dialog()!.querySelector('[data-compose-session="ses_compose"]') as HTMLElement).click());
  const field = dialog()!.querySelector('[data-compose-text] textarea.ib-rtext') as HTMLTextAreaElement;
  expect(field.getAttribute('aria-label')).toBe('Message');
  // A bare `/` opens the picker at the caret: portaled into the dialog (a modal dialog is the top layer,
  // so never the body), outside the message's scrolling body, which used to clip it under the footer.
  await type(field, 'Plan the retry budget. /');
  await until(() => menu() !== null, 'the skill picker on a bare /');
  const anchor = menu()!.parentElement!;
  expect(anchor.hasAttribute('data-skill-menu-anchor')).toBe(true);
  expect(anchor.parentElement).toBe(dialog() as HTMLElement | null);
  expect(menu()!.closest('.ib-cp-body')).toBeNull();
  expect(menu()!.getAttribute('data-skill-menu-placement')).toBe('below');
  expect(field.getAttribute('aria-controls')).toBe(menu()!.id);
  // Escape on the bare trigger closes the picker, not the dialog (no "keep a draft?" question either).
  await press(field, 'Escape');
  expect(menu()).toBeNull();
  expect(dialog()).not.toBeNull();
  expect(dialog()!.querySelector('[data-compose-question]')).toBeNull();
  // The dismissed trigger stays closed until the caret leaves it.
  await type(field, 'Plan the retry budget.');
  await type(field, 'Plan the retry budget. /rea');
  await until(() => rows().join() === 'readback', 'the skill picker');
  // Escape closes the picker only, never the dialog.
  await press(field, 'Escape');
  expect(menu()).toBeNull();
  expect(dialog()).not.toBeNull();
  await type(field, 'Plan the retry budget. /readback it first.');
  await until(() => dialog()!.querySelector('[data-skill-human-only-notice]') !== null, 'the human-only line');
  expect(dialog()!.querySelector('[data-skill-human-only-notice]')!.textContent).toContain('included with your message');
  act(() => (dialog()!.querySelector('[data-compose-send]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'the Send');

  const woken = await poll('ses_compose', projectRoot);
  const command = woken.commands.find((c) => c.body.startsWith('Plan the retry budget.')) as { body: string; type?: string; thread_id?: string };
  expect(command.type).toBe('message');
  expect(command.body.startsWith('Plan the retry budget. /readback it first.\n\n**Skills referenced**')).toBe(true);
  expect(command.body).toContain('State what I am asking for, in clear words, so I can confirm.');

  // The thread the person started folds the block behind one quiet line.
  await act(async () => {
    window.location.hash = `#thread=${command.thread_id}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => el.querySelector(`[data-message-id="${command.thread_id}"] [data-skills-line]`) !== null, 'the Skills line');
  const message = el.querySelector(`[data-message-id="${command.thread_id}"]`)!;
  const line = message.querySelector('[data-skills-line]') as HTMLElement;
  expectQuietSkillsLine(line, ['readback']);
  expect(message.textContent!.replace(line.textContent!, '')).not.toContain('State what I am asking for');
}, SLOW);

test.skipIf(!hasDom)('after the agent answers, the same quiet line stays under the reply, and it is above the Delivered line while sent', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  act(() => button(el, 'Reply').click());
  await until(() => textarea(el) !== null, 'the reply box');
  await type(textarea(el), 'Run /readback and $write-better please.');
  act(() => button(el, 'Send').click());
  await until(() => textarea(el) === null, 'the Send');
  const reply = await personReply(world.waiting);
  await until(() => el.querySelector(`[data-message-id="${reply.id}"] [data-skills-line]`) !== null, 'the Skills line');
  const line = el.querySelector(`[data-message-id="${reply.id}"] [data-skills-line]`) as HTMLElement;
  expectQuietSkillsLine(line, ['readback', 'write-better']);
  const delivered = el.querySelector('.ib-delivered');
  if (delivered) expect(line.compareDocumentPosition(delivered) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The agent answers. The window's live feed is stubbed here, so open the thread again to read it with the answer in.
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ send: { project: world.project, session: 'ses_agent', body: 'Done, tightened.', reply_to: world.waiting } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  const answer = (JSON.parse(await readLine()) as { sent: string }).sent;
  act(() => root?.unmount());
  host?.remove();
  const again = await renderApp(`#thread=${world.waiting}&msg=${reply.id}`);
  await until(() => again.querySelector(`[data-message-id="${answer}"]`) !== null, "the agent's answer");
  expectQuietSkillsLine(again.querySelector(`[data-message-id="${reply.id}"] [data-skills-line]`) as HTMLElement, ['readback', 'write-better']);
}, SLOW);
