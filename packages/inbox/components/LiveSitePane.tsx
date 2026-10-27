/**
 * PROVISIONAL UI for live sites (running local sites shown in a thread).
 *
 * Only the wiring needed to use and test the feature end to end. The
 * approved design (a row in the thread's Files under "Running on this
 * computer", plus a tile in the message; /tmp/inbox-files-converge) replaces
 * the chrome here: keep this file thin and isolated, and keep its
 * `data-live-*` hooks, which the e2e drives.
 *
 * The site itself is ui's `LiveSiteViewer` (HtmlViewer's live mode with page
 * tracking): pins and selections become Inbox annotation records with a
 * `live` target (`POST /api/inbox/threads/:id/live/:site/annotations`) that
 * ride the next Send. A page opened through the tailnet, and a phone, get
 * "Open this on your computer" instead: the proxy relays the person's
 * signed-in app and answers only this computer's own window.
 */

import { useEffect, useMemo, useState } from 'react';
import { LiveSiteViewer } from '@plannotator/ui/components/html-viewer';
import type { Annotation } from '@plannotator/ui/types';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi, type LiveSiteRefWire, type LiveSiteWire } from '../api';
import { annotationOf } from '../attachments';
import { Icon } from '../icons';

/** The open pane keeps its proxy alive (the server stops one after 10 idle minutes). */
const PING_MS = 60_000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function LiveSitePane(props: {
  threadId: string;
  siteId: string;
  /** The site's address when the thread knows it (an agent's tile): shown even where it cannot open. */
  url?: string;
  records: readonly InboxAnnotationRecord[];
  agent: string;
  /** Through the tailnet, or a phone: no live site, only where to open it. */
  remote: boolean;
  phone: boolean;
  onSaved: (record: InboxAnnotationRecord) => void;
  onClose: () => void;
  onWriteReply: () => void;
}) {
  const { threadId, siteId } = props;
  const [site, setSite] = useState<LiveSiteWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [armed, setArmed] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const away = props.remote || props.phone;

  useEffect(() => {
    if (away) return;
    let gone = false;
    setSite(null);
    setError(null);
    inboxApi
      .liveSite(threadId, siteId)
      .then((answer) => !gone && setSite(answer.site))
      .catch((cause) => !gone && setError(cause instanceof InboxApiError ? cause.message : 'The site did not open.'));
    const ping = setInterval(() => void inboxApi.pingLiveSite(threadId, siteId).catch(() => {}), PING_MS);
    return () => {
      gone = true;
      clearInterval(ping);
    };
  }, [threadId, siteId, away]);

  const mine = useMemo(() => props.records.filter((r) => r.live?.site_id === siteId), [props.records, siteId]);
  const annotations = useMemo(
    () => mine.map((r) => ({ ...annotationOf(r), ...(r.live?.page_url ? { pageUrl: r.live.page_url } : {}) }) as Annotation),
    [mine],
  );
  const save = async (annotation: Annotation) => {
    try {
      const answer = await inboxApi.saveLiveAnnotation(threadId, siteId, annotation);
      props.onSaved(answer.annotation);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The comment was not saved.');
    }
  };
  const pages = new Set(mine.map((r) => r.live?.page_url ?? '/')).size;
  const shownUrl = site?.url ?? props.url ?? null;
  const target = site ? new URL(page ?? '/', site.url).href : null;

  return (
    <section className="ib-live" aria-label={`Live site ${shownUrl ? hostOf(shownUrl) : ''}`} data-live-pane="">
      <header className="ib-live-head">
        <span className="ib-live-badge" aria-hidden="true">
          <span className="ib-live-dot" /> Live
        </span>
        <span className="ib-live-host" data-live-url-shown="">{shownUrl ?? (away ? 'Local site' : 'Opening…')}</span>
        <span className="ib-live-route" data-live-route="" title={page ?? undefined}>
          {page ?? '/'}
        </span>
        <span className="ib-live-sp" />
        {!away && (
          <div className="ib-seg" role="radiogroup" aria-label="Clicks on the page">
            <button type="button" role="radio" aria-checked={armed} className="ib-seg-o" data-on={armed ? '' : undefined} onClick={() => setArmed(true)} data-live-annotate="">
              <Icon name="pen" size={13} /> Annotate
            </button>
            <button type="button" role="radio" aria-checked={!armed} className="ib-seg-o" data-on={!armed ? '' : undefined} onClick={() => setArmed(false)} data-live-interact="">
              <Icon name="frame" size={13} /> Interact
            </button>
          </div>
        )}
        {target && (
          <a className="ib-iconbtn" href={target} target="_blank" rel="noopener noreferrer" aria-label="Open in browser">
            <Icon name="external" size={15} />
          </a>
        )}
        <button type="button" className="ib-iconbtn" onClick={props.onClose} aria-label="Close the site" data-live-close="">
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="ib-live-body">
        {away ? (
          <div className="ib-live-away" data-live-away="">
            <Icon name="lock" size={22} />
            <h3>Open this on your computer</h3>
            <p>
              The site runs on your computer, and only your computer's own Inbox window may show it, since it carries your signed-in session of the app.
              {mine.length > 0 && ` ${mine.length} comment${mine.length === 1 ? '' : 's'} made there will ride your next Send.`}
            </p>
          </div>
        ) : error ? (
          <p className="ib-live-err" role="alert">
            {error}
          </p>
        ) : site ? (
          <LiveSiteViewer
            appUrl={site.app_url}
            proxyOrigin={site.proxy_origin}
            token={site.token}
            title={`Live site ${hostOf(site.url)}`}
            annotations={annotations}
            onAddAnnotation={(a) => void save(a)}
            onSelectAnnotation={setSelected}
            selectedAnnotationId={selected}
            mode="selection"
            annotateModeActive={armed}
            onAnnotateModeExit={() => setArmed(false)}
            onAnnotateModeToggle={() => setArmed((v) => !v)}
            onPageChange={setPage}
            hideControls
          />
        ) : (
          <p className="ib-live-wait">Opening the site…</p>
        )}
      </div>
      <footer className="ib-live-foot">
        <span data-live-count="">
          {mine.length === 0
            ? armed
              ? 'Click an element to comment. Interact to use the app.'
              : 'Interact: clicks reach the app. Annotate to comment.'
            : `${mine.length} comment${mine.length === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'} ride your next Send to ${props.agent}.`}
        </span>
        <button type="button" className="ib-btn ib-primary" onClick={props.onWriteReply} data-live-reply="">
          Write the reply
        </button>
      </footer>
    </section>
  );
}

/** A live site an agent attached, as a tile in its message: the full URL, and it opens only on a click. */
export function LiveSiteTile({ url, onOpen, open }: { url: string; onOpen: () => void; open: boolean }) {
  return (
    <button type="button" className="ib-live-tile" onClick={onOpen} aria-current={open || undefined} data-live-tile="">
      <span className="ib-live-tile-ic" aria-hidden="true">
        <Icon name="frame" size={18} />
      </span>
      <span className="ib-live-tile-t">
        <span className="ib-live-tile-n" title={url} data-live-tile-url="">
          {url}
        </span>
        <span className="ib-live-tile-m">
          <span className="ib-live-dot" aria-hidden="true" /> Running on your computer · open live, click to comment
        </span>
      </span>
      <span className="ib-live-tile-o">{open ? 'Open beside' : 'Open live'}</span>
    </button>
  );
}

/**
 * "Open a local site": a URL field in a small popover in the thread's header,
 * and the sites the person opened in this thread before (the server's list),
 * so one opened yesterday opens again after a restart.
 */
export function OpenLocalSite({ threadId, onOpen, onOpenSite }: { threadId: string; onOpen: (url: string) => Promise<string | null>; onOpenSite: (siteId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('http://localhost:');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<LiveSiteRefWire[]>([]);
  useEffect(() => {
    if (!open) return;
    let gone = false;
    inboxApi
      .liveSites(threadId)
      .then((answer) => !gone && setOpened(answer.sites.filter((s) => s.opened_by === 'person')))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [open, threadId]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const refused = await onOpen(url);
    setBusy(false);
    if (refused) setError(refused);
    else setOpen(false);
  };
  return (
    <span className="ib-live-open">
      <button type="button" className="ib-iconbtn" aria-label="Open a local site" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-open-local-site="">
        <Icon name="frame" size={16} />
      </button>
      {open && (
        <form
          className="ib-live-pop"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <label htmlFor="ib-live-url">Open a local site in this thread</label>
          <input id="ib-live-url" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} data-live-url="" />
          <p>A dev server on this computer (localhost, 127.x). Comments you pin there ride your next Send, with the page and element.</p>
          {error && (
            <p className="ib-live-poperr" role="alert">
              {error}
            </p>
          )}
          {opened.length > 0 && (
            <ul className="ib-live-opened">
              {opened.map((site) => (
                <li key={site.id}>
                  <button
                    type="button"
                    className="ib-btn ib-ghost ib-sm"
                    onClick={() => {
                      setOpen(false);
                      onOpenSite(site.id);
                    }}
                    data-live-opened={site.id}
                  >
                    {site.url}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="ib-live-pop-row">
            <button type="button" className="ib-btn ib-ghost ib-sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="ib-btn ib-pri ib-sm" disabled={busy} data-live-open="">
              {busy ? 'Opening…' : 'Open'}
            </button>
          </div>
        </form>
      )}
    </span>
  );
}
