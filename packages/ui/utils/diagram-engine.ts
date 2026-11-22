/**
 * Which engine draws a Mermaid-syntax fence: Mermaid or Pele.
 *
 * ONE switch, `DIAGRAM_ENGINE_MODE`, decides for every fence. It is
 * `'mermaid'`, so every fence is drawn by Mermaid exactly as before Pele was
 * added, and no build carries any of Pele: `PELE_IN_BUILD` (`pele.ts`) is
 * derived from this switch, and its one import of `pele/lazy` and the
 * engine switch in `diagram-render.ts` sit behind it, so the bundler drops
 * them (`tests/entry-assets.test.ts` reads the built files). Changing this
 * constant is the one change that turns Pele on (`PELE.md`, "Turning Pele
 * on"). The other modes:
 *   - `'pele-where-safe'`: Pele draws a fence unless doing so would lose
 *     something Plannotator offers under Mermaid (`diagramEngineFor` below);
 *     then Mermaid draws it, quietly. A fence Pele cannot draw at render time
 *     (its `supports()` says no, or it throws) also falls back to Mermaid.
 *   - `'pele'`: Pele draws every fence; its errors are shown as errors.
 *
 * `PELE_CAPABILITIES` is the data the fallback reads: per Mermaid diagram
 * type, whether a single part can be commented on under each engine. The
 * features that are not per type are listed in `DIAGRAM_FEATURES`. Both are
 * checked against real renders in `DiagramBlock.engine.test.tsx`.
 */
export type DiagramEngine = 'mermaid' | 'pele';
export type DiagramEngineMode = 'mermaid' | 'pele-where-safe' | 'pele';

/** THE switch. `'mermaid'` is Plannotator's behavior before Pele. */
export const DIAGRAM_ENGINE_MODE: DiagramEngineMode = 'mermaid';

let modeOverride: DiagramEngineMode | undefined;

/** The mode in force: the switch, or a test's override. */
export function diagramEngineMode(): DiagramEngineMode {
  return modeOverride ?? DIAGRAM_ENGINE_MODE;
}

/** Test hook: render under another mode; `undefined` restores the switch. */
export function __setDiagramEngineModeForTests(mode: DiagramEngineMode | undefined): void {
  modeOverride = mode;
}

/** The Mermaid diagram types, by the keyword their source starts with. */
export type MermaidDiagramType =
  | 'flowchart'
  | 'sequence'
  | 'state'
  | 'class'
  | 'er'
  | 'requirement'
  | 'gantt'
  | 'pie'
  | 'gitGraph'
  | 'mindmap'
  | 'timeline'
  | 'journey'
  | 'quadrantChart'
  | 'xychart'
  | 'sankey'
  | 'block'
  | 'packet'
  | 'kanban'
  | 'architecture'
  | 'radar'
  | 'treemap'
  | 'c4'
  | 'other';

const KEYWORDS: ReadonlyArray<readonly [RegExp, MermaidDiagramType]> = [
  [/^(?:flowchart|graph)\b/u, 'flowchart'],
  [/^sequenceDiagram\b/u, 'sequence'],
  [/^stateDiagram(?:-v2)?\b/u, 'state'],
  [/^classDiagram(?:-v2)?\b/u, 'class'],
  [/^erDiagram\b/u, 'er'],
  [/^requirementDiagram\b/u, 'requirement'],
  [/^gantt\b/u, 'gantt'],
  [/^pie\b/u, 'pie'],
  [/^gitGraph\b/u, 'gitGraph'],
  [/^mindmap\b/u, 'mindmap'],
  [/^timeline\b/u, 'timeline'],
  [/^journey\b/u, 'journey'],
  [/^quadrantChart\b/u, 'quadrantChart'],
  [/^xychart(?:-beta)?\b/u, 'xychart'],
  [/^sankey(?:-beta)?\b/u, 'sankey'],
  [/^block(?:-beta)?\b/u, 'block'],
  [/^packet(?:-beta)?\b/u, 'packet'],
  [/^kanban\b/u, 'kanban'],
  [/^architecture(?:-beta)?\b/u, 'architecture'],
  [/^radar(?:-beta)?\b/u, 'radar'],
  [/^treemap(?:-beta)?\b/u, 'treemap'],
  [/^C4(?:Context|Container|Component|Dynamic|Deployment)\b/u, 'c4'],
];

/** The diagram type a source declares: the first line that is not front matter, a `%%` comment or a directive. */
export function mermaidDiagramTypeOf(source: string): MermaidDiagramType {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i += 1;
  if ((lines[i] ?? '').trim() === '---') {
    i += 1;
    while (i < lines.length && (lines[i] ?? '').trim() !== '---') i += 1;
    i += 1;
  }
  for (; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('%%')) continue;
    for (const [pattern, type] of KEYWORDS) if (pattern.test(line)) return type;
    return 'other';
  }
  return 'other';
}

export interface EngineCapability {
  /** A single part (node, edge, actor, message, ...) can carry a comment. */
  readonly partComments: boolean;
}

/**
 * Per diagram type, what each engine offers in Plannotator today. Mermaid's
 * part comments come from the finder in `diagram-anchor.ts` (flowchart,
 * state, class, ER, requirement, sequence); Pele's from
 * `diagram-anchor-pele.ts`, which addresses the same six types with the
 * same anchors. Every other type is a whole-diagram comment under both
 * engines.
 */
export const PELE_CAPABILITIES: Readonly<Record<MermaidDiagramType, Readonly<Record<DiagramEngine, EngineCapability>>>> = (() => {
  const both = (mermaid: boolean, pele: boolean) => ({ mermaid: { partComments: mermaid }, pele: { partComments: pele } });
  return {
    flowchart: both(true, true),
    sequence: both(true, true),
    state: both(true, true),
    class: both(true, true),
    er: both(true, true),
    requirement: both(true, true),
    gantt: both(false, false),
    pie: both(false, false),
    gitGraph: both(false, false),
    mindmap: both(false, false),
    timeline: both(false, false),
    journey: both(false, false),
    quadrantChart: both(false, false),
    xychart: both(false, false),
    sankey: both(false, false),
    block: both(false, false),
    packet: both(false, false),
    kanban: both(false, false),
    architecture: both(false, false),
    radar: both(false, false),
    treemap: both(false, false),
    c4: both(false, false),
    other: both(false, false),
  };
})();

/** Features that are not per type: whether Pele keeps each one. */
export const DIAGRAM_FEATURES = {
  /** `$$...$$` labels typeset with KaTeX (MathML). Pele: through the label step (`pele-labels.ts`). */
  mathLabels: { mermaid: true, pele: true },
  /** Styled label text: colour, underline, strike, code, bold, italic, line breaks (`pele-labels.ts`). Pictures and icons in a label draw under neither. */
  htmlLabels: { mermaid: true, pele: true },
  /** An author's theme settings (`%%{init}%%`, front matter `config:`). Pele: only the colours they spell out (`themeVariables`), never a theme name or `themeCSS` (`peleAuthorTheme.ts`). */
  initThemeDirectives: { mermaid: true, pele: true },
  /** The Diagram Shadow setting: Mermaid's neo look, and one scoped rule on Pele's nodes (`peleTheme.peleShadowCss`). */
  shadowSetting: { mermaid: true, pele: true },
  /** `click` links: both engines draw none (the canvas owns every click). */
  clickLinks: { mermaid: false, pele: false },
  /** Whole-diagram comments, popout, the Source pane, export and print, Ask AI, lazy load with Retry: engine-independent. */
  viewerFeatures: { mermaid: true, pele: true },
} as const;

/** Why `diagramEngineFor` kept a fence on Mermaid in `'pele-where-safe'`. */
export type MermaidReason = 'switch' | 'part-comments';

export interface EngineChoice {
  readonly engine: DiagramEngine;
  /** Set when the engine is Mermaid. */
  readonly reason?: MermaidReason;
}

/**
 * The engine for one fence's source under a mode. Synchronous: it reads the
 * source only. The render-time fallbacks (Pele's `supports()` says no, or it
 * throws) are `diagram-render.ts`'s, which call this first.
 */
export function diagramEngineFor(source: string, context: { readonly mode: DiagramEngineMode }): EngineChoice {
  if (context.mode === 'mermaid') return { engine: 'mermaid', reason: 'switch' };
  if (context.mode === 'pele') return { engine: 'pele' };
  const capability = PELE_CAPABILITIES[mermaidDiagramTypeOf(source)];
  if (capability.mermaid.partComments && !capability.pele.partComments) return { engine: 'mermaid', reason: 'part-comments' };
  return { engine: 'pele' };
}
