/** Graphviz is not drawn in the Guides webviews (overviews are Mermaid); this keeps its 1 MB engine out of the bundle. */
export function instance(): Promise<never> {
  return Promise.reject(new Error("Graphviz is not available in the Guided Reviews view."));
}
