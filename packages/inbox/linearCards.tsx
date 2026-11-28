/**
 * Linear hover cards in the Inbox window (core `linear-ref-card.ts`, server `inbox-linear-cards.ts`). A
 * call in configureUI.ts installs them through the ref card providers seam (`@plannotator/ui/utils/refCardProviders`):
 *
 * - A pasted `https://linear.app/<workspace>/issue/ENG-123` names a Linear ref; the Inbox's own ref transport
 *   (`GET /api/inbox/ref?url=`) fetches it, and `LinearRefCardView` draws the card.
 * - A bare `ENG-123` of one of the workspace's teams links to its issue, so the card opens on it too. The teams come
 *   from `GET /api/inbox/linear-refs` (read with this computer's Linear key), asked once prose on screen shows a
 *   candidate identifier, never on page load; no key, no teams, nothing linked.
 * - The same answer's `key` says whether Linear took the key: a card Linear answered `signed_out` then says the key
 *   was refused (and where to replace it) instead of asking for one, and Settings → Accounts → Linear says it too.
 */
import { findLinearIdentifiers, isLinearRef, linearAsForgeRef, linearIssueUrl, parseLinearRefUrl, type LinearIssueRefs } from '@plannotator/core/linear-ref-card';
import { LinearRefCardView } from '@plannotator/ui/components/LinearRefCardView';
import { registerPlainTextLinker, registerRefCardProvider, type PlainTextLinker, type RefCardProvider } from '@plannotator/ui/utils/refCardProviders';
import { getRefCardTransport, setRefCardTransport } from '@plannotator/ui/utils/refCard';
import { proseRefLinkProps } from '@plannotator/ui/utils/refCardClick';
import { useSyncExternalStore } from 'react';
import { inboxUrl } from './inboxUrl';

/** The linker for bare identifiers of these teams. */
export function linearIdentifierLinker(refs: LinearIssueRefs): PlainTextLinker {
  return (text, previousChar) => {
    // Never inside a bare URL: the scanner drops a span over one, and a URL's own text is not prose.
    return findLinearIdentifiers(text, refs, previousChar).map(({ start, end, identifier }) => ({
      start,
      end,
      node: (key: number) => (
        <a key={key} href={linearIssueUrl(refs.workspace, identifier)} target="_blank" rel="noopener noreferrer" className="text-primary font-medium hover:underline" data-linear-ref="" {...proseRefLinkProps(linearIssueUrl(refs.workspace, identifier))}>
          {identifier}
        </a>
      ),
    }));
  };
}

export const NO_KEY_TEXT = 'Add your Linear API key in Settings → Accounts to see details here.';
export const REFUSED_KEY_TEXT = 'Linear refused the API key. Replace it in Settings → Accounts → Linear.';

/** The server's `LinearKeyVerdict` from the last teams read; null before one. */
export type LinearKeyVerdict = 'accepted' | 'refused' | 'unknown' | 'none';
let verdict: LinearKeyVerdict | null = null;
const verdictSeen = new Set<() => void>();
function setVerdict(next: LinearKeyVerdict | null): void {
  if (next === verdict) return;
  verdict = next;
  for (const seen of verdictSeen) seen();
}
const watchVerdict = (seen: () => void) => {
  verdictSeen.add(seen);
  return () => verdictSeen.delete(seen);
};
/** The key's verdict, redrawn when a teams read changes it. */
export function useLinearKeyVerdict(): LinearKeyVerdict | null {
  return useSyncExternalStore(watchVerdict, () => verdict, () => verdict);
}

function LinearCardView(props: Parameters<typeof LinearRefCardView>[0]) {
  return <LinearRefCardView {...props} noKeyText={useLinearKeyVerdict() === 'refused' ? REFUSED_KEY_TEXT : NO_KEY_TEXT} />;
}

/**
 * The provider: Linear issue links, Linear's own card, and the identifier as the card's accessible name. A link to
 * another workspace than the key's is a plain link once that workspace is known (the server answers it not found
 * until then); the first Linear link asks for it.
 */
export const linearRefCardProvider: RefCardProvider = {
  parse: (href) => {
    const ref = parseLinearRefUrl(href);
    if (!ref) return null;
    askTeams();
    return keyWorkspace && ref.owner !== keyWorkspace ? null : linearAsForgeRef(ref);
  },
  owns: (ref) => isLinearRef(ref),
  View: LinearCardView,
  label: (ref) => `Linear issue ${ref.repo}-${ref.number}`,
};

type FetchTeams = (url: string, init?: RequestInit) => Promise<Response>;

/** Text that could hold a bare identifier: the teams are read only once prose on screen shows one. */
const MAYBE_IDENTIFIER = /(?<![\w/.-])[A-Za-z][A-Za-z0-9]{0,9}-[1-9]\d{0,8}(?![\w-])/;

let installed: { fetchTeams: FetchTeams; undo: (() => void)[] } | null = null;
let teamsAsked = false;
let unlink: (() => void) | null = null;
/** The key's workspace (its URL key), once read; null with no key or before. */
let keyWorkspace: string | null = null;

const VERDICTS: readonly string[] = ['accepted', 'refused', 'unknown', 'none'];

/** Bumped per read: an older read's answer (under the key before a save) is dropped. */
let reads = 0;

function linkTeams(): Promise<void> {
  if (!installed) return Promise.resolve();
  const read = ++reads;
  return installed
    .fetchTeams(inboxUrl('/linear-refs'), { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? (res.json() as Promise<{ workspace?: string | null; teams?: string[]; key?: string }>) : null))
    .then((body) => {
      if (read !== reads) return;
      // An older Inbox's answer has no `key`: not known.
      setVerdict(body && VERDICTS.includes(body.key ?? '') ? (body.key as LinearKeyVerdict) : null);
      unlink?.();
      unlink = null;
      keyWorkspace = installed && body?.workspace ? body.workspace.toLowerCase() : null;
      if (installed && body?.workspace && Array.isArray(body.teams) && body.teams.length > 0) unlink = registerPlainTextLinker(linearIdentifierLinker({ workspace: body.workspace, teams: body.teams }));
    })
    .catch(() => {});
}

/** Ask for the teams once, after the current render. */
function askTeams(): void {
  if (teamsAsked || !installed) return;
  teamsAsked = true;
  queueMicrotask(() => void linkTeams());
}

/** Links nothing; the first prose with something shaped like `ENG-123` asks for the teams. */
const askOnFirstCandidate: PlainTextLinker = (text) => {
  if (!teamsAsked && MAYBE_IDENTIFIER.test(text)) askTeams();
  return [];
};

/**
 * Install once: the provider at once; nothing is fetched until a card is hovered or prose shows a candidate
 * identifier. Returns the uninstall (tests).
 */
export function installLinearCards(fetchImpl?: FetchTeams): () => void {
  if (installed) return () => {};
  installed = { fetchTeams: fetchImpl ?? ((url, init) => fetch(url, init)), undo: [] };
  installed.undo.push(registerRefCardProvider(linearRefCardProvider), registerPlainTextLinker(askOnFirstCandidate));
  return () => {
    for (const undo of installed?.undo ?? []) undo();
    unlink?.();
    unlink = null;
    installed = null;
    teamsAsked = false;
    keyWorkspace = null;
    setVerdict(null);
  };
}

/** After the key changes: drop the cached cards and the verdict, and read the teams (and so the verdict) again. */
export function refreshLinearCards(): Promise<void> {
  if (!installed) return Promise.resolve();
  setRefCardTransport(getRefCardTransport());
  keyWorkspace = null;
  setVerdict(null);
  teamsAsked = true;
  return linkTeams();
}

/** Settings asks once for the verdict of a key it shows, when no read has said it yet. */
export function checkLinearKey(): Promise<void> {
  if (!installed || verdict !== null) return Promise.resolve();
  teamsAsked = true;
  return linkTeams();
}
