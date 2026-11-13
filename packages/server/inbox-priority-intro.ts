/**
 * The one-time Priority dialog (reveals.ts `priority`; the owner, 2026-11-13: "only if users haven't used priority
 * yet"): whether it is still open. Pure, so a test needs no Inbox; packages/server/inbox.ts reads and stamps
 * config.json `inboxPriorityIntro` with it. Its days, threads, gap and claim are the line's.
 *
 * Used means the person added a thread to Priority on this machine: by the window, the phone's door or a linked
 * machine's forward, every one of which writes inbox/priority.json here. That file deletes itself with its last entry,
 * so the first add is kept as `usedAt`; a thread in Priority now counts too (an Inbox that kept adds before this key).
 */

export interface PriorityIntroSaved {
  usedAt?: string;
}

/** Open while the person never added a thread to Priority here. */
export function priorityIntroOpen(saved: PriorityIntroSaved | undefined, personAdds: number): boolean {
  return !saved?.usedAt && personAdds === 0;
}

/** The stamp to save after a Priority change, or null when nothing changes (already used, or no add stands). */
export function priorityIntroUsed(saved: PriorityIntroSaved | undefined, personAdds: number, now: Date): PriorityIntroSaved | null {
  if (saved?.usedAt || personAdds === 0) return null;
  return { ...saved, usedAt: now.toISOString() };
}
