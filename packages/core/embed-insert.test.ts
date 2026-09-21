// These tests pin the splice planner's own-paragraph guarantee. A regression
// would leave an otherwise valid host-built embed line inline with prose,
// indented as code, or with the caret trapped on the embed line.
import { describe, expect, it } from 'bun:test';

import { planEmbedInsert } from './embed-insert';

describe('planEmbedInsert - the own-paragraph guarantee', () => {
  const EMBED_LINE = '[Report](report.html#embed)';

  /** Apply a splice plan the way CodeMirror would. */
  function applied(body: string, from: number, to: number): string {
    const plan = planEmbedInsert(body, from, to, EMBED_LINE);
    return body.slice(0, plan.from) + plan.insert + body.slice(plan.to);
  }

  it('keeps an embed typed on the only line terminated and puts the caret on the fresh last line', () => {
    const body = '/embed rep';
    const plan = planEmbedInsert(body, 0, body.length, EMBED_LINE);
    const result = applied(body, 0, body.length);
    expect(result).toBe(`${EMBED_LINE}\n`);
    expect(plan.cursor).toBe(result.length);
  });

  it('opens a blank line above an embed typed under a text line', () => {
    const body = 'Intro paragraph.\n/embed rep';
    const start = body.indexOf('/embed');
    const result = applied(body, start, body.length);
    expect(result).toBe(`Intro paragraph.\n\n${EMBED_LINE}\n`);
  });

  it('opens a blank line below an embed typed above existing text', () => {
    const body = '/embed rep\nNext paragraph.\n';
    const result = applied(body, 0, '/embed rep'.length);
    expect(result).toBe(`${EMBED_LINE}\n\nNext paragraph.\n`);
  });

  it('moves text after the cursor on the same line to its own paragraph', () => {
    const body = '/embed reptrailing words';
    const result = applied(body, 0, '/embed rep'.length);
    expect(result).toBe(`${EMBED_LINE}\n\ntrailing words`);
  });

  it('does not double already-blank surroundings', () => {
    const body = 'Intro.\n\n/embed rep\n\nOutro.\n';
    const start = body.indexOf('/embed');
    const result = applied(body, start, start + '/embed rep'.length);
    expect(result).toBe(`Intro.\n\n${EMBED_LINE}\n\nOutro.\n`);
  });

  it('swallows leading whitespace that would turn the embed into an indented code block', () => {
    const body = 'Intro.\n   /embed rep';
    const start = body.indexOf('/embed');
    const result = applied(body, start, body.length);
    expect(result).toBe(`Intro.\n\n${EMBED_LINE}\n`);
  });

  it('puts the caret on the blank line after the embed instead of on its link line', () => {
    const body = 'Intro.\n/embed rep\nOutro.\n';
    const start = body.indexOf('/embed');
    const plan = planEmbedInsert(body, start, start + '/embed rep'.length, EMBED_LINE);
    const result = body.slice(0, plan.from) + plan.insert + body.slice(plan.to);
    expect(result[plan.cursor - 1]).toBe('\n');
    const caretLineEnd = result.indexOf('\n', plan.cursor);
    expect(result.slice(plan.cursor, caretLineEnd === -1 ? undefined : caretLineEnd)).toBe('');
  });
});
