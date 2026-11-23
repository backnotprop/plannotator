import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installInertDiagramSvgParser, parseInertSvg } from '../test-setup/diagramSvg';
import { setPeleInBuildForTests } from '../test-setup/pele';
import { diagramFamilyOf, diagramSourceLine, MERMAID_FINDER, type DiagramFinder, type DiagramTarget } from './diagram-anchor';
import { PELE_COMPAT_FINDER, PELE_FINDER } from './diagram-anchor-pele';
import { __setDiagramEngineModeForTests } from './diagram-engine';
import { renderDiagram } from './diagram-render';

const hasDom = typeof document !== 'undefined';
const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const RENDER_ID = 'diagram-fixture';

function load(name: string): SVGSVGElement {
  const svg = parseInertSvg(readFileSync(join(FIXTURES, `${name}.svg`), 'utf8'));
  if (svg === null) throw new Error(`fixture ${name} has no SVG root`);
  return svg;
}

describe.if(hasDom)('Pele 1.3.0 flowchart anchors', () => {
  test('detects Pele output and maps stable data-id groups to the shared anchor wire shape', () => {
    const svg = load('pele-flowchart');
    expect(diagramFamilyOf(svg)).toBe('flowchart');
    const node = svg.querySelector('.pele-node[data-id="B"]');
    const edge = svg.querySelector('.pele-edge[data-id="L_A_B_0"]');
    expect(node && PELE_FINDER.targetFromElement(svg, node, RENDER_ID)).toEqual({
      family: 'flowchart', kind: 'node', id: 'B', label: 'Approve?',
    });
    expect(edge && PELE_FINDER.targetFromElement(svg, edge, RENDER_ID)).toEqual({
      family: 'flowchart', kind: 'edge', from: 'A', to: 'B', label: 'yes',
    });
    const edgeLabel = svg.querySelector('.pele-edge-label[data-id="L_A_B_0"]');
    expect(edgeLabel && PELE_FINDER.targetFromElement(svg, edgeLabel, RENDER_ID)).toEqual({
      family: 'flowchart', kind: 'edge', from: 'A', to: 'B', label: 'yes',
    });
  });

  test('restores by stable ids, unique label fallback and source line, refusing ambiguous duplicate edges', () => {
    const svg = load('pele-flowchart');
    const node = PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'node', id: 'B', label: '' }, RENDER_ID);
    expect(node?.getAttribute('data-id')).toBe('B');
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'edge', from: 'A', to: 'B', label: '' }, RENDER_ID)?.getAttribute('data-id')).toBe('L_A_B_0');
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'node', id: 'old', label: 'Approve?' }, RENDER_ID)?.getAttribute('data-id')).toBe('B');
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'node', id: 'missing', label: 'Nowhere' }, RENDER_ID)).toBeNull();
    expect(PELE_FINDER.sourceLine('flowchart TD\n A[Reviewer] --> B[Approve?]\n B --> C[Done]', { family: 'flowchart', kind: 'node', id: 'B', label: '' })).toEqual([2, 2]);
    expect(PELE_FINDER.sourceLine('flowchart TD\n A --> B', { family: 'flowchart', kind: 'node', id: 'Missing', label: '' })).toBeNull();

    const edge = svg.querySelector('.pele-edge[data-id="L_A_B_0"]')!;
    const duplicate = edge.cloneNode(true) as Element;
    duplicate.setAttribute('data-id', 'L_A_B_1');
    edge.parentElement!.appendChild(duplicate);
    expect(PELE_FINDER.targetFromElement(svg, duplicate, RENDER_ID)).toBeNull();
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'edge', from: 'A', to: 'B', label: '' }, RENDER_ID)).toBeNull();
  });

  test('whole-diagram comments restore on non-flowcharts; foreign parts and duplicate labels do not bind', () => {
    const pie = parseInertSvg('<svg class="pele pele-pie" viewBox="0 0 100 100"/>')!;
    expect(PELE_FINDER.findTarget(pie, { family: 'other', kind: 'diagram', label: '' }, RENDER_ID)).toBe(pie);
    const svg = load('pele-flowchart');
    expect(PELE_FINDER.findTarget(svg, { family: 'class', kind: 'node', id: 'B', label: 'Approve?' }, RENDER_ID)).toBeNull();
    const node = svg.querySelector('.pele-node[data-id="B"]')!;
    const duplicate = node.cloneNode(true) as Element;
    duplicate.setAttribute('data-id', 'renamed');
    node.parentElement!.appendChild(duplicate);
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'node', id: 'gone', label: 'Approve?' }, RENDER_ID)).toBeNull();
  });

  test('compatibility finder chooses from the rendered SVG and leaves Mermaid SVG handling intact', () => {
    const pele = load('pele-flowchart');
    const peleNode = pele.querySelector('.pele-node[data-id="A"]')!;
    expect(PELE_COMPAT_FINDER.targetFromElement(pele, peleNode, RENDER_ID)?.id).toBe('A');

    const mermaid = load('06-flowchart-review-decision');
    const mermaidNode = mermaid.querySelector('g.node')!;
    expect(PELE_COMPAT_FINDER.targetFromElement(mermaid, mermaidNode, RENDER_ID)).toEqual(
      MERMAID_FINDER.targetFromElement(mermaid, mermaidNode, RENDER_ID),
    );
  });
});

/**
 * Pele's finders against Mermaid's, per type, on the same source: a Mermaid
 * svg captured in Chromium (Mermaid 12.2.0, `test-setup/fixtures/diagrams/2x-*.svg`,
 * its source in the `.mmd` beside it) and Pele drawing that source for real.
 *
 * What regresses if these fail: a click on a part under Pele makes a
 * different anchor (kind, id, ends or label) than the same click under
 * Mermaid, so a comment made under one engine is lost, or lands on another
 * part, under the other; or a part with a twin (the same label, the same
 * ends) restores onto the twin.
 */
describe.if(hasDom)('Pele finders make the anchors Mermaid makes', () => {
  let restoreParser: (() => void) | undefined;
  beforeAll(() => {
    restoreParser = installInertDiagramSvgParser();
    __setDiagramEngineModeForTests('pele');
    setPeleInBuildForTests(true);
  });
  afterAll(() => {
    restoreParser?.();
    __setDiagramEngineModeForTests(undefined);
    setPeleInBuildForTests(false);
  });

  const PELE_ID = 'parts';
  const source = (name: string): string => readFileSync(join(FIXTURES, `${name}.mmd`), 'utf8');

  async function drawn(name: string): Promise<{ mermaid: SVGSVGElement; pele: SVGSVGElement; source: string }> {
    const result = await renderDiagram('mermaid', PELE_ID, source(name), { colorTheme: 'github', mode: 'dark' });
    if (result.ok === false) throw new Error(result.message);
    expect(result.svgNode.classList.contains('pele')).toBe(true);
    return { mermaid: load(name), pele: result.svgNode, source: source(name) };
  }

  /** Every target a click can make under one engine, by its JSON. */
  function clickable(svg: Element, finder: DiagramFinder, renderId: string): Map<string, DiagramTarget> {
    const targets = new Map<string, DiagramTarget>();
    for (const el of Array.from(svg.querySelectorAll(finder.targetSelector))) {
      const target = finder.targetFromElement(svg, el, renderId);
      if (target !== null) targets.set(JSON.stringify(target), target);
    }
    return targets;
  }

  /** The target the restored element stands for (a Mermaid frame restores to its group: read one of its lines). */
  function restoredAs(svg: Element, finder: DiagramFinder, target: DiagramTarget, renderId: string): DiagramTarget | null {
    const el = finder.findTarget(svg, target, renderId);
    if (el === null) return null;
    const part = el.matches('g') && el.querySelector(':scope > line.loopLine') !== null ? el.querySelector(':scope > line.loopLine')! : el;
    return finder.targetFromElement(svg, part, renderId);
  }

  const identity = ({ label: _label, ...rest }: DiagramTarget) => JSON.stringify(rest);

  function expectParity(svgs: { mermaid: SVGSVGElement; pele: SVGSVGElement }, compareLabels = true): DiagramTarget[] {
    const underMermaid = clickable(svgs.mermaid, MERMAID_FINDER, RENDER_ID);
    const underPele = clickable(svgs.pele, PELE_FINDER, PELE_ID);
    const key = compareLabels ? (t: DiagramTarget) => JSON.stringify(t) : identity;
    expect([...underPele.values()].map(key).sort()).toEqual([...underMermaid.values()].map(key).sort());
    for (const target of underMermaid.values()) {
      // Made under Mermaid, restored under Pele: the same part, not a twin.
      expect(key(restoredAs(svgs.pele, PELE_FINDER, target, PELE_ID)!)).toBe(key(target));
    }
    for (const target of underPele.values()) {
      expect(key(restoredAs(svgs.pele, PELE_FINDER, target, PELE_ID)!)).toBe(key(target));
      // Made under Pele, restored under Mermaid.
      expect(key(restoredAs(svgs.mermaid, MERMAID_FINDER, target, RENDER_ID)!)).toBe(key(target));
    }
    return [...underPele.values()];
  }

  const ids = (targets: readonly DiagramTarget[]) => targets.map((t) => `${t.kind} ${t.id ?? `${t.from} -> ${t.to}`}: ${t.label}`).sort();

  test('sequence: actors (the stick figure too), messages with a twin label, self-messages, notes and frames, nested ones first', async () => {
    const svgs = await drawn('20-sequence-parts');
    const targets = expectParity(svgs);
    expect(ids(targets)).toEqual([
      'cluster frame-1: opt [busy]',
      'cluster frame-2: loop [Every minute]',
      'cluster frame-3: alt [ok]',
      'cluster frame-4: par [first]',
      'edge msg-1: ping',
      'edge msg-2: pong',
      'edge msg-3: think',
      'edge msg-4: ping',
      'edge msg-5: wait',
      'edge msg-6: ack',
      'edge msg-7: fail "x" < y & z',
      'edge msg-8: one',
      'edge msg-9: two',
      'node A: Ada Novak',
      'node B: Bob Tully',
      'node C: Charlie Dunn',
      'node note-1: shared note',
      'node note-2: done',
    ]);
    const message = (id: string) => targets.find((t) => t.id === id)!;
    expect([message('msg-3').from, message('msg-3').to]).toEqual(['A', 'A']);
    expect([message('msg-4').from, message('msg-4').to]).toEqual(['B', 'C']);
    // The two `ping`s are two parts, and each restores to its own.
    expect(PELE_FINDER.findTarget(svgs.pele, message('msg-1'), PELE_ID)).not.toBe(PELE_FINDER.findTarget(svgs.pele, message('msg-4'), PELE_ID));
    // Every part's source line is the line that declares it, under either engine.
    const line = (id: string) => svgs.source.split('\n')[(diagramSourceLine(svgs.source, targets.find((t) => t.id === id)!)?.[0] ?? 0) - 1]?.trim();
    expect(line('msg-4')).toBe('B->>C: ping');
    expect(line('frame-1')).toBe('opt busy');
    expect(line('frame-2')).toBe('loop Every minute');
    expect(line('note-2')).toBe('Note right of C: done');
  });

  test('sequence: a frame with no label, a rect background, an activation and labels over two lines', async () => {
    const svgs = await drawn('25-sequence-frames-multiline');
    // Mermaid empties every message label once one message wraps, and keeps a
    // wrapped note's first line only; the parts are the same parts.
    const targets = expectParity(svgs, false);
    expect(ids(targets)).toEqual([
      'cluster frame-1: critical [crit]',
      'cluster frame-2: break [stop]',
      'cluster frame-3: loop',
      'edge msg-1: in rect',
      'edge msg-2: c1',
      'edge msg-3: c2',
      'edge msg-4: b1',
      'edge msg-5: line one line two',
      'edge msg-6: act',
      'edge msg-7: back',
      'node A: A',
      'node B: B',
      'node note-1: two lines',
    ]);
    const line = (id: string) => svgs.source.split('\n')[(diagramSourceLine(svgs.source, targets.find((t) => t.id === id)!)?.[0] ?? 0) - 1]?.trim();
    expect(line('frame-1')).toBe('critical crit');
    expect(line('frame-3')).toBe('loop');
    // Mermaid's placeholder for the missing label (a zero-width space) is no part of it.
    expect([...clickable(svgs.mermaid, MERMAID_FINDER, RENDER_ID).values()]).toContainEqual({ family: 'sequence', kind: 'cluster', id: 'frame-3', label: 'loop' });
  });

  // Pele ends a message to a `create`d actor at that actor's box (its
  // lifeline starts below it), and a message from deep in nested activations
  // at the edge of the innermost bar, ~25 px off the lifeline: neither end
  // is near a lifeline, so before these were read the message lost the ends
  // Mermaid gives it.
  test('sequence: a message to a created participant or actor, and one from six activations deep, keep their ends', async () => {
    const svgs = await drawn('28-sequence-create-activation');
    const targets = expectParity(svgs);
    const ends = (id: string) => {
      const t = targets.find((target) => target.id === id);
      return `${t?.from} -> ${t?.to}`;
    };
    expect(ends('msg-7')).toBe('B -> E');
    expect(ends('msg-8')).toBe('E -> B');
    expect(ends('msg-9')).toBe('B -> C');
    expect(ends('msg-10')).toBe('C -> D');
    expect(ends('msg-11')).toBe('B -> A');
    expect(targets.every((t) => t.kind !== 'edge' || (t.from !== undefined && t.to !== undefined))).toBe(true);
  });

  // Comments saved before these finders carry the anchor main's Mermaid
  // finder made (read off it running on these fixtures, source line from
  // main's core): a stick-figure actor labelled by its id, a frame with no
  // label keeping Mermaid's zero-width space, a class or requirement
  // labelled by its type line, twin relations, and source lines that main
  // numbered differently. Each must still restore onto the part it was made
  // on, under either engine, or old comments land on another part or list
  // as unanchored.
  test('anchors saved by the earlier Mermaid finder restore on the same part under either engine', async () => {
    const cases: ReadonlyArray<readonly [string, DiagramTarget, readonly [number, number], DiagramTarget]> = [
      ['25-sequence-frames-multiline', { family: 'sequence', kind: 'cluster', id: 'frame-3', label: 'loop ​' }, [12, 12], { family: 'sequence', kind: 'cluster', id: 'frame-3', label: 'loop' }],
      ['20-sequence-parts', { family: 'sequence', kind: 'node', id: 'C', label: 'C' }, [4, 4], { family: 'sequence', kind: 'node', id: 'C', label: 'Charlie Dunn' }],
      // Main numbered frames as drawn (the nested opt first) but gave frame-1 the loop's line.
      ['20-sequence-parts', { family: 'sequence', kind: 'cluster', id: 'frame-1', label: 'opt [busy]' }, [9, 9], { family: 'sequence', kind: 'cluster', id: 'frame-1', label: 'opt [busy]' }],
      ['27-class-namespace-annotation', { family: 'class', kind: 'node', id: 'Shape', label: '«interface»' }, [6, 6], { family: 'class', kind: 'node', id: 'Shape', label: 'Shape' }],
      ['24-requirement-parts', { family: 'requirement', kind: 'node', id: 'r1', label: '<<Requirement>>' }, [2, 2], { family: 'requirement', kind: 'node', id: 'r1', label: 'r1' }],
      // The second `User --> Order`; main gave it the first one's line.
      ['22-class-parts', { family: 'class', kind: 'edge', from: 'User', to: 'Order', label: 'owns' }, [7, 7], { family: 'class', kind: 'edge', from: 'User', to: 'Order', label: 'owns' }],
    ];
    for (const [fixture, made, sourceLine, part] of cases) {
      const svgs = await drawn(fixture);
      const saved: DiagramTarget = { v: 1, ...made, sourceLine } as DiagramTarget;
      expect({ fixture, made, mermaid: restoredAs(svgs.mermaid, MERMAID_FINDER, saved, RENDER_ID) }).toEqual({ fixture, made, mermaid: part });
      expect({ fixture, made, pele: restoredAs(svgs.pele, PELE_FINDER, saved, PELE_ID) }).toEqual({ fixture, made, pele: part });
    }
  });

  // A wrong end restores a comment onto another message of the same label,
  // so a point two actors could claim names neither, as it did before.
  test('sequence: a message end two actors could claim names neither', () => {
    const A_BAR = '<rect class="pele-activation" data-id="A" x="20" y="60" width="30" height="200"/>';
    const B_BAR = '<rect class="pele-activation" data-id="B" x="40" y="60" width="10" height="200"/>';
    const ends = (bars: string, end: number) => {
      const drawn = parseInertSvg(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-sequence" aria-roledescription="sequence"><g>',
          '<path class="pele-lifeline" data-id="A" d="M0,44V300"/><path class="pele-lifeline" data-id="B" d="M60,44V300"/><path class="pele-lifeline" data-id="C" d="M200,44V300"/>',
          bars,
          `<g class="pele-edge pele-message" data-id="i0"><path d="M${end},100H193"/></g>`,
          ...['A', 'B', 'C'].map((name, i) => `<g class="pele-node pele-actor" data-id="${name}"><rect x="${[0, 60, 200][i]! - 30}" y="0" width="60" height="44"/></g>`),
          '</g></svg>',
        ].join(''),
      )!;
      const t = PELE_FINDER.targetFromElement(drawn, drawn.querySelector('g.pele-message')!, PELE_ID);
      return `${t?.from} -> ${t?.to}`;
    };
    // On A's bar (deep activations reach right to x=50) and 15 px off B's lifeline: the two readings disagree.
    expect(ends(A_BAR, 45)).toBe('undefined -> undefined');
    // On bars of both A and B, and between their lifelines.
    expect(ends(A_BAR + B_BAR, 32)).toBe('undefined -> undefined');
    // On A's bar only, clear of B's lifeline: A; on no bar, near B's lifeline: B.
    expect(ends(A_BAR, 30)).toBe('A -> C');
    expect(ends(A_BAR, 66)).toBe('B -> C');
  });

  test('state: two states named alike in two composites, composites, a self-transition, a note; no pseudo-state', async () => {
    const svgs = await drawn('21-state-parts');
    const targets = expectParity(svgs);
    const run = targets.filter((t) => t.label === 'Run');
    expect(run.map((t) => t.id).sort()).toEqual(['Run', 'Run2']);
    expect(PELE_FINDER.findTarget(svgs.pele, run[0]!, PELE_ID)).not.toBe(PELE_FINDER.findTarget(svgs.pele, run[1]!, PELE_ID));
    expect(targets).toContainEqual({ family: 'state', kind: 'node', id: 'Busy', label: 'Busy' });
    expect(targets).toContainEqual({ family: 'state', kind: 'edge', id: 'edge3', label: 'retry' });
    expect(targets).toContainEqual({ family: 'state', kind: 'edge', id: 'edge7', label: '"x" < y & z' });
    expect(targets).toContainEqual({ family: 'state', kind: 'node', id: 'Idle----note', label: 'a note' });
    expect(targets.some((t) => /_(?:start|end)$/u.test(t.id ?? ''))).toBe(false);
    expectParity(await drawn('26-state-pseudostates'));
  });

  test('class: two relations with the same ends restore by their label; a self-relation; a note is not a part', async () => {
    const svgs = await drawn('22-class-parts');
    const targets = expectParity(svgs);
    const twins = targets.filter((t) => t.from === 'User' && t.to === 'Order');
    expect(twins.map((t) => t.label).sort()).toEqual(['owns', 'places']);
    expect(PELE_FINDER.findTarget(svgs.pele, twins[0]!, PELE_ID)).not.toBe(PELE_FINDER.findTarget(svgs.pele, twins[1]!, PELE_ID));
    expect(MERMAID_FINDER.findTarget(svgs.mermaid, twins[0]!, RENDER_ID)).not.toBe(MERMAID_FINDER.findTarget(svgs.mermaid, twins[1]!, RENDER_ID));
    expect(targets).toContainEqual({ family: 'class', kind: 'edge', from: 'User', to: 'User', label: 'self' });
    expect(targets).toContainEqual({ family: 'class', kind: 'node', id: 'Order', label: 'Order<T>' });
    expect(PELE_FINDER.targetFromElement(svgs.pele, svgs.pele.querySelector('g.pele-note')!, PELE_ID)).toBeNull();
    // A class with an annotation is labelled by its name under both engines.
    const annotated = expectParity(await drawn('27-class-namespace-annotation'));
    expect(annotated).toContainEqual({ family: 'class', kind: 'node', id: 'Shape', label: 'Shape' });
  });

  test('er: two relationships with the same ends, a self-relationship, an aliased entity', async () => {
    const svgs = await drawn('23-er-parts');
    const targets = expectParity(svgs);
    const twins = targets.filter((t) => t.from === 'CUSTOMER' && t.to === 'ORDER');
    expect(twins.map((t) => t.label).sort()).toEqual(['places', 'returns']);
    expect(PELE_FINDER.findTarget(svgs.pele, twins[0]!, PELE_ID)).not.toBe(PELE_FINDER.findTarget(svgs.pele, twins[1]!, PELE_ID));
    expect(targets).toContainEqual({ family: 'er', kind: 'edge', from: 'PERSON', to: 'PERSON', label: 'is married to' });
    expect(targets).toContainEqual({ family: 'er', kind: 'node', id: 'p', label: 'Person A & B' });
  });

  test('requirement: a requirement or element is labelled by its name, not its type line', async () => {
    const svgs = await drawn('24-requirement-parts');
    const targets = expectParity(svgs);
    expect(targets.filter((t) => t.kind === 'node').map((t) => t.label).sort()).toEqual(['e1', 'e2', 'r1', 'r2']);
    expect(targets).toContainEqual({ family: 'requirement', kind: 'edge', id: 'e1-r2', label: '<<verifies>>' });
  });

  test('two relations that are the same in ends AND label cannot be told apart, so neither is offered under Pele', async () => {
    const svgs = await drawn('22-class-parts');
    const edge = svgs.pele.querySelector('g.pele-edge[data-id="id_User_Order_2"]')!;
    const twin = edge.cloneNode(true) as Element;
    twin.setAttribute('data-id', 'id_User_Order_9');
    edge.parentElement!.appendChild(twin);
    const label = svgs.pele.querySelector('g.pele-edge-label[data-id="id_User_Order_2"]')!.cloneNode(true) as Element;
    label.setAttribute('data-id', 'id_User_Order_9');
    svgs.pele.appendChild(label);
    expect(PELE_FINDER.targetFromElement(svgs.pele, twin, PELE_ID)).toBeNull();
    expect(PELE_FINDER.targetFromElement(svgs.pele, edge, PELE_ID)).toBeNull();
    expect(PELE_FINDER.findTarget(svgs.pele, { family: 'class', kind: 'edge', from: 'User', to: 'Order', label: 'owns' }, PELE_ID)).toBeNull();
    // The relation beside them keeps its own.
    expect(PELE_FINDER.findTarget(svgs.pele, { family: 'class', kind: 'edge', from: 'User', to: 'Order', label: 'places' }, PELE_ID)?.getAttribute('data-id')).toBe('id_User_Order_1');
  });
});
