/**
 * What the reviewer is looking at, for the side chat's Ask AI (#1001).
 *
 * The editor keeps ONE Ask AI chat for the whole Plannotator session: switching
 * files, opening a linked document, Back, and a plan revision all keep it. The
 * session is created once, from the document on screen at the first question
 * (a separate AI gets that document in its session context; "Ask this session"
 * gets its surface line), so a later question names the document the reviewer
 * moved to. It names it by path, so the agent reads the file itself, instead
 * of pasting the document into every question. Only a document with no file
 * the agent can open (a converted URL page, an agent message, a plan without a
 * known file) carries its text, and only once, when it changes.
 */
export interface AskDocument {
  /** What makes two views the same document for the agent. A file is its
   *  path (the agent re-reads it, so edits never change it); a document
   *  without a file also counts its text, so a changed text is sent again. */
  key: string;
  /** `plan` is the plan under review; everything else is a document. */
  kind: 'plan' | 'document';
  /** Absolute path of a file on this computer the agent can read. For the
   *  plan, the history copy of this exact version (a separate AI's file). */
  path?: string;
  /** The plan's own file (the agent's, e.g. `~/.claude/plans/x.md`), when its
   *  text is the plan. "Ask this session" is named this one, never `path`:
   *  the history copy is outside its project (a permission prompt) and it
   *  wrote the revision itself. */
  ownPath?: string;
  /** Where a document without a file came from (a URL), when known. */
  url?: string;
  /** What to call a document without a path or URL ("your last message"). */
  label?: string;
  /** `html` is shown as a rendered page (the raw HTML), `markdown` otherwise. */
  renderAs?: string;
  /** The text on screen was converted from the source (HTML or a web page). */
  converted?: boolean;
  /** Plan version, when known. */
  version?: number;
  /** "file 2 of 3" in a review of several files. */
  position?: { index: number; total: number };
  /** The text on screen, for a document with no readable path. */
  content?: string;
}

/** What the agent was told last in this chat. */
export interface AskDocumentLatch {
  current: AskDocument | null;
  /** Documents viewed before `current`, most recent first. */
  history: AskDocument[];
}

export const EMPTY_ASK_DOCUMENT_LATCH: AskDocumentLatch = { current: null, history: [] };

/** How many earlier documents a note lists. */
export const MAX_ASK_DOCUMENT_HISTORY = 10;

/** Text pasted for a document without a file is cut here (the session context's cap). */
export const MAX_ASK_DOCUMENT_CONTENT_CHARS = 60_000;

/** A path the agent can open: absolute on POSIX or Windows, never a URL. */
export function isReadableDocumentPath(path: string | null | undefined): path is string {
  if (!path) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  return /^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

/** Three backticks, or one more than the longest run in `text` (as core's
 *  `codeFenceFor`), so the pasted text can never close its block early. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function hashText(text: string): string {
  // FNV-1a, enough to tell two texts apart in one tab.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * The AskDocument for the view on screen. `path` is the best path the editor
 * knows (a file, a URL, or a placeholder such as "agent message"); only an
 * absolute path counts as readable.
 */
export function describeAskDocument(input: {
  kind: 'plan' | 'document';
  path?: string | null;
  ownPath?: string | null;
  sourceUrl?: string | null;
  label?: string;
  renderAs?: string;
  converted?: boolean;
  version?: number;
  position?: { index: number; total: number };
  content: string;
}): AskDocument {
  const readable = isReadableDocumentPath(input.path) ? input.path : undefined;
  const urlCandidate = input.sourceUrl ?? input.path ?? undefined;
  const url = !readable && urlCandidate && /^https?:\/\//i.test(urlCandidate) ? urlCandidate : undefined;
  const base = {
    kind: input.kind,
    ...(input.renderAs ? { renderAs: input.renderAs } : {}),
    ...(input.converted ? { converted: true } : {}),
    ...(input.version ? { version: input.version } : {}),
    ...(input.position ? { position: input.position } : {}),
    ...(input.kind === 'plan' && isReadableDocumentPath(input.ownPath) ? { ownPath: input.ownPath } : {}),
  };
  if (readable) {
    return { ...base, key: `${input.kind}|file|${readable}|${input.renderAs ?? ''}|${input.converted ? 'c' : ''}`, path: readable };
  }
  return {
    ...base,
    key: `${input.kind}|text|${url ?? input.label ?? ''}|${input.renderAs ?? ''}|${input.version ?? ''}|${hashText(input.content)}`,
    ...(url ? { url } : {}),
    ...(input.label ? { label: input.label } : {}),
    content: input.content,
  };
}

/** The path a note may point this agent at: "Ask this session" gets the
 *  plan's own file or none, a separate AI the history copy it can read. */
function pathFor(doc: AskDocument, sessionBridge: boolean): string | undefined {
  return doc.kind === 'plan' && sessionBridge ? doc.ownPath : doc.path;
}

function nameOf(doc: AskDocument, sessionBridge: boolean): string {
  if (doc.kind === 'plan' && sessionBridge) {
    // An earlier version: its own file now holds the newer text.
    return doc.version ? `the plan (version ${doc.version})` : 'the plan';
  }
  const where = doc.path ?? doc.url ?? doc.label ?? (doc.kind === 'plan' ? 'the plan' : 'a document');
  return doc.kind === 'plan' && doc.version ? `${where} (plan version ${doc.version})` : where;
}

function detailsOf(doc: AskDocument): string {
  const parts: string[] = [];
  if (doc.position) parts.push(`file ${doc.position.index} of ${doc.position.total}`);
  if (doc.renderAs === 'html') parts.push('shown as a rendered HTML page');
  if (doc.converted) parts.push('converted to markdown for review, so line numbers may not match the source');
  return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

function currentLine(doc: AskDocument, earlier: AskDocument[], sessionBridge: boolean): string {
  const returning = earlier.some(e => e.key === doc.key);
  if (doc.kind === 'plan') {
    const path = pathFor(doc, sessionBridge);
    const lastPlan = earlier.find(e => e.kind === 'plan');
    if (lastPlan && lastPlan.key !== doc.key) {
      const version = doc.version ? ` to version ${doc.version}` : '';
      if (sessionBridge) {
        // The session wrote the revision: name its own file, never ask it to
        // read the history copy.
        return path
          ? `The plan was revised${version}: ${path}. This replaces the plan shown earlier in this chat.`
          : `The plan was revised${version}. This replaces the plan shown earlier in this chat.`;
      }
      return path
        ? `The plan was revised${version}: ${path}. This replaces the plan shown earlier in this chat; read the file for its current text.`
        : `The plan was revised${version}. This replaces the plan shown earlier in this chat.`;
    }
    const where = path ? `: ${path}` : '';
    return `The reviewer is ${returning ? 'back on' : 'now looking at'} the plan${where}.`;
  }
  const verb = returning ? 'is back on' : 'is now looking at';
  if (doc.path) {
    return `The reviewer ${verb} ${doc.path}${detailsOf(doc)}. This replaces the document named earlier in this chat; read the file for its contents.`;
  }
  return `The reviewer ${verb} ${nameOf(doc, sessionBridge)}${detailsOf(doc)}. This replaces the document named earlier in this chat.`;
}

/**
 * The note for one question and the latch to keep once the agent received it.
 *
 * - A question that starts a session (`freshSession`) needs no note: the
 *   session is created from the document on screen.
 * - The same document as the last note adds nothing.
 * - A different document gets one short note: its path (and how it is shown),
 *   plus the documents viewed earlier in this chat, most recent first. A
 *   document with no readable path also carries its text, except for "Ask
 *   this session" (`sessionBridge`): the agent wrote the plan or the message,
 *   or can open the URL itself, and a pasted copy would stay in its context
 *   window. That agent is also never pointed at the plan's history copy.
 */
export function planAskDocumentContext(
  latch: AskDocumentLatch,
  doc: AskDocument,
  options: { freshSession: boolean; sessionBridge: boolean; maxHistory?: number },
): { preamble: string; next: AskDocumentLatch } {
  if (options.freshSession) return { preamble: '', next: { current: doc, history: [] } };
  if (latch.current?.key === doc.key) return { preamble: '', next: latch };

  const maxHistory = options.maxHistory ?? MAX_ASK_DOCUMENT_HISTORY;
  const seen = new Set<string>([doc.key]);
  const history: AskDocument[] = [];
  for (const prev of [latch.current, ...latch.history]) {
    if (!prev || seen.has(prev.key)) continue;
    seen.add(prev.key);
    history.push(prev);
    if (history.length >= maxHistory) break;
  }

  const earlier = [latch.current, ...latch.history].filter((e): e is AskDocument => !!e);
  const lines = [`[Plannotator] ${currentLine(doc, earlier, options.sessionBridge)}`];
  if (history.length > 0) {
    // Distinct names only: two texts of one agent message read the same.
    const names = [...new Set(history.map(h => nameOf(h, options.sessionBridge)))];
    lines.push(`Viewed earlier in this chat, most recent first: ${names.join(', ')}.`);
  }
  // A text already sent in this chat (the reviewer came back to it) is not sent again.
  const sentBefore = earlier.some(e => e.key === doc.key);
  if (!doc.path && !options.sessionBridge && !sentBefore && doc.content?.trim()) {
    let text = doc.content;
    if (text.length > MAX_ASK_DOCUMENT_CONTENT_CHARS) {
      text = `${text.slice(0, MAX_ASK_DOCUMENT_CONTENT_CHARS)}\n\n... [truncated for context window]`;
    }
    const fence = fenceFor(text);
    const lang = doc.renderAs === 'html' ? 'html' : 'markdown';
    lines.push('', `Its text (sent once; later questions about it will not repeat it):`, `${fence}${lang}`, text, fence);
  }
  return { preamble: lines.join('\n'), next: { current: doc, history } };
}

/**
 * The fields one side-chat question carries for the document on screen, as
 * the editor sends them: a note when the document changed since the agent
 * was last told, and an `onDelivered` that records it only once the question
 * reached the session (a busy or failed ask leaves the latch alone, and the
 * retry that lands records it). Decided at submission, so a retry keeps the
 * document it was asked about even if the reviewer moved on.
 */
export function askDocumentParams(
  latchRef: { current: AskDocumentLatch },
  doc: AskDocument | null,
  options: { hasSession: boolean; sessionBridge: boolean },
): { contextPreamble?: string; onDelivered?: () => void } {
  if (!doc) return {};
  const plan = planAskDocumentContext(latchRef.current, doc, {
    // A question that creates the session needs no note: the session is made
    // from the document on screen.
    freshSession: !options.hasSession,
    sessionBridge: options.sessionBridge,
  });
  return {
    ...(plan.preamble ? { contextPreamble: plan.preamble } : {}),
    onDelivered: () => { latchRef.current = plan.next; },
  };
}
