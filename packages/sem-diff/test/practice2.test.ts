// Wrong claims found in the second practice batch (fresh projects), cut down to their
// cause, plus the real cases each fix must keep.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';

const kinds = async (lang: 'typescript' | 'java', a: string, b: string) =>
  (await semanticDiffFile(lang, a, b)).semanticOperations.map((o) => o.type).filter((t) => t === 'extractedFunction' || t === 'inlinedFunction');

test('helper renamed into a new closure of the caller is not inlined (hono fallbackRes -> renderFallback)', async () => {
  const a = `export const Boundary = async ({ fallback, fallbackRender, onError, children }: Props) => {
  const fallbackRes = (error: Error): string => {
    onError?.(error)
    return (fallback || (fallbackRender && fallbackRender(error)) || '') as string
  }
  try {
    return await render(children)
  } catch (e) {
    return fallbackRes(e as Error)
  }
}
`;
  const b = `export const Boundary = async ({ fallback, fallbackRender, onError, children }: Props) => {
  const renderFallback = async (error: Error): Promise<string> => {
    await preload(fallback)
    return withContext(async () => {
      onError?.(error)
      const res = (fallback || (fallbackRender && fallbackRender(error)) || '') as string
      return finalize(await toText(res), res.callbacks)
    })
  }
  try {
    return await render(children)
  } catch (e) {
    return renderFallback(e as Error)
  }
}
`;
  assert.deepEqual(await kinds('typescript', a, b), []);
});

test('statements calling different functions are not moved code (classList.add vs classList.toggle)', async () => {
  const a = `function load(params) {
  fetchBuilds(params).then((text) => {
    if (!text) {
      card.classList.add("jenkins-hidden");
      noBuilds.classList.add("jenkins-hidden");
      return;
    }
    contents.innerHTML = text;
  });
}
`;
  const b = `function setSearchControlsVisible(visible) {
  searchContainer.classList.toggle("jenkins-hidden", !visible);
  filterButton.classList.toggle("jenkins-hidden", !visible);
}

function load(params) {
  fetchBuilds(params).then((text) => {
    if (!text) {
      setSearchControlsVisible(false);
      return;
    }
    contents.innerHTML = text;
  });
}
`;
  assert.deepEqual(await kinds('typescript', a, b), []);
});

test('code inlined as a local class still counts (guava createEntrySet)', async () => {
  const a = `abstract class Desc<E> {
  public Set<Entry<E>> entrySet() {
    Set<Entry<E>> result = entrySet;
    return (result == null) ? entrySet = createEntrySet() : result;
  }

  Set<Entry<E>> createEntrySet() {
    final class EntrySetImpl extends Multisets.EntrySet<E> {
      Multiset<E> multiset() {
        return Desc.this;
      }

      public Iterator<Entry<E>> iterator() {
        return entryIterator();
      }

      public int size() {
        return forwardMultiset().entrySet().size();
      }
    }
    return new EntrySetImpl();
  }
}
`;
  const b = `abstract class Desc<E> {
  public Set<Entry<E>> entrySet() {
    final class EntrySetImpl extends Multisets.EntrySet<E> {
      Multiset<E> multiset() {
        return Desc.this;
      }

      public Iterator<Entry<E>> iterator() {
        return entryIterator();
      }

      public int size() {
        return forwardMultiset().entrySet().size();
      }
    }
    return new EntrySetImpl();
  }
}
`;
  assert.deepEqual(await kinds('java', a, b), ['inlinedFunction']);
});

test('code moved out of an object-property arrow function is an extract (excalidraw `perform: () => {}`)', async () => {
  const a = `export const actionWrap = register({
  name: "wrap",
  perform: (elements, appState, app) => {
    const selected = getSelectedElements(elements, appState);
    const frame = newFrameElement({ x: selected[0].x - PADDING, y: selected[0].y - PADDING, width: totalWidth(selected) + PADDING * 2 });
    addElementsToFrame([...elements, frame], selected, frame, appState);
    return { elements: [...elements, frame], appState: { ...appState, selectedElementIds: { [frame.id]: true } } };
  },
});
`;
  const b = `const wrapInFrame = (elements, selected, appState) => {
  const frame = newFrameElement({ x: selected[0].x - PADDING, y: selected[0].y - PADDING, width: totalWidth(selected) + PADDING * 2 });
  addElementsToFrame([...elements, frame], selected, frame, appState);
  return frame;
};

export const actionWrap = register({
  name: "wrap",
  perform: (elements, appState, app) => {
    const selected = getSelectedElements(elements, appState);
    const frame = wrapInFrame(elements, selected, appState);
    return { elements: [...elements, frame], appState: { ...appState, selectedElementIds: { [frame.id]: true } } };
  },
});
`;
  assert.deepEqual(await kinds('typescript', a, b), ['extractedFunction']);
});

test('a statement the caller kept, edited, is not code moved into a new helper (excalidraw prepareDataForJSONExport)', async () => {
  const a = `export const actionSave = register({
  perform: async (elements, appState, app) => {
    try {
      const { fileHandle } = await saveAsJSON(elements, appState, app.files, app.getName());
      return { appState: { ...appState, fileHandle } };
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        console.error(error);
      } else {
        console.warn(error);
      }
      return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
    }
  },
});
`;
  const b = `function prepareExport(elements, appState, app) {
  const controller = new AbortController();
  const data = new Promise(async (resolve) => {
    try {
      await app.props.onExport?.(elements, appState, { signal: controller.signal });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        console.warn(error);
      } else {
        console.error(error);
      }
    }
    resolve({ elements, appState });
  });
  return { controller, data };
}

export const actionSave = register({
  perform: async (elements, appState, app) => {
    const { controller, data } = prepareExport(elements, appState, app);
    try {
      const { fileHandle } = await saveAsJSON(await data, app.getName());
      return { appState: { ...appState, fileHandle } };
    } catch (error: any) {
      controller.abort();
      if (error?.name !== "AbortError") {
        console.error(error);
      } else {
        console.warn(error);
      }
      return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
    }
  },
});
`;
  assert.deepEqual(await kinds('typescript', a, b), []);
});

test('a one-line helper found by putting the call\'s argument in place of its parameter (storybook usesRegisterHooks)', async () => {
  const a = `export function registerLoader() {
  if (Number(process.versions.node.split('.')[0]) >= 26) {
    registerHooks(hooks);
  }
}
`;
  const b = `export const usesRegisterHooks = (nodeVersion: string) => Number(nodeVersion.split('.')[0]) >= 26;

export function registerLoader() {
  if (usesRegisterHooks(process.versions.node)) {
    registerHooks(hooks);
  }
}
`;
  assert.deepEqual(await kinds('typescript', a, b), ['extractedFunction']);
});

test('a helper that grew around the old expression is an extract (react-router getManifestPathsParam)', async () => {
  const a = `export async function fetchPatches(paths: string[], searchParams: URLSearchParams) {
  searchParams.set("paths", paths.sort().join(","));
  return fetch(url);
}
`;
  const b = `export function getManifestPathsParam(paths: string[]) {
  return paths
    .slice()
    .sort()
    .map((path) => path.replace(/,/g, "%2C"))
    .join(",");
}

export async function fetchPatches(paths: string[], searchParams: URLSearchParams) {
  searchParams.set("paths", getManifestPathsParam(paths));
  return fetch(url);
}
`;
  assert.deepEqual(await kinds('typescript', a, b), ['extractedFunction']);
});

test('an expression the caller still has, edited, did not grow into a new helper (kafka hasUnsecuredLoginOptions)', async () => {
  const a = `class Handler {
  private boolean moduleOptionsEmpty;
  void handle() {
    if (moduleOptions.keySet().stream().allMatch(name -> name.startsWith(EXTENSION_PREFIX))) {
      throw new Error();
    }
  }
}
`;
  const b = `class Handler {
  private boolean moduleOptionsEmpty;
  void handle() {
    if (!hasUnsecuredLoginOptions()) {
      return;
    }
    if (moduleOptions.keySet().stream()
        .filter(name -> name.startsWith(OPTION_PREFIX))
        .allMatch(name -> name.startsWith(EXTENSION_PREFIX))) {
      throw new Error();
    }
  }

  private boolean hasUnsecuredLoginOptions() {
    return moduleOptions.keySet().stream().anyMatch(name -> name.startsWith(OPTION_PREFIX));
  }
}
`;
  assert.deepEqual(await kinds('java', a, b), []);
});
