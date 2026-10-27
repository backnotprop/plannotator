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
 * or the Send (the api split).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxMessageWire, InboxQuestion } from '@plannotator/core/inbox-types';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';

const hasDom = typeof document !== 'undefined';
const { ActionChecklist } = (hasDom ? await import('./components/ActionChecklist') : {}) as typeof import('./components/ActionChecklist');
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

test.skipIf(!hasDom)('the header: how many, how many done, one badge (Holds up sums; Stopped wins); the watching line and the 10 s rule once', () => {
  const el = mount(<ActionChecklist actions={[record(0), record(1)]} agent="Claude Code" onMark={async () => true} />);
  const card = el.querySelector('[data-action-group]')!;
  expect(card.getAttribute('role')).toBe('group');
  expect(card.textContent).toContain('2 things only you can do');
  expect(card.querySelector('[data-action-progress]')!.textContent).toBe('0 of 2 done');
  expect(card.querySelector('[data-action-badge]')!.textContent).toBe('Holds up 3');
  expect(card.querySelectorAll('[data-action-watching]')).toHaveLength(1);
  expect(card.querySelector('[data-action-watching]')!.textContent).toBe("Claude Code is watching: the staging secret list; I'll see it appear.");
  expect(card.querySelector('[data-action-hint]')!.textContent).toBe('Done reaches Claude Code after 10 s, so you can undo.');
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

test.skipIf(!hasDom)("the row's tick is Done; while the window runs the row is struck with its Undo; the next open item opens", async () => {
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

  // The server's answer: picked, inside the Undo window.
  const result = { outcome: 'done' as const, note: null, at: '2026-10-21T15:12:00.000Z', by: 'person' as const };
  rerender(<ActionChecklist actions={[record(0, { state: 'picked', revision: 1, action_result: result }), record(1)]} agent="Claude Code" onMark={onMark} />);
  const done = rowOf(el, 0);
  expect(done.getAttribute('data-action-state')).toBe('pending');
  expect(done.querySelector('[data-action-settled]')!.textContent).toContain('Goes to Claude Code in a few seconds.');
  expect(el.querySelector('[data-action-progress]')!.textContent).toBe('1 of 2 done');
  expect(el.querySelector('[data-action-badge]')!.textContent).toBe('Holds up 2');
  const undoTick = done.querySelector<HTMLButtonElement>('[data-action-tick]')!;
  // The same name; aria-pressed carries the state.
  expect(undoTick.getAttribute('aria-label')).toBe('Done: Set the GitHub App client secret on staging');
  expect(undoTick.getAttribute('aria-pressed')).toBe('true');
  click(done.querySelector('[data-action-undo]')!);
  await settle();
  expect(marks.at(-1)).toEqual({ key: PARSED[0]!.key, mark: null });
  // The tick undoes too, but not within half a second of Done (the second click of a fast double-click).
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
  click(panel.querySelector('[data-action-cant]')!);
  const send = panel.querySelector<HTMLButtonElement>('[data-action-cant-send]')!;
  expect(send.disabled).toBe(true);
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

test.skipIf(!hasDom)('the row says "1 action item", or "1 question, 1 action item", as plain text', () => {
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
  const sections: InboxListSection[] = [{ id: 'stopped', label: 'Stopped on you', threads: [row('msg_a', 1, 1), row('msg_b', 2, 1)] }];
  const el = mount(
    <SidebarProvider>
      <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={false} />
    </SidebarProvider>,
  );
  const count = (id: string) => el.querySelector(`[data-thread-id="${id}"] .ib-c`)?.textContent;
  expect(count('msg_a')).toBe('1 action item');
  expect(count('msg_b')).toBe('1 question, 1 action item');
});
