export interface ThreadableAnnotation {
  id: string;
  inReplyTo?: string | null;
}

function replyTarget<T extends ThreadableAnnotation>(item: T, byId: Map<string, T>): string | null {
  const target = typeof item.inReplyTo === "string" ? item.inReplyTo : null;
  if (!target || target === item.id || !byId.has(target)) return null;
  return target;
}

export function resolveReplyParents<T extends ThreadableAnnotation>(
  items: readonly T[],
): Map<string, string | null> {
  const byId = new Map<string, T>();
  for (const item of items) byId.set(item.id, item);
  const parents = new Map<string, string | null>();
  for (const item of items) {
    if (parents.has(item.id)) continue;
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
 * The timestamp of every annotation's thread root (its own when it is a root), keyed by id, in one
 * linear pass over `parents`.
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
 * Validate an `inReplyTo` value about to be written onto annotation `id` (external-annotation PATCH
 * ingest, both runtimes).
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
  const seen = new Set<string>();
  let current: ThreadableAnnotation | undefined = byId.get(inReplyTo);
  while (current) {
    if (current.id === id) {
      return 'invalid "inReplyTo": the reply chain would form a cycle';
    }
    if (seen.has(current.id)) break;
    seen.add(current.id);
    const next = typeof current.inReplyTo === "string" ? current.inReplyTo : null;
    current = next ? byId.get(next) : undefined;
  }
  return null;
}
