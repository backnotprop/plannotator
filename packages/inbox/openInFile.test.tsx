import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { GuideCodeSpanContext, renderInlineMarkdown } from '@plannotator/guide-viewer/renderInlineMarkdown';
import { createRoot, type Root } from 'react-dom/client';
import { HOVER_PREVIEW_HIDE_DELAY_MS, HOVER_PREVIEW_SHOW_DELAY_MS } from '@plannotator/ui/hooks/useHoverPreview';

const hasDom = typeof document !== 'undefined';
const { OpenInCodeHover, OpenInCodeSpan, OpenInCodeSpans, OpenInFile, useOpenInCodeRegion } = (hasDom ? await import('./components/OpenIn') : {}) as typeof import('./components/OpenIn');
const { ShapeInline } = (hasDom ? await import('@plannotator/ui/components/shape/inline') : {}) as typeof import('@plannotator/ui/components/shape/inline');
const { InboxFileSourceProvider, INBOX_FILE_SOURCE } = (hasDom ? await import('./fileSource') : {}) as typeof import('./fileSource');

type Asked = { method: string; url: string; body: Record<string, unknown> | null };

const APPS = { available: true, platform: 'mac', apps: [{ id: 'reveal', label: 'Finder', kind: 'file-manager', icon: 'finder' }, { id: 'vscode', label: 'VS Code', kind: 'editor', icon: 'vscode' }] };
const REAL = '/work/app/src/a.ts';
const FILE = `${Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedMatch: typeof window.matchMedia;
let asked: Asked[] = [];
let answers: { apps: { status: number; body: unknown }; file: { status: number; body: unknown }; code: { status: number; body: unknown } };

beforeEach(() => {
  if (!hasDom) return;
  asked = [];
  answers = { apps: { status: 200, body: APPS }, file: { status: 200, body: { found: true, path: REAL, kind: 'code' } }, code: { status: 200, body: { found: true, contents: FILE } } };
  savedFetch = globalThis.fetch;
  savedMatch = window.matchMedia;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    asked.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const answer = url.includes('/open-in/apps') ? answers.apps : url.includes('/open-in/file/code') ? answers.code : method === 'POST' ? { status: 200, body: { ok: true } } : answers.file;
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => root?.unmount());
  host?.remove();
  globalThis.fetch = savedFetch;
  window.matchMedia = savedMatch;
  root = null;
  host = null;
});

async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20));
  });
}

const caret = () => host!.querySelector('[data-open-in-caret]');
const fileReads = () => asked.filter((a) => a.url.includes('/open-in/file') && !a.url.includes('/file/code') && a.method === 'GET');

test.skipIf(!hasDom)('through the tailnet: the apps route refuses, so nothing draws and no file is asked about', async () => {
  answers.apps = { status: 403, body: { code: 'local_only' } };
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_tailnet' }} path="src/a.ts" />));
  await settle();
  expect(host!.innerHTML).toBe('');
  expect(fileReads()).toHaveLength(0);
});

test.skipIf(!hasDom)('a file on disk: the split button; its primary launches with the scope, the path and the line, and no root', async () => {
  await act(async () => root!.render(<OpenInFile scope={{ shape: 'shp_one' }} path="src/a.ts" line={12} />));
  await settle();
  expect(caret()).not.toBeNull();
  const read = new URL(fileReads()[0]!.url, 'http://x').searchParams;
  expect(Object.fromEntries(read)).toEqual({ shape: 'shp_one', path: 'src/a.ts' });
  const primary = host!.querySelector<HTMLButtonElement>('[data-open-in-primary]')!;
  expect(primary.getAttribute('data-open-in-primary')).toBe('vscode');
  await act(async () => primary.click());
  await settle();
  const post = asked.find((a) => a.method === 'POST')!;
  const { serverSession: _session, ...body } = post.body!;
  expect(body).toEqual({ shape: 'shp_one', path: 'src/a.ts', app_id: 'vscode', line: 12 });
});

test.skipIf(!hasDom)('a file that is not here: nothing at all', async () => {
  answers.file = { status: 200, body: { found: false } };
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_a' }} path="src/gone.ts" />));
  await settle();
  expect(fileReads()).toHaveLength(1);
  expect(host!.innerHTML).toBe('');
});

test.skipIf(!hasDom)('a file the last read found and this one does not: the control goes away', async () => {
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_b' }} path="src/moved.ts" />));
  await settle();
  expect(caret()).not.toBeNull();
  answers.file = { status: 200, body: { found: false } };
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_b' }} path="src/other.ts" />));
  await settle();
  expect(host!.innerHTML).toBe('');
});

test.skipIf(!hasDom)('on a phone: nothing, and nothing is asked', async () => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  await act(async () => root!.render(<OpenInFile scope={{ thread: 'msg_p' }} path="src/a.ts" />));
  await settle();
  expect(host!.innerHTML).toBe('');
  expect(fileReads()).toHaveLength(0);
});

test.skipIf(!hasDom)('a source that writes nothing (the tour): nothing', async () => {
  await act(async () =>
    root!.render(
      <InboxFileSourceProvider source={{ ...INBOX_FILE_SOURCE, writes: false }}>
        <OpenInFile scope={{ thread: 'msg_t' }} path="src/a.ts" />
      </InboxFileSourceProvider>,
    ),
  );
  await settle();
  expect(host!.innerHTML).toBe('');
  expect(fileReads()).toHaveLength(0);
});

describe('words that name a file', () => {
  const scope = { thread: 'msg_span', message: 'msg_span2' };
  const words = () => host!.querySelector('[data-code-hover]') as HTMLElement;
  const codeWindow = () => document.querySelector('[data-code-snippet-preview]') as HTMLElement | null;
  const rows = () => [...codeWindow()!.querySelectorAll('tbody tr')].map((row) => row.querySelector('td:last-child')!.textContent);
  const marked = () => [...codeWindow()!.querySelectorAll('[data-target-line]')].map((row) => row.querySelector('td:last-child')!.textContent);
  const codeReads = () => asked.filter((a) => a.url.includes('/open-in/file/code'));
  const touchScreen = () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('coarse') || query.includes('pointer') || query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  };
  const draw = (text = 'src/a.ts:12') =>
    act(async () => root!.render(<OpenInCodeSpan scope={scope} text={text}><code>{text}</code></OpenInCodeSpan>));
  const rest = async () => {
    await act(async () => {
      words().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((done) => setTimeout(done, HOVER_PREVIEW_SHOW_DELAY_MS + 40));
    });
    await settle();
  };
  const leave = async (element: Element = words()) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      await new Promise((done) => setTimeout(done, HOVER_PREVIEW_HIDE_DELAY_MS + 40));
    });
  };
  const tap = async () => {
    await act(async () => {
      words().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, HOVER_PREVIEW_SHOW_DELAY_MS + 40));
    });
    await settle();
  };

  afterEach(() => {
    if (hasDom) window.getSelection()?.removeAllRanges();
  });

  test.skipIf(!hasDom)('asks nothing until the pointer rests, then shows the code around the line, with Open', async () => {
    await draw();
    await settle();
    expect(words().querySelector('code')!.textContent).toBe('src/a.ts:12');
    expect(asked.filter((a) => a.url.includes('/open-in/'))).toHaveLength(0);
    await rest();
    expect(codeReads()[0]!.url).toContain('path=src%2Fa.ts');
    expect(codeReads()[0]!.url).toContain('thread=msg_span');
    expect(marked()).toEqual(['line 12']);
    expect(rows().at(0)).toBe('line 6');
    expect(rows().at(-1)).toBe('line 18');
    expect(codeWindow()!.querySelector('[data-open-in-caret]')).not.toBeNull();
    expect(codeWindow()!.querySelector('[data-code-hover-close]')).toBeNull();
    expect(host!.querySelector('[data-open-in]')).toBeNull();
  });

  test.skipIf(!hasDom)('a range marks every line of it; no line shows the top of the file; a line past the end does too', async () => {
    await draw('src/a.ts:12-14');
    await rest();
    expect(marked()).toEqual(['line 12', 'line 13', 'line 14']);
    await leave();
    await act(async () => root!.render(<div />));
    await draw('src/a.ts');
    await rest();
    expect(rows()).toHaveLength(40);
    expect(rows()[0]).toBe('line 1');
    expect(marked()).toEqual([]);
    await leave();
    await act(async () => root!.render(<div />));
    await draw('src/a.ts:900');
    await rest();
    expect(rows()[0]).toBe('line 1');
    expect(marked()).toEqual([]);
  });

  test.skipIf(!hasDom)('a short file named with no line has no empty row after its last line', async () => {
    answers.code = { status: 200, body: { found: true, contents: 'one\ntwo\n' } };
    await draw('src/a.ts');
    await rest();
    expect(rows()).toEqual(['one', 'two']);
  });

  test.skipIf(!hasDom)('moving from the words into the window keeps it; leaving both closes it', async () => {
    await draw();
    await rest();
    await act(async () => {
      words().dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      codeWindow()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((done) => setTimeout(done, HOVER_PREVIEW_HIDE_DELAY_MS + 40));
    });
    expect(codeWindow()).not.toBeNull();
    await leave(codeWindow()!);
    expect(codeWindow()).toBeNull();
  });

  test.skipIf(!hasDom)('its own code scrolling keeps it; the page scrolling closes it, which it would drift from', async () => {
    await draw();
    await rest();
    await act(async () => {
      codeWindow()!.querySelector('.code-snippet-preview')!.dispatchEvent(new Event('scroll'));
    });
    expect(codeWindow()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new Event('scroll'));
    });
    expect(codeWindow()).toBeNull();
  });

  test.skipIf(!hasDom)('the window stays while its editor list is open, and a pick sends the scope, the path and the line', async () => {
    await draw();
    await rest();
    await act(async () => {
      codeWindow()!.querySelector('[data-open-in-caret]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((done) => setTimeout(done, 20));
    });
    await leave();
    expect(codeWindow()).not.toBeNull();
    const pick = document.querySelector('[data-open-in-menu] [data-open-in-item="vscode"]') as HTMLElement;
    await act(async () => {
      pick.click();
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(asked.find((a) => a.method === 'POST')!.body).toMatchObject({ thread: 'msg_span', message: 'msg_span2', path: 'src/a.ts', line: 12, app_id: 'vscode' });
  });

  test.skipIf(!hasDom)('a click in the window never reaches the page under it', async () => {
    let clicked = 0;
    await act(async () => root!.render(<div onClick={() => (clicked += 1)}><OpenInCodeSpan scope={scope} text="src/a.ts"><code>src/a.ts</code></OpenInCodeSpan></div>));
    await rest();
    await act(async () => codeWindow()!.click());
    expect(clicked).toBe(0);
  });

  test.skipIf(!hasDom)('a file that is only in the PR: its version, named, with the forge at those lines and no Open', async () => {
    answers.file = { status: 200, body: { found: false } };
    answers.code = { status: 200, body: { found: true, contents: FILE, pull: { label: '#412', platform: 'github', url: 'https://github.com/o/r/blob/abc/src/a.ts' } } };
    await draw('src/a.ts:12-14');
    await rest();
    expect(codeWindow()!.textContent).toContain('src/a.ts · #412');
    const forge = codeWindow()!.querySelector('[data-code-hover-forge]') as HTMLAnchorElement;
    expect(forge.getAttribute('href')).toBe('https://github.com/o/r/blob/abc/src/a.ts#L12-L14');
    expect(forge.textContent).toBe('Open on GitHub');
    expect(codeWindow()!.querySelector('[data-open-in-caret]')).toBeNull();
  });

  test.skipIf(!hasDom)('words that name no file show nothing and stay as they were', async () => {
    answers.code = { status: 200, body: { found: false } };
    await draw('react.js');
    await rest();
    expect(codeWindow()).toBeNull();
    expect(words().querySelector('code')!.textContent).toBe('react.js');
  });

  test.skipIf(!hasDom)('the words of a link that names no file then show why they are not a link', async () => {
    answers.code = { status: 200, body: { found: false } };
    await act(async () => root!.render(<OpenInCodeHover scope={scope} path="src/gone.ts" title="Not attached"><span>the file</span></OpenInCodeHover>));
    await rest();
    expect(codeWindow()).toBeNull();
    expect(document.querySelector('[data-pn-tooltip]')?.textContent).toBe('Not attached');
  });

  test.skipIf(!hasDom)('by keyboard: Enter shows it, Enter again goes in, Escape closes it and returns, and the page keeps no Escape', async () => {
    let pageEscape = 0;
    const onPage = (event: KeyboardEvent) => {
      if (event.key === 'Escape') pageEscape += 1;
    };
    document.addEventListener('keydown', onPage);
    try {
      await draw();
      words().focus();
      const press = async (target: Element, key: string) => {
        await act(async () => {
          target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
          await new Promise((done) => setTimeout(done, HOVER_PREVIEW_SHOW_DELAY_MS + 40));
        });
        await settle();
      };
      await press(words(), 'Enter');
      expect(codeWindow()).not.toBeNull();
      await press(words(), 'Enter');
      expect(codeWindow()!.contains(document.activeElement)).toBe(true);
      await press(document.activeElement!, 'Escape');
      expect(codeWindow()).toBeNull();
      expect(document.activeElement).toBe(words());
      expect(pageEscape).toBe(0);
      await press(words(), 'Escape');
      expect(pageEscape).toBe(1);
    } finally {
      document.removeEventListener('keydown', onPage);
    }
  });

  test.skipIf(!hasDom)('on a touch screen a hover does nothing, and a tap shows a sheet with no Open that Close and the scrim dismiss', async () => {
    touchScreen();
    await draw();
    await rest();
    expect(codeWindow()).toBeNull();
    await tap();
    expect(codeWindow()!.hasAttribute('data-code-snippet-sheet')).toBe(true);
    expect(marked()).toEqual(['line 12']);
    expect(codeWindow()!.querySelector('[data-open-in-caret]')).toBeNull();
    expect(asked.filter((a) => a.url.includes('/open-in/apps'))).toHaveLength(0);
    await act(async () => (codeWindow()!.querySelector('[data-code-hover-close]') as HTMLElement).click());
    expect(codeWindow()).toBeNull();
    await tap();
    await act(async () => (document.querySelector('[data-code-snippet-scrim]') as HTMLElement).click());
    expect(codeWindow()).toBeNull();
  });

  test.skipIf(!hasDom)('a phone\'s sheet for a PR\'s file links to the forge', async () => {
    touchScreen();
    answers.code = { status: 200, body: { found: true, contents: FILE, pull: { label: '!7', platform: 'gitlab', url: 'https://gitlab.com/o/r/-/blob/abc/src/a.ts' } } };
    await draw('src/a.ts:12-14');
    await tap();
    const forge = codeWindow()!.querySelector('[data-code-hover-forge]') as HTMLAnchorElement;
    expect(forge.getAttribute('href')).toBe('https://gitlab.com/o/r/-/blob/abc/src/a.ts#L12-14');
    expect(forge.textContent).toBe('Open on GitLab');
  });

  test.skipIf(!hasDom)('in the tour nothing is asked', async () => {
    await act(async () =>
      root!.render(
        <InboxFileSourceProvider source={{ ...INBOX_FILE_SOURCE, writes: false }}>
          <OpenInCodeSpan scope={scope} text="src/a.ts"><code>src/a.ts</code></OpenInCodeSpan>
        </InboxFileSourceProvider>,
      ),
    );
    expect(host!.querySelector('[data-code-hover]')).toBeNull();
    expect(host!.querySelector('code')).not.toBeNull();
  });
});

describe('words with a comment\'s marks around them', () => {
  const scope = { thread: 'msg_mark' };
  const codeWindow = () => document.querySelector('[data-code-snippet-preview]') as HTMLElement | null;
  const markTheWordsAfter = () => {
    const after = host!.querySelector('[data-after]')!.firstChild!;
    const mark = document.createElement('mark');
    after.parentNode!.insertBefore(mark, after);
    mark.appendChild(after);
  };
  const draw = (title?: string) =>
    act(async () =>
      root!.render(
        <p>
          before <OpenInCodeHover scope={scope} path="src/a.ts" title={title}><code>src/a.ts</code></OpenInCodeHover>
          <span style={{ display: 'contents' }} data-after="">after</span>
        </p>,
      ),
    );
  const rest = async (buttons = 0) => {
    await act(async () => {
      host!.querySelector('[data-code-hover]')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, buttons }));
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, HOVER_PREVIEW_SHOW_DELAY_MS + 40));
    });
    await settle();
  };

  test.skipIf(!hasDom)('resting on them shows the code and adds nothing among the words', async () => {
    await draw();
    const before = [...host!.querySelector('p')!.childNodes];
    markTheWordsAfter();
    await rest();
    expect(codeWindow()).not.toBeNull();
    expect(codeWindow()!.hasAttribute('data-code-hover-raised')).toBe(false);
    expect([...host!.querySelector('p')!.childNodes]).toEqual(before);
  });

  test.skipIf(!hasDom)('a file that is missing keeps the words in place, and the words still there', async () => {
    answers.code = { status: 200, body: { found: false } };
    await draw('Not on this computer');
    markTheWordsAfter();
    const words = host!.querySelector('[data-code-hover]')!;
    const highlight = document.createElement('mark');
    words.querySelector('code')!.appendChild(highlight);
    await rest();
    expect(codeWindow()).toBeNull();
    expect(host!.querySelector('[data-code-hover]')).toBe(words);
    expect(words.contains(highlight)).toBe(true);
    expect(document.querySelector('[data-pn-tooltip]')?.textContent).toBe('Not on this computer');
    expect(words.getAttribute('aria-description')).toBe('Not on this computer');
  });

  test.skipIf(!hasDom)('a drag over them is a selection: nothing opens or is asked', async () => {
    await draw();
    await rest(1);
    expect(asked.filter((a) => a.url.includes('/open-in/file/code'))).toEqual([]);
    expect(codeWindow()).toBeNull();
  });
});

function Region({ scope, on, children }: { scope: { thread: string }; on: boolean; children: ReactNode }) {
  const region = useOpenInCodeRegion(scope, on);
  return (
    <div data-host="" {...region.handlers}>
      {children}
      {region.window}
    </div>
  );
}

describe('code spans drawn as HTML: Ask AI\'s answers', () => {
  const scope = { thread: 'msg_ask' };
  const codeWindow = () => document.querySelector('[data-code-snippet-preview]') as HTMLElement | null;
  const draw = (on = true) =>
    act(async () =>
      root!.render(
        <Region scope={scope} on={on}>
          <div dangerouslySetInnerHTML={{ __html: '<p>See <code id="a">src/a.ts:12</code>, <code id="b">src/b.ts:2-3</code>, <a id="l" href="src/l.ts:4">the file</a> and <a id="x" href="https://example.com/x.ts">the site</a>.</p><pre><code id="p">src/c.ts</code></pre>' }} />
        </Region>,
      ),
    );
  const fire = async (id: string, type: string, wait = HOVER_PREVIEW_SHOW_DELAY_MS) => {
    await act(async () => {
      document.getElementById(id)!.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' && type !== 'mouseleave', cancelable: true }));
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, wait + 40));
    });
    await settle();
  };
  const over = (id: string) => fire(id, 'mouseover');
  const reads = () => asked.filter((a) => a.url.includes('/open-in/file/code')).map((a) => a.url);

  test.skipIf(!hasDom)('a span or a link names its file and shows its code; another replaces it; a code block and a web link ask nothing', async () => {
    await draw();
    await settle();
    await over('x');
    await over('p');
    await act(async () => {
      document.getElementById('a')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, buttons: 1 }));
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, HOVER_PREVIEW_SHOW_DELAY_MS + 40));
    });
    await settle();
    expect(reads()).toEqual([]);
    await over('a');
    expect(reads()[0]).toContain('thread=msg_ask');
    expect(reads()[0]).toContain(encodeURIComponent('src/a.ts'));
    expect(codeWindow()).not.toBeNull();
    expect(codeWindow()!.hasAttribute('data-code-hover-raised')).toBe(true);
    expect(document.getElementById('a')!.closest('[data-host]')!.parentElement).toBe(host);
    await over('b');
    expect(document.querySelectorAll('[data-code-snippet-preview]')).toHaveLength(1);
    expect(codeWindow()!.querySelectorAll('[data-target-line]')).toHaveLength(2);
    await over('l');
    expect(reads().at(-1)).toContain(encodeURIComponent('src/l.ts'));
    const followed = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      document.getElementById('l')!.dispatchEvent(followed);
    });
    expect(followed.defaultPrevented).toBe(true);
  });

  test.skipIf(!hasDom)('leaving the span closes it, and coming back shows it again', async () => {
    await draw();
    await over('a');
    await fire('a', 'mouseleave', HOVER_PREVIEW_HIDE_DELAY_MS);
    expect(codeWindow()).toBeNull();
    await fire('a', 'mouseenter');
    expect(codeWindow()).not.toBeNull();
  });

  test.skipIf(!hasDom)('off with Code review: nothing is asked, a link is left alone, and the host\'s element is as it was', async () => {
    await draw(false);
    expect(host!.firstElementChild!.hasAttribute('data-host')).toBe(true);
    expect(host!.children).toHaveLength(1);
    expect(host!.firstElementChild!.children).toHaveLength(1);
    await over('a');
    expect(reads()).toEqual([]);
    expect(codeWindow()).toBeNull();
    const followed = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      document.getElementById('l')!.dispatchEvent(followed);
    });
    expect(followed.defaultPrevented).toBe(false);
  });

  test.skipIf(!hasDom)('on a touch screen a hover does nothing, and a tap shows the sheet', async () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('coarse') || query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    await draw();
    await over('a');
    expect(codeWindow()).toBeNull();
    await fire('a', 'click');
    expect(codeWindow()!.hasAttribute('data-code-snippet-sheet')).toBe(true);
  });
});

describe('code spans in a guide and a board', () => {
  const scope = { shape: 'shp_x' };
  const spans = () => [...host!.querySelectorAll('[data-code-hover]')].map((el) => el.getAttribute('data-code-hover'));

  test.skipIf(!hasDom)('a guide: a span naming a file is the control, others and a link label are not', async () => {
    const renderLink = (href: string, label: ReactNode, key: number) => <button key={key} data-link={href}>{label}</button>;
    await act(async () =>
      root!.render(
        <GuideCodeSpanContext.Provider value={(text, code) => <OpenInCodeSpan scope={scope} text={text}>{code}</OpenInCodeSpan>}>
          <p>{renderInlineMarkdown('See `src/a.ts:3`, `not code` and [`src/label.ts`](code:src/label.ts).', { renderLink })}</p>
        </GuideCodeSpanContext.Provider>,
      ),
    );
    expect(spans()).toEqual(['src/a.ts']);
    expect(host!.querySelector('[data-link]')!.querySelector('code')!.textContent).toBe('src/label.ts');
  });

  test.skipIf(!hasDom)('a board: a span naming a file is the control, a number stays a number', async () => {
    await act(async () =>
      root!.render(
        <OpenInCodeSpans scope={scope} on>
          <p><ShapeInline text="See **`src/b.ts`**, `not code`." /></p>
        </OpenInCodeSpans>,
      ),
    );
    expect(spans()).toEqual(['src/b.ts']);
  });

  test.skipIf(!hasDom)('with Code review off, and with no host, both draw the same plain span', async () => {
    const drawn = async (node: ReactNode) => {
      await act(async () => root!.render(<div>{node}</div>));
      return host!.innerHTML;
    };
    const guide = () => <p>{renderInlineMarkdown('See `src/a.ts`.')}</p>;
    const board = () => <p><ShapeInline text="See `src/a.ts`." /></p>;
    const plainGuide = await drawn(guide());
    const plainBoard = await drawn(board());
    expect(await drawn(<GuideCodeSpanContext.Provider value={null}>{guide()}</GuideCodeSpanContext.Provider>)).toBe(plainGuide);
    expect(await drawn(<OpenInCodeSpans scope={scope} on={false}>{board()}</OpenInCodeSpans>)).toBe(plainBoard);
    expect(spans()).toEqual([]);
    expect(asked.filter((a) => a.url.includes('/open-in/'))).toHaveLength(0);
  });
});
