/**
 * Linear hover cards for a host whose ref transport reads Linear issue links (plan review and annotate over
 * `GET /api/ref`): the plain provider for the ref card providers seam (utils/refCardProviders.ts). Links only:
 * a pasted `https://linear.app/<workspace>/issue/ENG-123` gets the card, a bare `ENG-123` stays text. The Inbox
 * registers its own (packages/inbox/linearCards.tsx), which links bare identifiers too.
 */
import { isLinearRef, linearAsForgeRef, parseLinearRefUrl } from '@plannotator/core/linear-ref-card';
import { LinearRefCardView } from '../components/LinearRefCardView';
import type { RefCardProvider } from './refCardProviders';

/** The provider: Linear issue links, Linear's own card, and the identifier as the card's accessible name. */
export const linearLinkCardProvider: RefCardProvider = {
  parse: (href) => {
    const ref = parseLinearRefUrl(href);
    return ref ? linearAsForgeRef(ref) : null;
  },
  owns: (ref) => isLinearRef(ref),
  View: LinearRefCardView,
  label: (ref) => `Linear issue ${ref.repo}-${ref.number}`,
};
