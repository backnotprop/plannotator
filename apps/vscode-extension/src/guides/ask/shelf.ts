import { deleteAnswer, deleteGuideAnswers, listAnswers, saveAnswer, type AnswerRecord } from "./answers";

export class AnswerShelf {
  private readonly memory = new Map<string, Map<string, AnswerRecord>>();
  private readonly deletedGuides = new Set<string>();
  private readonly deletedAnswers = new Set<string>();
  private readonly reserved = new Set<string>();

  constructor(private readonly log: (line: string) => void = () => {}) {}

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

  list(repoKey: string, guideId: string, persists: boolean): AnswerRecord[] {
    if (this.deletedGuides.has(guideId)) return [];
    const all = persists ? listAnswers(repoKey, guideId) : [...(this.memory.get(guideId)?.values() ?? [])].sort((a, b) => b.askedAt - a.askedAt);
    return all.filter((r) => !this.deletedAnswers.has(r.id));
  }

  remove(record: AnswerRecord, persists: boolean): void {
    this.deletedAnswers.add(record.id);
    if (persists) deleteAnswer(record.repoKey, record.guideId, record.id);
    else this.memory.get(record.guideId)?.delete(record.id);
  }

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
