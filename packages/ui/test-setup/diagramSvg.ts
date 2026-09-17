/**
 * happy-dom cannot host DOMPurify (see `__setDiagramSvgParserForTests` in
 * utils/diagram-render), so DOM tests that render a diagram parse the
 * engine's markup through an inert `<template>` of the page document instead
 * of DOMPurify's fragment; the scrub pass still runs on every render. The
 * DOMPurify parse itself is proven in a browser, never here.
 */
import { __setDiagramSvgParserForTests } from '../utils/diagram-render';

export function parseInertSvg(markup: string): SVGSVGElement | null {
  // happy-dom's HTML parser stops at a `<style>` inside foreign content (a
  // real mermaid svg parses to one element); its XML parser reads the whole
  // document with the right namespaces. The template parse stays as the
  // fallback for markup that is not well-formed XML.
  try {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const root = doc.documentElement;
    // A root without the svg namespace (markup with no `xmlns`) is not an
    // SVGSVGElement here and has no `style`; the template parse gives it one.
    if (root !== null && root instanceof SVGSVGElement && doc.querySelector('parsererror') === null) {
      return document.adoptNode(root) as SVGSVGElement;
    }
  } catch {
    // Fall through to the template parse.
  }
  const template = document.createElement('template');
  template.innerHTML = markup;
  const root = template.content.querySelector('svg');
  if (root === null) return null;
  return (root.ownerDocument === document ? root : document.adoptNode(root)) as SVGSVGElement;
}

/** Install the inert parser; returns the restore. */
export function installInertDiagramSvgParser(): () => void {
  __setDiagramSvgParserForTests(parseInertSvg);
  return () => __setDiagramSvgParserForTests(undefined);
}
