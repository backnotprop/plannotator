import { __setDiagramSvgParserForTests } from '../utils/diagram-render';

export function parseInertSvg(markup: string): SVGSVGElement | null {
  try {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const root = doc.documentElement;
    if (root !== null && root instanceof SVGSVGElement && doc.querySelector('parsererror') === null) {
      return document.adoptNode(root) as SVGSVGElement;
    }
  } catch {
  }
  const template = document.createElement('template');
  template.innerHTML = markup;
  const root = template.content.querySelector('svg');
  if (root === null) return null;
  return (root.ownerDocument === document ? root : document.adoptNode(root)) as SVGSVGElement;
}

export function installInertDiagramSvgParser(): () => void {
  __setDiagramSvgParserForTests(parseInertSvg);
  return () => __setDiagramSvgParserForTests(undefined);
}
