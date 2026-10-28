import { describe, expect, test } from 'bun:test';
import {
  describeAskDocument,
  EMPTY_ASK_DOCUMENT_LATCH,
  isReadableDocumentPath,
  MAX_ASK_DOCUMENT_HISTORY,
  planAskDocumentContext,
  type AskDocument,
  type AskDocumentLatch,
} from './askDocumentContext';

const file = (path: string, content = `# ${path}\n\nBody of ${path}.\n`, extra: Partial<Parameters<typeof describeAskDocument>[0]> = {}) =>
  describeAskDocument({ kind: 'document', path, renderAs: 'markdown', content, ...extra });

/** Ask one question per document, as the editor does: each question's note is
 *  delivered, so the latch moves on to what it named. */
function askAlong(docs: AskDocument[], sessionBridge = false): string[] {
  let latch: AskDocumentLatch = EMPTY_ASK_DOCUMENT_LATCH;
  return docs.map((doc, i) => {
    const plan = planAskDocumentContext(latch, doc, { freshSession: i === 0, sessionBridge });
    latch = plan.next;
    return plan.preamble;
  });
}

describe('isReadableDocumentPath', () => {
  test('absolute paths only, never URLs or placeholders', () => {
    expect(isReadableDocumentPath('/home/me/notes.md')).toBe(true);
    expect(isReadableDocumentPath('C:\\docs\\a.md')).toBe(true);
    expect(isReadableDocumentPath('https://example.com/a')).toBe(false);
    expect(isReadableDocumentPath('agent message')).toBe(false);
    expect(isReadableDocumentPath('docs/a.md')).toBe(false);
    expect(isReadableDocumentPath(undefined)).toBe(false);
  });
});

describe('planAskDocumentContext', () => {
  test('the question that creates the session carries no note', () => {
    const [first] = askAlong([file('/w/alpha.md')]);
    expect(first).toBe('');
  });

  test('the same document twice sends nothing again', () => {
    const alpha = file('/w/alpha.md');
    const notes = askAlong([alpha, file('/w/beta.md'), file('/w/beta.md'), file('/w/beta.md')]);
    expect(notes[2]).toBe('');
    expect(notes[3]).toBe('');
  });

  test('an edit to a file on disk is not a new document: the agent re-reads it', () => {
    const notes = askAlong([file('/w/alpha.md'), file('/w/beta.md', 'v1'), file('/w/beta.md', 'v2 edited')]);
    expect(notes[2]).toBe('');
  });

  test('a switch names the new path and the earlier ones, never the text', () => {
    const notes = askAlong([file('/w/alpha.md', 'ALPHA SECRET TEXT'), file('/w/beta.md', 'BETA SECRET TEXT')]);
    expect(notes[1]).toContain('/w/beta.md');
    expect(notes[1]).toContain('read the file');
    expect(notes[1]).toContain('Viewed earlier in this chat, most recent first: /w/alpha.md.');
    expect(notes[1]).not.toContain('SECRET TEXT');
  });

  test('history is most recent first, without repeats, and capped', () => {
    const paths = Array.from({ length: MAX_ASK_DOCUMENT_HISTORY + 4 }, (_, i) => `/w/doc-${i}.md`);
    const docs = [...paths.map(p => file(p)), file('/w/doc-3.md'), file('/w/last.md')];
    const notes = askAlong(docs);
    const last = notes[notes.length - 1]!;
    const listed = last.split('most recent first: ')[1]!.replace(/\.$/, '').split(', ');
    expect(listed).toHaveLength(MAX_ASK_DOCUMENT_HISTORY);
    expect(listed[0]).toBe('/w/doc-3.md');
    expect(listed.filter(p => p === '/w/doc-3.md')).toHaveLength(1);
    expect(listed[1]).toBe(`/w/doc-${paths.length - 1}.md`);
  });

  test('coming back to a document says so', () => {
    const notes = askAlong([file('/w/alpha.md'), file('/w/beta.md'), file('/w/alpha.md')]);
    expect(notes[2]).toContain('is back on /w/alpha.md');
    expect(notes[2]).toContain('most recent first: /w/beta.md.');
  });

  test('raw HTML and converted documents say how they are shown', () => {
    const notes = askAlong([
      file('/w/a.md'),
      file('/w/page.html', '<p>x</p>', { renderAs: 'html' }),
      file('/w/other.html', '# converted', { converted: true }),
    ]);
    expect(notes[1]).toContain('/w/page.html (shown as a rendered HTML page)');
    expect(notes[2]).toContain('converted to markdown');
  });

  test('a URL page carries its text once, when it changes', () => {
    const url = (content: string) => describeAskDocument({
      kind: 'document', path: 'https://example.com/a', sourceUrl: 'https://example.com/a', content,
    });
    const notes = askAlong([file('/w/a.md'), url('Page text one'), url('Page text one'), url('Page text two')]);
    expect(notes[1]).toContain('https://example.com/a');
    expect(notes[1]).toContain('Page text one');
    expect(notes[2]).toBe('');
    expect(notes[3]).toContain('Page text two');
    expect(notes[3]).not.toContain('Page text one');
  });

  test('an agent message carries its text once; going back to it does not resend it', () => {
    const message = (content: string) => describeAskDocument({
      kind: 'document', path: 'agent message', label: "the agent's message", content,
    });
    const notes = askAlong([message('First message'), message('Second message'), message('First message')]);
    expect(notes[1]).toContain("the agent's message");
    expect(notes[1]).toContain('Second message');
    expect(notes[2]).toContain('is back on');
    expect(notes[2]).not.toContain('First message');
  });

  test('"Ask this session" never gets a pasted text', () => {
    const url = describeAskDocument({ kind: 'document', path: 'https://example.com/a', content: 'Page text' });
    const notes = askAlong([file('/w/a.md'), url], true);
    expect(notes[1]).toContain('https://example.com/a');
    expect(notes[1]).not.toContain('Page text');
  });

  test('pasted text cannot close its block early', () => {
    const md = describeAskDocument({ kind: 'document', path: 'agent message', content: 'a\n````\nb' });
    const [, note] = askAlong([file('/w/a.md'), md]);
    expect(note).toContain('`````markdown');
  });

  test('a plan revision names the new version file', () => {
    const plan = (version: number) => describeAskDocument({
      kind: 'plan', path: `/data/history/p/s/00${version}.md`, version, content: `# Plan v${version}`,
    });
    const notes = askAlong([plan(1), plan(2), plan(2)]);
    expect(notes[1]).toContain('The plan was revised to version 2: /data/history/p/s/002.md');
    expect(notes[1]).toContain('/data/history/p/s/001.md (plan version 1)');
    expect(notes[1]).not.toContain('# Plan v2');
    expect(notes[2]).toBe('');
  });

  test('"Ask this session": a revision names the plan\'s own file, never the history copy', () => {
    const plan = (version: number) => describeAskDocument({
      kind: 'plan', path: `/data/.plannotator/history/p/s/00${version}.md`, ownPath: '/home/me/.claude/plans/rollout.md',
      version, content: `# Plan v${version}`,
    });
    const notes = askAlong([plan(1), plan(2)], true);
    expect(notes[1]).toContain('The plan was revised to version 2: /home/me/.claude/plans/rollout.md.');
    expect(notes[1]).not.toContain('.plannotator');
    expect(notes[1]).not.toContain('read the file');
    expect(notes[1]).toContain('Viewed earlier in this chat, most recent first: the plan (version 1).');
    expect(notes[1]).not.toContain('# Plan v2');
  });

  test('"Ask this session": with no own plan file, a revision only says it was revised', () => {
    const plan = (version: number) => describeAskDocument({
      kind: 'plan', path: `/data/.plannotator/history/p/s/00${version}.md`, version, content: `# Plan v${version}`,
    });
    const notes = askAlong([plan(1), plan(2), plan(2)], true);
    expect(notes[1]).toContain('The plan was revised to version 2. This replaces the plan shown earlier in this chat.');
    expect(notes[1]).not.toContain('.plannotator');
    expect(notes[1]).not.toContain('read the file');
    expect(notes[1]).not.toContain('# Plan v2');
    expect(notes[2]).toBe('');
  });

  test('a separate AI keeps the history copy even when the plan has its own file', () => {
    const plan = (version: number) => describeAskDocument({
      kind: 'plan', path: `/data/.plannotator/history/p/s/00${version}.md`, ownPath: '/home/me/.claude/plans/rollout.md',
      version, content: `# Plan v${version}`,
    });
    const notes = askAlong([plan(1), plan(2)]);
    expect(notes[1]).toContain('The plan was revised to version 2: /data/.plannotator/history/p/s/002.md.');
    expect(notes[1]).toContain('read the file for its current text');
  });

  test('a plan with no known file carries its revised text once', () => {
    const plan = (version: number) => describeAskDocument({ kind: 'plan', version, content: `# Plan text v${version}` });
    const notes = askAlong([plan(1), plan(2)]);
    expect(notes[1]).toContain('The plan was revised to version 2.');
    expect(notes[1]).toContain('# Plan text v2');
  });

  test('back to the plan from a linked document is not a revision', () => {
    const plan = describeAskDocument({ kind: 'plan', path: '/data/001.md', version: 1, content: 'p' });
    const notes = askAlong([plan, file('/w/linked.md'), plan]);
    expect(notes[2]).toContain('is back on the plan: /data/001.md');
    expect(notes[2]).not.toContain('revised');
  });

  test('a new session (provider switch, New chat) starts over with no note', () => {
    const a = planAskDocumentContext(EMPTY_ASK_DOCUMENT_LATCH, file('/w/a.md'), { freshSession: true, sessionBridge: false });
    const b = planAskDocumentContext(a.next, file('/w/b.md'), { freshSession: true, sessionBridge: false });
    expect(b.preamble).toBe('');
    expect(b.next.history).toEqual([]);
  });
});
