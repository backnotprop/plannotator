/**
 * SPIKE (spike/option-live-prototype): a question's prototypes in one full
 * window (the approved question mock, v8 "C1"), for options whose prototype is
 * a running app on this computer (`Prototype: http://localhost:3000/…`).
 *
 * - The app is #2258's live site: framed through the Inbox's wrapper page and
 *   its loopback proxy (`LiveSiteViewer`), so pins and selections become
 *   `live` comments that ride the next Send, grouped by page.
 * - The bottom bar (‹ option › Pick) is this window's own row under the
 *   frame: never drawn over the app, never put into the app's page.
 * - ‹ › step through the options that have a prototype only; Pick picks that
 *   option on the card and closes the window. A sent card shows "Your answer".
 * - An app that does not answer now: one plain line where the app would be;
 *   the bar still steps and picks.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { LiveSiteViewer } from '@plannotator/ui/components/html-viewer';
import type { Annotation } from '@plannotator/ui/types';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi, type LiveSiteWire } from '../api';
import { annotationOf } from '../attachments';
import { Icon } from '../icons';
import { LIVE_FRAME_SANDBOX, pageHref } from './LiveSitePane';

/** The open window keeps its proxy alive (the server stops one after 10 idle minutes). */
const PING_MS = 60_000;

/** One option of the question, as the window's bar names it. */
export interface PrototypeOption {
  label: string;
  /** "A", "B", …: its place among the question's choices. */
  letter: string;
  /** The label already starts with its letter ("B · Total first"): no letter chip. */
  lettered: boolean;
  recommended: boolean;
  /** The live site its prototype is (the message's `live_sites`), or null: no running-app prototype. */
  siteId: string | null;
  /** The prototype's address as checked at send, or null. */
  url: string | null;
}

/** A choice's `Prototype:` target, matched to the message's checked live sites (null: not one of them). */
export function prototypeSiteOf(target: string | undefined, sites: readonly { id: string; url: string }[] | undefined): { id: string; url: string } | null {
  if (!target || !sites || sites.length === 0) return null;
  try {
    const url = new URL(target.trim());
    url.hash = '';
    return sites.find((site) => site.url === url.href) ?? null;
  } catch {
    return null;
  }
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function PrototypeWindow(props: {
  threadId: string;
  options: readonly PrototypeOption[];
  /** The option (index into `options`) the window opens on. */
  start: number;
  /** The labels picked on the card now. */
  picked: readonly string[];
  /** The card is sent or locked: no Pick, "Your answer" on the picked option. */
  readOnly: boolean;
  records: readonly InboxAnnotationRecord[];
  /** Through the tailnet: the app is not shown, only where to open it. */
  remote: boolean;
  onSaved: (record: InboxAnnotationRecord) => void;
  onPick: (label: string) => void;
  onClose: () => void;
}) {
  const { threadId, options } = props;
  const pages = useMemo(() => options.flatMap((o, i) => (o.siteId ? [i] : [])), [options]);
  const [at, setAt] = useState(() => (pages.includes(props.start) ? props.start : pages[0] ?? 0));
  const option = options[at]!;
  const siteId = option.siteId;
  const [site, setSite] = useState<LiveSiteWire | null>(null);
  const [down, setDown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [justPicked, setJustPicked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;

  // Open the option's site, asking the app first: a stopped app is one plain line, not the proxy's error page.
  useEffect(() => {
    if (!siteId || props.remote) return;
    let gone = false;
    setSite(null);
    setDown(null);
    setError(null);
    setPage(null);
    inboxApi
      .liveSite(threadId, siteId, true)
      .then((answer) => !gone && setSite(answer.site))
      .catch((cause) => {
        if (gone) return;
        if (cause instanceof InboxApiError && cause.code === 'live_not_answering') setDown(option.url ?? '');
        else setError(cause instanceof InboxApiError ? cause.message : 'The prototype did not open.');
      });
    const ping = setInterval(() => void inboxApi.pingLiveSite(threadId, siteId).catch(() => {}), PING_MS);
    return () => {
      gone = true;
      clearInterval(ping);
    };
  }, [threadId, siteId, props.remote, attempt, option.url]);

  // Esc closes the window (as the file viewer's full screen does) only from the window's own chrome: a key in the
  // app's frame stays the app's, and a comment box's Esc closes that box (HtmlViewer's ladder).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const at = document.activeElement;
      const chrome = !at || at === document.body || !!at.closest?.('.ib-pw-bar, .ib-pw-foot, .ib-pw-line');
      if (chrome) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const mine = useMemo(() => props.records.filter((r) => siteId !== null && r.live?.site_id === siteId), [props.records, siteId]);
  const annotations = useMemo(
    () => mine.map((r) => ({ ...annotationOf(r), ...(r.live?.page_url ? { pageUrl: r.live.page_url } : {}) }) as Annotation),
    [mine],
  );
  const save = async (annotation: Annotation) => {
    if (!siteId) return;
    try {
      const answer = await inboxApi.saveLiveAnnotation(threadId, siteId, annotation);
      props.onSaved(answer.annotation);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The comment was not saved.');
    }
  };

  const place = pages.indexOf(at);
  const prev = place > 0 ? pages[place - 1] : undefined;
  const next = place >= 0 && place < pages.length - 1 ? pages[place + 1] : undefined;
  const step = (to: number | undefined) => {
    if (to === undefined) return;
    setAt(to);
    setSelected(null);
  };
  const isPicked = props.picked.includes(option.label);
  const pick = () => {
    if (props.readOnly || justPicked) return;
    props.onPick(option.label);
    setJustPicked(true);
    setTimeout(() => closeRef.current(), 450);
  };
  const target = site ? pageHref(site.url, page) : null;
  const shown = option.url ? shortUrl(option.url) : option.label;

  const arrow = (dir: -1 | 1, to: number | undefined) => (
    <button
      type="button"
      className="ib-pw-step"
      aria-label={to !== undefined ? `${dir < 0 ? 'Previous' : 'Next'} option: ${options[to]!.label}` : `${dir < 0 ? 'Previous' : 'Next'} option: this is the ${dir < 0 ? 'first' : 'last'}`}
      aria-disabled={to === undefined ? true : undefined}
      onClick={() => step(to)}
      data-prototype-step={dir < 0 ? 'prev' : 'next'}
    >
      <Icon name={dir < 0 ? 'chevL' : 'chevR'} size={18} />
    </button>
  );

  return (
    <div className="ib-pw" role="dialog" aria-modal="true" aria-label={`Prototype: ${option.label}`} data-prototype-window="">
      <header className="ib-pw-bar">
        <span className="ib-pw-name" title={option.url ?? undefined} data-prototype-url="">
          {shown}
        </span>
        <span className="ib-pw-pill">{`Page ${place + 1} of ${pages.length}`}</span>
        <span className="ib-pw-sp" />
        {site && !props.remote && (
          <div className="ib-seg" role="radiogroup" aria-label="Clicks on the page">
            <button type="button" role="radio" aria-checked={!armed} className="ib-seg-o" data-on={!armed ? '' : undefined} onClick={() => setArmed(false)} aria-label="Interact" data-prototype-interact="">
              <Icon name="frame" size={13} /> <span className="ib-pw-segt">Interact</span>
            </button>
            <button type="button" role="radio" aria-checked={armed} className="ib-seg-o" data-on={armed ? '' : undefined} onClick={() => setArmed(true)} aria-label="Annotate" data-prototype-annotate="">
              <Icon name="pen" size={13} /> <span className="ib-pw-segt">Annotate</span>
            </button>
          </div>
        )}
        {target && (
          <a className="ib-iconbtn" href={target} target="_blank" rel="noopener noreferrer" aria-label="Open in browser">
            <Icon name="external" size={15} />
          </a>
        )}
        <button type="button" className="ib-iconbtn" onClick={props.onClose} aria-label="Close the prototype" data-prototype-close="">
          <Icon name="x" size={16} />
        </button>
      </header>
      <div className="ib-pw-stage">
        {props.remote ? (
          <p className="ib-pw-line" data-prototype-away="">
            This prototype runs on your computer. Open it there.
          </p>
        ) : down !== null ? (
          <p className="ib-pw-line" data-prototype-down="">
            Nothing answers at {shortUrl(down)} now. Start the app, then{' '}
            <button type="button" className="ib-pw-again" onClick={() => setAttempt((n) => n + 1)} data-prototype-retry="">
              try again
            </button>
            .
          </p>
        ) : error ? (
          <p className="ib-pw-line" role="alert">
            {error}
          </p>
        ) : site ? (
          <LiveSiteViewer
            key={site.id}
            appUrl={site.frame_url}
            liveNested
            proxyOrigin={site.proxy_origin}
            token={site.token}
            title={`Prototype ${option.label}`}
            annotations={annotations}
            onAddAnnotation={(a) => void save(a)}
            onSelectAnnotation={setSelected}
            selectedAnnotationId={selected}
            mode="selection"
            annotateModeActive={armed}
            onAnnotateModeExit={() => setArmed(false)}
            onAnnotateModeToggle={() => setArmed((v) => !v)}
            onPageChange={setPage}
            liveSandbox={LIVE_FRAME_SANDBOX}
            // The Inbox's upload takes no image (as AttachmentPane's HTML viewer).
            allowCommentImages={false}
            hideControls
          />
        ) : (
          <p className="ib-pw-line">Opening…</p>
        )}
      </div>
      <footer className="ib-pw-foot">
        <div className="ib-pw-cap" data-prototype-caption={option.letter}>
          {arrow(-1, prev)}
          {!option.lettered && (
            <span className="ib-pw-letter" aria-hidden="true">
              {option.letter}
            </span>
          )}
          <span className="ib-pw-mid">
            <b className="ib-pw-label">{option.label}</b>
            {option.recommended && <span className="ib-pw-rec">Recommended</span>}
          </span>
          {arrow(1, next)}
          {props.readOnly ? (
            isPicked && (
              <span className="ib-pw-rec ib-pw-sent">
                <Icon name="check" size={14} /> Your answer
              </span>
            )
          ) : (
            <button
              type="button"
              className="ib-pw-pick"
              aria-pressed={isPicked || justPicked}
              aria-label={`${isPicked || justPicked ? 'Picked' : 'Pick'} ${option.label}`}
              onClick={pick}
              data-prototype-pick=""
            >
              {isPicked || justPicked ? (
                <>
                  <Icon name="check" size={14} /> Picked
                </>
              ) : (
                'Pick'
              )}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

/** "Try prototype": the tab that hangs from a question's options, opening the window. */
export function TryPrototypeTab({ onOpen }: { onOpen: () => void }) {
  const foot = 'M11 0V10H0V9.5A10.5 9.5 0 0 0 10.5 0Z';
  return (
    <div className="ib-qtab-row">
      <button type="button" className="ib-qtab" onClick={onOpen} data-try-prototype="">
        <svg className="ib-qtab-foot l" viewBox="0 0 11 10" aria-hidden="true">
          <path d={foot} />
        </svg>
        <Icon name="play" size={13} />
        <span>Try prototype</span>
        <svg className="ib-qtab-foot r" viewBox="0 0 11 10" aria-hidden="true">
          <path d={foot} />
        </svg>
      </button>
    </div>
  );
}
