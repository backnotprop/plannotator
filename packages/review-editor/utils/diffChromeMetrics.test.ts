import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPACT_FILE_HEADER_HEIGHT, FILE_HEADER_HEIGHT, firstCodeLineOffset } from './diffChromeMetrics';

const panelHeaderVars = (file: string) =>
  [...readFileSync(join(import.meta.dir, file), 'utf8').matchAll(/--panel-header-h:\s*(\d+)px/g)].map((m) => Number(m[1]));

describe('code review chrome height budget', () => {
  test('the first code line sits within 100 px on desktop and 130 px on a phone', () => {
    expect(firstCodeLineOffset(false)).toBeLessThanOrEqual(100);
    expect(firstCodeLineOffset(true)).toBeLessThanOrEqual(130);
  });

  test('the file header the CSS draws is the height the virtual list reserves, in code review and in the Inbox', () => {
    expect(panelHeaderVars('../index.css')).toEqual([FILE_HEADER_HEIGHT]);
    const inbox = panelHeaderVars('../../inbox/inbox.css');
    expect(inbox.length).toBeGreaterThan(0);
    for (const value of inbox) expect(value).toBe(FILE_HEADER_HEIGHT);
    expect(COMPACT_FILE_HEADER_HEIGHT).toBeGreaterThanOrEqual(44);
  });
});
