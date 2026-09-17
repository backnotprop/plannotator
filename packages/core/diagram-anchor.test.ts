/**
 * The diagram anchor codec, pure half.
 *
 * What regresses if these fail:
 * - the anchor a viewer writes is not what `parseDiagramAnchor` reads back,
 *   so every diagram comment lists as unanchored on the next load;
 * - a foreign, partial or unversioned value throws instead of degrading to
 *   null (the standing rule: unanchored but listed) — the external-annotation
 *   POST, the feedback archive and the export all run this parser on data
 *   another writer produced;
 * - `diagramSourceLine` points at the wrong line (`D` matching `DR`), so the
 *   Source pane's gutter mark and an agent's grep land on the wrong text;
 * - the export's location line loses the part id an agent greps the fence for.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildDiagramAnchor,
  buildDiagramAnchorValue,
  diagramAnchorLocationLine,
  diagramFirstSourceLine,
  diagramSourceLine,
  diagramTargetName,
  diagramTargetText,
  lineMentions,
  parseDiagramAdditionalTargets,
  parseDiagramAnchor,
  sameTarget,
  type DiagramTarget,
} from './diagram-anchor';

const node: DiagramTarget = { family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?' };
const edge: DiagramTarget = { family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: 'Yes' };

describe('the wire codec', () => {
  test('the anchor value round-trips through JSON and the parser', () => {
    const value = buildDiagramAnchorValue(node, [4, 4]);
    expect(value).toEqual({ v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [4, 4] });
    expect(parseDiagramAnchor(JSON.parse(JSON.stringify(value)))).toEqual(value);
    const edgeValue = buildDiagramAnchorValue({ ...edge, label: '' }, null);
    expect(edgeValue).toEqual({ v: 1, family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: '', sourceLine: null });
    expect(parseDiagramAnchor(edgeValue)).toEqual(edgeValue);
  });

  test('the opaque-blob shape a host stores carries originalText, the anchor and the extra targets', () => {
    const wire = buildDiagramAnchor(node, [2, 2], [edge]);
    expect(wire).toEqual({
      originalText: 'Approve?',
      diagram: { v: 1, family: 'flowchart', kind: 'node', id: 'D', label: 'Approve?', sourceLine: [2, 2] },
      diagramAdditionalTargets: [{ family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: 'Yes' }],
    });
    expect(buildDiagramAnchor({ ...edge, label: '' }, null, [])).toEqual({
      originalText: 'D → M',
      diagram: { v: 1, family: 'flowchart', kind: 'edge', from: 'D', to: 'M', label: '', sourceLine: null },
    });
  });

  test('degrades a foreign, partial or unversioned value to null, never a throw', () => {
    expect(parseDiagramAnchor(undefined)).toBeNull();
    expect(parseDiagramAnchor('node D')).toBeNull();
    expect(parseDiagramAnchor({ kind: 'node', id: 'D' })).toBeNull();
    expect(parseDiagramAnchor({ v: 2, family: 'flowchart', kind: 'node', id: 'D' })).toBeNull();
    expect(parseDiagramAnchor({ v: 1, family: 'flowchart', kind: 'edge', from: 'D' })).toBeNull();
    expect(parseDiagramAnchor({ v: 1, family: 'plantuml', kind: 'node', id: 'D' })).toBeNull();
    // A bad sourceLine drops to null; the target survives.
    expect(parseDiagramAnchor({ v: 1, family: 'flowchart', kind: 'node', id: 'D', sourceLine: [0] })).toEqual({
      v: 1,
      family: 'flowchart',
      kind: 'node',
      id: 'D',
      label: '',
      sourceLine: null,
    });
  });

  test('caps oversized strings and the additional targets, and drops junk entries', () => {
    const long = 'x'.repeat(1000);
    expect(parseDiagramAnchor({ v: 1, family: 'graphviz', kind: 'node', id: long, label: long })?.id).toHaveLength(400);
    const many = Array.from({ length: 20 }, (_, i) => ({ family: 'flowchart', kind: 'node', id: `N${i}`, label: '' }));
    expect(parseDiagramAdditionalTargets(many, 16)).toHaveLength(16);
    expect(parseDiagramAdditionalTargets([null, 4, { kind: 'node' }, edge], 16)).toEqual([edge]);
    expect(parseDiagramAdditionalTargets('nope', 16)).toEqual([]);
  });

  test('sameTarget compares the id, else both ends, never the family', () => {
    expect(sameTarget(node, { ...node, family: 'class', label: 'other' })).toBe(true);
    expect(sameTarget(edge, { ...edge, label: '' })).toBe(true);
    expect(sameTarget(edge, { ...edge, to: 'R' })).toBe(false);
    expect(sameTarget(node, edge)).toBe(false);
  });

  test('names parts for chips, the composer and the export', () => {
    expect(diagramTargetText(node)).toBe('Approve?');
    expect(diagramTargetText({ ...edge, label: '' })).toBe('D → M');
    expect(diagramTargetName(node)).toBe('node D');
    expect(diagramTargetName(edge)).toBe('edge D → M');
    expect(diagramTargetName({ family: 'state', kind: 'edge', id: 'edge3', label: '' })).toBe('edge edge3');
    // The export line names the label, the id in parentheses, and the line.
    expect(diagramAnchorLocationLine(buildDiagramAnchorValue(node, [4, 4]))).toBe('Diagram node Approve? (D), line 4');
    expect(diagramAnchorLocationLine(buildDiagramAnchorValue(edge, [5, 6]))).toBe('Diagram edge Yes (D → M), lines 5–6');
    expect(diagramAnchorLocationLine(buildDiagramAnchorValue({ ...edge, label: '' }, null))).toBe('Diagram edge D → M');
    expect(diagramAnchorLocationLine(buildDiagramAnchorValue({ family: 'graphviz', kind: 'node', id: 'Ship', label: 'Ship' }, [3, 3]))).toBe(
      'Diagram node Ship, line 3',
    );
  });
});

describe('diagramSourceLine', () => {
  const source = [
    'flowchart LR',
    '  U([Reviewer]) --> D{Approve?}',
    '  D -->|Yes| M[(Merge)]',
    '  D -->|No| R[Revise]',
    '  subgraph Later["Later"]',
    '    R --> DR[Re-review]',
    '  end',
  ].join('\n');

  test('finds the first line that names a node, both ends of an edge, or a subgraph', () => {
    expect(diagramSourceLine(source, { family: 'flowchart', kind: 'node', id: 'D', label: '' })).toEqual([2, 2]);
    expect(diagramSourceLine(source, { family: 'flowchart', kind: 'node', id: 'R', label: '' })).toEqual([4, 4]);
    expect(diagramSourceLine(source, { family: 'flowchart', kind: 'edge', from: 'D', to: 'R', label: '' })).toEqual([4, 4]);
    expect(diagramSourceLine(source, { family: 'flowchart', kind: 'cluster', id: 'Later', label: '' })).toEqual([5, 5]);
  });

  test('matches whole tokens only (D is not DR) and answers null for a part not in the text', () => {
    expect(diagramSourceLine(source, { family: 'flowchart', kind: 'node', id: 'DR', label: '' })).toEqual([6, 6]);
    expect(diagramSourceLine(source, { family: 'flowchart', kind: 'node', id: 'Z', label: '' })).toBeNull();
    expect(diagramSourceLine(source, { family: 'state', kind: 'edge', id: 'edge2', label: '' })).toBeNull();
    // Plain string scanning: an id with a regex metacharacter is a token,
    // not a pattern.
    expect(lineMentions('  A.b(1) --> C', 'A.b(1)')).toBe(true);
    expect(lineMentions('  Ab1 --> C', 'A.b(1)')).toBe(false);
  });
});

describe('the sequence family and the whole-diagram kind (additive within v: 1)', () => {
  const source = [
    'sequenceDiagram',
    '  participant H as Hook',
    '  participant S as Server',
    '  H->>S: plan (stdin JSON)',
    '  Note over S: stops on decision',
    '  alt approved',
    '    S-->>H: allow',
    '  else denied',
    '    S--xH: deny',
    '  end',
    '',
  ].join('\n');

  test('sequence ordinals map to the n-th statement of their kind; an actor to the first line that names it', () => {
    // What regresses: the pane's gutter mark and an agent's grep land on the
    // wrong message because `msg-2` was looked up as a token, not an ordinal.
    expect(diagramSourceLine(source, { family: 'sequence', kind: 'edge', id: 'msg-1', label: '' })).toEqual([4, 4]);
    expect(diagramSourceLine(source, { family: 'sequence', kind: 'edge', id: 'msg-2', label: '' })).toEqual([7, 7]);
    expect(diagramSourceLine(source, { family: 'sequence', kind: 'edge', id: 'msg-3', label: '' })).toEqual([9, 9]);
    expect(diagramSourceLine(source, { family: 'sequence', kind: 'edge', id: 'msg-4', label: '' })).toBeNull();
    expect(diagramSourceLine(source, { family: 'sequence', kind: 'node', id: 'note-1', label: '' })).toEqual([5, 5]);
    expect(diagramSourceLine(source, { family: 'sequence', kind: 'cluster', id: 'frame-1', label: '' })).toEqual([6, 6]);
    expect(diagramSourceLine(source, { family: 'sequence', kind: 'node', id: 'S', label: 'Server' })).toEqual([3, 3]);
  });

  test('a whole-diagram anchor has no id, spans the source, and round-trips', () => {
    // What regresses: a click that resolves no part does nothing, or the
    // parser refuses the id-less anchor and the comment lists as unanchored.
    const whole: DiagramTarget = { family: 'sequence', kind: 'diagram', label: diagramFirstSourceLine(source) };
    expect(whole.label).toBe('sequenceDiagram');
    expect(diagramSourceLine(source, whole)).toEqual([1, 10]);
    const value = buildDiagramAnchorValue(whole, [12, 21]);
    expect(parseDiagramAnchor(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(diagramAnchorLocationLine(value)).toBe('Diagram (sequence), lines 12–21');
    expect(diagramTargetName(whole)).toBe('whole diagram');
    expect(sameTarget(whole, { family: 'other', kind: 'diagram', label: 'pie' })).toBe(true);
    expect(sameTarget(whole, node)).toBe(false);
    // A part still needs its id: only the whole-diagram kind may omit it.
    expect(parseDiagramAnchor({ v: 1, family: 'sequence', kind: 'node', label: 'x' })).toBeNull();
  });
});
