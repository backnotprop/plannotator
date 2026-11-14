/**
 * Counts which components React drew, by name, through the commit hook React DevTools uses: a component counts when
 * it performed work in a commit, and a subtree React reused whole is skipped. Import it before `react-dom` loads (a
 * DOM-gated test file runs isolated, so its first `await import('react-dom/client')` comes after this).
 */
type Fiber = { tag: number; flags: number; type: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };

const FUNCTION_COMPONENT = 0;
const SIMPLE_MEMO_COMPONENT = 15;
const PERFORMED_WORK = 1;

const nameOf = (type: unknown): string | null => {
  if (typeof type === 'function') return (type as { displayName?: string }).displayName || type.name || null;
  if (type && typeof type === 'object' && 'type' in type) return nameOf((type as { type: unknown }).type);
  return null;
};

const draws = new Map<string, number>();
let counting = false;
let attached = false;

function walk(fiber: Fiber | null) {
  for (let f = fiber; f; f = f.sibling) {
    if ((f.tag === FUNCTION_COMPONENT || f.tag === SIMPLE_MEMO_COMPONENT) && (f.flags & PERFORMED_WORK) === PERFORMED_WORK) {
      const name = nameOf(f.type);
      if (name) draws.set(name, (draws.get(name) ?? 0) + 1);
    }
    if (f.child && !(f.alternate && f.alternate.child === f.child)) walk(f.child);
  }
}

if (typeof document !== 'undefined') {
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => {
      attached = true;
      return 1;
    },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      if (counting) walk(root.current.child);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
  };
}

export async function drawsDuring(run: () => unknown | Promise<unknown>): Promise<Map<string, number>> {
  if (!attached) throw new Error('react-draws: React loaded before the hook; import this helper first');
  draws.clear();
  counting = true;
  try {
    await run();
  } finally {
    counting = false;
  }
  return new Map(draws);
}
