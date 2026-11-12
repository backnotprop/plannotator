import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxAttachment } from '@plannotator/core/inbox-types';
import type { PrototypeAppTarget } from '@plannotator/core/inbox-questions';
import { checkSendPrototypes, prototypeFileAttachment } from './inbox-prototypes';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-prototypes-')));
  roots.push(root);
  mkdirSync(join(root, 'proto'), { recursive: true });
  writeFileSync(join(root, 'proto', 'a.html'), '<p>A</p>');
  writeFileSync(join(root, 'proto', 'notes.md'), '# notes');
  return root;
}

function attached(root: string, rel: string, kind: InboxAttachment['kind']): InboxAttachment {
  return { id: `att_${rel.replace(/\W/g, '')}`, path: join(root, rel), named_path: null, name: rel.split('/').pop()!, kind, sent_sha256: 'a'.repeat(64), size: 1, sent_at: '', sent_mtime: '' };
}

const question = (lines: string[]) => [':::question', 'Which checkout ships?', ...lines, ':::'].join('\n');

async function refusal(body: string, options: Parameters<typeof checkSendPrototypes>[1]): Promise<string | null> {
  try {
    await checkSendPrototypes(body, options);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

test('a file prototype is one of the send\'s HTML attachments, from the folder sent from or the project root, or by its bare name', () => {
  const root = project();
  const a = attached(root, 'proto/a.html', 'html');
  expect(prototypeFileAttachment('proto/a.html', [a], [root])).toBe(a);
  expect(prototypeFileAttachment('a.html', [a], [join(root, 'elsewhere')])).toBe(a);
  expect(prototypeFileAttachment('./proto/a.html#total', [a], ['', root])).toBe(a);
  expect(prototypeFileAttachment(join(root, 'proto', 'a.html'), [a], [])).toBe(a);
  expect(prototypeFileAttachment('proto/b.html', [a], [root])).toBeNull();
});

test('refused before anything is written, naming the question and the option: a file not attached, a file that is not HTML, an app this Inbox does not take', async () => {
  const root = project();
  const a = attached(root, 'proto/a.html', 'html');
  const notes = attached(root, 'proto/notes.md', 'markdown');
  const bases = [root];
  const notAttached = await refusal(question(['- [ ] A · Classic', '    Prototype: proto/a.html', '- [ ] B · Total first', '    Prototype: proto/b.html']), { attachments: [a], bases, probing: true });
  expect(notAttached).toContain('body: question "Which checkout ships?", option "B · Total first": Prototype: proto/b.html: not in attachments');
  const notHtml = await refusal(question(['- [ ] A · Classic', '    Prototype: proto/notes.md', '- [ ] B']), { attachments: [notes], bases, probing: true });
  expect(notHtml).toContain('option "A · Classic": Prototype: proto/notes.md: a prototype is an HTML page');
  const shared = await refusal(question(['- [ ] A', '- [ ] B', 'Prototype: proto/gone.html']), { attachments: [a], bases, probing: true });
  expect(shared).toContain('question "Which checkout ships?" (its shared prototype): Prototype: proto/gone.html');
  const noApps = await refusal(question(['- [ ] A', '    Prototype: http://localhost:4000/a', '- [ ] B']), { attachments: [], bases, probing: true });
  expect(noApps).toContain('option "A": Prototype: http://localhost:4000/a: this Inbox shows no running app');
});

test('apps go to the live engine with their question and option, probed unless the send is a replay; files alone never reach it', async () => {
  const root = project();
  const a = attached(root, 'proto/a.html', 'html');
  const asked: { apps: readonly PrototypeAppTarget[]; probing?: boolean }[] = [];
  const checkApps = async (apps: readonly PrototypeAppTarget[], probing?: boolean) => {
    asked.push({ apps, probing });
    return apps.map((app, i) => ({ id: `liv_${i}`, url: app.target, opened_by: 'agent' as const }));
  };
  const body = question(['- [ ] A · Classic', '    Prototype: proto/a.html', '- [ ] B · Total first', '    Prototype: http://localhost:4000/checkout?v=b']);
  const checked = await checkSendPrototypes(body, { attachments: [a], bases: [root], checkApps, probing: false });
  expect(checked.liveSites).toEqual([{ id: 'liv_0', url: 'http://localhost:4000/checkout?v=b', opened_by: 'agent' }]);
  expect(asked).toEqual([{ apps: [{ target: 'http://localhost:4000/checkout?v=b', prompt: 'Which checkout ships?', label: 'B · Total first', kind: 'app' }], probing: false }]);
  await checkSendPrototypes(question(['- [ ] A', '    Prototype: proto/a.html', '- [ ] B']), { attachments: [a], bases: [root], checkApps, probing: true });
  expect(asked).toHaveLength(1);
});
