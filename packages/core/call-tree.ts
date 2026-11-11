/**
 * The Call tree: one function and the calls it makes, as one small versioned
 * document (`plannotator.callTree/1`). Browser-safe and dependency-free, so
 * the classic review app, a Guided Review chapter, the Inbox review and the
 * commercial app can all feed the same component from it.
 *
 * The calls themselves always come from analysis (CallDiff today). Words an
 * agent writes on top (phase 2) are marked with `provenance: "agent"` on the
 * node or the note; the view draws those with a pencil mark. Nothing in this
 * file adds, removes or moves a call.
 */

export const CALL_TREE_SCHEMA = "plannotator.callTree/1" as const;

export type CallTreeNodeStatus = "same" | "added" | "removed";
export type CallTreeNodeKind = "call" | "branch";

/** Who wrote a row's words or a note. Absent: computed by analysis. */
export type CallTreeProvenance = "agent";

export interface CallTreeNote {
  text: string;
  provenance?: CallTreeProvenance;
}

/**
 * One call (or branch) in the tree. Structurally the same as CallDiff's
 * `CallFlowNode`, so an analysis tree is a Call tree without copying.
 * `file:line` is where this call is written.
 */
export interface CallTreeNode {
  key: string;
  label: string;
  status: CallTreeNodeStatus;
  kind?: CallTreeNodeKind;
  file?: string;
  line?: number;
  endLine?: number;
  children: CallTreeNode[];
  /** Set when an agent wrote this row's label (phase 2). */
  provenance?: CallTreeProvenance;
  /** Short notes after the call (phase 2). */
  notes?: CallTreeNote[];
}

export interface CallTreeDoc {
  schema: typeof CALL_TREE_SCHEMA;
  /** The root function's name. */
  title: string;
  /** The analysis entry point the tree was cut from. */
  entry: string;
  /** Callers from the entry down to the root, outermost first; empty when the root is the entry. */
  trail: string[];
  /** Stable path of the root inside its entry tree (the Call flow tab's row path format). */
  rootPath: string;
  /** Who drew the calls. */
  source: "calldiff";
  from?: string;
  to?: string;
  root: CallTreeNode;
}

/** The analysis tree shape the review app receives (`CallFlowTree`), restated so core stays dependency-free. */
export interface CallTreeSourceTree {
  entry: string;
  tree: CallTreeNode;
}

/** The called name of a call label: `textMeasure.measureHtml(html)` -> `measureHtml`. */
export function calleeName(label: string): string {
  const open = label.indexOf("(");
  let head = (open === -1 ? label : label.slice(0, open)).trim();
  if (head.startsWith("new ")) head = head.slice(4);
  const dot = head.lastIndexOf(".");
  return dot === -1 ? head : head.slice(dot + 1);
}

/** Wrap one whole analysis entry tree as a Call tree document. */
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

// --- Re-rooting at the function around a hunk -------------------------------

/** One hunk of a file's diff: its whole new and old ranges (context included). */
export interface CallTreeHunk {
  file: string;
  oldFile?: string;
  newStart: number;
  newEnd: number;
  oldStart: number;
  oldEnd: number;
}

/** The function the hunk sits in, from `sem` (both sides when known). */
export interface CallTreeFunctionRange {
  name: string;
  newStart?: number;
  newEnd?: number;
  oldStart?: number;
  oldEnd?: number;
}

export interface CallTreeLocation {
  treeIndex: number;
  /** Nodes from the entry's root down to the found root, inclusive. */
  path: CallTreeNode[];
  /** Child index taken at each step below the entry root. */
  childIndexes: number[];
}

function inRange(line: number | undefined, start: number | undefined, end: number | undefined): boolean {
  return line !== undefined && start !== undefined && end !== undefined && line >= start && line <= end;
}

function sameFile(node: CallTreeNode, hunk: CallTreeHunk): boolean {
  return node.file !== undefined && (node.file === hunk.file || (hunk.oldFile !== undefined && node.file === hunk.oldFile));
}

/** A call written inside the range: removed calls live on the old side, the rest on the new side. */
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

/**
 * Find where to root the tree for a hunk. A node is the function around the
 * hunk when the calls it makes are written inside that function (its children
 * sit in the function's line range), or when it is an entry written there.
 * With `sem`'s function range the name must match too, so a same-file
 * neighbour is never picked; without it, calls written inside the hunk itself
 * decide. The shallowest match wins, so the caller trail is the shortest.
 */
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
      // Breadth-first per entry, so the first hit is the shallowest in that entry.
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
  return search((node, isEntryRoot) => (
    node.children.some((child) => writtenIn(child, hunk, hunkRange))
    || (isEntryRoot && writtenIn(node, hunk, hunkRange))
  ));
}

/** Cut a Call tree document out of the analysis at a found location. */
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

// --- Rows ----------------------------------------------------------------------

/** One drawn tree-line cell left of a row: a continuing line or blank. */
export type CallTreeGuide = "pipe" | "blank";

export interface CallTreeRow {
  /** Unique, stable path (the Call flow tab's row path format). */
  id: string;
  node: CallTreeNode;
  depth: number;
  parentId?: string;
  /** Tree-line cells for the ancestors' columns. */
  guides: CallTreeGuide[];
  /** The connector into this row; none for the root. */
  branch: "tee" | "elbow" | null;
  /** Children this row would show (after the Changes only filter). */
  childCount: number;
  folded: boolean;
  /** The same call with the same calls below it is already drawn above: not expanded again. */
  repeat: boolean;
  /** A changed call whose own line changed, drawn as a red or green band. */
  band: "added" | "removed" | null;
  /** A changed call under a band of the same kind: keeps the small dot only. */
  dot: "added" | "removed" | null;
  /** The nearest calling row's file (for the `:line`-only location). */
  callerFile?: string;
  /** The row or something below it changed. */
  hasChange: boolean;
}

export interface CallTreeRowOptions {
  /** Rows the person folded or unfolded, by id: true = folded. Others use the default. */
  folds?: ReadonlyMap<string, boolean>;
  changesOnly?: boolean;
}

interface TreeFacts {
  hasChange: Map<CallTreeNode, boolean>;
  signature: Map<CallTreeNode, number>;
}

const factsCache = new WeakMap<CallTreeNode, TreeFacts>();

/** Change presence and a structural signature per node, computed once per tree (iteratively: trees can be deep). */
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

/** True when the node or anything below it changed. */
export function callTreeHasChange(root: CallTreeNode, node: CallTreeNode = root): boolean {
  return treeFacts(root).hasChange.get(node) ?? false;
}

/** Rows folded by default: everything whose subtree holds no change, except the root. */
function foldedByDefault(depth: number, hasChange: boolean): boolean {
  return depth > 0 && !hasChange;
}

/**
 * Flatten the document into the rows the view draws, in order. Folded rows
 * and repeats hide their children; Changes only drops rows with no change
 * below them (never the root).
 */
export function buildCallTreeRows(doc: CallTreeDoc, options: CallTreeRowOptions = {}): CallTreeRow[] {
  const { hasChange, signature } = treeFacts(doc.root);
  const folds = options.folds;
  const changesOnly = options.changesOnly === true;
  const rows: CallTreeRow[] = [];
  const expandedSignatures = new Set<number>();
  const visibleChildren = (node: CallTreeNode): Array<[CallTreeNode, number]> => {
    const out: Array<[CallTreeNode, number]> = [];
    node.children.forEach((child, index) => {
      if (!changesOnly || hasChange.get(child)) out.push([child, index]);
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
    /** Status of the nearest banded or dotted changed ancestor chain. */
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
    const repeat = kids.length > 0 && expandedSignatures.has(sig);
    const folded = !repeat && kids.length > 0 && (folds?.get(frame.id) ?? foldedByDefault(depth, changed));
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
    });
    if (repeat || folded || kids.length === 0) continue;
    expandedSignatures.add(sig);
    const childGuides: CallTreeGuide[] = depth === 0
      ? []
      : [...frame.guides, frame.branch === "tee" ? "pipe" : "blank"];
    const callerFile = node.file ?? frame.callerFile;
    // Push in reverse so the first child is drawn first.
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

/** The folded state a row has with no override (for toggling). */
export function callTreeRowFoldedByDefault(row: CallTreeRow): boolean {
  return foldedByDefault(row.depth, row.hasChange);
}
