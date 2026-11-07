/**
 * The "Star the repo" ask in the Inbox (approval "star-ask"; packages/shared/star-ask.ts): the claim of its corner card
 * and its `POST /api/inbox/star-ask` actions, kept out of inbox.ts so they are tested without starting an Inbox
 * (inbox-star-ask.test.ts).
 *
 * The ask stands aside from the line of one-time dialogs (packages/shared/inbox/reveals.ts, `aside`): its claim needs
 * the line free, and stamps only its own reveal (`inboxReveals.star`) and `starAsk`, in one save, so no other dialog's
 * day moves. Its Not now records the answer and stamps nothing of the line either.
 */
import { InboxError } from "@plannotator/shared/inbox/schema";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { readStarAskRecord, type StarAskClaim, type StarAskRecord, type StarAskService } from "@plannotator/shared/star-ask";

/** config.json `inboxReveals.star`: when the Inbox showed it, and the page's key (a retry after a lost answer). */
export type InboxStarSaved = { shownAt?: string; key?: string };

export function inboxStarSaved(): InboxStarSaved | undefined {
  return (loadConfig().inboxReveals as { star?: InboxStarSaved } | undefined)?.star;
}

/** One save: the Inbox's own reveal stamp and the shared record. True when both were read back. */
export function inboxStarStamp(record: StarAskRecord, key: string | null): boolean {
  const at = record.shownAt!;
  saveConfig({ inboxReveals: { ...loadConfig().inboxReveals, star: { shownAt: at, ...(key ? { key } : {}) } }, starAsk: record });
  return inboxStarSaved()?.shownAt === at && readStarAskRecord(loadConfig())?.shownAt === at;
}

export interface InboxStarClaimDeps {
  service: StarAskService;
  /** A release build (the Inbox's `snoozeIntroRelease`). */
  release: boolean;
  /** The line is free and the ask's "who" holds (`revealMayClaim("star", …)`), read now. */
  mayClaim: () => boolean;
  /** Default: config.json (`inboxStarSaved`, `inboxStarStamp`). */
  saved?: () => InboxStarSaved | undefined;
  record?: () => StarAskRecord | undefined;
  stamp?: (record: StarAskRecord, key: string | null) => boolean;
}

/**
 * The page at its calm moment claims the ask: the owner only, a release build, the line free (checked before the
 * already-starred check and again after it: gh may take up to 3 s). `key`: the same page's retry after a lost answer is
 * shown it again while it is still unanswered.
 */
export async function claimInboxStar(deps: InboxStarClaimDeps, owner: boolean, key: string | null): Promise<StarAskClaim> {
  const no: StarAskClaim = { show: false, canStar: false };
  if (!owner || !deps.release) return no;
  const saved = (deps.saved ?? inboxStarSaved)();
  if (key && saved?.key === key) {
    const record = (deps.record ?? (() => readStarAskRecord(loadConfig())))();
    return record?.shownAt === saved.shownAt && !record?.answer && record?.surface === "inbox" ? { show: true, canStar: record.canStar === true } : no;
  }
  const stamp = deps.stamp ?? inboxStarStamp;
  return deps.service.claim("inbox", { gate: deps.mayClaim, stamp: (record) => stamp(record, key) });
}

/**
 * `POST /api/inbox/star-ask`: `{ action: "star" }` stars it with the person's gh (their click, on the card the Inbox
 * showed, while its check found gh able to); `{ action: "answer", answer: "not-now" | "opened" }` records the answer.
 * The owner's pages only: a guest gets `{ starred: false }` or `{ ok: false }` and nothing runs.
 */
export async function inboxStarAction(service: StarAskService, owner: boolean, body: Record<string, unknown>): Promise<{ starred: boolean } | { ok: boolean }> {
  if (body.action === "star") return owner ? service.star("inbox") : { starred: false };
  if (body.action !== "answer" || (body.answer !== "not-now" && body.answer !== "opened")) {
    throw new InboxError("validation_error", "action: star, or answer with answer: not-now or opened.", { field: "action" });
  }
  if (!owner) return { ok: false };
  return service.answer(body.answer);
}
