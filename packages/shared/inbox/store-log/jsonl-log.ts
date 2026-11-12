/**
 * Today's record log: per-project append-only JSONL under `<dataDir>/inbox/` (the layout is in `../schema.ts`).
 *
 * Every change appends ONE line, a full snapshot of the record, in a single append-mode write. A line that
 * does not parse is skipped on read (a torn last line after a crash); before the first append to a file whose
 * last line is torn, a newline is appended first so the fragment stays its own unreadable line and the new
 * line stays whole. A deletion rewrites the project's files whole (temp file, then rename) and keeps the
 * highest seq in `seq.json`, so an agent's cursor already past it never sees that number again.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxCard, InboxLine, InboxProject } from "@plannotator/core/inbox-types";
import {
  ANNOTATIONS_FILE,
  CARDS_FILE,
  INBOX_PROJECTS_DIR,
  INITIATIVES_FILE,
  LEGACY_DECISIONS_FILE,
  MESSAGES_FILE,
  parseInboxLine,
  PROJECT_FILE,
  PULLS_FILE,
  QUESTIONS_FILE,
  SEQ_FLOOR_FILE,
  STEPS_FILE,
} from "../schema";
import type { InboxLog, InboxLogContents, InboxLogUsage } from "./log";

const FILE_OF: Record<InboxLine["kind"], string> = {
  project: PROJECT_FILE,
  message: MESSAGES_FILE,
  question: QUESTIONS_FILE,
  annotation: ANNOTATIONS_FILE,
  card: CARDS_FILE,
  steps: STEPS_FILE,
  thread_pull: PULLS_FILE,
  initiative: INITIATIVES_FILE,
};

/** Files an older Inbox never reads: after a line there, `seq.json` keeps that Inbox from handing out its seq again. */
const FLOORED: ReadonlySet<InboxLine["kind"]> = new Set(["card", "steps", "thread_pull", "initiative"]);

/** Every project file the store reads, in the order it always read them. */
const PROJECT_FILES = [PROJECT_FILE, MESSAGES_FILE, QUESTIONS_FILE, ANNOTATIONS_FILE, CARDS_FILE, STEPS_FILE, PULLS_FILE];

export function jsonlInboxLog(dir: string): InboxLog {
  return new JsonlInboxLog(dir);
}

class JsonlInboxLog implements InboxLog {
  /** Files whose last line is torn: the next append starts on a fresh line. */
  private readonly tornFiles = new Set<string>();

  constructor(private readonly dir: string) {}

  read(): InboxLogContents {
    this.tornFiles.clear();
    let seqFloor = this.readSeqFloor();
    const lines: InboxLine[] = [];
    // The Board's initiatives: one file for every project, on the same seq.
    this.readLines(join(this.dir, INITIATIVES_FILE), lines);
    const projectsDir = join(this.dir, INBOX_PROJECTS_DIR);
    if (!existsSync(projectsDir)) return { lines, seqFloor };
    for (const key of readdirSync(projectsDir)) {
      const folder = join(projectsDir, key);
      // Decisions were removed (2026-10): an older store's decisions.jsonl is
      // left on disk and never applied, but its seqs still count, so a seq is
      // never handed out twice.
      seqFloor = Math.max(seqFloor, legacySeqFloor(join(folder, LEGACY_DECISIONS_FILE)));
      for (const name of PROJECT_FILES) this.readLines(join(folder, name), lines);
    }
    return { lines, seqFloor };
  }

  append(line: InboxLine, project: InboxProject | null): void {
    const file = line.kind === "initiative" || !project ? join(this.dir, FILE_OF[line.kind]) : join(this.folder(project), FILE_OF[line.kind]);
    const prefix = this.tornFiles.has(file) ? "\n" : "";
    try {
      appendFileSync(file, `${prefix}${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (error) {
      // A failed append may have left part of the line (disk full): the next
      // append starts on a fresh line so it cannot be glued to the fragment.
      this.tornFiles.add(file);
      throw error;
    }
    this.tornFiles.delete(file);
    if (!FLOORED.has(line.kind)) return;
    try {
      this.keepSeqFloor(line.seq);
    } catch {
      // Best effort: the line is written; only a downgrade would read the floor.
    }
  }

  keyTaken(key: string): boolean {
    return existsSync(join(this.dir, INBOX_PROJECTS_DIR, key));
  }

  createProject(project: InboxProject, line: InboxLine): void {
    const folder = this.folder(project);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // The first line, written whole: temp file then rename (a rename appends later lines through append()).
    const path = join(folder, PROJECT_FILE);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }

  deleteThread(project: InboxProject, threadId: string, messageIds: ReadonlySet<string>, seq: number): void {
    this.keepSeqFloor(seq);
    const folder = this.folder(project);
    for (const name of [MESSAGES_FILE, QUESTIONS_FILE, ANNOTATIONS_FILE, STEPS_FILE, PULLS_FILE]) {
      const path = join(folder, name);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const kept = text.split("\n").filter((raw) => {
        const line = parseInboxLine(raw);
        if (!line) return false;
        if (line.kind === "message") return line.record.thread_id !== threadId;
        if (line.kind === "question") return !messageIds.has(line.record.message_id);
        if (line.kind === "annotation") return line.record.thread_id !== threadId;
        if (line.kind === "steps") return line.record.thread_id !== threadId;
        if (line.kind === "thread_pull") return line.record.thread_id !== threadId;
        return true;
      });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
      renameSync(temp, path);
    }
  }

  deleteProject(project: InboxProject, seq: number): void {
    this.keepSeqFloor(seq);
    rmSync(this.folder(project), { recursive: true, force: true });
  }

  cardLines(project: InboxProject, cardId: string): { seq: number; card: InboxCard }[] {
    let text = "";
    try {
      text = readFileSync(join(this.folder(project), CARDS_FILE), "utf8");
    } catch {
      // No file to read (removed under us): the card as it stands is all there is.
    }
    const lines: { seq: number; card: InboxCard }[] = [];
    for (const raw of text.split("\n")) {
      const line = parseInboxLine(raw);
      if (line?.kind === "card" && line.record.id === cardId) lines.push({ seq: line.seq, card: line.record });
    }
    return lines;
  }

  usage(project: InboxProject): InboxLogUsage {
    const folder = this.folder(project);
    let bytes = 0;
    const lines: InboxLogUsage["lines"] = [];
    for (const name of [PROJECT_FILE, MESSAGES_FILE, QUESTIONS_FILE, LEGACY_DECISIONS_FILE, ANNOTATIONS_FILE, CARDS_FILE, STEPS_FILE, PULLS_FILE]) {
      let text: string;
      try {
        text = readFileSync(join(folder, name), "utf8");
      } catch {
        continue;
      }
      bytes += Buffer.byteLength(text);
      // The project line, an older store's decisions file and the cards count for the project, not a thread.
      if (name === PROJECT_FILE || name === LEGACY_DECISIONS_FILE || name === CARDS_FILE) continue;
      for (const raw of text.split("\n")) {
        const line = parseInboxLine(raw);
        if (line) lines.push({ line, bytes: Buffer.byteLength(raw) + 1 });
      }
    }
    return { bytes, lines };
  }

  private folder(project: InboxProject): string {
    return join(this.dir, INBOX_PROJECTS_DIR, project.key);
  }

  /** One store file's lines into `into` (none when it is missing); a torn last line is noted for the next append. */
  private readLines(path: string, into: InboxLine[]): void {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (text.length > 0 && !text.endsWith("\n")) this.tornFiles.add(path);
    for (const raw of text.split("\n")) {
      const line = parseInboxLine(raw);
      if (line) into.push(line);
    }
  }

  /** Keep the highest seq across a deletion: the lines removed may hold it. */
  private keepSeqFloor(seq: number): void {
    const path = join(this.dir, SEQ_FLOOR_FILE);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ seq })}\n`, { mode: 0o600 });
    renameSync(temp, path);
  }

  private readSeqFloor(): number {
    try {
      const value = JSON.parse(readFileSync(join(this.dir, SEQ_FLOOR_FILE), "utf8")) as { seq?: unknown };
      return typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq > 0 ? value.seq : 0;
    } catch {
      return 0;
    }
  }
}

/**
 * The highest seq in an older store's decisions.jsonl (Decisions were removed
 * in 2026-10; the file is kept on disk and its records are never read), or 0.
 * Read leniently: only each line's `seq` counts.
 */
function legacySeqFloor(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let high = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const seq = (JSON.parse(raw) as { seq?: unknown }).seq;
      if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > high) high = seq;
    } catch {
      // A torn line: skipped, as the store skips one.
    }
  }
  return high;
}

