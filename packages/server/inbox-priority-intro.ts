/**
 * The one-time Priority dialog (reveals.ts `priority`; the owner, 2026-11-13: "only if users haven't used priority
 * yet"): whether it is still open. Pure, so a test needs no Inbox; packages/server/inbox.ts reads and stamps
 * config.json `inboxPriorityIntro` with it. Its days, threads, gap and claim are the line's.
 *
 * Used means the person added a thread to Priority on this machine: by the window, the phone's door or a linked
 * machine's forward, every one of which writes inbox/priority.json here. That file deletes itself with its last entry,
 * so the first add is kept as `usedAt`; a thread in Priority now counts too (an Inbox that kept adds before this key).
 *
 * Never on the day the Inbox first runs a version that has it (the owner, 2026-11-13: "Hold it back a day after an
 * upgrade"): that day is stamped at the first release start, as the tab icon's is, in the line's own record
 * (config.json `inboxReveals.priority.dueAt`), and the dialog stays closed until the local calendar day after it.
 */
import { revealDay } from "@plannotator/shared/inbox/reveals";

export interface PriorityIntroSaved {
  usedAt?: string;
}

/** The person never added a thread to Priority here. */
export function priorityIntroUnused(saved: PriorityIntroSaved | undefined, personAdds: number): boolean {
  return !saved?.usedAt && personAdds === 0;
}

/**
 * Open while the person never added a thread to Priority here, from the day after the first start of a version that
 * has it (`dueAt`; none stamped yet, as on a dev build: closed).
 */
export function priorityIntroOpen(saved: PriorityIntroSaved | undefined, personAdds: number, dueAt: string | undefined, now: Date): boolean {
  const due = dueAt ? Date.parse(dueAt) : Number.NaN;
  if (Number.isNaN(due) || revealDay(due) === revealDay(now.getTime())) return false;
  return priorityIntroUnused(saved, personAdds);
}

/** The stamp to save after a Priority change, or null when nothing changes (already used, or no add stands). */
export function priorityIntroUsed(saved: PriorityIntroSaved | undefined, personAdds: number, now: Date): PriorityIntroSaved | null {
  if (saved?.usedAt || personAdds === 0) return null;
  return { ...saved, usedAt: now.toISOString() };
}
