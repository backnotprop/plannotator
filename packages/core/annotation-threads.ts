/**
 * Reply threading (`inReplyTo`) rules shared by every consumer: the feedback
 * export, the annotations panel, and the external-annotation ingest.
 *
 * Browser-safe, zero-dep. `inReplyTo` is an additive field whose value can
 * come from anywhere (a browser agent's tool call, a PATCH on
 * /api/external-annotations that merges arbitrary fields), so consumers must
 * never trust it to form a tree. The one rule every consumer applies:
 *
 *   An annotation is a reply only when its `inReplyTo` names a DIFFERENT
 *   annotation in the same list AND following the chain of parents never
 *   comes back to the annotation itself. Everything else is a root: a plain
 *   comment, an orphan whose parent is absent, a self-reference, and every
 *   member of a cycle. Roots keep their original order. A reply to a cycle
 *   member stays a reply: its parent is rendered (as a root).
 *
 * Consequence: no annotation is ever dropped from a threaded rendering, and
 * a reply always hangs under something that is itself rendered.
 *
 * Every walk here is linear in the number of annotations: each id is
 * classified once and later chains stop at the first classified id, so a
 * 5,000-deep chain (which a hostile or buggy tool can POST) costs 5,000
 * steps, not 12.5 million.
 */

export interface ThreadableAnnotation {
  id: string;
  inReplyTo?: string | null;
}

/** The id `item` points at when that target could be a parent: present, and not itself. */
function replyTarget<T extends ThreadableAnnotation>(item: T, byId: Map<string, T>): string | null {
  const target = typeof item.inReplyTo === "string" ? item.inReplyTo : null;
  if (!target || target === item.id || !byId.has(target)) return null;
  return target;
}

/**
 * The effective parent of every annotation in `items`: the `inReplyTo`
 * target for a valid reply, `null` for a root (see the module comment).
 * O(n): ids are classified once, with path compression along each chain.
 */
export function resolveReplyParents<T extends ThreadableAnnotation>(
  items: readonly T[],
): Map<string, string | null> {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  const parents = new Map<string, string | null>();
  for (const item of items) {
    if (parents.has(item.id)) continue;
    // Walk the chain until it reaches an already classified id, a root, or
    // an id already on this walk (a cycle). Ids on the walk are remembered
    // with their position so the cycle segment can be told from the run-in.
    const path: T[] = [];
    const position = new Map<string, number>();
    let current: T | undefined = item;
    let cycleStart = -1;
    while (current) {
      if (parents.has(current.id)) break;
      const seen = position.get(current.id);
      if (seen !== undefined) {
        cycleStart = seen;
        break;
      }
      position.set(current.id, path.length);
      path.push(current);
      const target = replyTarget(current, byId);
      if (!target) {
        parents.set(current.id, null);
        break;
      }
      current = byId.get(target);
    }
    // Cycle members are roots; everything before the cycle (and every id on
    // a walk that ended at a known id or a root) is a reply of its target.
    const replyEnd = cycleStart === -1 ? path.length : cycleStart;
    for (let i = 0; i < path.length; i++) {
      const node = path[i];
      if (parents.has(node.id)) continue;
      parents.set(node.id, i < replyEnd ? replyTarget(node, byId) : null);
    }
  }
  return parents;
}

/**
 * The timestamp of every annotation's thread root (its own when it is a
 * root), keyed by id, in one linear pass over `parents`. Panels sort threads
 * by this so a reply sits at its root's position on the timeline.
 */
export function resolveThreadRootTimestamps<T extends ThreadableAnnotation & { createdA: number }>(
  items: readonly T[],
  parents: ReadonlyMap<string, string | null> = resolveReplyParents(items),
): Map<string, number> {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  const rootTs = new Map<string, number>();
  for (const item of items) {
    if (rootTs.has(item.id)) continue;
    const path: string[] = [];
    let current: T | undefined = item;
    let ts: number | undefined;
    while (current) {
      const known = rootTs.get(current.id);
      if (known !== undefined) {
        ts = known;
        break;
      }
      path.push(current.id);
      const parent = parents.get(current.id) ?? null;
      if (!parent) {
        ts = current.createdA;
        break;
      }
      current = byId.get(parent);
    }
    const resolved = ts ?? item.createdA;
    for (const id of path) rootTs.set(id, resolved);
  }
  return rootTs;
}

/**
 * Validate an `inReplyTo` value about to be written onto annotation `id`
 * (external-annotation PATCH ingest, both runtimes). A reply must point at
 * an existing, different annotation, and must not close a cycle through the
 * existing chain. `null`/`undefined` clear the field and are always valid.
 * Returns the error message, or `null` when the value may be applied.
 */
export function validateReplyTarget(
  all: readonly ThreadableAnnotation[],
  id: string,
  inReplyTo: unknown,
): string | null {
  if (inReplyTo === undefined || inReplyTo === null) return null;
  if (typeof inReplyTo !== "string" || inReplyTo.length === 0) {
    return 'invalid "inReplyTo": must be the id of an existing annotation';
  }
  if (inReplyTo === id) {
    return 'invalid "inReplyTo": an annotation cannot reply to itself';
  }
  const byId = new Map<string, ThreadableAnnotation>();
  for (const item of all) byId.set(item.id, item);
  if (!byId.has(inReplyTo)) {
    return `invalid "inReplyTo": no annotation with id "${inReplyTo}"`;
  }
  // Would the target's own chain lead back to `id`? Then the write would
  // create a cycle.
  const seen = new Set<string>();
  let current: ThreadableAnnotation | undefined = byId.get(inReplyTo);
  while (current) {
    if (current.id === id) {
      return 'invalid "inReplyTo": the reply chain would form a cycle';
    }
    if (seen.has(current.id)) break; // pre-existing cycle elsewhere; not ours to close
    seen.add(current.id);
    const next = typeof current.inReplyTo === "string" ? current.inReplyTo : null;
    current = next ? byId.get(next) : undefined;
  }
  return null;
}
