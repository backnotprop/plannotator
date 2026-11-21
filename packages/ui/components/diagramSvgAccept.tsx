import { createContext } from 'react';

/**
 * Opt-in: a host's check of every drawn diagram svg before it reaches the page (`DiagramRenderOptions.accept` in
 * utils/diagram-render: called on the parsed root while it is still in the sanitizer's inert document). Refused, the
 * block shows its source as code. Absent (null), every diagram renders exactly as before. Its own small module, so a
 * host can provide it without importing the diagram engine.
 */
export const DiagramSvgAcceptContext = createContext<((svg: SVGSVGElement) => boolean) | null>(null);
