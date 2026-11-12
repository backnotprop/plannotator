export const CALL_TREE_SCHEMA = "plannotator.callTree/1" as const;

export type CallTreeNodeStatus = "same" | "added" | "removed";
export type CallTreeNodeKind = "call" | "branch";

export type CallTreeProvenance = "agent";

export interface CallTreeNote {
  text: string;
  provenance?: CallTreeProvenance;
}

export interface CallTreeNode {
  key: string;
  label: string;
  status: CallTreeNodeStatus;
  kind?: CallTreeNodeKind;
  file?: string;
  line?: number;
  endLine?: number;
  children: CallTreeNode[];
  provenance?: CallTreeProvenance;
  notes?: CallTreeNote[];
}

export interface CallTreeDoc {
  schema: typeof CALL_TREE_SCHEMA;
  title: string;
  entry: string;
  trail: string[];
  rootPath: string;
  source: "calldiff";
  from?: string;
  to?: string;
  root: CallTreeNode;
}

export interface CallTreeSourceTree {
  entry: string;
  tree: CallTreeNode;
}

export function calleeName(label: string): string {
  const open = label.indexOf("(");
  let head = (open === -1 ? label : label.slice(0, open)).trim();
  if (head.startsWith("new ")) head = head.slice(4);
  const dot = head.lastIndexOf(".");
  return dot === -1 ? head : head.slice(dot + 1);
}

export function callTreeFromEntry(
  tree: CallTreeSourceTree,
  index: number,
  range?: { from?: string; to?: string },
): CallTreeDoc {
  return {
    schema: CALL_TREE_SCHEMA,
    title: tree.entry,
    entry: tree.entry,
    trail: [],
    rootPath: `${tree.entry}:${index}`,
    source: "calldiff",
    ...(range?.from ? { from: range.from } : {}),
    ...(range?.to ? { to: range.to } : {}),
    root: tree.tree,
  };
}

export interface CallTreeHunk {
  file: string;
  oldFile?: string;
  newStart: number;
  newEnd: number;
  oldStart: number;
  oldEnd: number;
}

export interface CallTreeFunctionRange {
  name: string;
  newStart?: number;
  newEnd?: number;
  oldStart?: number;
  oldEnd?: number;
}

export interface CallTreeLocation {
  treeIndex: number;
  path: CallTreeNode[];
  childIndexes: number[];
}

function inRange(line: number | undefined, start: number | undefined, end: number | undefined): boolean {
  return line !== undefined && start !== undefined && end !== undefined && line >= start && line <= end;
}

function sameFile(node: CallTreeNode, hunk: CallTreeHunk): boolean {
  return node.file !== undefined && (node.file === hunk.file || (hunk.oldFile !== undefined && node.file === hunk.oldFile));
}

function writtenIn(
  node: CallTreeNode,
  hunk: CallTreeHunk,
  range: { newStart?: number; newEnd?: number; oldStart?: number; oldEnd?: number },
): boolean {
  if (!sameFile(node, hunk)) return false;
  return node.status === "removed"
    ? inRange(node.line, range.oldStart, range.oldEnd)
    : inRange(node.line, range.newStart, range.newEnd);
}

export function findCallTreeRoot(
  trees: readonly CallTreeSourceTree[],
  hunk: CallTreeHunk,
  fn?: CallTreeFunctionRange,
): CallTreeLocation | null {
  const fnRange = fn && (fn.newStart !== undefined || fn.oldStart !== undefined) ? fn : undefined;
  const hunkRange = { newStart: hunk.newStart, newEnd: hunk.newEnd, oldStart: hunk.oldStart, oldEnd: hunk.oldEnd };

  const search = (accept: (node: CallTreeNode, isEntryRoot: boolean) => boolean): CallTreeLocation | null => {
    let best: CallTreeLocation | null = null;
    trees.forEach((tree, treeIndex) => {
      const queue: Array<{ node: CallTreeNode; path: CallTreeNode[]; childIndexes: number[] }> = [
        { node: tree.tree, path: [tree.tree], childIndexes: [] },
      ];
      for (let head = 0; head < queue.length; head++) {
        const item = queue[head]!;
        if (best && item.path.length >= best.path.length) break;
        if (accept(item.node, item.path.length === 1)) {
          best = { treeIndex, path: item.path, childIndexes: item.childIndexes };
          break;
        }
        item.node.children.forEach((child, index) => {
          queue.push({ node: child, path: [...item.path, child], childIndexes: [...item.childIndexes, index] });
        });
      }
    });
    return best;
  };

  if (fnRange) {
    const found = search((node, isEntryRoot) => {
      const named = calleeName(node.label) === fnRange.name;
      if (named && node.children.some((child) => writtenIn(child, hunk, fnRange))) return true;
      return isEntryRoot && named && writtenIn(node, hunk, fnRange);
    });
    if (found) return found;
  }
  const found = search((node, isEntryRoot) => (
    node.children.some((child) => writtenIn(child, hunk, hunkRange))
    || (isEntryRoot && writtenIn(node, hunk, hunkRange))
  ));
  return found ? liftOutOfCallArguments(found, hunk, hunkRange) : null;
}

function liftOutOfCallArguments(
  location: CallTreeLocation,
  hunk: CallTreeHunk,
  range: { newStart: number; newEnd: number; oldStart: number; oldEnd: number },
): CallTreeLocation {
  let { path, childIndexes } = location;
  while (path.length > 1) {
    const root = path[path.length - 1]!;
    if (!root.file || !root.line || !root.endLine || root.endLine <= root.line) break;
    const inHunk = root.children.filter((child) => writtenIn(child, hunk, range));
    const allInsideCall = inHunk.length > 0 && inHunk.every((child) => (
      child.status !== "removed" && child.file === root.file && child.line !== undefined
      && child.line >= root.line! && child.line <= root.endLine!
    ));
    if (!allInsideCall) break;
    path = path.slice(0, -1);
    childIndexes = childIndexes.slice(0, -1);
  }
  return { treeIndex: location.treeIndex, path, childIndexes };
}

export function callTreeAt(
  trees: readonly CallTreeSourceTree[],
  location: CallTreeLocation,
  options: { title?: string; from?: string; to?: string } = {},
): CallTreeDoc {
  const tree = trees[location.treeIndex]!;
  const root = location.path[location.path.length - 1]!;
  let rootPath = `${tree.entry}:${location.treeIndex}`;
  location.childIndexes.forEach((childIndex, step) => {
    rootPath += `/${location.path[step + 1]!.key}:${childIndex}`;
  });
  return {
    schema: CALL_TREE_SCHEMA,
    title: options.title ?? calleeName(root.label),
    entry: tree.entry,
    trail: location.path.slice(0, -1).map((node) => calleeName(node.label)),
    rootPath,
    source: "calldiff",
    ...(options.from ? { from: options.from } : {}),
    ...(options.to ? { to: options.to } : {}),
    root,
  };
}

export type CallTreeGuide = "pipe" | "blank";

export interface CallTreeRow {
  id: string;
  node: CallTreeNode;
  depth: number;
  parentId?: string;
  guides: CallTreeGuide[];
  branch: "tee" | "elbow" | null;
  childCount: number;
  folded: boolean;
  repeat: boolean;
  band: "added" | "removed" | null;
  dot: "added" | "removed" | null;
  callerFile?: string;
  hasChange: boolean;
  match: boolean;
}

export interface CallTreeRowOptions {
  folds?: ReadonlyMap<string, boolean>;
  changesOnly?: boolean;
  query?: string;
}

export function callTreeNodeMatches(node: CallTreeNode, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return false;
  return `${node.label}\n${node.file ?? ""}`.toLocaleLowerCase().includes(normalized);
}

const searchCache = new WeakMap<CallTreeNode, { query: string; below: Set<CallTreeNode> }>();

function searchFacts(root: CallTreeNode, query: string): Set<CallTreeNode> {
  const cached = searchCache.get(root);
  if (cached && cached.query === query) return cached.below;
  const order: CallTreeNode[] = [];
  const stack: CallTreeNode[] = [root];
  const seen = new Set<CallTreeNode>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    order.push(node);
    for (const child of node.children) stack.push(child);
  }
  const below = new Set<CallTreeNode>();
  for (let index = order.length - 1; index >= 0; index--) {
    const node = order[index]!;
    if (callTreeNodeMatches(node, query) || node.children.some((child) => below.has(child))) below.add(node);
  }
  searchCache.set(root, { query, below });
  return below;
}

interface TreeFacts {
  hasChange: Map<CallTreeNode, boolean>;
  signature: Map<CallTreeNode, number>;
}

const factsCache = new WeakMap<CallTreeNode, TreeFacts>();

function treeFacts(root: CallTreeNode): TreeFacts {
  const cached = factsCache.get(root);
  if (cached) return cached;
  const hasChange = new Map<CallTreeNode, boolean>();
  const signature = new Map<CallTreeNode, number>();
  const interned = new Map<string, number>();
  const order: CallTreeNode[] = [];
  const stack: CallTreeNode[] = [root];
  const seen = new Set<CallTreeNode>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    order.push(node);
    for (const child of node.children) stack.push(child);
  }
  for (let index = order.length - 1; index >= 0; index--) {
    const node = order[index]!;
    let changed = node.status !== "same";
    const parts: string[] = [];
    for (const child of node.children) {
      if (hasChange.get(child)) changed = true;
      parts.push(`${signature.get(child)}@${child.file ?? ""}:${child.line ?? ""}`);
    }
    hasChange.set(node, changed);
    const text = `${node.kind ?? "call"}|${node.status}|${calleeName(node.label)}|${parts.join(",")}`;
    let id = interned.get(text);
    if (id === undefined) {
      id = interned.size;
      interned.set(text, id);
    }
    signature.set(node, id);
  }
  const facts = { hasChange, signature };
  factsCache.set(root, facts);
  return facts;
}

export function callTreeHasChange(root: CallTreeNode, node: CallTreeNode = root): boolean {
  return treeFacts(root).hasChange.get(node) ?? false;
}

function foldedByDefault(depth: number, hasChange: boolean): boolean {
  return depth > 0 && !hasChange;
}

export function buildCallTreeRows(doc: CallTreeDoc, options: CallTreeRowOptions = {}): CallTreeRow[] {
  const { hasChange, signature } = treeFacts(doc.root);
  const folds = options.folds;
  const changesOnly = options.changesOnly === true;
  const query = options.query?.trim() ?? "";
  const searching = query.length > 0;
  const matchBelow = searching ? searchFacts(doc.root, query) : null;
  const rows: CallTreeRow[] = [];
  const expandedSignatures = new Set<number>();
  const visibleChildren = (node: CallTreeNode): Array<[CallTreeNode, number]> => {
    const out: Array<[CallTreeNode, number]> = [];
    node.children.forEach((child, index) => {
      if (changesOnly && !hasChange.get(child)) return;
      if (matchBelow && !matchBelow.has(child)) return;
      out.push([child, index]);
    });
    return out;
  };

  interface Frame {
    node: CallTreeNode;
    id: string;
    depth: number;
    parent?: { node: CallTreeNode; id: string };
    guides: CallTreeGuide[];
    branch: CallTreeRow["branch"];
    callerFile?: string;
    parentStatus: CallTreeNodeStatus | null;
  }
  const stack: Frame[] = [{
    node: doc.root,
    id: doc.rootPath,
    depth: 0,
    guides: [],
    branch: null,
    parentStatus: null,
  }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node, depth } = frame;
    const changed = hasChange.get(node) ?? false;
    const kids = visibleChildren(node);
    const sig = signature.get(node)!;
    const repeat = !searching && kids.length > 0 && expandedSignatures.has(sig);
    const folded = !repeat && kids.length > 0 && (folds?.get(frame.id) ?? (searching ? false : foldedByDefault(depth, changed)));
    const ownChange = node.status === "same" ? null : node.status;
    const band = ownChange && frame.parentStatus !== ownChange ? ownChange : null;
    rows.push({
      id: frame.id,
      node,
      depth,
      ...(frame.parent ? { parentId: frame.parent.id } : {}),
      guides: frame.guides,
      branch: frame.branch,
      childCount: kids.length,
      folded,
      repeat,
      band,
      dot: ownChange && !band ? ownChange : null,
      ...(frame.callerFile ? { callerFile: frame.callerFile } : {}),
      hasChange: changed,
      match: searching && callTreeNodeMatches(node, query),
    });
    if (repeat || folded || kids.length === 0) continue;
    expandedSignatures.add(sig);
    const childGuides: CallTreeGuide[] = depth === 0
      ? []
      : [...frame.guides, frame.branch === "tee" ? "pipe" : "blank"];
    const callerFile = node.file ?? frame.callerFile;
    for (let index = kids.length - 1; index >= 0; index--) {
      const [child, childIndex] = kids[index]!;
      stack.push({
        node: child,
        id: `${frame.id}/${child.key}:${childIndex}`,
        depth: depth + 1,
        parent: { node, id: frame.id },
        guides: childGuides,
        branch: index === kids.length - 1 ? "elbow" : "tee",
        ...(callerFile ? { callerFile } : {}),
        parentStatus: node.status === "same" ? null : node.status,
      });
    }
  }
  return rows;
}

export function callTreeRowFoldedByDefault(row: CallTreeRow): boolean {
  return foldedByDefault(row.depth, row.hasChange);
}
