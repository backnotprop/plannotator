/**
 * Where a guide's answers live while VS Code runs: on disk (`answers.ts`), or
 * in memory when the guide is not saved (guide history off). It remembers
 * what was deleted, so a question still being answered when its guide (or the
 * answer itself) is deleted is not written back when it finishes. It also
 * holds the one-question-at-a-time reservation per guide, taken before
 * anything is awaited, so two quick asks cannot both start.
 *
 * No `vscode` here.
 */

import { deleteAnswer, deleteGuideAnswers, listAnswers, saveAnswer, type AnswerRecord } from "./answers";

export class AnswerShelf {
  private readonly memory = new Map<string, Map<string, AnswerRecord>>();
  private readonly deletedGuides = new Set<string>();
  private readonly deletedAnswers = new Set<string>();
  private readonly reserved = new Set<string>();

  constructor(private readonly log: (line: string) => void = () => {}) {}

  /** Write an answer; false (and nothing written) when it or its guide was deleted. */
  save(record: AnswerRecord, persists: boolean): boolean {
    if (this.isDeleted(record)) return false;
    if (!persists) {
      const m = this.memory.get(record.guideId) ?? new Map<string, AnswerRecord>();
      m.set(record.id, record);
      this.memory.set(record.guideId, m);
      return true;
    }
    try {
      saveAnswer(record);
      return true;
    } catch (err) {
      this.log(`[guides] could not save the answer: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** A guide's answers, newest first. */
  list(repoKey: string, guideId: string, persists: boolean): AnswerRecord[] {
    if (this.deletedGuides.has(guideId)) return [];
    const all = persists ? listAnswers(repoKey, guideId) : [...(this.memory.get(guideId)?.values() ?? [])].sort((a, b) => b.askedAt - a.askedAt);
    return all.filter((r) => !this.deletedAnswers.has(r.id));
  }

  /** Delete one answer (and never write it again). */
  remove(record: AnswerRecord, persists: boolean): void {
    this.deletedAnswers.add(record.id);
    if (persists) deleteAnswer(record.repoKey, record.guideId, record.id);
    else this.memory.get(record.guideId)?.delete(record.id);
  }

  /** The guide was deleted: its answers go, and none is written again. */
  removeGuide(repoKey: string, guideId: string): void {
    this.deletedGuides.add(guideId);
    this.memory.delete(guideId);
    deleteGuideAnswers(repoKey, guideId);
  }

  isDeleted(record: Pick<AnswerRecord, "id" | "guideId">): boolean {
    return this.deletedGuides.has(record.guideId) || this.deletedAnswers.has(record.id);
  }

  isGuideDeleted(guideId: string): boolean {
    return this.deletedGuides.has(guideId);
  }

  /** Take the guide's question slot; false when a question is already starting or being answered. */
  reserve(guideId: string): boolean {
    if (this.reserved.has(guideId)) return false;
    this.reserved.add(guideId);
    return true;
  }

  release(guideId: string): void {
    this.reserved.delete(guideId);
  }

  isReserved(guideId: string): boolean {
    return this.reserved.has(guideId);
  }
}
