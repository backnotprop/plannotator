/**
 * Linear hover cards in the Inbox window (core `linear-ref-card.ts`, server `inbox-linear-cards.ts`). A
 * call in App.tsx installs them through the ref card providers seam (`@plannotator/ui/utils/refCardProviders`):
 *
 * - A pasted `https://linear.app/<workspace>/issue/ENG-123` names a Linear ref; the Inbox's own ref transport
 *   (`GET /api/inbox/ref?url=`) fetches it, and `LinearRefCardView` draws the card.
 * - A bare `ENG-123` of one of the workspace's teams links to its issue, so the card opens on it too. The teams come
 *   from `GET /api/inbox/linear-refs` (read with this computer's Linear key); no key, no teams, nothing linked.
 */
import { findLinearIdentifiers, isLinearRef, linearAsForgeRef, linearIssueUrl, parseLinearRefUrl, type LinearIssueRefs } from '@plannotator/core/linear-ref-card';
import { LinearRefCardView } from '@plannotator/ui/components/LinearRefCardView';
import { registerPlainTextLinker, registerRefCardProvider, type PlainTextLinker, type RefCardProvider } from '@plannotator/ui/utils/refCardProviders';
import { inboxUrl } from './inboxUrl';

/** The linker for bare identifiers of these teams. */
export function linearIdentifierLinker(refs: LinearIssueRefs): PlainTextLinker {
  return (text, previousChar) => {
    // Never inside a bare URL: the scanner drops a span over one, and a URL's own text is not prose.
    return findLinearIdentifiers(text, refs, previousChar).map(({ start, end, identifier }) => ({
      start,
      end,
      node: (key: number) => (
        <a key={key} href={linearIssueUrl(refs.workspace, identifier)} target="_blank" rel="noopener noreferrer" className="text-primary font-medium hover:underline" data-linear-ref="">
          {identifier}
        </a>
      ),
    }));
  };
}

/** The provider: Linear issue links, Linear's own card, and the identifier as the card's accessible name. */
export const linearRefCardProvider: RefCardProvider = {
  parse: (href) => {
    const ref = parseLinearRefUrl(href);
    return ref ? linearAsForgeRef(ref) : null;
  },
  owns: (ref) => isLinearRef(ref),
  View: LinearRefCardView,
  label: (ref) => `Linear issue ${ref.repo}-${ref.number}`,
};

let installed = false;

/** Install once: the provider at once, the bare identifiers once the server has read the teams. */
export function installLinearCards(fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): void {
  if (installed) return;
  installed = true;
  registerRefCardProvider(linearRefCardProvider);
  void fetchImpl(inboxUrl('/linear-refs'), { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? (res.json() as Promise<{ workspace?: string | null; teams?: string[] }>) : null))
    .then((body) => {
      if (body?.workspace && Array.isArray(body.teams) && body.teams.length > 0) registerPlainTextLinker(linearIdentifierLinker({ workspace: body.workspace, teams: body.teams }));
    })
    .catch(() => {});
}
