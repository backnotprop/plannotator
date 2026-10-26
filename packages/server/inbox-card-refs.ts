/**
 * The Board's references, resolved (owner's answer, 2026-10-26): the live
 * state of what a card links (a PR, an issue), fetched when the person opens
 * the card, never before, and never acted on (state never moves a card).
 *
 * One resolver per source, behind one interface: the source registry's
 * parser (shared/inbox/card-refs.ts) reads a reference, a resolver here says
 * what it is now. GitHub and GitLab go through #2187's hover-card lookup
 * (`createRefCards`: this computer's own gh / glab, github.com, gitlab.com and
 * the hosts they are signed in to only, `--hostname` always passed, read
 * only, its cache). A source with no resolver (Bitbucket today) answers
 * `unsupported`, and the window shows the reference quietly. A new source
 * (Linear, Jira, Figma, Vercel) adds one entry to CARD_REF_RESOLVERS.
 */

import type { ForgeRefCardResult } from "@plannotator/core/forge-ref-card";
import type { InboxCardRef } from "@plannotator/core/inbox-types";
import type { RefCards } from "./ref-cards";

/** What one reference is now: the hover card's data, or why it could not say. */
export type InboxCardRefResult = ForgeRefCardResult;

/** One source's resolver. `resolve` answers null when the reference is not one it reads. */
export interface InboxCardRefResolver {
  sources: readonly string[];
  resolve(ref: InboxCardRef): Promise<InboxCardRefResult | null>;
}

/** GitHub and GitLab: #2187's lookup, by the reference's URL. */
export function forgeCardRefResolver(refCards: RefCards): InboxCardRefResolver {
  return { sources: ["github", "gitlab"], resolve: (ref) => refCards.get(ref.url) };
}

/**
 * Every reference of a card, resolved at once (each source's own limits and
 * cache apply). A reference no resolver reads answers `unsupported`.
 */
export async function resolveInboxCardRefs(
  refs: readonly InboxCardRef[],
  resolvers: readonly InboxCardRefResolver[],
  now: () => number = Date.now,
): Promise<{ ref: InboxCardRef; result: InboxCardRefResult }[]> {
  return Promise.all(
    refs.map(async (ref) => {
      const resolver = resolvers.find((r) => r.sources.includes(ref.source));
      let result: InboxCardRefResult | null = null;
      try {
        result = resolver ? await resolver.resolve(ref) : null;
      } catch {
        result = { ok: false, error: "unavailable", fetchedAt: now() };
      }
      return { ref, result: result ?? { ok: false, error: "unsupported", fetchedAt: now() } };
    }),
  );
}
