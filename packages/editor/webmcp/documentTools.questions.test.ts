/**
 * WebMCP and `:::question` blocks: browser agents can READ the questions and
 * the human's answers through `read_document`, and can never write an answer
 * (owner decision 5).
 *
 * What regresses if this fails: an agent reading the page cannot see what
 * the human answered (or sees an answer attached to the wrong question); a
 * document with no questions starts carrying a `questions` key; or a tool
 * gains a way to create, edit or remove an answer.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { questionAnswerToAnnotation } from '@plannotator/ui/utils/questionAnswers';
import { indexQuestionBlocks, type QuestionAnswer } from '@plannotator/shared/question-block';
import { runTool, type ToolResponse, type ToolSpec } from '@plannotator/ui/webmcp';
import {
  buildDocumentHooks,
  buildDocumentTools,
  createDocumentToolState,
  type DocumentSessionView,
  type DocumentToolAdapter,
} from './documentTools';

const PLAN = `# Offline sync

## Conflicts

:::question
Where should losing conflict versions be kept?

Last-write-wins silently drops the loser.

- [ ] Local only — cheap
- [ ] Server-side per user

Recommended: Local only
:::

## Transport

:::question
Which transport?

- [x] REST
- [ ] gRPC
:::

:::question-text
Describe the manual test.
:::
`;

function setup(text = PLAN) {
  const blocks = parseMarkdownToBlocks(text);
  const annotations: Annotation[] = [];
  const session: DocumentSessionView = {
    mode: 'plan', surface: 'markdown', source: { title: 'Offline sync', path: '/plan.md', url: null },
    gate: false, readOnly: false, decision: 'pending', commentOnly: false, sourceStale: false, editing: false,
    versions: null, pageUrl: null,
  };
  const adapter: DocumentToolAdapter = {
    getSession: () => session,
    getDocument: () => ({ path: '/plan.md', text, blocks, annotations }),
    readDocument: async () => null,
    getSiblingDocuments: () => [],
    getComposer: () => ({ open: false }),
    addAnnotation: (a) => { annotations.push(a); return true; },
    updateAnnotation: (id, patch) => { const i = annotations.findIndex((a) => a.id === id); if (i < 0) return false; annotations[i] = { ...annotations[i]!, ...patch }; return true; },
    removeAnnotation: (id) => { const i = annotations.findIndex((a) => a.id === id); if (i < 0) return false; annotations.splice(i, 1); return true; },
    revealAnnotation: () => true,
    revealSection: () => true,
    showBanner: () => {},
  };
  const state = createDocumentToolState();
  const toolName = (bare: string) => `plannotator.${bare}`;
  const hooks = buildDocumentHooks(adapter, state, toolName);
  const tools = buildDocumentTools(adapter, state, { writable: true, folder: false, toolName });
  const call = (name: string, input: unknown = {}): Promise<ToolResponse> => {
    const spec = tools.find((t) => t.name === name)!;
    return runTool(spec as ToolSpec<unknown, unknown>, hooks, input, { signal: new AbortController().signal });
  };
  const answer = (number: number, fields: Partial<QuestionAnswer>) => {
    const indexed = indexQuestionBlocks(blocks).find((q) => q.number === number)!;
    const value: QuestionAnswer = {
      v: 1, key: indexed.question.key, kind: indexed.question.kind, prompt: indexed.question.prompt,
      selected: [], sourceLine: indexed.line, ...fields,
    };
    const ann = questionAnswerToAnnotation(indexed.blockId, value, 1);
    annotations.push(ann);
    return ann;
  };
  return { annotations, call, answer, tools };
}

const dataOf = (r: ToolResponse): any => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.data;
};

describe('read_document questions', () => {
  test('lists every question with options, recommendation, status and the human answer', async () => {
    const fx = setup();
    const ann = fx.answer(1, { selected: ['Local only'], note: 'keep the log' });
    fx.answer(3, { skipped: true });
    const data = dataOf(await fx.call('read_document'));

    expect(data.questions.map((q: any) => [q.q, q.kind, q.status])).toEqual([
      [1, 'single', 'answered'],
      [2, 'single', 'settled'],
      [3, 'text', 'skipped'],
    ]);
    const [first, second, third] = data.questions;
    expect(first.prompt).toBe('Where should losing conflict versions be kept?');
    expect(first.context).toContain('Last-write-wins');
    expect(first.section).toEqual({ id: 'conflicts', title: 'Conflicts' });
    expect(first.recommended).toEqual(['Local only']);
    expect(first.options).toEqual([
      { label: 'Local only', description: 'cheap', recommended: true, settled: false },
      { label: 'Server-side per user', recommended: false, settled: false },
    ]);
    expect(first.answer).toEqual({ annotationId: ann.id, selected: ['Local only'], note: 'keep the log' });
    expect(second.options.find((o: any) => o.settled)?.label).toBe('REST');
    expect(second.answer).toBeUndefined();
    expect(third.answer).toEqual({ annotationId: expect.any(String), selected: [], skipped: true });

    // The answer is also a listed annotation, tied back to its question.
    const listed = data.annotations.find((a: any) => a.id === ann.id);
    expect(listed.answersQuestion).toBe(first.key);
  });

  test('an answer whose question left the document is listed as orphaned', async () => {
    const fx = setup();
    fx.answer(1, { selected: ['Local only'] });
    const orphan = { ...fx.annotations[0]!, id: 'ann-question-q-deadbeef', questionAnswer: { ...fx.annotations[0]!.questionAnswer!, key: 'q-deadbeef', prompt: 'An old prompt?' } };
    fx.annotations.push(orphan);
    const data = dataOf(await fx.call('read_document'));
    const listed = data.questions.find((q: any) => q.key === 'q-deadbeef');
    expect(listed).toMatchObject({ q: null, orphaned: true, prompt: 'An old prompt?', status: 'answered' });
  });

  test('a document without questions carries no questions key', async () => {
    const fx = setup('# Plan\n\nJust prose.\n');
    const data = dataOf(await fx.call('read_document'));
    expect('questions' in data).toBe(false);
  });

  test('include without questions omits them', async () => {
    const fx = setup();
    const data = dataOf(await fx.call('read_document', { include: ['outline'] }));
    expect('questions' in data).toBe(false);
  });
});

describe('answers are read-only to agents', () => {
  test('no tool name answers a question', () => {
    for (const tool of setup().tools) expect(tool.name).not.toMatch(/answer|question/i);
  });

  test('add_comments never creates an answer, even as a reply to one', async () => {
    const fx = setup();
    const ann = fx.answer(1, { selected: ['Server-side per user'] });
    const res = dataOf(await fx.call('add_comments', {
      comments: [
        { text: 'Local only is cheaper.', inReplyTo: ann.id },
        { text: 'Pick REST.', quote: 'Which transport?' },
      ],
    }));
    expect(res.results.every((r: any) => r.ok)).toBe(true);
    const created = fx.annotations.filter((a) => a.id !== ann.id);
    expect(created.length).toBe(2);
    for (const a of created) {
      expect(a.questionAnswer).toBeUndefined();
      expect(a.type).toBe(AnnotationType.COMMENT);
    }
    // The human's answer is untouched.
    expect(fx.annotations.find((a) => a.id === ann.id)?.questionAnswer?.selected).toEqual(['Server-side per user']);
  });

  test('update_comment and remove_comments refuse the human answer', async () => {
    const fx = setup();
    const ann = fx.answer(1, { selected: ['Local only'] });
    const update = await fx.call('update_comment', { id: ann.id, text: 'Answer: Server-side per user' });
    expect(update.ok).toBe(false);
    const removal = dataOf(await fx.call('remove_comments', { ids: [ann.id] }));
    expect(removal.results[0].ok).toBe(false);
    expect(fx.annotations.find((a) => a.id === ann.id)?.questionAnswer?.selected).toEqual(['Local only']);
  });
});
