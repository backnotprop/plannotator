/**
 * The Mermaid anchor codec and `findDiagramTarget` over REAL rendered SVGs
 * (test-setup/fixtures/diagrams/*.svg: mermaid's own output captured from a
 * headless Chromium with MERMAID_CONFIG — strict, htmlLabels — and render
 * id "diagram-fixture"; every id shape is byte-identical under 12.0.0, see
 * HANDOFF.md "Mermaid 12"). Nothing here is hand-written; happy-dom parses
 * the svg, so the ids, classes and label text the codec reads are the real
 * ones.
 *
 * What regresses if these fail:
 * - `findDiagramTarget` misses or mis-resolves an id in a real svg: the
 *   flowchart counter suffix (`flowchart-D-1`) is matched whole, an edge id
 *   is split at the wrong underscore, a state pseudo-state (`root_start`)
 *   is offered as a node, a requirement node is missed because its id has
 *   no family prefix, or the label fallback (restore step 2) does not run
 *   when the id is gone;
 * - an edge between underscored node ids (`user_login --> check_auth`,
 *   rendered as `L_user_login_check_auth_0`) is split at the first
 *   underscore, so the wrong `from` and `to` are persisted;
 * - the scrub belt lets a script, a handler attribute or a javascript:
 *   reference through into the app DOM, or keeps an `<a href>` that would
 *   turn a pinpoint click into a navigation.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInertSvg } from '../test-setup/diagramSvg';
import {
  DIAGRAM_TARGET_SELECTOR,
  MERMAID_FINDER,
  diagramFamilyOf,
  findDiagramTarget,
  splitEdgeStem,
  targetFromElement,
  type DiagramTarget,
} from './diagram-anchor';
import { diagramHitSource, scopeDiagramCss, scrubDiagramSvg, widenEdgeHitAreas } from './diagram-render';

const hasDom = typeof document !== 'undefined';
const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const RENDER_ID = 'diagram-fixture';

function loadSvg(name: string): SVGSVGElement {
  const markup = readFileSync(join(FIXTURES, `${name}.svg`), 'utf8');
  const svg = parseInertSvg(markup);
  if (svg === null) throw new Error(`fixture ${name} has no svg root`);
  return svg;
}

/** Every addressable part the codec describes in a fixture, by element id. */
function describeAll(svg: Element): Map<string, DiagramTarget> {
  const out = new Map<string, DiagramTarget>();
  for (const el of Array.from(svg.querySelectorAll(DIAGRAM_TARGET_SELECTOR))) {
    const target = targetFromElement(svg, el, RENDER_ID);
    if (target !== null) out.set(el.id, target);
  }
  return out;
}

describe.if(hasDom)('the flowchart family (06-flowchart-review-decision, 01-flowchart-td-subgraphs)', () => {
  test('declares the family, describes nodes by Mermaid id with their label, edges by from and to', () => {
    const svg = loadSvg('06-flowchart-review-decision');
    expect(diagramFamilyOf(svg)).toBe('flowchart');
    const parts = describeAll(svg);
    expect(parts.get('diagram-fixture-flowchart-D-1')).toEqual({ family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?' });
    expect(parts.get('diagram-fixture-flowchart-U-0')).toEqual({ family: 'flowchart', kind: 'node', id: 'U', label: 'Reviewer' });
    expect(parts.get('diagram-fixture-L_D_M_0')).toEqual({ family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: 'Yes' });
    expect(parts.get('diagram-fixture-L_U_D_0')).toEqual({ family: 'flowchart', kind: 'edge', from: 'U', to: 'D', label: '' });
  });

  test('restores by id whatever counter the render gave it, by from and to, by label when the id is gone, and null when both are', () => {
    const svg = loadSvg('06-flowchart-review-decision');
    expect(findDiagramTarget(svg, { family: 'flowchart', kind: 'node', id: 'M', label: 'stale label' }, RENDER_ID)?.id).toBe(
      'diagram-fixture-flowchart-M-3',
    );
    expect(findDiagramTarget(svg, { family: 'flowchart', kind: 'edge', from: 'D', to: 'R', label: '' }, RENDER_ID)?.id).toBe(
      'diagram-fixture-L_D_R_0',
    );
    expect(findDiagramTarget(svg, { family: 'flowchart', kind: 'node', id: 'Gone', label: 'Revise' }, RENDER_ID)?.id).toBe(
      'diagram-fixture-flowchart-R-5',
    );
    expect(findDiagramTarget(svg, { family: 'flowchart', kind: 'node', id: 'Gone', label: 'Nowhere' }, RENDER_ID)).toBeNull();
    // A wrong render id prefix is never a match.
    expect(findDiagramTarget(svg, { family: 'flowchart', kind: 'node', id: 'M', label: '' }, 'diagram-other')).toBeNull();
  });

  test('addresses subgraphs as clusters by their subgraph id', () => {
    const clustered = loadSvg('01-flowchart-td-subgraphs');
    const parts = describeAll(clustered);
    expect(parts.get('diagram-fixture-Browser')).toEqual({ family: 'flowchart', kind: 'cluster', id: 'Browser', label: 'Browser session' });
    expect(findDiagramTarget(clustered, { family: 'flowchart', kind: 'cluster', id: 'Agent', label: '' }, RENDER_ID)?.id).toBe(
      'diagram-fixture-Agent',
    );
    expect(parts.get('diagram-fixture-L_Serve_Boot_0')).toMatchObject({ kind: 'edge', from: 'Serve', to: 'Boot' });
  });

  test('an edge between underscored node ids reads both ends whole', () => {
    // The declared node ids decide the split; the first underscore would
    // persist `from: "user"` for `user_login --> check_auth`.
    const nodeIds = new Set(['user_login', 'check_auth', 'user_home']);
    expect(splitEdgeStem('user_login_check_auth', nodeIds)).toEqual({ from: 'user_login', to: 'check_auth' });
    expect(splitEdgeStem('check_auth_user_home', nodeIds)).toEqual({ from: 'check_auth', to: 'user_home' });
    // Through the real element walk: a minimal flowchart svg in the
    // runtime's own id grammar.
    const svg = parseInertSvg(
      '<svg aria-roledescription="flowchart-v2">' +
        '<g class="nodes"><g id="diagram-us-flowchart-user_login-0" class="node"><span class="nodeLabel">Login</span></g>' +
        '<g id="diagram-us-flowchart-check_auth-1" class="node"><span class="nodeLabel">Auth?</span></g></g>' +
        '<g class="edgePaths"><path id="diagram-us-L_user_login_check_auth_0" class="flowchart-link"/></g></svg>',
    )!;
    const edge = svg.querySelector('path')!;
    expect(targetFromElement(svg, edge, 'diagram-us')).toEqual({ family: 'flowchart', kind: 'edge', from: 'user_login', to: 'check_auth', label: '' });
    expect(MERMAID_FINDER.findTarget(svg, { family: 'flowchart', kind: 'edge', from: 'user_login', to: 'check_auth', label: '' }, 'diagram-us')).toBe(edge);
  });
});

describe.if(hasDom)('the other id-bearing families', () => {
  test('state: nodes by state id, transitions by ordinal, pseudo-states skipped', () => {
    const svg = loadSvg('08-state-diagram');
    expect(diagramFamilyOf(svg)).toBe('state');
    const parts = describeAll(svg);
    expect(parts.get('diagram-fixture-state-Idle-1')).toEqual({ family: 'state', kind: 'node', id: 'Idle', label: 'Idle' });
    expect(parts.get('diagram-fixture-state-Running-7')).toMatchObject({ kind: 'node', id: 'Running' });
    expect(parts.get('diagram-fixture-edge1')).toEqual({ family: 'state', kind: 'edge', id: 'edge1', label: 'launch job' });
    expect(parts.has('diagram-fixture-state-root_start-0')).toBe(false);
  });

  test('class: classes by name, relations by from and to', () => {
    const svg = loadSvg('09-class-diagram');
    expect(diagramFamilyOf(svg)).toBe('class');
    const parts = describeAll(svg);
    expect(parts.get('diagram-fixture-classId-HtmlElementAnchor-1')).toMatchObject({ kind: 'node', id: 'HtmlElementAnchor' });
    expect(parts.get('diagram-fixture-id_Annotation_ImageAttachment_1')).toMatchObject({ kind: 'edge', from: 'Annotation', to: 'ImageAttachment' });
  });

  test('er: entities by name, relationships by both entity names with the inner counters dropped', () => {
    const svg = loadSvg('10-er-diagram');
    expect(diagramFamilyOf(svg)).toBe('er');
    const parts = describeAll(svg);
    expect(parts.get('diagram-fixture-entity-DECISION-3')).toMatchObject({ kind: 'node', id: 'DECISION' });
    expect(parts.get('diagram-fixture-id_entity-PLAN-1_entity-VERSION-2_1')).toMatchObject({ kind: 'edge', from: 'PLAN', to: 'VERSION' });
  });

  test('requirement: nodes by bare name (no family prefix), relations by stem', () => {
    const svg = loadSvg('15-requirement-diagram');
    expect(diagramFamilyOf(svg)).toBe('requirement');
    const parts = describeAll(svg);
    expect(parts.get('diagram-fixture-strict_gate')).toMatchObject({ kind: 'node', id: 'strict_gate' });
    expect(parts.get('diagram-fixture-cli-strict_gate-1')).toMatchObject({ kind: 'edge', id: 'cli-strict_gate' });
    expect(findDiagramTarget(svg, { family: 'requirement', kind: 'node', id: 'result_file', label: '' }, RENDER_ID)?.id).toBe(
      'diagram-fixture-result_file',
    );
  });

  test('sequence: parts carry classes, not ids, so actors go by name and messages, notes and frames by ordinal', () => {
    // What regresses: clicking a sequence diagram does nothing (the owner's
    // report), a bottom actor box is a different target from its top box,
    // or a message's text and its line are two targets.
    const svg = loadSvg('11-sequence-diagram');
    expect(diagramFamilyOf(svg)).toBe('sequence');
    const top = svg.querySelector('rect.actor-top[name="H"]')!;
    const bottom = svg.querySelector('rect.actor-bottom[name="H"]')!;
    const hook: DiagramTarget = { family: 'sequence', kind: 'node', id: 'H', label: 'Hook' };
    expect(targetFromElement(svg, top, RENDER_ID)).toEqual(hook);
    expect(targetFromElement(svg, bottom, RENDER_ID)).toEqual(hook);
    expect(targetFromElement(svg, bottom.parentElement!.querySelector('text.actor')!, RENDER_ID)).toEqual(hook);
    expect(findDiagramTarget(svg, hook, RENDER_ID)).toBe(top);

    const lines = Array.from(svg.querySelectorAll('.messageLine0, .messageLine1'));
    const texts = Array.from(svg.querySelectorAll('text.messageText'));
    const first: DiagramTarget = { family: 'sequence', kind: 'edge', id: 'msg-1', from: 'CC', to: 'H', label: 'ExitPlanMode' };
    expect(targetFromElement(svg, lines[0]!, RENDER_ID)).toEqual(first);
    // The message TEXT is the same message: it is what a person clicks.
    expect(targetFromElement(svg, texts[0]!, RENDER_ID)).toEqual(first);
    expect(findDiagramTarget(svg, first, RENDER_ID)).toBe(lines[0]!);

    expect(targetFromElement(svg, svg.querySelector('rect.note')!, RENDER_ID)).toEqual({
      family: 'sequence', kind: 'node', id: 'note-1', label: 'server stops on decision',
    });
    expect(targetFromElement(svg, svg.querySelector('line.loopLine')!, RENDER_ID)).toEqual({
      family: 'sequence', kind: 'cluster', id: 'frame-1', label: 'alt [approved]',
    });
    expect(targetFromElement(svg, svg.querySelector('rect.activation0')!, RENDER_ID)).toBeNull();
  });

  test('sequence restore: an ordinal that moved is found by its label; an edited label keeps its ordinal', () => {
    const svg = loadSvg('11-sequence-diagram');
    const lines = Array.from(svg.querySelectorAll('.messageLine0, .messageLine1'));
    // A message was inserted above: the stored ordinal now names another
    // message, but ONE message carries the stored label.
    expect(findDiagramTarget(svg, { family: 'sequence', kind: 'edge', id: 'msg-1', label: 'open review UI' }, RENDER_ID)).toBe(lines[2]!);
    // The text was edited in place: nothing carries the label, the ordinal stands.
    expect(findDiagramTarget(svg, { family: 'sequence', kind: 'edge', id: 'msg-2', label: 'a label nobody has' }, RENDER_ID)).toBe(lines[1]!);
    expect(findDiagramTarget(svg, { family: 'sequence', kind: 'edge', id: 'msg-99', label: 'gone' }, RENDER_ID)).toBeNull();
    // An actor whose name is gone restores by its unique label.
    expect(findDiagramTarget(svg, { family: 'sequence', kind: 'node', id: 'Renamed', label: 'Browser' }, RENDER_ID)).toBe(
      svg.querySelector('rect.actor-top[name="B"]'),
    );
  });

  test('the whole diagram is always restorable: its element is the svg root', () => {
    const svg = loadSvg('11-sequence-diagram');
    expect(findDiagramTarget(svg, { family: 'sequence', kind: 'diagram', label: 'sequenceDiagram' }, RENDER_ID)).toBe(svg);
  });
});

describe.if(hasDom)('scrubDiagramSvg (the belt over the engine output)', () => {
  test('drops script elements, handler attributes, javascript: and data: references, and every anchor target', () => {
    const svg = parseInertSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="window.pwned=1">' +
        '<script>window.pwned = 1</script>' +
        '<a href="https://example.com/away" target="_blank"><g id="x-flowchart-B-1" class="node"><rect width="4" height="4"/></g></a>' +
        '<g id="x-flowchart-A-0" class="node" onclick="window.pwned=1"><rect width="4" height="4"/></g>' +
        '<a href="javascript:alert(1)"><text>t</text></a>' +
        '<a href="#x-flowchart-A-0"><text>u</text></a>' +
        '<image href="data:text/html,x" width="1" height="1"/>' +
        '<image href="https://example.com/a.png" width="1" height="1"/>' +
        '<iframe src="https://example.com"></iframe>' +
        '</svg>',
    )!;
    scrubDiagramSvg(svg);
    const markup = svg.outerHTML;
    expect(svg.querySelector('script')).toBeNull();
    expect(svg.querySelector('iframe')).toBeNull();
    expect(markup).not.toContain('onclick');
    expect(markup).not.toContain('onload');
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('data:text/html');
    // Every anchor loses its target, the fragment link included; the
    // wrapped node survives.
    expect(svg.querySelector('a[href]')).toBeNull();
    expect(svg.querySelector('#x-flowchart-B-1')).not.toBeNull();
    expect(markup).not.toContain('href="#x-flowchart-A-0"');
    expect(markup).toContain('id="x-flowchart-A-0"');
    // An http(s) image reference is the one external reference that stays;
    // the data: one before it lost its href.
    const images = Array.from(svg.querySelectorAll('image'));
    expect(images).toHaveLength(2);
    expect(images[0]!.hasAttribute('href')).toBe(false);
    expect(images[1]!.getAttribute('href')).toBe('https://example.com/a.png');
  });

  test('leaves a real fixture whole (no element, id or label is lost)', () => {
    const markup = readFileSync(join(FIXTURES, '06-flowchart-review-decision.svg'), 'utf8');
    const raw = parseInertSvg(markup)!;
    const clean = parseInertSvg(markup)!;
    scrubDiagramSvg(clean);
    expect(clean.querySelectorAll('foreignObject').length).toBeGreaterThan(0);
    expect(clean.querySelectorAll('*').length).toBe(raw.querySelectorAll('*').length);
    expect(clean.querySelectorAll('*').length).toBeGreaterThan(50);
    expect(clean.querySelectorAll('[id]').length).toBe(raw.querySelectorAll('[id]').length);
    expect(clean.textContent?.replace(/\s+/gu, ' ').trim()).toBe(raw.textContent?.replace(/\s+/gu, ' ').trim());
  });
});

describe.if(hasDom)('edge labels, duplicate labels, and the hit layer', () => {
  test('an edge LABEL resolves to its edge (it is painted over the edge, and is where a person clicks it)', () => {
    const svg = loadSvg('06-flowchart-review-decision');
    const label = Array.from(svg.querySelectorAll('g.edgeLabel')).find((g) => g.textContent?.includes('Yes'))!;
    expect(label).toBeDefined();
    expect(targetFromElement(svg, label, RENDER_ID)).toEqual({ family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: 'Yes' });
    // Restore lands on the edge path, never on the label group.
    expect(findDiagramTarget(svg, { family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: '' }, RENDER_ID)?.tagName.toLowerCase()).toBe('path');
  });

  test('the label fallback is skipped when two nodes carry the label (the first match is the wrong node half the time)', () => {
    const svg = parseInertSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" aria-roledescription="flowchart-v2"><g class="nodes">' +
        '<g id="r-flowchart-A-0" class="node"><text>Retry</text></g>' +
        '<g id="r-flowchart-B-1" class="node"><text>Retry</text></g>' +
        '<g id="r-flowchart-C-2" class="node"><text>Done</text></g></g></svg>',
    )!;
    expect(findDiagramTarget(svg, { family: 'flowchart', kind: 'node', id: 'Gone', label: 'Retry' }, 'r')).toBeNull();
    expect(findDiagramTarget(svg, { family: 'flowchart', kind: 'node', id: 'Gone', label: 'Done' }, 'r')?.id).toBe('r-flowchart-C-2');
  });

  test('every edge gets ONE bare hit path in a layer appended last, placed by the ancestors\' transforms', () => {
    // What regresses: an edge is a 1–2 px target; a sibling clone is covered
    // by the edge's own label box; a clone that keeps `data-id` makes a
    // host's `[data-id="L_D_M_0"]` match twice.
    const svg = loadSvg('06-flowchart-review-decision');
    const dataIdBefore = svg.querySelectorAll('[data-id="L_D_M_0"]').length;
    widenEdgeHitAreas(svg);
    widenEdgeHitAreas(svg); // idempotent
    const layers = svg.querySelectorAll('[data-diagram-hit-layer]');
    expect(layers.length).toBe(1);
    expect(svg.lastElementChild).toBe(layers[0]!);
    const edges = Array.from(svg.querySelectorAll('path.flowchart-link'));
    const hits = Array.from(layers[0]!.children);
    expect(hits.length).toBe(edges.length);
    hits.forEach((hit, index) => {
      expect(diagramHitSource(hit)).toBe(edges[index]!);
      expect(hit.getAttribute('d')).toBe(edges[index]!.getAttribute('d'));
      const names = Array.from(hit.attributes).map((a) => a.name).sort();
      expect(names.filter((n) => n.startsWith('data-'))).toEqual(['data-diagram-hit']);
      expect(names).not.toContain('id');
      expect(names).not.toContain('class');
      expect(names).not.toContain('marker-end');
      expect(hit.getAttribute('stroke-width')).toBe('14');
      expect(hit.getAttribute('pointer-events')).toBe('stroke');
      expect(hit.getAttribute('stroke')).toBe('transparent');
    });
    expect(svg.querySelectorAll('[data-id="L_D_M_0"]').length).toBe(dataIdBefore);
    expect(diagramHitSource(edges[0]!)).toBeNull();
  });

  test('a hit path in a nested group carries every ancestor transform, outermost first', () => {
    const svg = parseInertSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><g transform="translate(10,20)"><g class="root" transform="translate(5,5)">' +
        '<g class="edgePaths"><path class="flowchart-link" d="M0,0L10,10" transform="scale(2)"/></g></g></g>' +
        '<g class="edge"><path d="M0,0L1,1"/></g></svg>',
    )!;
    widenEdgeHitAreas(svg);
    const hits = Array.from(svg.querySelectorAll('[data-diagram-hit]'));
    expect(hits.map((h) => h.getAttribute('transform'))).toEqual(['translate(10,20) translate(5,5) scale(2)', null]);
  });
});

describe.if(hasDom)('scopeDiagramCss: a <style> in a diagram may only style that diagram', () => {
  test('the reviewer\'s payload: @import, a rule on an outside element and a fetching url( are dropped; scoped rules and keyframes stay', () => {
    const css =
      '@import url(//evil.example/x.css); #victim{color:red!important} ' +
      '#d1 .node rect{fill:#123} #d1 .bg{background:url(//evil.example/a.png)} #d1 .f{filter:url(#drop)} ' +
      '#d1 .a, #victim{color:red} #d10 .x{color:red} #d1 .e{background:u\\72l(//evil.example/b.png)} ' +
      '#d1 .i{background:image-set("//evil.example/c.png" 1x)} @font-face{font-family:x;src:url(//evil.example/f.woff)} ' +
      '@keyframes dash{to{stroke-dashoffset:0}} @media print{#d1 .node{fill:#000} #victim{display:none}}';
    const kept = scopeDiagramCss(css, 'd1');
    expect(kept).toBe('#d1 .node rect{fill:#123}#d1 .f{filter:url(#drop)}@keyframes dash{to{stroke-dashoffset:0}}@media print{#d1 .node{fill:#000}}');
    // With no root id nothing can be scoped: only keyframes survive.
    expect(scopeDiagramCss('#d1 .node{fill:red} @keyframes k{to{opacity:1}}', '')).toBe('@keyframes k{to{opacity:1}}');
  });

  test('the scrub applies it to the mounted tree, and every rule Mermaid itself emitted survives', () => {
    const hostile = parseInertSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" id="d1"><style>@import url(//evil.example/x.css); #victim{color:red!important} #d1 .node{fill:red}</style><g class="node"/></svg>',
    )!;
    scrubDiagramSvg(hostile);
    expect(hostile.querySelector('style')?.textContent).toBe('#d1 .node{fill:red}');
    const onlyHostile = parseInertSvg('<svg xmlns="http://www.w3.org/2000/svg" id="d2"><style>#victim{color:red}</style></svg>')!;
    scrubDiagramSvg(onlyHostile);
    expect(onlyHostile.querySelector('style')).toBeNull();

    for (const name of ['06-flowchart-review-decision', '08-state-diagram', '09-class-diagram', '10-er-diagram', '11-sequence-diagram', '15-requirement-diagram']) {
      const svg = loadSvg(name);
      const before = svg.querySelector('style')!.textContent!;
      scrubDiagramSvg(svg);
      const after = svg.querySelector('style')!.textContent!;
      const rules = (text: string) => (text.match(/\{/gu) ?? []).length;
      expect(rules(after)).toBe(rules(before));
      expect(after.replace(/\s+/gu, '')).toBe(before.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\s+/gu, ''));
    }
  });
});
