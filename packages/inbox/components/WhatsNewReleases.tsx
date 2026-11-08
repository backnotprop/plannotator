/**
 * What's new's TL;DR ledger and releases panel (design of record
 * .product/approved/inbox-whats-new-tldr/, round 2): the ledger between two
 * hairlines with a fixed label column and status dots; the panel's Latest
 * card (compact while the latest release is open, full otherwise) and its
 * earlier releases, each a link to `#whats-new=<version>`; the same list in a
 * bottom sheet where the panel does not fit (a phone, a window under 1100 px).
 */
import { useEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { TldrLine, WhatsNewRelease, WhatsNewReleasesModel } from '../api';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { codeParts, latestCardFace, releaseWords, tldrDot } from '../whatsNew';
import { Modal } from './Updates';

const RELEASES_URL = 'https://github.com/backnotprop/plannotator/releases';

/** "Nov 8", from an ISO date. */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

/** A TL;DR line's words, its `code` in the mono face. */
export function TldrText({ text }: { text: string }) {
  return (
    <>
      {codeParts(text).map((part, i) => (part.code ? <code key={i}>{part.text}</code> : <span key={i}>{part.text}</span>))}
    </>
  );
}

function Dot({ kind }: { kind: string }) {
  return <i className={`ib-wn-dot ib-wn-d-${kind}`} aria-hidden="true" />;
}

/** The ledger: "TL;DR", then each line's label (with its dot) in a fixed column and its words on one edge. */
export function TldrLedger({ lines }: { lines: TldrLine[] }) {
  return (
    <section className="ib-wn-tldr" aria-labelledby="ib-wn-tldr-h" data-whats-new-tldr="">
      <h2 id="ib-wn-tldr-h">TL;DR</h2>
      <ul>
        {lines.map((line, i) => {
          const dot = tldrDot(line.label);
          return (
            <li key={i}>
              <span className="ib-wn-tl">
                {dot && <Dot kind={dot} />}
                {line.label}
              </span>
              <span className="ib-wn-tt">
                <TldrText text={line.text} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * While the notes load or can't be fetched: the line the newest saved release
 * list gives this release, marked where it comes from; placeholder bars when
 * there is none and the notes are still on their way; nothing otherwise.
 */
export function KnownLine({ row, loading }: { row: WhatsNewRelease | null; loading: boolean }) {
  if (row && row.tldr.length > 0) return <TldrLedger lines={row.tldr} />;
  if (row?.listed) {
    return (
      <section className="ib-wn-tldr" aria-labelledby="ib-wn-tldr-h" data-whats-new-known="">
        <h2 id="ib-wn-tldr-h">TL;DR</h2>
        <p className="ib-wn-known">
          <TldrText text={row.listed.text} />
        </p>
        <p className="ib-wn-from">
          From the release list in <span className="ib-wn-mono">{row.listed.in}</span>&apos;s notes
        </p>
      </section>
    );
  }
  if (!loading) return <div className="ib-wn-tldr ib-wn-tldr-empty" aria-hidden="true" />;
  return (
    <section className="ib-wn-tldr" aria-busy="true" aria-label="TL;DR">
      <h2>TL;DR</h2>
      {[64, 52, 58].map((w) => (
        <span key={w} className="ib-wn-sk" style={{ width: `${w}%` }} />
      ))}
    </section>
  );
}

/** A row's words under its version: two TL;DR lines, or its fallback clamped to two lines. */
function RowWords({ row }: { row: WhatsNewRelease }) {
  const words = releaseWords(row);
  if (words.kind === 'tldr') {
    return (
      <ul className="ib-wn-rl">
        {words.lines.slice(0, 2).map((line, i) => (
          <li key={i}>
            <TldrText text={line.text} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className="ib-wn-rp" data-whats-new-words={words.kind}>
      {words.kind === 'none' ? 'No summary' : <TldrText text={words.text} />}
    </p>
  );
}

function VersionLine({ row, current }: { row: WhatsNewRelease; current: string }) {
  const mine = row.version === current;
  return (
    <>
      {mine && <Dot kind="yours" />}
      <span className="ib-wn-rv">
        {row.version}
        {mine && <small className="ib-wn-yours">You have this</small>}
      </span>
      <span className="ib-wn-rd">{shortDate(row.published_at) ?? ''}</span>
    </>
  );
}

export interface ReleasesListProps {
  releases: WhatsNewReleasesModel;
  /** The release the page shows (the row with the fill). */
  showing: string | null;
  /** A plain click on a row: the page switches to it (Cmd-click and the like open the link itself). */
  onOpen: (version: string) => void;
}

/** The Latest card and the earlier releases, shared by the panel and the sheet. */
function ReleasesList({ releases, showing, onOpen }: ReleasesListProps) {
  const [top, ...rest] = releases.releases;
  if (!top) return null;
  const click = (version: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(version);
  };
  const face = latestCardFace(showing, top.version);
  return (
    <>
      <div className="ib-wn-sub ib-wn-sub-first">
        <span>Latest</span>
      </div>
      <a
        href={`#whats-new=${top.version}`}
        className="ib-wn-rel ib-wn-card"
        aria-current={showing === top.version ? 'page' : undefined}
        data-whats-new-release={top.version}
        data-whats-new-latest={face}
        onClick={click(top.version)}
      >
        <VersionLine row={top} current={releases.current} />
        {face === 'full' && top.tldr.length > 0 ? (
          <ul className="ib-wn-cl">
            {top.tldr.map((line, i) => (
              <li key={i}>
                <Dot kind={tldrDot(line.label) ?? 'changed'} />
                <span>
                  <TldrText text={line.text} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <RowWords row={top} />
        )}
      </a>
      {rest.length > 0 && (
        <>
          <div className="ib-wn-sub">
            <span>Earlier releases</span>
            <span className="ib-wn-mono ib-wn-n">{formatCount(rest.length)}</span>
          </div>
          <ul className="ib-wn-rlist">
            {rest.map((row) => (
              <li key={row.version}>
                <a
                  href={`#whats-new=${row.version}`}
                  className="ib-wn-rel"
                  aria-current={showing === row.version ? 'page' : undefined}
                  data-whats-new-release={row.version}
                  onClick={click(row.version)}
                >
                  <VersionLine row={row} current={releases.current} />
                  <RowWords row={row} />
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      <a className="ib-wn-more" href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
        Older releases on GitHub
        <Icon name="external" />
      </a>
    </>
  );
}

/** Scroll a list so the row of `version` sits in its middle (the panel follows the page's release). */
function centerRow(scroller: HTMLElement | null, version: string | null) {
  if (!scroller || !version) return;
  const row = scroller.querySelector<HTMLElement>(`[data-whats-new-release="${CSS.escape(version)}"]`);
  if (!row) return;
  const top = row.offsetTop - scroller.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2;
  scroller.scrollTop = Math.max(0, top);
}

/** The panel beside the notes: an inspector column with its own scroll, its heading on the version's baseline. */
export function ReleasesPanel(props: ReleasesListProps & { scrollRef?: RefObject<HTMLDivElement | null> }) {
  const own = useRef<HTMLDivElement>(null);
  const scroller = props.scrollRef ?? own;
  useEffect(() => centerRow(scroller.current, props.showing), [props.showing, props.releases.releases.length]);
  return (
    <aside className="ib-wn-panel" aria-labelledby="ib-wn-rel-h" data-whats-new-panel="">
      <div className="ib-wn-phead">
        <h2 id="ib-wn-rel-h">Releases</h2>
        <span className="ib-wn-mono ib-wn-n">{formatCount(props.releases.releases.length)}</span>
      </div>
      <div className="ib-wn-pscroll" ref={scroller}>
        <ReleasesList {...props} />
      </div>
    </aside>
  );
}

/** The same list in a bottom sheet: the version picker in the bar opens it; a row, ×, Escape or the dimmed page close it. */
export function ReleasesSheet(props: ReleasesListProps & { onClose: () => void; focusVersion: string | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = scroller.current?.querySelector<HTMLElement>(`[data-whats-new-release="${CSS.escape(props.focusVersion ?? props.showing ?? '')}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <Modal labelledBy="ib-wn-sheet-h" onClose={props.onClose} testId="whats-new-releases" ownKeys className="ib-wn-sheet" initialFocus="[data-whats-new-sheet]">
      <div className="ib-wn-sheet-in" tabIndex={-1} data-whats-new-sheet="">
        <div className="ib-wn-grab" aria-hidden="true" />
        <div className="ib-wn-phead">
          <h2 id="ib-wn-sheet-h">Releases</h2>
          <button type="button" className="ib-wn-sheet-x" aria-label="Close" onClick={props.onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ib-wn-pscroll" ref={scroller}>
          <ReleasesList
            releases={props.releases}
            showing={props.showing}
            onOpen={(version) => {
              props.onClose();
              props.onOpen(version);
            }}
          />
        </div>
      </div>
    </Modal>
  );
}

/** The notes could not be had: why, with Try again (GitHub out of reach) and the release on GitHub. */
export function NotesMissing({
  version,
  unreachable,
  message,
  releaseUrl,
  onRetry,
  retrying,
}: {
  version: string;
  unreachable: boolean;
  message: string | null;
  releaseUrl: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  let body: ReactNode;
  if (unreachable) {
    body = (
      <>
        The notes for <span className="ib-wn-mono">{version}</span> aren&apos;t on this computer yet. They load the next time you open this release online.
      </>
    );
  } else body = message ?? 'These release notes are not saved on this computer.';
  return (
    <section className="ib-wn-off" role="status" data-whats-new-missing={unreachable ? 'unreachable' : 'not-found'}>
      <span className="ib-wn-tl">Not saved</span>
      <div>
        <h2>{unreachable ? "Can't reach GitHub" : 'Not on this computer'}</h2>
        <p>{body}</p>
        <div className="ib-wn-btns">
          {unreachable && onRetry && (
            <button type="button" className="ib-btn" onClick={onRetry} disabled={retrying} data-whats-new-retry="">
              <Icon name="refresh" />
              Try again
            </button>
          )}
          <a className="ib-btn" href={releaseUrl} target="_blank" rel="noopener noreferrer" data-whats-new-open-github="">
            Open on GitHub
            <Icon name="external" />
          </a>
        </div>
      </div>
    </section>
  );
}
