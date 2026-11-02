/**
 * Happy-dom as a host for DOMPurify, for the chat folder's sanitizer tests. As it
 * stands happy-dom cannot host it, for two reasons, and both are bridged here: its
 * NodeIterator loses its place when the node under it goes, so here the walk is a
 * list taken up front; and `Node.prototype.nodeName`, which DOMPurify reads
 * directly, is blank there, so here it answers as a browser's does. The rest is
 * DOMPurify's own code, and if either bridge stops working the sanitizer fails its
 * proof and those tests fail.
 *
 * Call it inside `beforeAll`, and call what it returns in `afterAll`.
 */
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
