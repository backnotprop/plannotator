/**
 * The pull request page's description line (approval "diff-controls-headers", take A, "Description line"): in the
 * strip under the header, the first line of what the author wrote, cut with "…", and More, which opens the whole
 * description under the strip (Less closes it). "No description" when they wrote nothing; nothing while it is read or
 * when the forge did not answer. Read through `GET /api/inbox/pulls/description` (gh / glab on this computer).
 * Comments and checks are not here.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InboxPull } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { ContextMarkdown } from '../components/ContextMarkdown';
import { Icon } from '../icons';
import { forgeName } from './labels';

type Read = { state: 'reading' } | { state: 'failed' } | { state: 'read'; body: string | null; cut: boolean };

/** Markdown down to words: no marks, links as their text, images and HTML gone, one line. */
function plain(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`+)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The description's first line: its first paragraph that is not a heading, a fence or a rule (PR templates open with
 * "## Summary"), else the first words at all. `more`: there is anything after it.
 */
export function descriptionLead(markdown: string): { lead: string; more: boolean } {
  const blocks = markdown.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const words = blocks.map((block) => ({ block, text: plain(block) })).filter((b) => b.text);
  const skip = (block: string) => /^\s{0,3}(#{1,6}\s|```|~~~|(?:[-*_]\s*){3,}$)/.test(block);
  const at = words.findIndex((b) => !skip(b.block));
  const pick = at >= 0 ? at : 0;
  const first = words[pick];
  if (!first) return { lead: '', more: false };
  return { lead: first.text, more: words.length > 1 || first.block.includes('\n') };
}

export function PullDescription({ pull }: { pull: InboxPull }) {
  const [read, setRead] = useState<Read>({ state: 'reading' });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setRead({ state: 'reading' });
    inboxApi
      .pullDescription(pull.key, abort.signal)
      .then((answer) => setRead({ state: 'read', body: answer.body, cut: answer.cut === true }))
      .catch(() => {
        if (!abort.signal.aborted) setRead({ state: 'failed' });
      });
    return () => abort.abort();
  }, [pull.key, pull.updated_at]);

  const body = read.state === 'read' ? read.body : null;
  const { lead, more } = body ? descriptionLead(body) : { lead: '', more: false };
  // A single line cut by the strip's width also opens.
  const leadRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = leadRef.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    check();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    watch?.observe(el);
    return () => watch?.disconnect();
  }, [lead, open]);

  if (read.state !== 'read') return <div className="ib-prr-desc" data-pull-description={read.state} />;
  if (!body) {
    return (
      <div className="ib-prr-desc" data-pull-description="none">
        <span className="ib-prr-desc-lead ib-prr-desc-none">No description</span>
      </div>
    );
  }
  const opens = more || overflows || read.cut || open;
  return (
    <>
      <div className="ib-prr-desc" data-pull-description={open ? 'open' : 'line'}>
        {open ? (
          <b className="ib-prr-desc-name">Description</b>
        ) : (
          <span ref={leadRef} className="ib-prr-desc-lead" dir="auto" title={lead}>
            {lead}
          </span>
        )}
        {opens && (
          <button type="button" className="ib-prr-desc-more" aria-expanded={open} aria-controls={`ib-prr-desc-${pull.number}`} onClick={() => setOpen((was) => !was)} data-pull-description-toggle="">
            {open ? 'Less' : 'More'}
            <Icon name={open ? 'chevU' : 'chevD'} size={13} />
          </button>
        )}
      </div>
      {open && (
        <div className="ib-prr-desc-panel" id={`ib-prr-desc-${pull.number}`} data-pull-description-panel="">
          <ContextMarkdown className="ib-body ib-prr-desc-md" markdown={body} refRepo={{ display: pull.repo, host: pull.host }} />
          {read.cut && (
            <p className="ib-prr-desc-cut">
              The rest is on {forgeName(pull)}:{' '}
              <a href={pull.url} target="_blank" rel="noreferrer noopener">
                read it there
              </a>
            </p>
          )}
        </div>
      )}
    </>
  );
}
