import {
  EMPTY_LAYOUT,
  activateTab,
  activeTabId,
  addTab,
  closeTab,
  collapseToOnePane,
  findTab,
  focusPane,
  paneIndexOf,
  updateTab,
  type PaneLayout,
  type PanePlacement,
  type PaneTab,
} from './paneLayout';

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T) {
    for (const listener of [...this.listeners]) listener(value);
  }
}

export interface WorkspacePanelApi {
  readonly id: string;
  readonly title: string | undefined;
  readonly isActive: boolean;
  setActive(): void;
  close(): void;
  setTitle(title: string): void;
  updateParameters(params: Record<string, unknown>): void;
  getParameters<T = Record<string, unknown>>(): T;
  onDidParametersChange(listener: Listener<Record<string, unknown>>): { dispose(): void };
  onDidTitleChange(listener: Listener<{ title: string }>): { dispose(): void };
}

export interface WorkspaceGroup {
  readonly element: HTMLElement | null;
  readonly header: { hidden: boolean };
}

export interface WorkspacePanel {
  readonly id: string;
  readonly params: Record<string, unknown>;
  readonly title: string;
  readonly api: WorkspacePanelApi;
  readonly group: WorkspaceGroup;
}

export interface AddPanelOptions {
  id: string;
  component: string;
  title?: string;
  params?: Record<string, unknown>;
  position?: { referencePanel?: string; direction?: 'right' | 'left' | 'above' | 'below' | 'within' };
  initialWidth?: number;
}

export class WorkspaceStore {
  private layout: PaneLayout = EMPTY_LAYOUT;
  private handles = new Map<string, WorkspacePanel>();
  private paramEvents = new Map<string, Emitter<Record<string, unknown>>>();
  private titleEvents = new Map<string, Emitter<{ title: string }>>();
  private paneElements: (HTMLElement | null)[] = [];
  private changes = new Emitter<void>();
  private activeChanges = new Emitter<WorkspacePanel | undefined>();
  private added = new Emitter<WorkspacePanel>();
  private removed = new Emitter<WorkspacePanel>();
  private groupsChanged = new Emitter<void>();
  private singlePane = false;

  readonly api = this.createApi();

  getLayout = () => this.layout;
  subscribe = (listener: () => void) => this.changes.on(listener).dispose;

  setSinglePane(single: boolean) {
    if (this.singlePane === single) return;
    this.singlePane = single;
    if (single && this.layout.panes.length > 1) this.commit(collapseToOnePane(this.layout));
  }

  setPaneElement(index: number, element: HTMLElement | null) {
    this.paneElements[index] = element;
  }

  focusPane(index: number) {
    this.commit(focusPane(this.layout, index));
  }

  private commit(next: PaneLayout) {
    if (next === this.layout) return;
    const before = this.layout;
    const beforeActive = activeTabId(before);
    this.layout = next;
    const beforeIds = new Set(before.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id)));
    const afterIds = new Set(next.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id)));
    for (const id of afterIds) if (!beforeIds.has(id)) this.added.fire(this.handle(id)!);
    for (const id of beforeIds) {
      if (afterIds.has(id)) continue;
      const handle = this.handles.get(id);
      this.handles.delete(id);
      this.paramEvents.delete(id);
      this.titleEvents.delete(id);
      if (handle) this.removed.fire(handle);
    }
    if (before.panes.length !== next.panes.length) this.groupsChanged.fire();
    this.changes.fire();
    const afterActive = activeTabId(next);
    if (afterActive !== beforeActive) this.activeChanges.fire(afterActive ? this.handle(afterActive) : undefined);
  }

  private tab(id: string): PaneTab | undefined {
    return findTab(this.layout, id);
  }

  private handle(id: string): WorkspacePanel | undefined {
    if (!this.tab(id)) return undefined;
    const existing = this.handles.get(id);
    if (existing) return existing;
    const store = this;
    const paramEvents = new Emitter<Record<string, unknown>>();
    const titleEvents = new Emitter<{ title: string }>();
    this.paramEvents.set(id, paramEvents);
    this.titleEvents.set(id, titleEvents);
    const api: WorkspacePanelApi = {
      id,
      get title() { return store.tab(id)?.title; },
      get isActive() { return activeTabId(store.layout) === id; },
      setActive: () => store.commit(activateTab(store.layout, id)),
      close: () => store.commit(closeTab(store.layout, id)),
      setTitle: (title) => {
        store.commit(updateTab(store.layout, id, { title }));
        titleEvents.fire({ title });
      },
      updateParameters: (params) => {
        const merged = { ...(store.tab(id)?.params ?? {}), ...params };
        store.commit(updateTab(store.layout, id, { params: merged }));
        paramEvents.fire(merged);
      },
      getParameters: <T,>() => (store.tab(id)?.params ?? {}) as T,
      onDidParametersChange: paramEvents.on,
      onDidTitleChange: titleEvents.on,
    };
    const handle: WorkspacePanel = {
      id,
      get params() { return store.tab(id)?.params ?? {}; },
      get title() { return store.tab(id)?.title ?? id; },
      api,
      get group() {
        const index = paneIndexOf(store.layout, id);
        return { element: store.paneElements[index] ?? null, header: { hidden: false } };
      },
    };
    this.handles.set(id, handle);
    return handle;
  }

  private placementOf(options: AddPanelOptions): PanePlacement {
    const position = options.position;
    if (!position?.referencePanel && !position?.direction) return { kind: 'active' };
    if (position.direction && position.direction !== 'within') return { kind: 'beside', referenceId: position.referencePanel };
    return { kind: 'with', referenceId: position.referencePanel! };
  }

  private createApi() {
    const store = this;
    return {
      get panels(): WorkspacePanel[] {
        return store.layout.panes.flatMap((pane) => pane.tabs.map((tab) => store.handle(tab.id)!));
      },
      get activePanel(): WorkspacePanel | undefined {
        const id = activeTabId(store.layout);
        return id ? store.handle(id) : undefined;
      },
      get groups(): WorkspaceGroup[] {
        return store.layout.panes.map((_, index) => ({ element: store.paneElements[index] ?? null, header: { hidden: false } }));
      },
      getPanel: (id: string) => store.handle(id),
      addPanel: (options: AddPanelOptions) => {
        const tab: PaneTab = { id: options.id, component: options.component, title: options.title ?? options.id, params: options.params ?? {} };
        store.commit(addTab(store.layout, tab, store.placementOf(options), store.singlePane));
        return store.handle(options.id)!;
      },
      onDidActivePanelChange: store.activeChanges.on,
      onDidAddPanel: store.added.on,
      onDidRemovePanel: store.removed.on,
      onDidAddGroup: (listener: () => void) => store.groupsChanged.on(listener),
      onDidRemoveGroup: (listener: () => void) => store.groupsChanged.on(listener),
      onDidMovePanel: (listener: () => void) => store.changes.on(listener),
      onDidLayoutChange: (listener: () => void) => store.changes.on(listener),
    };
  }
}

export type WorkspaceApi = WorkspaceStore['api'];
