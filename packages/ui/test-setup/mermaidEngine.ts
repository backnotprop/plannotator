/**
 * For a test file about Mermaid's own path: a stand-in Mermaid runtime that
 * answers with captured svgs (or a failing one), and checks of what Mermaid
 * draws. The shipped switch (`DIAGRAM_ENGINE_MODE = 'pele-where-safe'`) draws
 * a fence with Pele wherever Pele can, so such a file asks for Mermaid for
 * every fence, as a fence that falls back to Mermaid gets it. What Pele
 * draws, and that it falls back, is `DiagramBlock.engine.test.tsx`'s.
 */
import { afterAll, beforeAll } from 'bun:test';
import { __setDiagramEngineModeForTests } from '../utils/diagram-engine';

/** Call once at the top of a test file: Mermaid draws every Mermaid fence in it. */
export function drawMermaidFencesWithMermaid(): void {
  beforeAll(() => __setDiagramEngineModeForTests('mermaid'));
  afterAll(() => __setDiagramEngineModeForTests(undefined));
}
