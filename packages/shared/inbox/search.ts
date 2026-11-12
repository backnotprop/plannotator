import {
  inboxSearchRanges,
  inboxSearchSnippet,
  inboxSearchTerms,
  scanInboxSearchTokens,
  tokenizeInboxSearchText,
  INBOX_SEARCH_BROWSE_LIMIT,
  INBOX_SEARCH_CAPS,
  INBOX_SEARCH_GROUPS,
  INBOX_SEARCH_LIMIT_MAX,
  INBOX_SEARCH_RECENT_THREADS,
  type InboxSearchAnswer,
  type InboxSearchFrom,
  type InboxSearchGroupId,
  type InboxSearchProjectRef,
  type InboxSearchQuery,
  type InboxSearchRow,
  type InboxSearchThreadRow,
} from "@plannotator/core/inbox-search";
import { findQuestionBlocks, QUESTION_ANSWERS_HEADING, type QuestionAnswer } from "@plannotator/core/question-block";
import { INBOX_STILL_OPEN_LINE } from "@plannotator/core/inbox-questions";
import { withoutInboxSkillsBlock } from "@plannotator/core/skill-reference-block";
import {
  displayInboxSubject,
  inboxAgentName,
  isInboxNote,
  type InboxLine,
  type InboxListRow,
  type InboxMessage,
  type InboxProject,
  type InboxQuestion,
  type InboxSectionId,
} from "@plannotator/core/inbox-types";
import { inboxRowArchived } from "./list";
import { canPrefixId, fnvString, ID_BUCKETS, ID_PREFIX_KEEP, ID_PREFIX_LENGTH, isIdLikeToken, Postings, Vocabulary } from "./search-vocabulary";
import type { InboxStore } from "./store";

export {
  INBOX_SEARCH_BROWSE_LIMIT,
  INBOX_SEARCH_CAPS,
  INBOX_SEARCH_GROUPS,
  INBOX_SEARCH_LIMIT_MAX,
  INBOX_SEARCH_RECENT_THREADS,
  INBOX_SEARCH_SORTS,
  INBOX_SEARCH_STATUSES,
  type InboxSearchAnswer,
  type InboxSearchFileRow,
  type InboxSearchFrom,
  type InboxSearchGroupId,
  type InboxSearchMessageRow,
  type InboxSearchProjectRef,
  type InboxSearchProjectRow,
  type InboxSearchQuery,
  type InboxSearchRow,
  type InboxSearchSort,
  type InboxSearchStatus,
  type InboxSearchThreadRow,
} from "@plannotator/core/inbox-search";

const ANSWERS_HEADING_LINE = new RegExp(`^#{1,6}\\s+${QUESTION_ANSWERS_HEADING}\\s*$`);

const INLINE_MARKUP = /[[<*_~`|]/;

function plainInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/<(?:https?|mailto):[^>\s]*>/g, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, "")
    .replace(/(^|[^\w*~])(\*\*|__|~~|\*)(?=\S)([^\n]*?\S)\2(?=$|[\s,;:!?)\]"'.])/g, "$1$3")
    .replace(/`+/g, "");
}

export function inboxSearchBodyText(markdown: string): string {
  const out: string[] = [];
  forEachInboxSearchBodyLine(markdown, (line) => out.push(line));
  return out.join("\n").trim();
}

export function forEachInboxSearchBodyLine(markdown: string, visit: (line: string) => void): void {
  const skips = markdown.includes(":::question") ? findQuestionBlocks(markdown, { frontmatter: false }).map((b) => [b.startLine, b.endLine] as const) : [];
  let fence: string | null = null;
  let lineNo = 0;
  for (let at = 0; at <= markdown.length; ) {
    let next = markdown.indexOf("\n", at);
    if (next < 0) next = markdown.length;
    let raw = markdown.slice(at, next);
    at = next + 1;
    lineNo += 1;
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (skips.length > 0 && skips.some(([from, to]) => lineNo >= from && lineNo <= to)) continue;
    const line = raw.trim();
    if (fence !== null) {
      if (line.startsWith(fence)) fence = null;
      else visit(raw);
      continue;
    }
    if (line.length === 0) continue;
    const first = line.charCodeAt(0);
    if (first === 0x60 || first === 0x7e) {
      const open = /^(`{3,}|~{3,})/.exec(line);
      if (open) {
        fence = open[1]!;
        continue;
      }
    }
    const marked = first === 0x23 || first === 0x3e || first === 0x2d || first === 0x2a || first === 0x2b || first === 0x3a || first === 0x7c || first === 0x5f || (first >= 0x30 && first <= 0x39);
    if (marked && (/^:{3,}/.test(line) || /^[-*_]{3,}$/.test(line) || /^\|?\s*:?-{3,}/.test(line))) continue;
    let text = marked ? line.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, "").replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "") : line;
    if (INLINE_MARKUP.test(text)) text = plainInline(text.replace(/\|/g, " "));
    visit(text);
  }
}

export function inboxSearchReplyText(body: string, message?: { reask?: readonly string[] | null }): string {
  if ((message?.reask?.length ?? 0) > 0) return "";
  return replyWordsText(withoutInboxSkillsBlock(body));
}

function replyWordsText(body: string): string {
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((line) => ANSWERS_HEADING_LINE.test(line.trim()) || INBOX_STILL_OPEN_LINE.test(line.trim()));
  const kept = (at >= 0 ? lines.slice(0, at) : lines).join("\n");
  return inboxSearchBodyText(kept.replace(/^\s*(?:Answered \d+ questions?(?:, skipped \d+)?|Skipped \d+ questions?)\.\s*/, ""));
}

function answerText(answer: QuestionAnswer | null): string {
  if (!answer || answer.skipped) return "";
  const parts = [...answer.selected];
  if (answer.other) parts.push(answer.other);
  if (answer.text) parts.push(answer.text);
  return parts.join(", ");
}

function fileFolder(path: string): string | null {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2]! : null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase().slice(0, 8) : "file";
}

function toMarks(ranges: readonly [number, number][]): [number, number][] {
  return ranges.map(([a, b]) => [a, b - a]);
}

type DocType = "thread" | "message" | "file" | "guide" | "project";

interface Doc {
  key: string;
  type: DocType;
  ref: string;
  threadId: string | null;
  projectId: string;
  at: number;
  from: InboxSearchFrom | null;
  tokens: Uint8Array;
  count: number;
  titleLen: number;
  sig: string;
}

class Bytes {
  buf: Uint8Array;
  len = 0;
  constructor(size = 16) {
    this.buf = new Uint8Array(size);
  }
  push(value: number): void {
    if (this.len + 5 > this.buf.length) {
      const grown = new Uint8Array(Math.max(this.buf.length * 2, this.len + 16));
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    let v = value;
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.len++] = v;
  }
  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

interface ThreadFacts {
  projectId: string;
  section: InboxSectionId;
  archived: boolean;
  lastAt: string;
  subject: string;
  threadName: string | null;
  agent: boolean;
  me: boolean;
}

type Field = string | { body: string };

interface FieldSet {
  title: Field[];
  other: Field[];
}

export interface InboxSearchIndexOptions {
  sliceMs?: number;
  yieldNow?: () => Promise<void>;
  now?: () => number;
}

const defaultYield = (): Promise<void> =>
  new Promise((resolve) => (typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)));

export interface InboxSearchBuildStats {
  docs: number;
  threads: number;
  tokens: number;
  vocabulary: number;
  idBuckets: number;
  indexBytes: number;
  slices: number;
  longestSliceMs: number;
  slicesOver8Ms: number;
  totalMs: number;
}

export class InboxSearchIndex {
  private readonly store: InboxStore;
  private readonly sliceMs: number;
  private readonly yieldNow: () => Promise<void>;
  private readonly now: () => number;

  private docs: (Doc | null)[] = [];
  private byKey = new Map<string, number>();
  private dead = 0;
  private vocab = new Vocabulary();
  private postings = new Postings();
  private facts = new Map<string, ThreadFacts>();
  private projectNames = new Map<string, string>();

  private built = false;
  private building: Promise<void> | null = null;
  private generation = 0;
  private reloadsSeen = -1;
  private buildTotal = 0;
  private stats: InboxSearchBuildStats | null = null;

  private dirtyThreads = new Set<string>();
  private dirtyMessages = new Set<string>();
  private dirtyProjects = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private mark = new Int32Array(0);
  private epoch = 0;
  private termOf = new Uint16Array(0);
  private termFlagged = 0;
  private seq = new Bytes(4096);

  constructor(store: InboxStore, options: InboxSearchIndexOptions = {}) {
    this.store = store;
    this.sliceMs = options.sliceMs ?? 5;
    this.yieldNow = options.yieldNow ?? defaultYield;
    this.now = options.now ?? (() => performance.now());
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  ready(): boolean {
    return this.built && this.reloadsSeen === this.store.reloadCount() && !this.tooManyDead();
  }

  threadCount(): number {
    return this.building ? this.buildTotal : this.store.threadIds().length;
  }

  lastBuildStats(): InboxSearchBuildStats | null {
    return this.stats;
  }

  ensureBuilt(): Promise<void> {
    if (this.ready()) return Promise.resolve();
    if (this.building) return this.building;
    const generation = ++this.generation;
    this.building = this.build(generation).finally(() => {
      if (this.generation === generation) this.building = null;
    });
    return this.building;
  }

  private tooManyDead(): boolean {
    return this.dead > 2000 && this.dead > this.byKey.size;
  }

  private listen(): void {
    if (this.unsubscribe) return;
    const lines = this.store.subscribe((line) => this.noteLine(line));
    const drafts = this.store.onReplyDraftChange((threadId) => this.facts.delete(threadId));
    this.unsubscribe = () => {
      lines();
      drafts();
    };
  }

  private noteLine(line: InboxLine): void {
    switch (line.kind) {
      case "project":
        for (const project of this.store.allProjects()) this.dirtyProjects.add(project.id);
        break;
      case "message":
        this.dirtyMessages.add(line.record.id);
        this.dirtyThreads.add(line.record.thread_id);
        break;
      case "question": {
        this.dirtyMessages.add(line.record.message_id);
        const message = this.store.message(line.record.message_id);
        if (message) this.dirtyThreads.add(message.thread_id);
        break;
      }
      case "annotation":
        this.facts.delete(line.record.thread_id);
        return;
      case "card":
        return;
    }
    if (line.kind === "message" || line.kind === "question") {
      const threadId = line.kind === "message" ? line.record.thread_id : this.store.message(line.record.message_id)?.thread_id;
      if (threadId) this.facts.delete(threadId);
    }
    if (this.built && !this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.built && !this.building) this.flush();
      }, 50);
    }
  }

  private resetIndex(): void {
    this.docs = [];
    this.byKey = new Map();
    this.dead = 0;
    this.vocab = new Vocabulary();
    this.postings = new Postings();
    this.termOf = new Uint16Array(0);
    this.termFlagged = 0;
    this.facts = new Map();
    this.projectNames = new Map();
  }

  private async build(generation: number): Promise<void> {
    this.listen();
    const started = this.now();
    let sliceStart = started;
    let slices = 1;
    let longest = 0;
    let over = 0;
    const reloads = this.store.reloadCount();
    this.built = false;
    this.resetIndex();
    this.dirtyThreads.clear();
    this.dirtyMessages.clear();
    this.dirtyProjects.clear();
    const threadIds = this.store.threadIds();
    this.buildTotal = threadIds.length;
    const maybeYield = async (): Promise<boolean> => {
      const t = this.now();
      if (t - sliceStart < this.sliceMs) return true;
      longest = Math.max(longest, t - sliceStart);
      if (t - sliceStart > 8) over += 1;
      await this.yieldNow();
      slices += 1;
      sliceStart = this.now();
      return this.generation === generation && this.store.reloadCount() === reloads;
    };
    for (const project of this.store.allProjects()) this.indexProject(project);
    for (const threadId of threadIds) {
      for (const id of this.store.threadMessageIds(threadId)) {
        const message = this.store.message(id);
        if (message) this.indexMessage(message);
        if (!(await maybeYield())) return;
      }
      this.indexThread(threadId, false);
      if (!(await maybeYield())) return;
    }
    while (!this.vocab.settleGrowth(1 << 16)) {
      if (!(await maybeYield())) return;
    }
    for (const part of [this.vocab, this.postings]) {
      longest = Math.max(longest, this.now() - sliceStart);
      if (this.now() - sliceStart > 8) over += 1;
      await this.yieldNow();
      slices += 1;
      sliceStart = this.now();
      if (this.generation !== generation || this.store.reloadCount() !== reloads) return;
      part.compact();
    }
    longest = Math.max(longest, this.now() - sliceStart);
    if (this.now() - sliceStart > 8) over += 1;
    if (this.generation !== generation || this.store.reloadCount() !== reloads) return;
    this.reloadsSeen = reloads;
    this.built = true;
    this.flush();
    let tokens = 0;
    for (const doc of this.docs) if (doc) tokens += doc.count;
    this.stats = {
      docs: this.byKey.size,
      threads: threadIds.length,
      tokens,
      vocabulary: this.vocab.count(),
      idBuckets: this.vocab.bucketCount(),
      indexBytes: this.indexBytes(),
      slices,
      longestSliceMs: longest,
      slicesOver8Ms: over,
      totalMs: this.now() - started,
    };
  }

  flush(): void {
    if (!this.built) return;
    for (const id of this.dirtyProjects) {
      const project = this.store.project(id);
      if (project) {
        const renamed = this.projectNames.has(id) && this.projectNames.get(id) !== project.name;
        this.indexProject(project);
        if (renamed) for (const threadId of this.store.threadIds()) if (this.store.message(threadId)?.project_id === id) this.dirtyThreads.add(threadId);
      }
    }
    this.dirtyProjects.clear();
    for (const id of this.dirtyMessages) {
      const message = this.store.message(id);
      if (message) this.indexMessage(message);
    }
    this.dirtyMessages.clear();
    for (const threadId of this.dirtyThreads) {
      this.facts.delete(threadId);
      this.indexThread(threadId, false);
    }
    this.dirtyThreads.clear();
  }

  private put(key: string, type: DocType, meta: { ref: string; threadId: string | null; projectId: string; at: string; from: InboxSearchFrom | null }, fields: FieldSet, sig: string): void {
    const existing = this.byKey.get(key);
    const at = Date.parse(meta.at) || 0;
    if (existing !== undefined) {
      const doc = this.docs[existing]!;
      if (doc.sig === sig) {
        doc.at = at;
        doc.from = meta.from;
        doc.projectId = meta.projectId;
        return;
      }
      this.remove(key);
    }
    const seq = this.seq;
    seq.len = 0;
    let count = 0;
    let lastWasToken = false;
    const number = this.docs.length;
    const vocab = this.vocab;
    const postings = this.postings;
    const add = (id: number) => {
      seq.push(id);
      count += 1;
      lastWasToken = true;
      postings.add(id, number);
      if (vocab.lastWasId) {
        const keep = vocab.lastPrefixLength;
        const complete = keep > 0 && vocab.lastIdLength === keep;
        seq.push(keep | (complete ? ID_TAIL_COMPLETE : 0));
        if (keep === 0) seq.push(Math.floor(vocab.lastHash / ID_BUCKETS));
        else if (!complete) seq.push(vocab.lastHash >>> 11);
        for (let k = 0; k < keep; k++) seq.push(vocab.lastPrefix[k]!);
      }
    };
    const visit = (token: string) => add(vocab.idOfToken(token));
    let current = "";
    const visitSpan = (start: number, end: number, upper: boolean) => add(vocab.idOfSpan(current, start, end, upper));
    const scan = (text: string) => {
      current = text;
      scanInboxSearchTokens(text, visitSpan, visit);
    };
    const push = (fields: Field[]) => {
      for (const field of fields) {
        if (!field) continue;
        if (lastWasToken) {
          seq.push(0);
          count += 1;
          lastWasToken = false;
        }
        if (typeof field === "string") scan(field);
        else forEachInboxSearchBodyLine(field.body, scan);
      }
    };
    push(fields.title);
    const titleLen = count;
    push(fields.other);
    if (count === 0) return;
    const tokens = seq.take();
    this.docs.push({ key, type, ref: meta.ref, threadId: meta.threadId, projectId: meta.projectId, at, from: meta.from, tokens, count, titleLen, sig });
    this.byKey.set(key, number);
  }

  private postingsOf(id: number): Int32Array {
    return this.postings.list(id);
  }

  indexBytes(): number {
    let docs = 0;
    for (const doc of this.docs) docs += doc ? 160 + doc.tokens.byteLength + doc.key.length * 2 + doc.sig.length * 2 : 8;
    return this.vocab.bytes() + this.postings.bytes() + this.termOf.byteLength + docs;
  }

  private remove(key: string): void {
    const number = this.byKey.get(key);
    if (number === undefined) return;
    this.docs[number] = null;
    this.byKey.delete(key);
    this.dead += 1;
  }

  private indexProject(project: InboxProject): void {
    this.projectNames.set(project.id, project.name);
    this.put(`p:${project.id}`, "project", { ref: project.id, threadId: null, projectId: project.id, at: project.created_at, from: null }, { title: [project.name], other: [project.root] }, `${project.name}\u0001${project.root}`);
  }

  private indexThread(threadId: string, withMessages: boolean): void {
    const root = this.store.message(threadId);
    if (!root || root.thread_id !== threadId) {
      this.remove(`t:${threadId}`);
      this.facts.delete(threadId);
      return;
    }
    if (withMessages) for (const id of this.store.threadMessageIds(threadId)) {
      const message = this.store.message(id);
      if (message) this.indexMessage(message);
    }
    const facts = this.factsOf(threadId);
    const project = this.store.project(root.project_id);
    const subject = facts?.subject ?? displayInboxSubject(root.subject) ?? "";
    this.put(
      `t:${threadId}`,
      "thread",
      { ref: threadId, threadId, projectId: root.project_id, at: facts?.lastAt ?? root.created_at, from: null },
      { title: [subject, root.thread_name ?? ""], other: project ? [project.name] : [] },
      `${subject}\u0001${root.thread_name ?? ""}\u0001${project?.name ?? ""}`,
    );
  }

  private indexMessage(message: InboxMessage): void {
    const meta = { ref: message.id, threadId: message.thread_id, projectId: message.project_id, at: message.created_at };
    if (message.author.kind === "person") {
      if (isInboxNote(message)) return;
      this.put(`m:${message.id}`, "message", { ...meta, from: "me" }, { title: [], other: [inboxSearchReplyText(message.body, message)] }, `${message.body.length}`);
      return;
    }
    const questions = this.store.questionsOf(message.id).flatMap(questionTexts);
    const name = inboxAgentName(message.author);
    const sig = `${message.body.length}\u0001${name}\u0001${questions.join("\u0001")}`;
    const existing = this.byKey.get(`m:${message.id}`);
    if (existing === undefined || this.docs[existing]!.sig !== sig) {
      this.put(`m:${message.id}`, "message", { ...meta, from: "agent" }, { title: [], other: [{ body: message.body }, ...questions, name] }, sig);
    } else {
      this.docs[existing]!.at = Date.parse(message.created_at) || 0;
    }
    for (const attachment of message.attachments ?? []) {
      const tail = attachment.path.split(/[\\/]+/).slice(-2).join("/");
      this.put(`f:${attachment.id}`, "file", { ...meta, ref: attachment.id, from: "agent" }, { title: [attachment.name], other: [tail] }, `${attachment.name}\u0001${tail}`);
    }
    if (message.guide) this.put(`g:${message.id}`, "guide", { ...meta, from: "agent" }, { title: [message.guide.title], other: [] }, message.guide.title);
  }

  private factsOf(threadId: string): ThreadFacts | null {
    const cached = this.facts.get(threadId);
    if (cached) return cached;
    const row: InboxListRow | null = this.store.listRow(threadId);
    if (!row) return null;
    let agent = false;
    let me = false;
    for (const id of this.store.threadMessageIds(threadId)) {
      const message = this.store.message(id);
      if (!message) continue;
      if (message.author.kind === "agent") agent = true;
      else if (!isInboxNote(message)) me = true;
    }
    const facts: ThreadFacts = {
      projectId: row.project.id,
      section: row.section,
      archived: inboxRowArchived(row),
      lastAt: row.last_at,
      subject: row.subject ?? "",
      threadName: row.thread_name,
      agent,
      me,
    };
    this.facts.set(threadId, facts);
    return facts;
  }

  private nextEpoch(): number {
    if (this.mark.length < this.docs.length) {
      const grown = new Int32Array(Math.max(this.docs.length * 2, 1024));
      this.mark = grown;
      this.epoch = 0;
    }
    this.epoch += 1;
    if (this.epoch > 0x7ffffff0) {
      this.mark.fill(0);
      this.epoch = 1;
    }
    return this.epoch;
  }

  private wholeIdTerm(term: string, bit: number, last: boolean): WholeIdTerm | null {
    const hash = fnvString(term);
    const letter = /[a-z]/.test(term);
    const bucket = letter ? this.vocab.prefixBucketOf(fnvString(term.slice(0, ID_PREFIX_LENGTH))) : this.vocab.numberBucketOf(hash);
    if (bucket < 0) return null;
    return {
      bucket,
      high: Math.floor(hash / ID_BUCKETS),
      hashBits: hash >>> 11,
      chars: Uint8Array.from(term.slice(0, ID_PREFIX_KEEP), (c) => c.charCodeAt(0)),
      length: term.length,
      term,
      hashOnly: !letter || term.length > ID_PREFIX_KEEP,
      bit,
      last,
    };
  }

  private prepareTermOf(): Uint16Array {
    const size = this.vocab.size;
    if (this.termOf.length < size) {
      const grown = new Uint16Array(Math.max(Math.ceil(size * 1.25), 1024));
      grown.set(this.termOf);
      this.termOf = grown;
    }
    for (let id = this.termFlagged; id < size; id++) if (this.vocab.isBucket(id)) this.termOf[id] = BUCKET_FLAG;
    this.termFlagged = size;
    return this.termOf;
  }

  private match(terms: readonly string[]): { doc: number; tier: number; title: boolean }[] {
    const n = terms.length;
    const vocab = this.vocab;
    const exactIds: number[] = [];
    const ids: IdQuery = { whole: [], prefix: null, prefixBit: 0 };
    for (let i = 0; i < n - 1; i++) {
      const term = terms[i]!;
      if (isIdLikeToken(term)) {
        const spec = this.wholeIdTerm(term, 1 << i, false);
        if (!spec) return [];
        exactIds.push(spec.bucket);
        ids.whole.push(spec);
        continue;
      }
      const id = vocab.idOf(term);
      if (id < 0) return [];
      exactIds.push(id);
    }
    const last = terms[n - 1]!;
    const lastBit = 1 << (n - 1);
    const lastIdLike = isIdLikeToken(last);
    const lastExact = lastIdLike ? -1 : vocab.idOf(last);
    const prefix = vocab.prefixIds(last);
    const sources = [...prefix];
    if (lastIdLike) {
      const spec = this.wholeIdTerm(last, lastBit, true);
      if (spec) {
        sources.push(spec.bucket);
        ids.whole.push(spec);
      }
    }
    let prefixNeedsText = false;
    if (canPrefixId(last)) {
      const bucket = vocab.prefixBucketOf(fnvString(last.slice(0, ID_PREFIX_LENGTH)));
      if (bucket >= 0) {
        if (!sources.includes(bucket)) sources.push(bucket);
        ids.prefix = Uint8Array.from(last.slice(0, ID_PREFIX_KEEP), (c) => c.charCodeAt(0));
        ids.prefixBit = lastBit;
        prefixNeedsText = last.length > ID_PREFIX_KEEP;
      }
    }
    if (sources.length === 0) return [];
    const withIds = ids.whole.length > 0 || ids.prefixBit !== 0;

    const termOf = this.prepareTermOf();
    const touched: number[] = [];
    const flag = (id: number, bit: number) => {
      if ((termOf[id]! & BUCKET_FLAG) !== 0) return;
      if (termOf[id] === 0) touched.push(id);
      termOf[id]! |= bit;
    };
    exactIds.forEach((id, i) => flag(id, 1 << i));
    for (const id of prefix) flag(id, lastBit);

    try {
      let candidates: Int32Array;
      const alive = (list: Int32Array) => {
        let k = 0;
        for (let i = 0; i < list.length; i++) if (this.docs[list[i]!] !== null) list[k++] = list[i]!;
        return list.subarray(0, k);
      };
      if (exactIds.length > 0) {
        const order = [...exactIds].sort((a, b) => this.postings.count(a) - this.postings.count(b));
        candidates = alive(this.postingsOf(order[0]!));
        for (const id of order.slice(1)) {
          const epoch = this.nextEpoch();
          const list = this.postingsOf(id);
          for (let i = 0; i < list.length; i++) this.mark[list[i]!] = epoch;
          let k = 0;
          for (let i = 0; i < candidates.length; i++) if (this.mark[candidates[i]!] === epoch) candidates[k++] = candidates[i]!;
          candidates = candidates.subarray(0, k);
          if (candidates.length === 0) return [];
        }
        let sourcePostings = 0;
        for (const id of sources) sourcePostings += this.postings.count(id);
        if (sourcePostings <= candidates.length * 32) {
          const epoch = this.nextEpoch();
          for (const id of sources) {
            const list = this.postingsOf(id);
            for (let i = 0; i < list.length; i++) this.mark[list[i]!] = epoch;
          }
          let k = 0;
          for (let i = 0; i < candidates.length; i++) if (this.mark[candidates[i]!] === epoch) candidates[k++] = candidates[i]!;
          candidates = candidates.subarray(0, k);
        }
      } else {
        const epoch = this.nextEpoch();
        let total = 0;
        for (const id of sources) total += this.postings.count(id);
        const out = new Int32Array(total);
        let k = 0;
        for (const id of sources) {
          const list = this.postingsOf(id);
          for (let i = 0; i < list.length; i++) {
            const d = list[i]!;
            if (this.mark[d] === epoch || this.docs[d] === null) continue;
            this.mark[d] = epoch;
            out[k++] = d;
          }
        }
        candidates = out.subarray(0, k);
      }

      const all = (1 << n) - 1;
      const out: { doc: number; tier: number; title: boolean }[] = [];
      let exactEpoch = -1;
      if (n === 1 && !withIds && lastExact >= 0) {
        exactEpoch = this.nextEpoch();
        const list = this.postingsOf(lastExact);
        for (let i = 0; i < list.length; i++) this.mark[list[i]!] = exactEpoch;
      }
      for (let c = 0; c < candidates.length; c++) {
        const d = candidates[c]!;
        const doc = this.docs[d]!;
        if (n === 1 && !withIds) {
          out.push({ doc: d, tier: exactEpoch >= 0 && this.mark[d] === exactEpoch ? 2 : 1, title: scanTitle(doc.tokens, doc.titleLen, termOf) });
          continue;
        }
        const found = scanDocument(doc.tokens, doc.titleLen, termOf, lastExact, lastBit, all, withIds ? ids : null);
        if (found < 0) continue;
        if ((found & 8) !== 0 && prefixNeedsText && !this.textHasToken(doc, last, false)) continue;
        let tier = found & 3;
        const hashOnly = found >> 8;
        if (hashOnly !== 0) {
          let holds = true;
          for (const w of ids.whole) {
            if ((w.bit & hashOnly) === 0 || this.textHasToken(doc, w.term, true)) continue;
            if (w.last && canPrefixId(last) && this.textHasToken(doc, last, false)) {
              tier = 1;
              continue;
            }
            holds = false;
            break;
          }
          if (!holds) continue;
        }
        out.push({ doc: d, tier, title: (found & 4) !== 0 });
      }
      return out;
    } finally {
      for (const id of touched) termOf[id] = 0;
    }
  }

  private textHasToken(doc: Doc, term: string, whole: boolean): boolean {
    const pattern = tokenPattern(term, whole);
    for (const text of this.docTexts(doc)) if (text && pattern.test(text)) return true;
    return false;
  }

  private docTexts(doc: Doc): string[] {
    switch (doc.type) {
      case "thread": {
        const root = this.store.message(doc.ref);
        if (!root) return [];
        const facts = this.factsOf(doc.ref);
        return [facts?.subject ?? displayInboxSubject(root.subject) ?? "", root.thread_name ?? "", this.store.project(root.project_id)?.name ?? ""];
      }
      case "message": {
        const message = this.store.message(doc.ref);
        if (!message) return [];
        if (message.author.kind === "person") return [inboxSearchReplyText(message.body, message)];
        return [inboxSearchBodyText(message.body), ...this.store.questionsOf(message.id).flatMap(questionTexts), inboxAgentName(message.author)];
      }
      case "file": {
        const hit = this.store.attachment(doc.ref);
        return hit ? [hit.attachment.name, hit.attachment.path.split(/[\\/]+/).slice(-2).join("/")] : [];
      }
      case "guide":
        return [this.store.message(doc.ref)?.guide?.title ?? ""];
      case "project": {
        const project = this.store.project(doc.ref);
        return project ? [project.name, project.root] : [];
      }
    }
  }

  search(query: InboxSearchQuery): InboxSearchAnswer {
    const started = this.now();
    this.flush();
    const q = query.q.trim();
    const terms = inboxSearchTerms(q);
    const filtered = Boolean(query.project || query.status || query.from);
    const base = { q, terms, indexing: false, threads: this.threadCount() };
    const labels = new Map(this.store.allProjects().map((project) => [project.id, { id: this.store.canonicalProjectId(project.id), name: project.name }]));
    if (terms.length === 0 && !filtered) {
      return { ...base, took_ms: this.now() - started, totals: null, groups: null, recent: this.recentThreads(labels) };
    }
    const groups: Record<InboxSearchGroupId, { doc: number; score: number }[]> = { threads: [], messages: [], files: [], projects: [] };

    const snoozed = query.status ? this.store.snoozedThreads() : null;
    const statusOk = (facts: ThreadFacts | null, threadId: string | null): boolean => {
      if (!query.status) return true;
      if (!facts) return false;
      if (query.status === "archived") return facts.archived;
      if (facts.archived || (threadId !== null && snoozed?.has(threadId))) return false;
      if (query.status === "waiting") return facts.section === "stopped" || facts.section === "holding" || facts.section === "waiting";
      return facts.section === query.status;
    };
    const fromOk = (doc: Doc, facts: ThreadFacts | null): boolean => {
      if (!query.from) return true;
      if (doc.type === "thread") return query.from === "me" ? !!facts?.me : !!facts?.agent;
      return doc.from === query.from;
    };
    const admit = (doc: Doc): { group: InboxSearchGroupId; facts: ThreadFacts | null } | null => {
      if (query.project && !this.store.sameProject(doc.projectId, query.project)) return null;
      if (doc.type === "project" && this.store.canonicalProjectId(doc.ref) !== doc.ref) return null;
      let group: InboxSearchGroupId;
      switch (doc.type) {
        case "thread":
          group = "threads";
          break;
        case "message":
          group = "messages";
          break;
        case "file":
        case "guide":
          group = "files";
          break;
        case "project":
          if (query.status || query.from) return null;
          return { group: "projects", facts: null };
      }
      const facts = doc.threadId ? this.factsOf(doc.threadId) : null;
      if (doc.threadId && !facts) return null;
      if (!statusOk(facts, doc.threadId ?? null) || !fromOk(doc, facts)) return null;
      return { group, facts };
    };
    const score = (tier: number, title: boolean, archived: boolean, current: boolean, at: number): number =>
      ((((tier * 2 + (title ? 1 : 0)) * 2 + (archived ? 0 : 1)) * 2 + (current ? 1 : 0)) * 1e13) + Math.max(0, Math.min(at, 9.99e12));

    if (terms.length === 0) {
      for (const [key, number] of this.byKey) {
        if (!key.startsWith("t:")) continue;
        const doc = this.docs[number]!;
        const admitted = admit(doc);
        if (!admitted) continue;
        groups.threads.push({ doc: number, score: doc.at });
      }
    } else {
      let projectLatest: Map<string, number> | null = null;
      const latestOf = (doc: Doc): number => {
        if (doc.type !== "project") return doc.at;
        if (!projectLatest) {
          projectLatest = new Map();
          for (const [key, number] of this.byKey) {
            if (!key.startsWith("t:")) continue;
            const thread = this.docs[number]!;
            const id = this.store.canonicalProjectId(thread.projectId);
            if (thread.at > (projectLatest.get(id) ?? -Infinity)) projectLatest.set(id, thread.at);
          }
        }
        return projectLatest.get(doc.ref) ?? doc.at;
      };
      for (const hit of this.match(terms)) {
        const doc = this.docs[hit.doc]!;
        const admitted = admit(doc);
        if (!admitted) continue;
        const archived = admitted.facts?.archived ?? false;
        const ranked = query.sort === "newest" ? Math.max(0, latestOf(doc)) : score(hit.tier, hit.title, archived, !!query.current && this.store.sameProject(doc.projectId, query.current), doc.at);
        groups[admitted.group].push({ doc: hit.doc, score: ranked });
      }
    }
    const totals = {} as Record<InboxSearchGroupId, number>;
    const answer: Partial<Record<InboxSearchGroupId, InboxSearchRow[]>> = {};
    for (const id of INBOX_SEARCH_GROUPS) {
      const list = groups[id];
      totals[id] = list.length;
      if (query.group && query.group !== id) continue;
      if (terms.length === 0 && id !== "threads") continue;
      const limit = Math.min(INBOX_SEARCH_LIMIT_MAX, query.limit ?? (query.group ? INBOX_SEARCH_LIMIT_MAX : terms.length === 0 ? INBOX_SEARCH_BROWSE_LIMIT : INBOX_SEARCH_CAPS[id]));
      const offset = query.group ? Math.max(0, query.offset ?? 0) : 0;
      const rows: InboxSearchRow[] = [];
      for (const { doc } of topOf(list, offset + limit).slice(offset, offset + limit)) {
        const row = this.row(this.docs[doc]!, terms, labels);
        if (row) rows.push(row);
      }
      answer[id] = rows;
    }
    return { ...base, took_ms: this.now() - started, totals, groups: answer, recent: null };
  }

  private recentThreads(labels: Map<string, InboxSearchProjectRef>): InboxSearchThreadRow[] {
    const looked: { id: string; seq: number }[] = [];
    for (const id of this.store.threadIds()) {
      const seq = this.store.message(id)?.person_seen_seq;
      if (typeof seq === "number") looked.push({ id, seq });
    }
    looked.sort((a, b) => b.seq - a.seq);
    const out: InboxSearchThreadRow[] = [];
    for (const { id } of looked.slice(0, INBOX_SEARCH_RECENT_THREADS)) {
      const facts = this.factsOf(id);
      const root = this.store.message(id);
      if (!facts || !root) continue;
      out.push({
        type: "thread",
        id,
        thread_id: id,
        project: labels.get(facts.projectId) ?? { id: facts.projectId, name: "" },
        title: facts.subject || "(no subject)",
        title_marks: [],
        thread_name: facts.threadName,
        section: facts.section,
        archived: facts.archived,
        at: facts.lastAt,
      });
    }
    return out;
  }

  private row(doc: Doc, terms: readonly string[], labels: Map<string, InboxSearchProjectRef>): InboxSearchRow | null {
    const project = labels.get(doc.projectId) ?? { id: doc.projectId, name: "" };
    const facts = doc.threadId ? this.factsOf(doc.threadId) : null;
    const where = { project, section: facts?.section ?? null, archived: facts?.archived ?? false };
    switch (doc.type) {
      case "thread": {
        if (!facts) return null;
        const title = facts.subject || "(no subject)";
        return { type: "thread", id: doc.ref, thread_id: doc.ref, ...where, title, title_marks: toMarks(inboxSearchRanges(title, terms)), thread_name: facts.threadName, at: facts.lastAt };
      }
      case "message": {
        const message = this.store.message(doc.ref);
        if (!message || !facts) return null;
        const best = this.bestMessageText(message, terms);
        return {
          type: "message",
          id: message.id,
          thread_id: message.thread_id,
          ...where,
          author: message.author.kind === "agent" ? { kind: "agent", name: inboxAgentName(message.author), host: message.author.host ?? null } : { kind: "me", name: "You", host: null },
          title: facts.subject || "(no subject)",
          thread_name: facts.threadName,
          snippet: inboxSearchSnippet(best.text, inboxSearchRanges(best.text, terms)),
          question: best.question,
          at: message.created_at,
        };
      }
      case "file": {
        const hit = this.store.attachment(doc.ref);
        if (!hit || !facts) return null;
        const name = hit.attachment.name;
        return {
          type: "file",
          id: hit.attachment.id,
          thread_id: hit.message.thread_id,
          message_id: hit.message.id,
          ...where,
          name,
          name_marks: toMarks(inboxSearchRanges(name, terms)),
          folder: fileFolder(hit.attachment.path),
          kind: fileKind(hit.attachment.kind, name),
          title: facts.subject || "(no subject)",
          thread_name: facts.threadName,
          at: hit.message.created_at,
        };
      }
      case "guide": {
        const message = this.store.message(doc.ref);
        if (!message?.guide || !facts) return null;
        const name = message.guide.title;
        return {
          type: "guide",
          id: message.id,
          thread_id: message.thread_id,
          message_id: message.id,
          ...where,
          name,
          name_marks: toMarks(inboxSearchRanges(name, terms)),
          folder: null,
          kind: "guide",
          title: facts.subject || "(no subject)",
          thread_name: facts.threadName,
          at: message.created_at,
        };
      }
      case "project": {
        const record = this.store.project(doc.ref);
        if (!record) return null;
        return { type: "project", id: record.id, project, name: project.name, name_marks: toMarks(inboxSearchRanges(project.name, terms)), root: record.root, at: record.created_at };
      }
    }
  }

  private bestMessageText(message: InboxMessage, terms: readonly string[]): { text: string; question: { key: string; replaced: boolean } | null } {
    const candidates: { text: string; question: { key: string; replaced: boolean } | null }[] = [];
    if (message.author.kind === "person") {
      if ((message.reask?.length ?? 0) === 0) candidates.push({ text: replyWordsText(nearFirstHit(withoutInboxSkillsBlock(message.body), terms)), question: null });
    } else {
      candidates.push({ text: inboxSearchBodyText(nearFirstHit(message.body, terms)), question: null });
      for (const q of this.store.questionsOf(message.id)) {
        const ref = { key: q.key, replaced: q.state === "superseded" };
        const answer = answerText(q.answer);
        candidates.push({ text: q.prompt, question: ref });
        if (answer) candidates.push({ text: `${q.prompt} → ${answer}`, question: ref });
        for (const choice of q.choices) candidates.push({ text: `${q.prompt} → ${choice.label}`, question: ref });
        if (q.context) candidates.push({ text: q.context, question: ref });
      }
      candidates.push({ text: inboxAgentName(message.author), question: null });
    }
    let best = candidates[0]!;
    let bestCount = -1;
    for (const candidate of candidates) {
      if (!candidate.text) continue;
      const tokens = new Set(tokenizeInboxSearchText(candidate.text).map((t) => t.token));
      let count = 0;
      terms.forEach((term, i) => {
        if (tokens.has(term) || (i === terms.length - 1 && [...tokens].some((t) => t.startsWith(term)))) count += 1;
      });
      if (count === terms.length) return candidate;
      if (count > bestCount) {
        best = candidate;
        bestCount = count;
      }
    }
    return best;
  }
}

const BUCKET_FLAG = 0x100;

const ID_TAIL_KEPT = 0x0f;
const ID_TAIL_COMPLETE = 0x10;

interface WholeIdTerm {
  bucket: number;
  high: number;
  hashBits: number;
  chars: Uint8Array;
  length: number;
  term: string;
  hashOnly: boolean;
  bit: number;
  last: boolean;
}

function sameBytes(bytes: Uint8Array, at: number, chars: Uint8Array, count: number): boolean {
  for (let k = 0; k < count; k++) if (bytes[at + k] !== chars[k]) return false;
  return true;
}

interface IdQuery {
  whole: WholeIdTerm[];
  prefix: Uint8Array | null;
  prefixBit: number;
}

const tail = { bits: 0, wholeLast: false, prefix: false, hashOnly: 0 };

function readIdTail(bytes: Uint8Array, p: number, id: number, ids: IdQuery | null): number {
  const flags = bytes[p++]!;
  const kept = flags & ID_TAIL_KEPT;
  const complete = (flags & ID_TAIL_COMPLETE) !== 0;
  let high = -1;
  if (!complete) {
    high = bytes[p++]!;
    if (high & 0x80) {
      high &= 0x7f;
      let shift = 7;
      let b: number;
      do {
        b = bytes[p++]!;
        high |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
    }
  }
  const at = p;
  tail.bits = 0;
  tail.wholeLast = false;
  tail.prefix = false;
  tail.hashOnly = 0;
  if (ids) {
    for (const w of ids.whole) {
      if (w.bucket !== id) continue;
      const same =
        kept === 0
          ? high === w.high
          : complete
            ? w.length === kept && sameBytes(bytes, at, w.chars, kept)
            : w.length > ID_PREFIX_KEEP && (high >>> 0) === w.hashBits && sameBytes(bytes, at, w.chars, ID_PREFIX_KEEP);
      if (!same) continue;
      tail.bits |= w.bit;
      if (w.hashOnly) tail.hashOnly |= w.bit;
      if (w.last) tail.wholeLast = true;
    }
    const prefix = ids.prefix;
    if (prefix !== null && kept >= prefix.length && sameBytes(bytes, at, prefix, prefix.length)) {
      tail.bits |= ids.prefixBit;
      tail.prefix = true;
    }
  }
  return at + kept;
}

function scanTitle(bytes: Uint8Array, titleLen: number, termOf: Uint16Array): boolean {
  let p = 0;
  for (let t = 0; t < titleLen; t++) {
    let id = bytes[p++]!;
    if (id & 0x80) {
      id &= 0x7f;
      let shift = 7;
      let b: number;
      do {
        b = bytes[p++]!;
        id |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
    }
    const m = termOf[id]!;
    if (m === 0) continue;
    if (m >= BUCKET_FLAG) p = readIdTail(bytes, p, id, null);
    else return true;
  }
  return false;
}

function scanDocument(bytes: Uint8Array, titleLen: number, termOf: Uint16Array, lastExact: number, lastBit: number, all: number, ids: IdQuery | null): number {
  const length = bytes.length;
  let seen = 0;
  let seenTitle = 0;
  let whole = false;
  let phrase = false;
  let lastOther = false;
  let lastAsIdPrefix = false;
  let hashOnly = 0;
  let run = 0;
  let p = 0;
  let t = 0;
  while (p < length) {
    let id = bytes[p++]!;
    if (id & 0x80) {
      id &= 0x7f;
      let shift = 7;
      let b: number;
      do {
        b = bytes[p++]!;
        id |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
    }
    let m = termOf[id]!;
    if (m !== 0) {
      if (m >= BUCKET_FLAG) {
        p = readIdTail(bytes, p, id, ids);
        m = tail.bits;
        if (tail.wholeLast) {
          whole = true;
          lastOther = true;
        }
        if (tail.prefix) lastAsIdPrefix = true;
        hashOnly |= tail.hashOnly;
      } else {
        if (id === lastExact) whole = true;
        if ((m & lastBit) !== 0) lastOther = true;
      }
    }
    run = ((run << 1) | 1) & m;
    if (m !== 0) {
      seen |= m;
      if (t < titleLen) seenTitle |= m;
      if ((run & lastBit) !== 0 && lastBit > 1) phrase = true;
    }
    t++;
    if (phrase && whole && t >= titleLen && seen === all) break;
  }
  if (seen !== all) return -1;
  return (phrase ? 3 : whole ? 2 : 1) | (seenTitle === all ? 4 : 0) | (!lastOther && lastAsIdPrefix ? 8 : 0) | (hashOnly << 8);
}

function tokenPattern(term: string, whole: boolean): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}${whole ? "(?![A-Za-z0-9])" : ""}`, "i");
}

const ROW_TEXT_WINDOW_FROM = 64 * 1024;
const ROW_TEXT_WINDOW_SIDE = 4096;

function nearFirstHit(body: string, terms: readonly string[]): string {
  if (body.length <= ROW_TEXT_WINDOW_FROM) return body;
  let first = -1;
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i]!;
    if (!/^[\x20-\x7e]+$/.test(term)) return body;
    const at = body.search(tokenPattern(term, i < terms.length - 1));
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  if (first < 0) return body;
  const start = first <= ROW_TEXT_WINDOW_SIDE ? 0 : body.lastIndexOf("\n", first - ROW_TEXT_WINDOW_SIDE) + 1;
  const end = body.indexOf("\n", first + ROW_TEXT_WINDOW_SIDE);
  return body.slice(start, end < 0 ? body.length : end);
}

function topOf(list: { doc: number; score: number }[], k: number): { doc: number; score: number }[] {
  const better = (a: { doc: number; score: number }, b: { doc: number; score: number }) => b.score - a.score || a.doc - b.doc;
  if (k > 64 || list.length <= k * 4) return list.sort(better).slice(0, k);
  const best: { doc: number; score: number }[] = [];
  for (const hit of list) {
    if (best.length === k && better(hit, best[k - 1]!) >= 0) continue;
    let i = best.length === k ? k - 1 : best.length;
    if (best.length < k) best.push(hit);
    while (i > 0 && better(hit, best[i - 1]!) < 0) {
      best[i] = best[i - 1]!;
      i--;
    }
    best[i] = hit;
  }
  return best;
}

function questionTexts(question: InboxQuestion): string[] {
  return [question.prompt, question.context ?? "", ...question.choices.map((c) => c.label), answerText(question.answer)].filter(Boolean);
}

function fileKind(kind: string, name: string): string {
  const extension = extensionOf(name);
  if (extension !== "file") return extension;
  return kind === "markdown" ? "md" : kind;
}

export function projectLabels(projects: readonly InboxProject[]): Map<string, InboxSearchProjectRef> {
  return new Map(projects.map((project) => [project.id, { id: project.id, name: project.name }]));
}
