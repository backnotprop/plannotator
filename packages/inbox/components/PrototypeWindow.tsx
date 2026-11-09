/**
 * A question's prototypes in one full window (approval
 * "inbox-question-tradeoffs": the "Try prototype" tab, C1). Each option's
 * page, or the question's one shared page, is either:
 *
 * - an HTML file the message attached, at the version that was sent, in the
 *   file viewer's own HTML frame (its served document, under its own
 *   policy); comments are the file's, as in the file viewer;
 * - an app running on this computer, through the Inbox's live proxy and its
 *   same-origin wrapper page (`LiveSiteViewer`, the engine of #2258); on the
 *   owner's phone over the tailnet the wrapper frames the prototype relay
 *   instead (server side; nothing differs here); comments are `live`
 *   records, grouped by page in the export. A page that does not open (a
 *   guest login over the tailnet, say) is the server's words in one line.
 *
 * The window opens on Interact, with Annotate one click away. Its bottom row
 * (‹ option › Pick) is the window's own, under the page: never drawn over it
 * and never put into it. ‹ › step through the options that have a page only
 * (a shared page: every option), and the bar keeps one width, so the arrows
 * stay under the pointer. Pick picks that option on the card, which stays
 * unsent, and closes the window after a beat. A stopped app is one plain
 * line where its page would be; the bar still steps and picks.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { HtmlViewer, LiveSiteViewer } from '@plannotator/ui/components/html-viewer';
import type { Annotation } from '@plannotator/ui/types';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi, type AttachmentView, type LiveSiteWire } from '../api';
import { annotationOf } from '../attachments';
import { useInboxFileSource } from '../fileSource';
import { Icon } from '../icons';
import { LIVE_FRAME_SANDBOX, type PrototypePage } from '../prototypes';

/** The open window keeps an app's proxy alive (the server stops one after 10 idle minutes). */
const PING_MS = 60_000;
/** Pick shows "Picked" this long before the window closes. */
export const PICK_CLOSE_MS = 450;

/** One option of the question, as the window's bar names it. */
export interface PrototypeOption {
  label: string;
  /** "A", "B", …: its place among the question's choices. */
  letter: string;
  /** The label already starts with its letter ("B · Total first"): no letter chip. */
  lettered: boolean;
  recommended: boolean;
  /** Its page, or null: the option has none, and ‹ › skip it. */
  page: PrototypePage | null;
}

/** The options ‹ › go through: the ones with a page, in choice order. */
export function steppable(options: readonly PrototypeOption[]): number[] {
  return options.flatMap((option, i) => (option.page ? [i] : []));
}

/** Where the window opens: the recommended option's page, else the first page. */
export function openingOption(options: readonly PrototypeOption[]): number {
  const recommended = options.findIndex((o) => o.recommended && o.page);
  return recommended >= 0 ? recommended : (steppable(options)[0] ?? 0);
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function pageKey(page: PrototypePage): string {
  return page.kind === 'app' ? `app:${page.siteId}` : `file:${page.attachmentId}`;
}

export function PrototypeWindow(props: {
  threadId: string;
  options: readonly PrototypeOption[];
  /** The option (index into `options`) the window opens on. */
  start: number;
  /** Every option shows the question's one page. */
  shared: boolean;
  /** The labels picked on the card now. */
  picked: readonly string[];
  /** The card is sent or locked: no Pick, "Your answer" on the picked option. */
  readOnly: boolean;
  records: readonly InboxAnnotationRecord[];
  /** The thread's files (an HTML prototype is one of them). */
  attachments: readonly InboxAttachmentState[];
  onSaved: (record: InboxAnnotationRecord) => void;
  onPick: (label: string) => void;
  onClose: () => void;
}) {
  const { options } = props;
  const pages = useMemo(() => steppable(options), [options]);
  const [at, setAt] = useState(() => (pages.includes(props.start) ? props.start : (pages[0] ?? 0)));
  const option = options[at]!;
  const page = option.page;
  const [armed, setArmed] = useState(false);
  const [justPicked, setJustPicked] = useState(false);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (closing.current) clearTimeout(closing.current);
  }, []);

  // Esc closes the window (as the file viewer's full screen does) only from the window's own chrome: a key in the
  // page stays the page's, and a comment box's Esc closes that box (HtmlViewer's ladder).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const focused = document.activeElement;
      const chrome = !focused || focused === document.body || !!focused.closest?.('.ib-pw-bar, .ib-pw-foot, .ib-pw-line');
      if (chrome) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const place = pages.indexOf(at);
  const prev = place > 0 ? pages[place - 1] : undefined;
  const next = place >= 0 && place < pages.length - 1 ? pages[place + 1] : undefined;
  const isPicked = props.picked.includes(option.label);
  const pick = () => {
    if (props.readOnly || justPicked) return;
    props.onPick(option.label);
    setJustPicked(true);
    closing.current = setTimeout(() => closeRef.current(), PICK_CLOSE_MS);
  };
  const attachment = page?.kind === 'file' ? (props.attachments.find((a) => a.id === page.attachmentId) ?? null) : null;
  const name = !page ? option.label : page.kind === 'app' ? shortUrl(page.url) : page.name;

  const arrow = (dir: -1 | 1, to: number | undefined) => (
    <button
      type="button"
      className="ib-pw-step"
      aria-label={to !== undefined ? `${dir < 0 ? 'Previous' : 'Next'} option: ${options[to]!.label}` : `${dir < 0 ? 'Previous' : 'Next'} option: this is the ${dir < 0 ? 'first' : 'last'}`}
      aria-disabled={to === undefined ? true : undefined}
      onClick={() => {
        if (to === undefined) return;
        setAt(to);
        setJustPicked(false);
      }}
      data-prototype-step={dir < 0 ? 'prev' : 'next'}
    >
      <Icon name={dir < 0 ? 'chevL' : 'chevR'} size={18} />
    </button>
  );

  return (
    <div className="ib-pw" role="dialog" aria-modal="true" aria-label={`Prototype: ${option.label}`} data-prototype-window="" data-prototype-kind={page?.kind}>
      <header className="ib-pw-bar">
        <span className="ib-pw-name" title={page?.kind === 'app' ? page.url : undefined} data-prototype-url="">
          {name}
        </span>
        {!props.shared && pages.length > 1 && <span className="ib-pw-pill">{`Page ${place + 1} of ${pages.length}`}</span>}
        <span className="ib-pw-sp" />
        {page && (
          <div className="ib-seg" role="radiogroup" aria-label="Clicks on the page">
            <button type="button" role="radio" aria-checked={!armed} className="ib-seg-o" data-on={!armed ? '' : undefined} onClick={() => setArmed(false)} aria-label="Interact" data-prototype-interact="">
              <Icon name="frame" size={13} /> <span className="ib-pw-segt">Interact</span>
            </button>
            <button type="button" role="radio" aria-checked={armed} className="ib-seg-o" data-on={armed ? '' : undefined} onClick={() => setArmed(true)} aria-label="Annotate" data-prototype-annotate="">
              <Icon name="pen" size={13} /> <span className="ib-pw-segt">Annotate</span>
            </button>
          </div>
        )}
        <button type="button" className="ib-iconbtn" onClick={props.onClose} aria-label="Close the prototype" data-prototype-close="">
          <Icon name="x" size={16} />
        </button>
      </header>
      <div className="ib-pw-stage">
        {!page ? (
          <p className="ib-pw-line">This option has no prototype.</p>
        ) : page.kind === 'app' ? (
          <AppPage
            key={pageKey(page)}
            threadId={props.threadId}
            siteId={page.siteId}
            url={page.url}
            title={`Prototype ${option.label}`}
            armed={armed}
            setArmed={setArmed}
            records={props.records}
            onSaved={props.onSaved}
          />
        ) : attachment ? (
          <FilePage
            key={pageKey(page)}
            attachment={attachment}
            title={`Prototype ${option.label}`}
            armed={armed}
            setArmed={setArmed}
            records={props.records}
            onSaved={props.onSaved}
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
            <b className="ib-pw-label" title={option.label}>
              {option.label}
            </b>
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

/** A page's Annotate/Interact and its comments, as the window passes them. */
interface PageProps {
  title: string;
  armed: boolean;
  setArmed: (next: boolean | ((was: boolean) => boolean)) => void;
  records: readonly InboxAnnotationRecord[];
  onSaved: (record: InboxAnnotationRecord) => void;
}

/** An app running on this computer, through the live proxy. A stopped one is one plain line. */
function AppPage(props: PageProps & { threadId: string; siteId: string; url: string }) {
  const { threadId, siteId } = props;
  const [site, setSite] = useState<LiveSiteWire | null>(null);
  const [down, setDown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Open the site, asking the app first (`?probe=1`): a stopped app answers live_not_answering.
  useEffect(() => {
    let gone = false;
    setSite(null);
    setDown(false);
    setError(null);
    inboxApi
      .liveSite(threadId, siteId, true)
      .then((answer) => !gone && setSite(answer.site))
      .catch((cause) => {
        if (gone) return;
        if (cause instanceof InboxApiError && cause.code === 'live_not_answering') setDown(true);
        else setError(cause instanceof InboxApiError ? cause.message : 'The prototype did not open.');
      });
    const ping = setInterval(() => void inboxApi.pingLiveSite(threadId, siteId).catch(() => {}), PING_MS);
    return () => {
      gone = true;
      clearInterval(ping);
    };
  }, [threadId, siteId, attempt]);

  const annotations = useMemo(
    () =>
      props.records
        .filter((r) => r.live?.site_id === siteId)
        .map((r) => ({ ...annotationOf(r), ...(r.live?.page_url ? { pageUrl: r.live.page_url } : {}) }) as Annotation),
    [props.records, siteId],
  );
  const save = async (annotation: Annotation) => {
    try {
      const answer = await inboxApi.saveLiveAnnotation(threadId, siteId, annotation);
      props.onSaved(answer.annotation);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The comment was not saved.');
    }
  };

  if (down) {
    return (
      <p className="ib-pw-line" data-prototype-down="">
        Nothing answers at {shortUrl(props.url)} now. Start the app, then{' '}
        <button type="button" className="ib-pw-again" onClick={() => setAttempt((n) => n + 1)} data-prototype-retry="">
          try again
        </button>
        .
      </p>
    );
  }
  if (error) {
    return (
      <p className="ib-pw-line" role="alert">
        {error}
      </p>
    );
  }
  if (!site) return <p className="ib-pw-line">Opening…</p>;
  return (
    <LiveSiteViewer
      appUrl={site.frame_url}
      liveNested
      proxyOrigin={site.proxy_origin}
      token={site.token}
      title={props.title}
      annotations={annotations}
      onAddAnnotation={(a) => void save(a)}
      onSelectAnnotation={setSelected}
      selectedAnnotationId={selected}
      mode="selection"
      annotateModeActive={props.armed}
      onAnnotateModeExit={() => props.setArmed(false)}
      onAnnotateModeToggle={() => props.setArmed((v) => !v)}
      liveSandbox={LIVE_FRAME_SANDBOX}
      // The Inbox's upload takes no image (as the file viewer's HTML frame).
      allowCommentImages={false}
      hideControls
    />
  );
}

/** An HTML file the message attached, at the version that was sent, in the file viewer's own HTML frame. */
function FilePage(props: PageProps & { attachment: InboxAttachmentState }) {
  const { attachment } = props;
  const source = useInboxFileSource();
  const [view, setView] = useState<AttachmentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    setView(null);
    setError(null);
    source
      .view(attachment, 'sent')
      .then((next) => !gone && setView(next))
      .catch((cause) => !gone && setError(cause instanceof InboxApiError ? cause.message : 'The prototype did not open.'));
    return () => {
      gone = true;
    };
  }, [attachment, source]);

  const version = view?.version ?? attachment.sent_sha256;
  const annotations = useMemo(
    () => props.records.filter((r) => !r.live && !r.message && !r.guide && r.path === attachment.path && r.version === version).map(annotationOf),
    [props.records, attachment.path, version],
  );
  const save = async (annotation: Annotation) => {
    try {
      props.onSaved(await source.saveAnnotation(attachment, version, annotation));
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The comment was not saved.');
    }
  };

  if (error) {
    return (
      <p className="ib-pw-line" role="alert">
        {error}
      </p>
    );
  }
  if (!view || view.html === null) return <p className="ib-pw-line">Opening…</p>;
  return (
    <HtmlViewer
      rawHtml={view.html}
      // Its own document, served under its own policy (as the file viewer's HTML frame).
      frameUrl={source.pageFrameUrl}
      title={props.title}
      annotations={annotations}
      onAddAnnotation={(a) => void save(a)}
      onSelectAnnotation={setSelected}
      selectedAnnotationId={selected}
      mode="selection"
      inputMethod="pinpoint"
      annotateModeActive={props.armed}
      onAnnotateModeExit={() => props.setArmed(false)}
      onAnnotateModeToggle={() => props.setArmed((v) => !v)}
      allowCommentImages={false}
      fullViewport
      hideControls
    />
  );
}

/** "Try prototype": the tab that hangs from the right end of a question's options, opening the window. */
/** "Try prototypes" when the window steps between several options' pages; "Try prototype" for one page (shared or one option's). */
export function TryPrototypeTab({ onOpen, pages = 1 }: { onOpen: () => void; pages?: number }) {
  const foot = 'M11 0V10H0V9.5A10.5 9.5 0 0 0 10.5 0Z';
  return (
    <div className="ib-qtab-row">
      <button type="button" className="ib-qtab" onClick={onOpen} data-try-prototype="">
        <svg className="ib-qtab-foot l" viewBox="0 0 11 10" aria-hidden="true">
          <path d={foot} />
        </svg>
        <Icon name="play" size={13} />
        <span>{pages > 1 ? 'Try prototypes' : 'Try prototype'}</span>
        <svg className="ib-qtab-foot r" viewBox="0 0 11 10" aria-hidden="true">
          <path d={foot} />
        </svg>
      </button>
    </div>
  );
}

