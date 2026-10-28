/**
 * Sidebar → Feedback (components/FeedbackDialog.tsx) through the window's
 * real client (`inboxApi.sendFeedback`) with `fetch` stubbed: what regresses
 * is the window sending more than the person typed (thread content, extra
 * fields), sending without Send, losing the words on a failure, a silent
 * failure, the cap not enforced before the round trip, the category not
 * clearable, a Sent state that never shows, and the copy prompt losing the
 * draft or the "only after I say yes" rule. Plus the sidebar row: above
 * Settings, only when the window gives it a handler.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FEEDBACK_HEREDOC_END, FEEDBACK_UNAVAILABLE } from '@plannotator/core/product-feedback';
import { FEEDBACK_PROMPT_TEXT_LINE, feedbackCopiedToast, feedbackPrompt } from './feedbackPrompt';

const hasDom = typeof document !== 'undefined';
const { FeedbackDialog } = (hasDom ? await import('./components/FeedbackDialog') : {}) as typeof import('./components/FeedbackDialog');
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');

const BIN = '/Users/ada/.local/bin/plannotator';

let root: Root | null = null;
const restorers: Array<() => void> = [];

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  if (hasDom) document.body.innerHTML = '';
  while (restorers.length > 0) restorers.pop()!();
});

type Call = { url: string; method: string; body: Record<string, unknown> };

/** Stubs window.fetch for the test: records each call and answers with `answer`. */
function stubFetch(answer: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  restorers.push(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function render(overrides: { onCopyPrompt?: (draft: string) => void; onClose?: () => void } = {}) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <FeedbackDialog
        version="0.28.33"
        phone={false}
        onSend={async (input) => {
          await inboxApi.sendFeedback(input);
        }}
        onCopyPrompt={overrides.onCopyPrompt ?? (() => {})}
        onClose={overrides.onClose ?? (() => {})}
      />,
    ),
  );
  const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel);
  return {
    host,
    box: () => q<HTMLTextAreaElement>('[data-feedback-message]')!,
    contact: () => q<HTMLInputElement>('[data-feedback-contact]')!,
    send: () => q<HTMLButtonElement>('[data-feedback-send]')!,
    cat: (value: string) => q<HTMLButtonElement>(`[data-feedback-category="${value}"]`)!,
    error: () => q<HTMLElement>('[data-feedback-error]'),
    sent: () => q<HTMLElement>('[data-feedback-sent]'),
    copy: () => q<HTMLButtonElement>('[data-feedback-copy-prompt]')!,
    what: () => q<HTMLElement>('[data-feedback-what]')!,
  };
}

/** Types into a React-controlled field the way a person does (the native setter, then `input`). */
function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
  });
  // The fetch's answer, then React's update.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe.skipIf(!hasDom)('the Feedback dialog', () => {
  test('Send posts only what was typed to the Inbox, then shows the sent state', async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    const dialog = render();
    // The box takes focus on open: the person types at once.
    expect(document.activeElement).toBe(dialog.box());
    // The line says what is sent, naming this version (the data it must keep truthful).
    expect(dialog.what().textContent).toContain('0.28.33');
    // It names every field the Inbox adds, the surface (that it came from the Inbox) included.
    expect(dialog.what().textContent).toMatch(/\bOS\b/);
    expect(dialog.what().textContent).toMatch(/\bInbox\b/);
    expect(calls).toHaveLength(0);

    type(dialog.box(), '  Reload loses my place in the list  ');
    await press(dialog.cat('bug'));
    type(dialog.contact(), ' ada@example.com ');
    // Typing and choosing sends nothing: only Send does.
    expect(calls).toHaveLength(0);
    await press(dialog.send());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/inbox/feedback');
    expect(calls[0]!.method).toBe('POST');
    const { serverSession: _session, ...body } = calls[0]!.body;
    expect(body).toEqual({ message: 'Reload loses my place in the list', category: 'bug', contact: 'ada@example.com' });
    expect(dialog.sent()).not.toBeNull();
    expect(document.activeElement?.hasAttribute('data-feedback-done')).toBe(true);
  });

  test('a failure keeps the words, says why, and Send works again', async () => {
    let fail = true;
    const calls = stubFetch(() => (fail ? Response.json({ error: 'Too many requests. Try again later.', code: 'feedback_not_sent' }, { status: 502 }) : Response.json({ ok: true })));
    const dialog = render();
    type(dialog.box(), 'It crashed on open');
    await press(dialog.send());
    expect(dialog.sent()).toBeNull();
    expect(dialog.error()?.getAttribute('role')).toBe('alert');
    expect(dialog.error()?.textContent).toContain('Too many requests');
    expect(dialog.box().value).toBe('It crashed on open');
    expect(dialog.send().getAttribute('aria-disabled')).toBeNull();

    fail = false;
    await press(dialog.send());
    expect(calls).toHaveLength(2);
    expect(dialog.sent()).not.toBeNull();
  });

  test('the service or the Inbox unavailable: one plain line, never a network error or a status, and the words stay', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      // The Inbox's 502 when the Worker is unreachable, not deployed or silent.
      () => Response.json({ error: FEEDBACK_UNAVAILABLE, code: 'feedback_not_sent' }, { status: 502 }),
      // The Inbox itself gone: the browser's own network error.
      () => Promise.reject(new TypeError('Failed to fetch')),
      // Something in the way answering a page, not the Inbox's JSON.
      () => new Response('<html>Bad gateway</html>', { status: 503, headers: { 'Content-Type': 'text/html' } }),
      // The window's own time limit (an Inbox that holds the request).
      () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    ];
    let next = 0;
    stubFetch(() => answers[next++]!());
    const dialog = render();
    type(dialog.box(), 'It crashed on open');
    for (let i = 0; i < answers.length; i += 1) {
      await press(dialog.send());
      expect(dialog.sent()).toBeNull();
      expect(dialog.error()?.textContent).toBe(FEEDBACK_UNAVAILABLE);
      expect(dialog.box().value).toBe('It crashed on open');
    }
    expect(next).toBe(answers.length);
  });

  test('when its opener is gone (the phone drawer closed), closing puts focus on the page heading, not <body>', () => {
    const main = document.createElement('main');
    main.className = 'ib-main';
    const heading = document.createElement('h1');
    heading.textContent = 'Inbox';
    main.appendChild(heading);
    const opener = document.createElement('button');
    opener.textContent = 'Feedback';
    document.body.append(main, opener);
    opener.focus();
    render();
    // The drawer that held the Feedback row unmounts when the row is picked.
    opener.remove();
    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  test('nothing empty or over 4,000 characters leaves the window', async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    const dialog = render();
    await press(dialog.send());
    expect(dialog.error()).not.toBeNull();
    expect(document.activeElement).toBe(dialog.box());
    type(dialog.box(), '   ');
    await press(dialog.send());
    expect(calls).toHaveLength(0);

    type(dialog.box(), 'x'.repeat(4001));
    expect(dialog.host.querySelector('[data-feedback-count]')?.textContent).toContain('1 over');
    await press(dialog.send());
    expect(calls).toHaveLength(0);
    expect(dialog.error()).not.toBeNull();

    type(dialog.box(), 'x'.repeat(4000));
    await press(dialog.send());
    expect(calls).toHaveLength(1);
  });

  test('email and category are optional, and say so: with neither, Send sends just the message', async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    const dialog = render();
    // Optional where a person sees it (the placeholder, and the line above the row) and where a screen reader hears it.
    expect(dialog.contact().getAttribute('placeholder')).toBe('Email (optional)');
    expect(dialog.contact().getAttribute('aria-label')).toBe('Email (optional)');
    expect(dialog.contact().required).toBe(false);
    expect(dialog.host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Category (optional)');
    expect(dialog.host.querySelector('[data-feedback-optional]')?.textContent).toContain('optional');
    type(dialog.box(), 'Just the words');
    await press(dialog.send());
    expect(calls).toHaveLength(1);
    const { serverSession: _session, ...body } = calls[0]!.body;
    expect(body).toEqual({ message: 'Just the words' });
    expect(dialog.sent()).not.toBeNull();
  });

  test('the category is optional: a second press clears it, and none is sent', async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    const dialog = render();
    await press(dialog.cat('idea'));
    expect(dialog.cat('idea').getAttribute('aria-pressed')).toBe('true');
    await press(dialog.cat('other'));
    expect(dialog.cat('idea').getAttribute('aria-pressed')).toBe('false');
    expect(dialog.cat('other').getAttribute('aria-pressed')).toBe('true');
    await press(dialog.cat('other'));
    expect(dialog.cat('other').getAttribute('aria-pressed')).toBe('false');
    type(dialog.box(), 'hi');
    await press(dialog.send());
    const { serverSession: _session, ...body } = calls[0]!.body;
    expect(body).toEqual({ message: 'hi' });
  });

  test('Enter in the email field does not send', async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    const dialog = render();
    type(dialog.box(), 'hi');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      dialog.contact().dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('Prompt your agent to send feedback hands over what is typed so far, and sends nothing', async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    const drafts: string[] = [];
    const dialog = render({ onCopyPrompt: (draft) => drafts.push(draft) });
    type(dialog.box(), 'Half a thought');
    await press(dialog.copy());
    expect(drafts).toEqual(['Half a thought']);
    expect(calls).toHaveLength(0);
  });
});

describe('the copy prompt', () => {
  test('the command reads `plannotator feedback`, with the installed binary only as the fallback; the agent asks first', () => {
    const prompt = feedbackPrompt([BIN, 'inbox', 'mcp']);
    // Pinned on purpose (owner, 2026-10-27): installed users see `plannotator feedback …`, never an execPath.
    // The text goes on stdin: a QUOTED heredoc with an end word no feedback quotes (bash; feedback-command.test.ts runs it),
    // or a single-quoted here-string with UTF-8 output (PowerShell). Never double quotes, which expand $VAR and backticks.
    expect(prompt).toContain(`<<'${FEEDBACK_HEREDOC_END}'\n${FEEDBACK_PROMPT_TEXT_LINE}\n${FEEDBACK_HEREDOC_END}\n`);
    expect(prompt).toContain(`$OutputEncoding = [Text.UTF8Encoding]::new($false)\n@'\n${FEEDBACK_PROMPT_TEXT_LINE}\n'@ | plannotator feedback --stdin`);
    expect(prompt).not.toContain("<<'EOF'");
    expect(prompt).not.toContain('feedback "');
    expect(prompt).toContain('`plannotator feedback --help`');
    expect(prompt).toContain(`If \`plannotator\` is not found, use ${BIN} in its place.`);
    expect(prompt).not.toContain(`${BIN} feedback`);
    // Windows: the .exe is the installed binary too.
    expect(feedbackPrompt(['C:\\Users\\ada\\AppData\\Local\\plannotator\\plannotator.exe', 'inbox', 'mcp'])).toContain('plannotator.exe');
    // Pinned on purpose: the owner's rule that the agent shows the exact text and waits for a yes.
    expect(prompt).toContain('Show me the exact text you will send');
    expect(prompt).toContain('Only after I say yes');
    // No draft: no quote.
    expect(prompt).not.toContain('> ');
  });

  test('a source run (bun plus a script) or settings not loaded: bare plannotator, and no runtime path anywhere', () => {
    for (const command of [null, ['/private/tmp/bun-darwin-aarch64/bun', 'inbox', 'mcp'], ['/opt/bun', '/repo/apps/hook/server/index.ts', 'inbox', 'mcp']]) {
      const prompt = feedbackPrompt(command);
      expect(prompt).toContain("plannotator feedback --stdin");
      expect(prompt).not.toContain('bun');
      expect(prompt).not.toContain('not found');
    }
  });

  test('a draft is quoted line by line for the agent to start from', () => {
    const prompt = feedbackPrompt(null, 'First line\nSecond line');
    expect(prompt).toContain('> First line\n> Second line');
  });

  test('the toast says copied, or that it was not', () => {
    expect(feedbackCopiedToast(true)).toMatchObject({ icon: 'check', lead: 'Prompt copied' });
    expect(feedbackCopiedToast(false)).toMatchObject({ icon: 'warn' });
  });
});

describe.skipIf(!hasDom)('the sidebar row', () => {
  function sidebar(onFeedback?: () => void) {
    const host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    root = createRoot(host);
    const noop = () => {};
    act(() =>
      root!.render(
        <SidebarProvider>
          <Sidebar
            page="inbox"
            projectId={null}
            inboxCount={0}
            projects={[]}
            projectCounts={new Map()}
            update={null}
            restarting={false}
            updated={null}
            onInbox={noop}
            onProject={noop}
            onSettings={noop}
            onUpdate={noop}
            onWhatsNew={noop}
            mcpCommand={[BIN, 'inbox', 'mcp']}
            onFeedback={onFeedback}
          />
        </SidebarProvider>,
      ),
    );
    return host;
  }

  test('Feedback sits in the foot right above the Settings row and opens the dialog', async () => {
    let opened = 0;
    const host = sidebar(() => (opened += 1));
    const row = host.querySelector<HTMLButtonElement>('[data-feedback-nav]')!;
    expect(row.closest('.ib-side-foot')).not.toBeNull();
    expect(row.nextElementSibling?.classList.contains('ib-setrow')).toBe(true);
    expect(row.getAttribute('aria-haspopup')).toBe('dialog');
    await act(async () => row.click());
    expect(opened).toBe(1);
  });

  test('no handler, no row', () => {
    const host = sidebar(undefined);
    expect(host.querySelector('[data-feedback-nav]')).toBeNull();
  });
});
