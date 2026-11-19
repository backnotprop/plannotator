/**
 * The app's flow specs (apps/mobile/contract/flows/*.md) cite the window's
 * code for every numbered check, so a builder implements what the window does,
 * not what someone remembered (docs/agent-guides/mobile.md).
 *
 * What can regress:
 *  - a check added or edited without saying where the window does it: every
 *    check line ends with ` (path:line)`, several joined by `; `, or with
 *    `(phone only)`, and a phone-only check says `phone differs:`;
 *  - a cited file moved or deleted, so the citation points at nothing.
 *
 * Only the file is checked, never the line: line numbers are a reader's
 * guide, and a window change that moves lines must never fail here. Reads
 * the flow files as text; no React, no server.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
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

  test('every cited file exists', () => {
    const bad: string[] = [];
    for (const { file, id, text } of checks()) {
      const cited = CITED.exec(text);
      if (!cited) continue;
      for (const ref of cited[1]!.split('; ')) {
        const path = ref.slice(0, ref.lastIndexOf(':'));
        if (!existsSync(join(ROOT, path))) bad.push(`${file} [${id}]: ${path} does not exist; cite where the window does it now`);
      }
    }
    expect(bad).toEqual([]);
  });
});
