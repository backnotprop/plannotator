export function instance(): Promise<never> {
  return Promise.reject(new Error("Graphviz is not available in the Guided Reviews view."));
}
