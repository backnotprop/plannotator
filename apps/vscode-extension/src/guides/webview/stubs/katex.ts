const katex = {
  renderToString(): string {
    throw new Error("Math is not available in the Guided Reviews view.");
  },
  render(): void {
    throw new Error("Math is not available in the Guided Reviews view.");
  },
};
export default katex;
