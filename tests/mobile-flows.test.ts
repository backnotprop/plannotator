/**
 * The app's flow specs (apps/mobile/contract/flows/*.md) cite the window's
 * code for every numbered check, so a builder implements what the window does,
 * not what someone remembered (docs/agent-guides/mobile.md).
 *
 * What can regress:
 *  - a check added or edited without saying where the window does it: every
 *    check line ends with ` (path:line)`, several joined by `; `, or with
 *    `(phone only)`, and a phone-only check says `phone differs:`;
 *
 * Whether each cited file still exists is scripts/mobile/check.ts's (the
 * mobile-contract workflow): a window change can move a file, and that must
 * never fail an Inbox pull request. Reads the flow files as text only.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOW_FILES } from '../scripts/mobile/flows';

const ROOT = join(import.meta.dir, '..');
const CHECK = /^- \[([a-z]+-\d{2})\]\s+(.*)$/;
const CITED = /\(((?:[\w./-]+:\d+)(?:; [\w./-]+:\d+)*)\)$/;

function checks(): { file: string; id: string; text: string }[] {
  return FLOW_FILES.flatMap((file) =>
    readFileSync(join(ROOT, file), 'utf8')
      .split('\n')
      .map((line) => CHECK.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ file, id: m[1]!, text: m[2]!.trimEnd() })),
  );
}

describe('the flow checks', () => {
  test('every check cites the window, or says it is the phone\'s own', () => {
    const all = checks();
    expect(all.length).toBeGreaterThan(0);
    const bad = all
      .filter(({ text }) => !(CITED.test(text) || (text.endsWith('(phone only)') && text.includes('phone differs:'))))
      .map(({ file, id }) => `${file} [${id}]: end it with (path:line), or say "phone differs:" and end with (phone only)`);
    expect(bad).toEqual([]);
  });
});
