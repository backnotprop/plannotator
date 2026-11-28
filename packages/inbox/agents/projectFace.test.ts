/**
 * Agent icons from the project name (approval "inbox-generated-agent-icons", 2026-11-15): the letters, the hue, and
 * what a face the person picked turns into under the Rows setting.
 * What this catches: a hard project name drawing other letters than the approved table (`.product/approved/
 * inbox-generated-agent-icons/variant-a-solid.html`, "Hard names"); a hue that moves with case, spaces or the order the
 * window met its projects (it must match on every machine); a tile that changes colour when the window's label for its
 * project gains " · work" or " · <machine>", or when another project with the same letters appears (review of #3503:
 * a colour never moves); the setting drawing over a face someone picked; the default (setting untouched) showing anything but
 * today's faces; the agent's own mark under the setting not being kept as a pick; a tile kept as a face, or a value no
 * build knows kept.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInboxAgentFaces } from '@plannotator/core/inbox-types';
import type { AgentFace } from './faceChoices';
import { learnProjects, onSessionProjects, resetKnownProjectsForTests, sessionProjectOf } from '../projectPictures';
import { hueOf, projectLetters } from '../letterMarks';
import { agentProjectLabel, keptAgentFace, projectSeed, projectTileOf, resetProjectFaces, shownAgentFace } from './projectFace';

afterEach(() => {
  resetKnownProjectsForTests();
  resetProjectFaces();
});

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
  test("keyed on the project's own name alone, NFC, lowercased with spaces folded: the same on every machine", () => {
    expect(projectSeed('  Orchard ')).toBe('orchard');
    expect(projectSeed('u\u0308ber-cli')).toBe(projectSeed('über-cli'));
    for (const name of ['orchard', 'tidepool-web', '@acme/ui-kit', '東京メモ', 'web3']) expect(projectTileOf(name)!.hue).toBe(hueOf(projectSeed(name)));
    expect(projectTileOf('Orchard')!.hue).toBe(projectTileOf('orchard')!.hue);
    expect(projectSeed('kestrel  ·  Work')).toBe('kestrel');
  });

  test("an agent's tile keeps its colour when a second folder of that name or a linked machine shows it with a suffix, or another project appears", () => {
    const tile = (session: string) => {
      const name = agentProjectLabel(session);
      return name ? projectTileOf(name) : null;
    };
    learnProjects([], [{ project: { id: 'prj_api_work', name: 'api' }, author: { kind: 'agent', session: 'ses_work' } }]);
    const before = tile('ses_work')!;
    // A second folder named "api": the Inbox renames both "api · work" and "api · home" (shared/inbox/project-name.ts);
    // a linked machine's reads "api · MacBook". The tile keys on the name before " · ".
    learnProjects([], [
      { project: { id: 'prj_api_work', name: 'api · work' }, author: { kind: 'agent', session: 'ses_work' } },
      { project: { id: 'prj_api_home', name: 'api · home' }, author: { kind: 'agent', session: 'ses_home' } },
      { project: { id: 'ibx_mac:prj_api', name: 'api · MacBook' }, author: { kind: 'agent', session: 'ses_mac' } },
      { project: { id: 'prj_apex', name: 'apex-ui' }, author: { kind: 'agent', session: 'ses_apex' } },
    ]);
    expect([tile('ses_work')!.hue, tile('ses_work')!.letters]).toEqual([before.hue, before.letters]);
    expect(tile('ses_home')!.hue).toBe(before.hue);
    expect(tile('ses_mac')!.hue).toBe(before.hue);
    // A project with the same letters never moves another's colour: each keeps its own name's hue.
    expect(projectTileOf('apex-ui')!.letters.text).toBe('AU');
    expect(tile('ses_apex')!.hue).toBe(hueOf(projectSeed('apex-ui')));
  });
});

describe("an ended agent's project, from the rows", () => {
  type Row = NonNullable<Parameters<typeof learnProjects>[1]>[number];
  const wrote = (id: string, session: string): Row => ({ project: { id, name: id.slice(4) }, author: { kind: 'agent', session } });
  const tookPart = (id: string, session: string): Row => ({ project: { id, name: id.slice(4) }, author: { kind: 'human' }, participants: [{ session }] });

  test('one rule in any order: a project it wrote in over one it only took part in, then the lowest id; a read with nothing new redraws nothing', () => {
    let heard = 0;
    const stop = onSessionProjects(() => heard++);
    try {
      for (const rows of [
        [tookPart('prj_a', 's1'), wrote('prj_z', 's1'), wrote('prj_m', 's2'), wrote('prj_c', 's2')],
        [wrote('prj_c', 's2'), wrote('prj_z', 's1'), wrote('prj_m', 's2'), tookPart('prj_a', 's1')],
      ]) {
        resetKnownProjectsForTests();
        learnProjects([], rows);
        expect([sessionProjectOf('s1')?.id, sessionProjectOf('s2')?.id]).toEqual(['prj_z', 'prj_c']);
      }
      // The same rows again, and in another order: no change, so no tile hears of it.
      heard = 0;
      learnProjects([], [wrote('prj_m', 's2'), tookPart('prj_a', 's1'), wrote('prj_z', 's1'), wrote('prj_c', 's2')]);
      expect(heard).toBe(0);
      // A renamed project is heard.
      learnProjects([], [{ project: { id: 'prj_c', name: 'renamed' }, author: { kind: 'agent', session: 's2' } }]);
      expect([sessionProjectOf('s2')?.name, heard]).toEqual(['renamed', 1]);
    } finally {
      stop();
    }
  });
});

describe('the letters at small sizes', () => {
  test('under 20 px a tile shows one letter (the first), at the one-letter size; two from 20 px up (review of #3503: two were 7 px)', () => {
    const css = readFileSync(join(import.meta.dir, 'agents.css'), 'utf8');
    const block = /@container \(min-width: 19\.5px\) \{\n([\s\S]*?)\n\}/.exec(css.slice(css.indexOf('.ib-mk.ib-pf > .ib-pf-t {')))?.[1] ?? '';
    const outside = css.slice(css.indexOf('.ib-mk.ib-pf > .ib-pf-t {'), css.indexOf('@container (min-width: 19.5px) {\n  .ib-mk.ib-pf'));
    // Outside the container query (a 16 px tile): the second letter hidden, every tile at the one-letter size.
    expect(outside).toMatch(/\.ib-mk\.ib-pf > \.ib-pf-t \{[^}]*font-size: 54cqw;/);
    expect(outside).toMatch(/\.ib-pf-t \.ib-lm-2 \{ display: none; \}/);
    expect(outside).not.toMatch(/data-n="2"/);
    // From 20 px: the second letter shown, two at the two-letter size.
    expect(block).toMatch(/\.ib-pf-t\[data-n="2"\] \{ font-size: 44cqw; \}/);
    expect(block).toMatch(/\.ib-pf-t \.ib-lm-2 \{ display: inline; \}/);
  });
});

describe('the setting and the faces people pick', () => {
  const PICKED: AgentFace[] = ['glass-red', 'transparent', 'totman', `own:${'a'.repeat(64)}`, 'set:pixel/cat', 'project'];

  test('with the setting untouched every face shows as today; the own mark picked is forgotten, as today', () => {
    for (const face of ['agent', ...PICKED] as AgentFace[]) expect(shownAgentFace(face, false)).toBe(face);
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

  test('the reader keeps a tile beside the own mark, never as a face, and drops what it does not know', () => {
    const read = readInboxAgentFaces({
      a: { face: 'agent', tile: 'project', sessions: ['s1'] },
      b: { face: 'agent', tile: 'mark', sessions: [] },
      c: { face: 'rainbow', sessions: [] },
      d: { face: 'glass-red', tile: 'project', sessions: [] },
      e: { face: 'project', sessions: [] },
      f: { face: 'agent', tile: 'rainbow', sessions: [] },
    });
    expect(read).toEqual({ a: { face: 'agent', tile: 'project', sessions: ['s1'] }, b: { face: 'agent', tile: 'mark', sessions: [] }, d: { face: 'glass-red', sessions: [] } });
  });
});
