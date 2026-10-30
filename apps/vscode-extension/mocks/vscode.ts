// Mock VS Code module for bun:test
// Only implements the APIs that plannotator-webview actually uses.

export interface UriHandler {
  handleUri(uri: Uri): ProviderResult<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>;

export interface ExtensionContext {
  subscriptions: { dispose(): void }[];
  extensionPath: string;
  environmentVariableCollection: {
    replace(variable: string, value: string): void;
    append(variable: string, value: string): void;
    prepend(variable: string, value: string): void;
    delete(variable: string): void;
  };
  globalState: {
    get<T>(key: string, defaultValue?: T): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
  };
}

export class Uri {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;

  constructor(
    scheme: string,
    authority: string,
    path: string,
    query: string,
    fragment: string,
  ) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  static file(fsPath: string): Uri {
    return new Uri("file", "", fsPath, "", "");
  }

  static from(c: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(c.scheme, c.authority ?? "", c.path ?? "", c.query ?? "", c.fragment ?? "");
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, base.authority, [base.path.replace(/\/+$/, ""), ...segments].join("/"), base.query, base.fragment);
  }

  get fsPath(): string {
    return this.path;
  }

  static parse(value: string): Uri {
    const parsed = new globalThis.URL(value);
    return new Uri(
      parsed.protocol.replace(":", ""),
      parsed.host,
      parsed.pathname,
      parsed.search.replace("?", ""),
      parsed.hash.replace("#", ""),
    );
  }

  toString(): string {
    let result = `${this.scheme}://${this.authority}${this.path}`;
    if (this.query) result += `?${this.query}`;
    if (this.fragment) result += `#${this.fragment}`;
    return result;
  }
}

export const commands = {
  registerCommand(_id: string, _handler: (...args: unknown[]) => unknown) {
    return { dispose() {} };
  },
  async executeCommand(_command: string, ..._args: unknown[]) {},
};

export interface Webview {
  html: string;
  onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
  postMessage(message: unknown): Thenable<boolean>;
}

export interface WebviewPanel {
  webview: Webview;
  iconPath?: Uri;
  reveal(viewColumn?: number): void;
  dispose(): void;
  onDidDispose(listener: () => void): { dispose(): void };
}

/** Every panel `createWebviewPanel` made (tests read what it posted and send it messages). */
export const createdWebviewPanels: Array<WebviewPanel & { posted: unknown[]; receive(message: unknown): void }> = [];

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
};

export const window = {
  /** No editor groups unless a test sets them. */
  tabGroups: { all: [] as unknown[], activeTabGroup: undefined as unknown },
  registerUriHandler(_handler: unknown) {
    return { dispose() {} };
  },
  async showInformationMessage(_message: string, ..._items: string[]): Promise<string | undefined> {
    return undefined;
  },
  async showWarningMessage(_message: string, ..._items: string[]): Promise<string | undefined> {
    return undefined;
  },
  async showErrorMessage(_message: string, ..._items: string[]): Promise<string | undefined> {
    return undefined;
  },
  async showInputBox(_options?: unknown) {
    return undefined;
  },
  createOutputChannel(_name: string, _options?: unknown) {
    return { info() {}, warn() {}, error() {}, debug() {}, appendLine() {}, dispose() {} };
  },
  createWebviewPanel(
    _viewType: string,
    _title: string,
    _showOptions: number,
    _options?: { enableScripts?: boolean; retainContextWhenHidden?: boolean },
  ): WebviewPanel {
    let disposeListener: (() => void) | null = null;
    const listeners: Array<(message: unknown) => void> = [];
    const posted: unknown[] = [];
    const panel = {
      webview: {
        html: "",
        cspSource: "https://file+.vscode-resource.vscode-cdn.net",
        asWebviewUri: (uri: Uri) => Uri.parse(`https://file+.vscode-resource.vscode-cdn.net${uri.path}`),
        onDidReceiveMessage(listener: (message: unknown) => void) {
          listeners.push(listener);
          return { dispose() { listeners.splice(listeners.indexOf(listener), 1); } };
        },
        postMessage(message: unknown) {
          posted.push(message);
          return Promise.resolve(true);
        },
      },
      /** Test hooks: what the panel posted, and a message as if the webview sent it. */
      posted,
      receive: (message: unknown) => {
        for (const l of [...listeners]) l(message);
      },
      reveal() {},
      dispose() {
        disposeListener?.();
      },
      onDidDispose(listener: () => void) {
        disposeListener = listener;
        return { dispose() {} };
      },
    };
    createdWebviewPanels.push(panel);
    return panel;
  },
  createTextEditorDecorationType(_options: unknown) {
    return { dispose() {} };
  },
  get activeTextEditor() {
    return undefined;
  },
  get visibleTextEditors(): unknown[] {
    return [];
  },
  onDidChangeActiveTextEditor(_listener: unknown) {
    return { dispose() {} };
  },
  createTreeView(_id: string, _options: unknown) {
    return { dispose() {} };
  },
  registerWebviewViewProvider(_id: string, _provider: unknown, _options?: unknown) {
    return { dispose() {} };
  },
};

export const env = {
  async asExternalUri(uri: Uri): Promise<Uri> {
    return uri;
  },
  clipboard: {
    async readText(): Promise<string> {
      return "";
    },
    async writeText(_value: string): Promise<void> {},
  },
  async openExternal(_uri: Uri): Promise<boolean> {
    return true;
  },
};

/** Every comment thread made, for tests that look at what a controller shows. */
export const createdCommentThreads: Array<{ uri: Uri; range: unknown; comments: unknown[]; label?: string; contextValue: string; canReply: boolean; collapsibleState: number; disposed: boolean; controller: string }> = [];

export const comments = {
  createCommentController(id: string, _label: string) {
    return {
      id,
      options: {},
      dispose() {},
      createCommentThread(_uri: Uri, _range: unknown, _comments: unknown[]) {
        const thread = {
          uri: _uri,
          range: _range,
          comments: _comments,
          label: undefined as string | undefined,
          state: undefined as number | undefined,
          collapsibleState: 0,
          canReply: true,
          contextValue: "",
          disposed: false,
          controller: id,
          dispose() {
            thread.disposed = true;
          },
        };
        createdCommentThreads.push(thread);
        return thread;
      },
    };
  },
};

export class MarkdownString {
  value: string;
  supportThemeIcons: boolean;
  isTrusted?: boolean | { enabledCommands: readonly string[] };
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(text: string) {
    this.value += text.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
    return this;
  }
  appendMarkdown(text: string) {
    this.value += text;
    return this;
  }
}

export const languages = {
  registerCodeActionsProvider(_selector: unknown, _provider: unknown, _metadata?: unknown) {
    return { dispose() {} };
  },
};

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Location {
  constructor(readonly uri: Uri, readonly range: Range) {}
}

export class Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
  isEmpty: boolean;
  constructor(startLine: number | { line: number; character: number }, startChar?: number | { line: number; character: number }, endLine?: number, endChar?: number) {
    if (typeof startLine === "object") {
      this.start = startLine;
      this.end = startChar as { line: number; character: number };
    } else {
      this.start = { line: startLine, character: startChar as number };
      this.end = { line: endLine!, character: endChar! };
    }
    this.isEmpty = this.start.line === this.end.line && this.start.character === this.end.character;
  }
  isEqual(other: Range) {
    return this.start.line === other.start.line && this.start.character === other.start.character &&
      this.end.line === other.end.line && this.end.character === other.end.character;
  }
}

export class TabInputWebview {
  constructor(readonly viewType: string) {}
}

export class TabInputTextDiff {
  constructor(readonly original: Uri, readonly modified: Uri) {}
}

export const CommentMode = { Preview: 1, Editing: 0 };
export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 };
export const CommentThreadState = { Unresolved: 0, Resolved: 1 };

export const CodeActionKind = {
  RefactorInline: { value: "refactor.inline" },
};

export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };

export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get(_key: string, defaultValue?: unknown) {
        return defaultValue;
      },
    };
  },
};

// Mock EnvironmentVariableCollection
class MockEnvironmentVariableCollection {
  private _vars = new Map<string, string>();

  replace(variable: string, value: string) {
    this._vars.set(variable, value);
  }

  append(variable: string, value: string) {
    this._vars.set(variable, (this._vars.get(variable) || "") + value);
  }

  prepend(variable: string, value: string) {
    this._vars.set(variable, value + (this._vars.get(variable) || ""));
  }

  delete(variable: string) {
    this._vars.delete(variable);
  }

  get(variable: string) {
    return this._vars.get(variable);
  }

  clear() {
    this._vars.clear();
  }

  [Symbol.iterator]() {
    return this._vars.entries();
  }
}

// Factory to create a mock ExtensionContext
export function createMockExtensionContext(
  extensionPath = "/mock/extension/path",
) {
  return {
    subscriptions: [] as { dispose: () => void }[],
    extensionPath,
    environmentVariableCollection: new MockEnvironmentVariableCollection(),
    globalState: (() => {
      const store = new Map<string, unknown>();
      return {
        get<T>(key: string, defaultValue?: T): T | undefined {
          return (store.has(key) ? store.get(key) : defaultValue) as T | undefined;
        },
        update(key: string, value: unknown): Promise<void> {
          store.set(key, value);
          return Promise.resolve();
        },
      };
    })(),
    workspaceState: { get: () => undefined, update: async () => {} },
  };
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}
