/**
 * Action items as a checklist (approval "action-items-checklist", option A;
 * first approved as one card per item, "inbox-next-actions"), as the window
 * draws them. Failures to catch: adjacent `:::action` blocks drawn as separate
 * cards, or blocks separated by prose gathered into one (the run rule); the
 * block's own lines drawn beside the card; more than one row open, or a row
 * whose disclosure is not wired (aria-expanded / aria-controls); the tick not
 * marking Done, or not offering the Undo while its window runs; the next open
 * item not opening after Done; Open dropped when an item also has a command
 * (the old card's bug); the Holds up words dropped; the command cut; Can't do
 * it sent without its reason; a settled row still offering Done; a header
 * that contradicts its rows when items were replaced ("0 things… 0 of 0
 * done"); a double-click on the tick doing Done then Undo; the tick dropping
 * keyboard focus while it saves (disabled) or changing its name; the copy
 * result not announced; the row's count; an action item reaching the picks
 * or the Send (the api split). In the reply draft (approval
 * "inbox-action-items-in-reply"): a Done offering an Undo timer instead of
 * "in your draft"; its note not saved (typing, leaving the field) or saved
 * loud; the agent's own done hiding the person's note; the old "Add note…"
 * and "10 s" words coming back.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';

const hasDom = typeof document !== 'undefined';
const { ActionChecklist, taskMarkdown } = (hasDom ? await import('./components/ActionChecklist') : {}) as typeof import('./components/ActionChecklist');
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { splitMessageActions, actionForBlock } = await import('./actions');
const { waitCount } = await import('./format');

const CLIENT_CMD = 'cd ~/workspaces/projects/appnotes/worktrees/main && pbpaste | npx wrangler secret put APPNOTES_GITHUB_APP_CLIENT_SECRET --env staging';

const BODY = [
  'Staging is almost ready.',
  '',
  ':::action',
  'Set the GitHub App client secret on staging',
  'On the App\'s page, click "Generate a new client secret" and copy it. Then run the command below.',
  'Where: https://github.com/organizations/acme/settings/apps/appnotes-staging',
  `Run: \`${CLIENT_CMD}\``,
  'Holds up: staging sign-in with GitHub',
  "Watching: the staging secret list; I'll see it appear",
  ':::',
  '',
  ':::action',
  'Set the GitHub App private key on staging',
  'On the same page, click "Generate a private key".',
  'Run: `npx wrangler secret put APPNOTES_GITHUB_APP_PRIVATE_KEY --env staging < key.pem`',
  'Holds up: the agent opening PRs on staging; the release notes',
  "Watching: the staging secret list; I'll see it appear",
  ':::',
  '',
  'After both of those, one more thing:',
  '',
  ':::action',
  'Approve the production deploy on Vercel',
  'The build waits under "Promote to Production".',
  'Where: [Vercel](https://vercel.com/acme/web/deployments)',
  'Stopped: release 4.2 waits on it',
  ':::',
].join('\n');

const PARSED = parseInboxActionBlocks(BODY);

function record(index: number, over: Partial<InboxQuestion> = {}): InboxQuestion {
  const p = PARSED[index]!;
  return {
    key: p.key,
    position: index,
    kind: 'action',
    prompt: p.prompt,
    context: p.why,
    choices: [],
    recommendation: null,
    suggested_text: null,
    stopped: p.stopped,
    holds_up: p.holds_up,
    asked_by_agent_id: 'ses_a',
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YE',
    superseded_by: null,
    set_aside_at: null,
    action: p.action,
    action_result: null,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const rerender = (node: React.ReactNode) => act(() => root!.render(node));
/** A fresh card (its open row is decided when it mounts). */
const remount = (node: React.ReactNode) => {
  act(() => root!.render(<></>));
  act(() => root!.render(node));
};

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const click = (el: Element) => act(() => (el as HTMLElement).click());
const rowOf = (el: HTMLElement, index: number) => el.querySelector<HTMLElement>(`[data-action-card="${PARSED[index]!.key}"]`)!;
const toggleOf = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('[data-action-toggle]')!;
const panelOf = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-action-panel]')!;

function wireMessage(questions: InboxQuestion[]): InboxMessageWire {
  return {
    id: 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YE',
    project_id: 'prj_1',
    thread_id: 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YE',
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    subject: 'Staging secrets',
    body: BODY,
    created_at: '2026-10-21T15:10:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    questions,
  } as InboxMessageWire;
}

test.skipIf(!hasDom)('adjacent `:::action` blocks are one card; blocks separated by prose are separate cards, each in its place', () => {
  const message = splitMessageActions(wireMessage([record(0), record(1), record(2)]));
  // Out of `questions`: nothing that picks or sends answers meets them.
  expect(message.questions).toBeUndefined();
  expect(message.actions!.map((a) => a.key)).toEqual(PARSED.map((p) => p.key));
  const runs: string[][] = [];
  const el = mount(
    <MessageBody
      message={message}
      projectRoot="/work/web"
      onOpenAttachment={() => {}}
      readOnly
      answers={new Map()}
      onPick={() => {}}
      footerFor={() => null}
      renderActions={{
        recordFor: (block) => actionForBlock(message.body, message.actions, block),
        render: (records) => {
          runs.push(records.map((r) => r.key));
          return <ActionChecklist actions={records} agent="Claude Code" onMark={async () => true} />;
        },
      }}
    />,
  );
  const cards = [...el.querySelectorAll<HTMLElement>('[data-action-group]')];
  expect(cards).toHaveLength(2);
  expect(cards[0]!.querySelectorAll('[data-action-card]')).toHaveLength(2);
  expect(cards[1]!.querySelectorAll('[data-action-card]')).toHaveLength(1);
  expect(runs.at(-2)).toEqual([PARSED[0]!.key, PARSED[1]!.key]);
  expect(runs.at(-1)).toEqual([PARSED[2]!.key]);
  // The prose between the two runs stays between the two cards.
  const text = el.textContent!;
  const first = text.indexOf('Set the GitHub App private key');
  const prose = text.indexOf('After both of those, one more thing:');
  const second = text.indexOf('Approve the production deploy');
  expect(first).toBeGreaterThan(text.indexOf('Staging is almost ready.'));
  expect(prose).toBeGreaterThan(first);
  expect(second).toBeGreaterThan(prose);
  // The block's own lines are never drawn as a callout beside the card.
  expect(text).not.toContain('Where: https://github.com');
  expect(text).not.toContain('Run: ');
});

test.skipIf(!hasDom)('refs in a task stay plain text in its toggle (a button); its why links them into the thread repo', () => {
  const action = record(0, { prompt: 'Merge acme/web#12 and #3, not `acme/web#13`', context: 'Then team/app#4 can ship.' });
  const el = mount(<ActionChecklist actions={[action]} agent="Claude Code" refRepo={{ display: 'group/web', host: 'gitlab.example.com' }} onMark={async () => true} />);
  const toggle = el.querySelector('[data-action-toggle]')!;
  expect(toggle.querySelector('a')).toBeNull();
  expect(toggle.textContent).toContain('Merge acme/web#12 and #3, not acme/web#13');
  const why = el.querySelector('[data-action-why]')!;
  expect([...why.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))).toContain('https://gitlab.example.com/team/app/-/issues/4');
  // The task's text holds no link even where refs would link (a renderer given a repo).
  const html = renderToStaticMarkup(<InlineMarkdown text={taskMarkdown(action.prompt)} githubRepo="group/web" repoHost="gitlab.example.com" />);
  expect(html).not.toContain('acme/web/-/issues/12');
  expect(html).not.toContain('`');
});

test.skipIf(!hasDom)('the header: how many, how many done, one badge (Holds up sums; Stopped wins); the watching line once, no timer words', () => {
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={async () => true} />);
  const card = el.querySelector('[data-action-group]')!;
  expect(card.getAttribute('role')).toBe('group');
  expect(card.textContent).toContain('2 things only you can do');
  expect(card.querySelector('[data-action-progress]')!.textContent).toBe('0 of 2 done');
  expect(card.querySelector('[data-action-badge]')!.textContent).toBe('Holds up 3');
  expect(card.querySelectorAll('[data-action-watching]')).toHaveLength(1);
  expect(card.querySelector('[data-action-watching]')!.textContent).toBe("Claude Code is watching: the staging secret list; I'll see it appear.");
  // A Done goes with the person's Send: there is no Undo window to explain.
  expect(card.querySelector('[data-action-hint]')).toBeNull();
  expect(card.textContent).not.toContain('10 s');
  act(() => root!.render(<ActionChecklist actions={[record(2), record(0)]} agent="Claude Code" onMark={async () => true} />));
  expect(el.querySelector('[data-action-badge]')!.textContent).toBe('Stopped');
  act(() => root!.render(<ActionChecklist actions={[record(2)]} agent="Claude Code" onMark={async () => true} />));
  expect(el.textContent).toContain('1 thing only you can do');
});

test.skipIf(!hasDom)("the why is markdown, as a question's context: bold, code, a list and a link (opened safely), never the raw marks", () => {
  // The owner's report (0.28.31): `**App Manifest**` and `slack-app.yaml` in backticks came through literally.
  const context = [
    "Steps: api.slack.com/apps → **App Manifest** → replace it with the contents of `slack-app.yaml` → **Save**.",
    '',
    '- Run `pbpaste > /tmp/sfharness/slack-bot` on your Mac',
    '- Then reinstall: see [the Slack docs](https://api.slack.com/authentication/basics)',
  ].join('\n');
  const el = mount(<ActionChecklist actions={[record(0, { context })]} agent="Claude Code" onMark={async () => true} />);
  const why = panelOf(rowOf(el, 0)).querySelector<HTMLElement>('[data-action-why]')!;
  expect(why).not.toBeNull();
  expect(why.textContent).not.toContain('**');
  expect(why.textContent).not.toContain('`');
  expect([...why.querySelectorAll('strong')].map((b) => b.textContent)).toEqual(['App Manifest', 'Save']);
  expect([...why.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['slack-app.yaml', 'pbpaste > /tmp/sfharness/slack-bot']);
  expect(why.querySelectorAll('[data-rich-list-kind="ul"]')).toHaveLength(2);
  const link = why.querySelector<HTMLAnchorElement>('a[href="https://api.slack.com/authentication/basics"]')!;
  expect(link.textContent).toBe('the Slack docs');
  expect(link.target).toBe('_blank');
  expect(link.rel).toBe('noopener noreferrer');
});

test.skipIf(!hasDom)('the task line draws inline markdown, but never a link inside its toggle button', () => {
  const el = mount(
    <ActionChecklist
      actions={[record(0, { prompt: 'Run `npm login` on **this machine**, see [the guide](https://docs.npmjs.com/) or https://npmjs.com/login' })]}
      agent="Claude Code"
      onMark={async () => true}
    />,
  );
  const task = rowOf(el, 0).querySelector<HTMLElement>('.ib-chk-do')!;
  expect(task.querySelector('code')!.textContent).toBe('npm login');
  expect(task.querySelector('strong')!.textContent).toBe('this machine');
  expect(task.querySelector('a')).toBeNull();
  expect(task.textContent).toBe('Run npm login on this machine, see the guide or https://npmjs.com/login');
});

test.skipIf(!hasDom)('rows are disclosures, one open at a time; the first open item starts open', () => {
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={async () => true} />);
  const a = rowOf(el, 0);
  const b = rowOf(el, 1);
  expect(toggleOf(a).getAttribute('aria-expanded')).toBe('true');
  expect(toggleOf(b).getAttribute('aria-expanded')).toBe('false');
  expect(toggleOf(b).getAttribute('aria-controls')).toBe(panelOf(b).id);
  expect(panelOf(a).hidden).toBe(false);
  expect(panelOf(b).hidden).toBe(true);
  click(toggleOf(b));
  expect(toggleOf(b).getAttribute('aria-expanded')).toBe('true');
  expect(toggleOf(a).getAttribute('aria-expanded')).toBe('false');
  expect(panelOf(a).hidden).toBe(true);
  click(toggleOf(b));
  expect(el.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0);
});

test.skipIf(!hasDom)('an open row: why, the Holds up words, Open for its link and the whole command with Copy, both', () => {
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={async () => true} />);
  const panel = panelOf(rowOf(el, 0));
  expect(panel.textContent).toContain('Generate a new client secret');
  expect(panel.querySelector('[data-action-holds]')!.textContent).toBe('Holds up staging sign-in with GitHub');
  const open = panel.querySelector<HTMLAnchorElement>('[data-action-open]')!;
  expect(open.href).toBe('https://github.com/organizations/acme/settings/apps/appnotes-staging');
  expect(open.rel).toBe('noopener noreferrer');
  expect(open.textContent).toBe('Open github.com');
  // The command, whole: every character is in the DOM, and the stylesheet wraps it rather than cutting it.
  const cmd = panel.querySelector('[data-action-cmd]')!;
  expect(cmd.textContent!.replace(/^\$\s/, '')).toBe(CLIENT_CMD);
  expect(panel.querySelector('[data-action-copy]')).not.toBeNull();
  const css = readFileSync(new URL('./inbox.css', import.meta.url), 'utf8');
  const rule = /\.pn-inbox \.ib-chk-cmd \{([^}]*)\}/.exec(css)![1]!;
  expect(rule).toContain('white-space: pre-wrap');
  expect(rule).not.toContain('text-overflow');
  expect(rule).not.toContain('nowrap');
  // The second item's two hold-ups, and a Stopped item's words.
  expect(panelOf(rowOf(el, 1)).querySelector('[data-action-holds]')!.textContent).toBe('Holds up the agent opening PRs on staging; the release notes');
  act(() => root!.render(<ActionChecklist actions={[record(2)]} agent="Claude Code" onMark={async () => true} />));
  expect(el.querySelector('[data-action-stopped]')!.textContent).toBe('Stopped release 4.2 waits on it');
  expect(el.querySelector<HTMLAnchorElement>('[data-action-open]')!.textContent).toBe('Open Vercel');
});

test.skipIf(!hasDom)("the row's tick is Done into the reply draft: the row is struck, its note field and \"in your draft\", no Undo timer; the tick takes it back; the next open item opens", async () => {
  const marks: { key: string; mark: unknown }[] = [];
  const onMark = async (action: InboxQuestion, mark: unknown) => (marks.push({ key: action.key, mark }), true);
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={onMark} />);
  const tick = rowOf(el, 0).querySelector<HTMLButtonElement>('[data-action-tick]')!;
  expect(tick.getAttribute('aria-label')).toBe('Done: Set the GitHub App client secret on staging');
  click(tick);
  await settle();
  expect(marks).toEqual([{ key: PARSED[0]!.key, mark: { outcome: 'done' } }]);
  expect(toggleOf(rowOf(el, 1)).getAttribute('aria-expanded')).toBe('true');
  expect(toggleOf(rowOf(el, 0)).getAttribute('aria-expanded')).toBe('false');

  // The server's answer: picked and staged, waiting for the Send.
  const result = { outcome: 'done' as const, note: null, at: '2026-10-21T15:12:00.000Z', by: 'person' as const, staged: true };
  rerender(<ActionChecklist actions={[record(0, { state: 'picked', revision: 1, action_result: result }), record(1)]} agent="Claude Code" onMark={onMark} />);
  const done = rowOf(el, 0);
  expect(done.getAttribute('data-action-state')).toBe('pending');
  expect(done.querySelector('[data-action-undo]')).toBeNull();
  expect(done.textContent).not.toContain('in a few seconds');
  expect(done.querySelector('[data-action-draft-line]')!.textContent).toMatch(/^Done \d{1,2}:\d{2}\s?[AP]M · in your draft$/);
  expect(done.querySelector<HTMLTextAreaElement>('[data-action-draft-note]')!.placeholder).toBe('Add a note for Claude Code');
  expect(el.querySelector('[data-action-progress]')!.textContent).toBe('1 of 2 done');
  expect(el.querySelector('[data-action-badge]')!.textContent).toBe('Holds up 2');
  const undoTick = done.querySelector<HTMLButtonElement>('[data-action-tick]')!;
  // The same name; aria-pressed carries the state.
  expect(undoTick.getAttribute('aria-label')).toBe('Done: Set the GitHub App client secret on staging');
  expect(undoTick.getAttribute('aria-pressed')).toBe('true');
  // The tick takes it back, but not within half a second of Done (the second click of a fast double-click).
  const before = marks.length;
  click(undoTick);
  await settle();
  expect(marks.length).toBe(before);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 520));
  });
  click(undoTick);
  await settle();
  expect(marks.length).toBe(before + 1);
  expect(marks.at(-1)).toEqual({ key: PARSED[0]!.key, mark: null });
});

test.skipIf(!hasDom)('the note under a Done in the draft saves quietly as it is typed and on leaving the field; Can\'t do it\'s reason never empties', async () => {
  const marks: unknown[] = [];
  const onMark = async (_a: InboxQuestion, mark: unknown) => (marks.push(mark), true);
  const at = '2026-10-21T15:12:00.000Z';
  const type = (area: HTMLTextAreaElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const el = mount(
    <ActionChecklist actions={[record(0, { state: 'picked', revision: 1, action_result: { outcome: 'done', note: null, at, by: 'person', staged: true } })]} agent="Claude Code" onMark={onMark} />,
  );
  const area = el.querySelector<HTMLTextAreaElement>('[data-action-draft-note]')!;
  type(area, 'Rotated the old one too.');
  expect(marks).toEqual([]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 650));
  });
  expect(marks).toEqual([{ outcome: 'done', note: 'Rotated the old one too.', quiet: true }]);
  // Leaving the field saves at once (a Send right after carries it); the same words twice save once.
  type(area, 'Rotated the old one too. Staging only.');
  act(() => area.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  await settle();
  expect(marks.at(-1)).toEqual({ outcome: 'done', note: 'Rotated the old one too. Staging only.', quiet: true });
  const count = marks.length;
  act(() => area.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  await settle();
  expect(marks).toHaveLength(count);

  remount(
    <ActionChecklist actions={[record(0, { state: 'picked', revision: 1, action_result: { outcome: 'cant', note: 'No access.', at, by: 'person', staged: true } })]} agent="Claude Code" onMark={onMark} />,
  );
  const reason = el.querySelector<HTMLTextAreaElement>('[data-action-draft-note]')!;
  expect(reason.value).toBe('No access.');
  expect(el.querySelector('[data-action-draft-line]')!.textContent).toMatch(/^Can't do it .* · in your draft$/);
  type(reason, '');
  act(() => reason.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  await settle();
  // An emptied reason is never saved, and the field never shows less than what goes: the saved reason comes back.
  expect(marks).toHaveLength(count);
  expect(reason.value).toBe('No access.');
});

test.skipIf(!hasDom)('a note still inside its typing pause goes as the page goes (a reload, a closed tab): one keepalive request, as a note save', async () => {
  const marks: unknown[] = [];
  const at = '2026-10-21T15:12:00.000Z';
  const sent: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return new Response('{}');
  }) as typeof fetch;
  try {
    const el = mount(
      <ActionChecklist actions={[record(0, { state: 'picked', revision: 1, action_result: { outcome: 'done', note: null, at, by: 'person', staged: true } })]} agent="Claude Code" onMark={async (_a, mark) => (marks.push(mark), true)} />,
    );
    const area = el.querySelector<HTMLTextAreaElement>('[data-action-draft-note]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Rotated the old one too.');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(/\/api\/inbox\/messages\/[^/]+\/actions\/a-/);
    expect(sent[0]!.init.keepalive).toBe(true);
    expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({ outcome: 'done', note: 'Rotated the old one too.', note_only: true, staged: true });
    // Sent once: the pause's timer is gone, and the row going away has nothing left to save.
    act(() => window.dispatchEvent(new Event('pagehide')));
    act(() => root!.render(<></>));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(sent).toHaveLength(1);
    expect(marks).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test.skipIf(!hasDom)('a note still inside its typing pause is saved when its row goes away (the pane closed), never dropped', async () => {
  const marks: unknown[] = [];
  const at = '2026-10-21T15:12:00.000Z';
  const el = mount(
    <ActionChecklist actions={[record(0, { state: 'picked', revision: 1, action_result: { outcome: 'done', note: null, at, by: 'person', staged: true } })]} agent="Claude Code" onMark={async (_a, mark) => (marks.push(mark), true)} />,
  );
  const area = el.querySelector<HTMLTextAreaElement>('[data-action-draft-note]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Rotated the old one too.');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(marks).toEqual([]);
  act(() => root!.render(<></>));
  await settle();
  expect(marks).toEqual([{ outcome: 'done', note: 'Rotated the old one too.', quiet: true }]);
  // Nothing left waiting: the timer is gone, so no second save later.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 650));
  });
  expect(marks).toHaveLength(1);
});

test.skipIf(!hasDom)("the agent saw it done while the person's note waited in the draft: the note stays editable, and emptying it takes it out", async () => {
  const marks: unknown[] = [];
  const result = {
    outcome: 'done' as const,
    note: null,
    at: '2026-10-21T15:14:00.000Z',
    by: 'agent' as const,
    message_id: 'msg_2',
    person: { outcome: 'done' as const, note: 'Rotated the old one too.', at: '2026-10-21T15:12:00.000Z' },
  };
  const el = mount(<ActionChecklist actions={[record(0, { state: 'closed', revision: 2, sent_revision: 0, action_result: result })]} agent="Claude Code" onMark={async (_a, mark) => (marks.push(mark), true)} />);
  const row = rowOf(el, 0);
  expect(row.getAttribute('data-action-state')).toBe('seen');
  expect(row.querySelector('[data-action-settled]')!.textContent).toMatch(/^Claude Code saw it done, /);
  expect(row.querySelector('[data-action-draft-line]')!.textContent).toBe('Your note · in your draft');
  const area = row.querySelector<HTMLTextAreaElement>('[data-action-draft-note]')!;
  expect(area.value).toBe('Rotated the old one too.');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => area.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  await settle();
  expect(marks).toEqual([null]);
  // Sent: the note went; no field.
  remount(<ActionChecklist actions={[record(0, { state: 'closed', revision: 2, sent_revision: 2, action_result: result })]} agent="Claude Code" onMark={async () => true} />);
  expect(el.querySelector('[data-action-draft-note]')).toBeNull();
});

test.skipIf(!hasDom)('a Done through the timed path (decision mode, the phone door) keeps its "Goes to … in a few seconds" line and Undo', async () => {
  const marks: unknown[] = [];
  const result = { outcome: 'done' as const, note: null, at: '2026-10-21T15:12:00.000Z', by: 'person' as const };
  const el = mount(<ActionChecklist actions={[record(0, { state: 'picked', revision: 1, action_result: result })]} agent="Claude Code" onMark={async (_a, mark) => (marks.push(mark), true)} />);
  const row = rowOf(el, 0);
  expect(row.querySelector('[data-action-settled]')!.textContent).toContain('Goes to Claude Code in a few seconds.');
  expect(row.querySelector('[data-action-draft-note]')).toBeNull();
  click(row.querySelector('[data-action-undo]')!);
  await settle();
  expect(marks).toEqual([null]);
});

test.skipIf(!hasDom)('a double-click on the tick is Done once: its second click, after Done has landed, never undoes it', async () => {
  const marks: unknown[] = [];
  const onMark = async (_a: InboxQuestion, mark: unknown) => (marks.push(mark), true);
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={onMark} />);
  const tick = () => rowOf(el, 0).querySelector<HTMLButtonElement>('[data-action-tick]')!;
  const press = (detail: number) =>
    act(() => {
      tick().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
    });
  press(1);
  await settle();
  // Done landed: the row is in its Undo window before the second click arrives.
  const result = { outcome: 'done' as const, note: null, at: '2026-10-21T15:12:00.000Z', by: 'person' as const };
  rerender(<ActionChecklist actions={[record(0, { state: 'picked', revision: 1, action_result: result }), record(1)]} agent="Claude Code" onMark={onMark} />);
  press(2);
  await settle();
  // A slow double-click arrives as two single clicks: the half second after Done still holds.
  press(1);
  await settle();
  expect(marks).toEqual([{ outcome: 'done' }]);
});

test.skipIf(!hasDom)('while a mark saves the tick keeps keyboard focus (aria-disabled, not disabled) and ignores clicks', async () => {
  const marks: unknown[] = [];
  let release: (ok: boolean) => void = () => {};
  const el = mount(
    <ActionChecklist
      actions={[record(0), record(1)]}
      agent="Claude Code"
      onMark={(_a, mark) => {
        marks.push(mark);
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      }}
    />,
  );
  const tick = rowOf(el, 0).querySelector<HTMLButtonElement>('[data-action-tick]')!;
  act(() => tick.focus());
  click(tick);
  expect(marks).toEqual([{ outcome: 'done' }]);
  expect(tick.disabled).toBe(false);
  expect(tick.getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(tick);
  click(tick);
  expect(marks).toHaveLength(1);
  await act(async () => {
    release(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(tick.hasAttribute('aria-disabled')).toBe(false);
  expect(document.activeElement).toBe(tick);
});

test.skipIf(!hasDom)("Done from the open row's button moves focus to the next row's toggle", async () => {
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={async () => true} />);
  click(panelOf(rowOf(el, 0)).querySelector('[data-action-done]')!);
  await settle();
  expect(document.activeElement).toBe(toggleOf(rowOf(el, 1)));
});

test.skipIf(!hasDom)("Can't do it asks for the reason; nothing goes without one", async () => {
  const marks: unknown[] = [];
  const el = mount(<ActionChecklist actions={[record(0)]} agent="Claude Code" onMark={async (_a, mark) => (marks.push(mark), true)} />);
  const panel = panelOf(rowOf(el, 0));
  // Done and Can't do it…, no separate Add note… (the note goes under a marked row).
  expect(panel.querySelector('[data-action-note]')).toBeNull();
  click(panel.querySelector('[data-action-cant]')!);
  const send = panel.querySelector<HTMLButtonElement>('[data-action-cant-send]')!;
  expect(send.disabled).toBe(true);
  expect(send.textContent).toBe("Can't do it");
  expect(panel.querySelector('label')!.textContent).toBe("Why can't you? Claude Code gets this word for word.");
  const area = panel.querySelector<HTMLTextAreaElement>('textarea')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(area, "I'm not an org owner; ask Dana.");
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  click(panel.querySelector('[data-action-cant-send]')!);
  await settle();
  expect(marks).toEqual([{ outcome: 'cant', note: "I'm not an org owner; ask Dana." }]);
});

test.skipIf(!hasDom)('settled rows: sent, can\'t do it with its reason, the agent saw it done, set aside; none offers Done', () => {
  const at = '2026-10-21T15:12:00.000Z';
  const el = mount(
    <ActionChecklist
      actions={[
        record(0, { state: 'sent', revision: 1, sent_revision: 1, action_result: { outcome: 'done', note: null, at, by: 'person' } }),
        record(1, { state: 'sent', revision: 1, sent_revision: 1, action_result: { outcome: 'cant', note: 'No access.', at, by: 'person' } }),
        record(2, { state: 'closed', revision: 1, action_result: { outcome: 'done', note: null, at, by: 'agent' } }),
      ]}
      agent="Claude Code"
      onMark={async () => true}
    />,
  );
  expect(el.querySelector('[data-action-progress]')!.textContent).toBe('2 of 3 done');
  expect(el.querySelector('[data-action-badge]')).toBeNull();
  expect(el.querySelector('[data-action-hint]')).toBeNull();
  expect(el.querySelector('[data-action-tick] , button[data-action-tick]')).toBeNull();
  expect(el.querySelector('[data-action-done]')).toBeNull();
  expect(el.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0);
  const sent = rowOf(el, 0);
  expect(sent.getAttribute('data-action-state')).toBe('done');
  expect(sent.querySelector('.ib-badge')!.textContent).toBe('Done');
  click(toggleOf(sent));
  expect(panelOf(sent).querySelector('[data-action-settled]')!.textContent).toContain('Sent to Claude Code.');
  const cant = rowOf(el, 1);
  expect(cant.querySelector('[data-action-settled]')!.textContent).toBe('Can\'t do it: “No access.” Sent to Claude Code.');
  click(toggleOf(rowOf(el, 2)));
  expect(panelOf(rowOf(el, 2)).querySelector('[data-action-settled]')!.textContent).toMatch(/^Claude Code saw it done, /);
});

test.skipIf(!hasDom)('replaced items are counted apart: the header never says "0 things… 0 of 0 done"', () => {
  const superseded = { message_id: 'msg_01M5F3B7KD2WQ9XN4C8VJTR6YZ', key: null };
  const el = mount(
    <ActionChecklist
      actions={[record(0, { state: 'superseded', superseded_by: superseded }), record(1, { state: 'superseded', superseded_by: superseded })]}
      agent="Claude Code"
      onMark={async () => true}
    />,
  );
  expect(el.querySelector('[data-action-title]')!.textContent).toBe('2 action items, replaced');
  expect(el.querySelector('[data-action-progress]')).toBeNull();
  expect(el.querySelector('[data-action-badge]')).toBeNull();
  expect(el.querySelector('[data-action-hint]')).toBeNull();
  // The agent's watch on replaced items is over: no watching line.
  expect(el.querySelector('[data-action-foot]')).toBeNull();
  expect([...el.querySelectorAll('[data-action-card] .ib-badge')].map((b) => b.textContent)).toEqual(['Replaced', 'Replaced']);
  expect(el.querySelector('[data-action-tick]')).toBeNull();
  rerender(<ActionChecklist actions={[record(0, { state: 'superseded', superseded_by: superseded })]} agent="Claude Code" onMark={async () => true} />);
  expect(el.querySelector('[data-action-title]')!.textContent).toBe('1 action item, replaced');
  // Mixed: the open items are the count, the replaced ones said after it.
  remount(<ActionChecklist actions={[record(0, { state: 'superseded', superseded_by: superseded }), record(1), record(2)]} agent="Claude Code" onMark={async () => true} />);
  expect(el.querySelector('[data-action-title]')!.textContent).toBe('2 things only you can do');
  expect(el.querySelector('[data-action-progress]')!.textContent).toBe('0 of 2 done · 1 replaced');
  // The first OPEN item starts open, not the replaced one.
  expect(toggleOf(rowOf(el, 1)).getAttribute('aria-expanded')).toBe('true');
  click(toggleOf(rowOf(el, 0)));
  expect(panelOf(rowOf(el, 0)).querySelector('[data-action-settled]')!.textContent).toBe('Claude Code replaced this action item.');
  expect(panelOf(rowOf(el, 0)).querySelector('[data-action-done]')).toBeNull();
});

test.skipIf(!hasDom)('set aside and closed rows: their chip and line, a dashed mark, no Done; a read-only card takes no Done but still opens', () => {
  const el = mount(
    <ActionChecklist
      actions={[record(0, { state: 'closed', set_aside_at: '2026-10-21T15:20:00.000Z' }), record(1, { state: 'closed' })]}
      agent="Claude Code"
      onMark={async () => true}
    />,
  );
  const aside = rowOf(el, 0);
  const closed = rowOf(el, 1);
  expect(aside.getAttribute('data-action-state')).toBe('set-aside');
  expect(closed.getAttribute('data-action-state')).toBe('archived');
  expect(aside.querySelector('.ib-badge')!.textContent).toBe('Set aside');
  expect(closed.querySelector('.ib-badge')!.textContent).toBe('Closed');
  expect(el.querySelector('[data-action-tick]')).toBeNull();
  expect(el.querySelector('[data-action-progress]')!.textContent).toBe('0 of 2 done');
  click(toggleOf(aside));
  expect(panelOf(aside).querySelector('[data-action-settled]')!.textContent).toBe('Set aside when you marked the thread read. Claude Code was told not to wait.');
  click(toggleOf(closed));
  expect(panelOf(closed).querySelector('[data-action-settled]')!.textContent).toBe('Closed when the thread was archived.');
  expect(el.querySelector('[data-action-done]')).toBeNull();

  remount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" readOnly onMark={async () => true} />);
  expect(el.querySelector('[data-action-tick]')).toBeNull();
  expect(el.querySelector('[data-action-done]')).toBeNull();
  expect(el.querySelector('[data-action-hint]')).toBeNull();
  // Read-only still shows what to do: the open row's why, link and command.
  expect(panelOf(rowOf(el, 0)).hidden).toBe(false);
  expect(panelOf(rowOf(el, 0)).querySelector('[data-action-open]')).not.toBeNull();
  expect(panelOf(rowOf(el, 0)).querySelector('[data-action-cmd]')).not.toBeNull();
});

test.skipIf(!hasDom)("Copy is named by its visible words, and its result is said in a polite live region", async () => {
  const el = mount(<ActionChecklist actions={[record(0)]} agent="Claude Code" onMark={async () => true} />);
  const copy = el.querySelector<HTMLButtonElement>('[data-action-copy]')!;
  expect(copy.hasAttribute('aria-label')).toBe(false);
  const status = el.querySelector('[data-action-copy-status]')!;
  expect(status.getAttribute('role')).toBe('status');
  expect(status.textContent).toBe('');
  click(copy);
  await settle();
  expect(['Command copied.', "Couldn't copy the command."]).toContain(status.textContent!);
});

test.skipIf(!hasDom)('the row draws open action items as the box pill and open questions as the speech bubble, wide, beside a thread and on a phone; none draws nothing', () => {
  expect(waitCount(1, 1)).toBe('1 action item');
  expect(waitCount(2, 1)).toBe('1 question, 1 action item');
  expect(waitCount(3, 1)).toBe('2 questions, 1 action item');
  expect(waitCount(2, 0)).toBe('2 questions');
  expect(waitCount(1, 0)).toBe('');
  const row = (id: string, open: number, actions: number): InboxListRow => ({
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-21T15:10:00.000Z',
    last_at: '2026-10-21T15:10:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open, picked: 0, stopped: true, holds_up: [], prompt: null, actions },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'web' },
    thread_name: null,
    section: 'stopped',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  });
  const answered = { ...row('msg_e', 2, 1), answered_not_sent: true };
  const sections: InboxListSection[] = [{ id: 'stopped', label: 'Stopped on you', threads: [row('msg_a', 1, 1), row('msg_b', 3, 1), row('msg_c', 2, 0), row('msg_d', 14, 12), row('msg_f', 256, 128), answered] }];
  const list = (narrow: boolean, phone: boolean) => (
    <SidebarProvider>
      <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={narrow} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={phone} />
    </SidebarProvider>
  );
  const el = mount(list(false, false));
  // What a row draws for its open counts (approval "inbox-row-action-icon", 2026-10-29): the action pill (the
  // drawn number, its accessible words, its icon the checklist's box with no tick) and `?N` (the drawn number,
  // its words, its icon). Read off the row's open counts only, in the order they sit.
  const box = 'M6.75 3.75h10.5a3 3 0 0 1 3 3v10.5a3 3 0 0 1-3 3H6.75a3 3 0 0 1-3-3V6.75a3 3 0 0 1 3-3Z';
  // Pinned on purpose: the owner's pick for the question count is Q3, Lucide's message-circle-question-mark.
  const bubble = 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01';
  const counts = (scope: Element) =>
    [...scope.querySelectorAll('[data-action-count], .ib-qn')].map((c) => ({
      kind: c.matches('[data-action-count]') ? 'action' : 'question',
      pill: c.classList.contains('ib-badge'),
      drawn: c.querySelector('[aria-hidden="true"]:not(svg)')!.textContent,
      name: c.querySelector('.ib-sr')!.textContent!.trim(),
      icon: c.querySelector('svg path')!.getAttribute('d') === (c.matches('[data-action-count]') ? box : bubble),
    }));
  const pill = (n: string, name: string) => ({ kind: 'action', pill: true, drawn: n, name, icon: true });
  const q = (n: string, name: string) => ({ kind: 'question', pill: false, drawn: n, name, icon: true });
  const expected: Record<string, unknown[]> = {
    msg_a: [pill('1', '1 action to do')],
    msg_b: [pill('1', '1 action to do'), q('2', '2 questions')],
    msg_c: [q('2', '2 questions')],
    msg_d: [pill('12', '12 actions to do'), q('2', '2 questions')],
    // Past 99 the drawn number is "99+" (both at full length would run over a wide row's badge); the words keep it exact.
    msg_f: [pill('99+', '128 actions to do'), q('99+', '128 questions')],
    msg_e: [],
  };
  const rowOf = (shape: string, id: string) => el.querySelector(`${shape}[data-thread-id="${id}"]`)!;
  // A wide row: both sit in the open counts' column before the time; the words column says nothing for them.
  for (const [id, want] of Object.entries(expected)) {
    expect(counts(rowOf('.ib-row', id).querySelector('.ib-cq')!)).toEqual(want as never);
    if (id !== 'msg_e') expect(rowOf('.ib-row', id).querySelector('.ib-cw')!.textContent).toBe('');
  }
  // Words of their own (here an older Inbox's "Answered") still take the place of the counts.
  expect(rowOf('.ib-row', 'msg_e').querySelector('.ib-cw [data-count-words]')!.getAttribute('data-count-words')).toBe('Answered, not sent');
  // The row's accessible name (its text less what is hidden from a screen reader) carries the counts' words apart.
  const named = rowOf('.ib-row', 'msg_b').cloneNode(true) as Element;
  named.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  expect(named.textContent).toContain(' 1 action to do 2 questions');
  // Beside a thread and on a phone: at line 3's end, the action pill then `?N`, after the badge.
  for (const [narrow, phone, shape, line] of [[true, false, '.ib-nrow', '.ib-l3'], [false, true, '.ib-mrow', '.ib-m3']] as const) {
    rerender(list(narrow, phone));
    for (const [id, want] of Object.entries(expected)) expect(counts(rowOf(shape, id))).toEqual(want as never);
    const tail = [...rowOf(shape, 'msg_b').querySelector(line)!.children].slice(-3).map((c) => (c.matches('[data-row-badge]') ? 'badge' : c.matches('[data-action-count]') ? 'action' : c.classList.contains('ib-qn') ? 'question' : c.className));
    expect(tail).toEqual(['badge', 'action', 'question']);
  }
});
