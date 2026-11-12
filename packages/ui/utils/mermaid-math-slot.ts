import { getMathRenderer, type MathRenderer } from './math';

const MERMAID_MATH_REGEX = /\$\$(.*)\$\$/;

export function hasMermaidMath(source: string): boolean {
  return MERMAID_MATH_REGEX.test(source);
}

export const MERMAID_MATH_SLOT_EMPTY_MESSAGE =
  'Math label: no math renderer is registered (the mathRendererLoader did not resolve before the diagram rendered)';

const slotRenderer: MathRenderer = {
  renderToString(tex, options) {
    const renderer = getMathRenderer();
    if (!renderer) throw new Error(MERMAID_MATH_SLOT_EMPTY_MESSAGE);
    return renderer.renderToString(tex, options);
  },
};

export default slotRenderer;
