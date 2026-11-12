export function bridgeSanitizerDom(): () => void {
  const realNodeName = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeName');

  function nameLikeABrowser(this: Node) {
    if (this.nodeType === 1) return (this as Element).tagName;
    if (this.nodeType === 3) return '#text';
    if (this.nodeType === 8) return '#comment';
    return realNodeName?.get?.call(this);
  }

  function walkFromAList(root: Node) {
    const nodes: Node[] = [];
    const visit = (node: Node) => {
      nodes.push(node);
      for (const child of node.childNodes) visit(child);
    };
    visit(root);
    let at = 0;
    return { nextNode: () => nodes[at++] ?? null };
  }

  Object.defineProperty(Node.prototype, 'nodeName', { configurable: true, get: nameLikeABrowser });
  Object.defineProperty(document, 'createNodeIterator', { configurable: true, value: walkFromAList });
  return () => {
    delete (document as { createNodeIterator?: unknown }).createNodeIterator;
    Object.defineProperty(Node.prototype, 'nodeName', realNodeName!);
  };
}
