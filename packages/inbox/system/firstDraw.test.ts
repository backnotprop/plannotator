/**
 * The first-draw prompt Copy prompt copies (system/firstDraw.ts). What regresses: a prompt that sends the agent to
 * write the drawing in the person's repo (`.plannotator/system`) instead of Plannotator's own folder,
 * `<data dir>/system/<project key>/drawing` (owner ruling: System never writes to the repo).
 */
import { expect, test } from 'bun:test';
import { systemFirstDrawPrompt } from './firstDraw';

test('the first-draw prompt names the drawing folder in the data dir, never the repo', () => {
  const drawing = '/Users/ada/.plannotator/system/app-abc123/drawing';
  const prompt = systemFirstDrawPrompt(
    { name: 'app', root: '/Users/ada/code/app', repo: 'github.com/acme/app', drawing },
    { repos: [], docs: [], model: null },
  );
  expect(prompt).toContain(`into ${drawing}.`);
  expect(prompt).not.toContain('into .plannotator/system');
  expect(prompt.replaceAll(drawing, '')).not.toContain('.plannotator/system');
});
