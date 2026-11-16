/**
 * Agent icons from the project name (approval "inbox-generated-agent-icons", 2026-11-15): the letters, the hue, and
 * what a face the person picked turns into under the Rows setting.
 * What this catches: a hard project name drawing other letters than the approved table (`.product/approved/
 * inbox-generated-agent-icons/variant-a-solid.html`, "Hard names"); a hue that moves with case, spaces or the order the
 * window met its projects (it must match on every machine); two projects on screen with the same letters left in the
 * same hue; the setting drawing over a face someone picked; the default (setting untouched) showing anything but
 * today's faces; the agent's own mark under the setting not being kept as a pick; a face value no build knows kept.
 */
import { describe, expect, test } from 'bun:test';
import { readInboxAgentFaces, type InboxAgentFace } from '@plannotator/core/inbox-types';
import { hueOf, projectLetters } from '../letterMarks';
import { keptAgentFace, projectHues, projectSeed, shownAgentFace } from './projectFace';

describe('the letters', () => {
  test('the approved table of hard names', () => {
    const table: [string, string, 'letters' | 'emoji' | 'none'][] = [
      ['x', 'X', 'letters'],
      ['🚀 launchpad', 'LD', 'letters'],
      ['🚀', '🚀', 'emoji'],
      ['東京メモ', '東', 'letters'],
      ['Привет-мир', 'ПМ', 'letters'],
      ['مشروع', 'م', 'letters'],
      ['한국어-앱', '한', 'letters'],
      ['plannotator · plannotator', 'PR', 'letters'],
      ['plannotator · work', 'PR', 'letters'],
      ['my-app', 'MA', 'letters'],
      ['myApp', 'MA', 'letters'],
      ['@scope/pkg', 'PG', 'letters'],
      ['@acme/ui-kit', 'UK', 'letters'],
      ['web3-wallet', 'WW', 'letters'],
      ['web3', 'W3', 'letters'],
      ['README', 'RE', 'letters'],
      ['XMLParser', 'XP', 'letters'],
      ['über-cli', 'ÜC', 'letters'],
      ['___', '', 'none'],
      ['payments-platform-internal-tooling-and-migration-scripts-v2', 'PV', 'letters'],
    ];
    expect(table.map(([name]) => [name, projectLetters(name).text, projectLetters(name).kind])).toEqual(table);
  });

  test('by grapheme: a decomposed letter and a flag are one each', () => {
    expect(projectLetters('über-cli').text).toBe('ÜC');
    expect(projectLetters('🇯🇵').text).toBe('🇯🇵');
    expect(projectLetters('tidepool-web').count).toBe(2);
    expect(projectLetters('東京メモ').count).toBe(1);
  });
});

describe('the hue', () => {
  test('keyed on the label alone, lowercased with spaces folded: the same on every machine and in any order', () => {
    expect(projectSeed('  Orchard ')).toBe('orchard');
    expect(projectSeed('kestrel  ·  Work')).toBe('kestrel · work');
    const labels = ['orchard', 'tidepool-web', '@acme/ui-kit', '東京メモ', 'web3'];
    const forward = projectHues(labels);
    const backward = projectHues([...labels].reverse());
    for (const label of labels) {
      expect(forward.get(label)).toBe(hueOf(projectSeed(label)));
      expect(backward.get(label)).toBe(forward.get(label));
    }
  });

  test('two projects that would draw the same letters in the same hue get different hues, the same way in any order', () => {
    const seen = new Map<number, string>();
    let pair: [string, string] | null = null;
    for (let n = 0; n < 40 && !pair; n++) {
      const label = `kestrel · box${n}`;
      const hue = hueOf(projectSeed(label));
      const before = seen.get(hue);
      if (before) pair = [before, label];
      else seen.set(hue, label);
    }
    const [a, b] = pair!;
    expect(projectLetters(a).text).toBe(projectLetters(b).text);
    const one = projectHues([a, b, 'orchard']);
    const two = projectHues(['orchard', b, a]);
    expect(one.get(a)).not.toBe(one.get(b));
    expect([two.get(a), two.get(b)]).toEqual([one.get(a), one.get(b)]);
    // The first by its key keeps its own hue; the next steps three round the wheel.
    const [first, next] = [a, b].sort((x, y) => (projectSeed(x) < projectSeed(y) ? -1 : 1));
    expect(one.get(first!)).toBe(hueOf(projectSeed(first!)));
    expect(one.get(next!)).toBe((hueOf(projectSeed(next!)) + 3) % 8);
    // Different letters in one hue are told apart by their letters: neither moves.
    expect(projectHues([a, 'orchard']).get('orchard')).toBe(hueOf('orchard'));
  });
});

describe('the setting and the faces people pick', () => {
  const PICKED: InboxAgentFace[] = ['glass-red', 'transparent', 'totman', `own:${'a'.repeat(64)}`, 'set:pixel/cat', 'project'];

  test('with the setting untouched every face shows as today; the own mark picked is forgotten, as today', () => {
    for (const face of ['agent', ...PICKED] as InboxAgentFace[]) expect(shownAgentFace(face, false)).toBe(face);
    expect(keptAgentFace('agent', false)).toBe('agent');
    expect(keptAgentFace('glass-red', false)).toBe('glass-red');
    expect(keptAgentFace('project', false)).toBe('project');
  });

  test('"From the project name" changes only an agent with no face picked; a picked one stays', () => {
    expect(shownAgentFace('agent', true)).toBe('project');
    for (const face of PICKED) expect(shownAgentFace(face, true)).toBe(face);
  });

  test('under the setting the agent\'s own mark is kept as a pick and shows as the own mark, setting on or off', () => {
    expect(keptAgentFace('agent', true)).toBe('mark');
    expect(shownAgentFace('mark', true)).toBe('agent');
    expect(shownAgentFace('mark', false)).toBe('agent');
    // Picking the tile there is the default again: nothing kept.
    expect(keptAgentFace('project', true)).toBe('agent');
  });

  test('the reader keeps the two new faces and drops a face it does not know', () => {
    const read = readInboxAgentFaces({
      a: { face: 'project', sessions: ['s1'] },
      b: { face: 'mark', sessions: [] },
      c: { face: 'rainbow', sessions: [] },
      d: { face: 'glass-red', sessions: [] },
    });
    expect(Object.fromEntries(Object.entries(read).map(([key, entry]) => [key, entry.face]))).toEqual({ a: 'project', b: 'mark', d: 'glass-red' });
  });
});
