/**
 * A sankey written with a CSV header row draws in Pele.
 *
 * What regresses if this fails: since Pele 1.10, `Source,Target,Value` as the
 * first row is a parse error ("Expecting a number"), so the diagram falls back
 * to Mermaid, whose sankey on the dark theme has near-invisible flows and runs
 * each name into its value ("Electricity75"). Pele 1.3 drew it. A bad value in
 * a later row must stay an error at its own line, and a first row that is a
 * flow must stay a flow.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { setPeleInBuildForTests } from '../test-setup/pele';
import { __setDiagramEngineModeForTests } from './diagram-engine';
import { renderDiagram } from './diagram-render';

const hasDom = typeof document !== 'undefined';
const theme = { colorTheme: 'github', mode: 'dark' } as const;
const nodes = (svg: SVGSVGElement) => Array.from(svg.querySelectorAll('rect.pele-sankey-node')).map((node) => node.getAttribute('data-id'));

describe.if(hasDom)('a sankey with a header row in Pele', () => {
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

  test('draws the flows and reads the header as a header', async () => {
    const source = 'sankey-beta\n%% energy\nSource,Target,"Value"\nElectricity,Homes,40\nElectricity,Industry,35\nGas,Homes,20\nGas,Industry,15';
    const result = await renderDiagram('mermaid', 'sankey-header', source, theme);
    if (result.ok === false) throw new Error(result.message);
    expect(nodes(result.svgNode).sort()).toEqual(['Electricity', 'Gas', 'Homes', 'Industry']);
    expect(result.svgNode.querySelectorAll('path.pele-sankey-link').length).toBe(4);
  });

  test('a first row that is a flow stays a flow', async () => {
    const result = await renderDiagram('mermaid', 'sankey-plain', 'sankey\nElectricity,Homes,40\nGas,Homes,20', theme);
    if (result.ok === false) throw new Error(result.message);
    expect(nodes(result.svgNode).sort()).toEqual(['Electricity', 'Gas', 'Homes']);
  });

  test('a bad value after the first row is still an error at its own line', async () => {
    const result = await renderDiagram('mermaid', 'sankey-bad', 'sankey-beta\nSource,Target,Value\nElectricity,Homes,40\nGas,Homes,lots', theme);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.line).toBe(4);
  });
});
