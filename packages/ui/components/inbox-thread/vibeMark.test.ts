/**
 * A launched Mistral Vibe session draws Vibe's own mark (the To picker, the Agents section, its messages and its
 * permission cards), never the neutral glyph a host with no mark gets.
 */
import { expect, test } from 'bun:test';
import { hostHasMark } from './icons';

test('mistral-vibe has its own mark', () => {
  expect(hostHasMark('mistral-vibe')).toBe(true);
});
