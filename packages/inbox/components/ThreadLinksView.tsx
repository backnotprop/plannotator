/**
 * The Links side of a thread's Artifacts view: every web link its messages
 * draw (threadLinks.ts), once each. Forge links by repository; a PR or an
 * issue shows its state in its icon, read through the hover card's own route
 * and cache, for the rows on screen only (neutral until it answers, or if it
 * cannot). Every other link after them, with its site's name. A link opens as
 * it does in a message, and a PR or an issue shows the same hover card.
 */

import { forwardRef, useEffect, useRef, useState } from 'react';
import { GitHubIcon } from '@plannotator/ui/components/GitHubIcon';
import { GitLabIcon } from '@plannotator/ui/components/GitLabIcon';
import { useRefHoverCards } from '@plannotator/ui/components/RefHoverCard';
import { loadRefCard, refCardTarget } from '@plannotator/ui/utils/refCard';
import type { ForgePlatform } from '@plannotator/core/forge-refs';
import type { ForgeRefCardData } from '@plannotator/core/forge-ref-card';
import { markStateWords, RefMarkIcon } from '../board/RefMark';
import type { ForgeLinkKind, RepoGroup, ThreadLink, ThreadLinks } from '../threadLinks';
import { Icon } from '../icons';
import { Tip } from './Tip';

/** Octicons (MIT), on the 16 grid the marks are drawn on. A PR's and an issue's are the Board's RefMarkIcon. */
const GLYPHS: Record<Exclude<ForgeLinkKind, 'pull' | 'issue'> | 'site', string> = {
  file: 'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z',
  commit: 'M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z',
  page: 'm7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z',
  site: 'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM5.78 8.75a9.64 9.64 0 0 0 1.363 4.177c.255.426.542.832.857 1.215.245-.296.551-.705.857-1.215A9.64 9.64 0 0 0 10.22 8.75Zm4.44-1.5a9.64 9.64 0 0 0-1.363-4.177c-.307-.51-.612-.919-.857-1.215a9.927 9.927 0 0 0-.857 1.215A9.64 9.64 0 0 0 5.78 7.25Zm-5.944 1.5H1.543a6.507 6.507 0 0 0 4.666 5.5c-.123-.181-.24-.365-.352-.552-.715-1.192-1.437-2.874-1.581-4.948Zm-2.733-1.5h2.733c.144-2.074.866-3.756 1.58-4.948.12-.197.237-.381.353-.552a6.507 6.507 0 0 0-4.666 5.5Zm10.181 1.5c-.144 2.074-.866 3.756-1.58 4.948-.12.197-.237.381-.353.552a6.507 6.507 0 0 0 4.666-5.5Zm2.733-1.5a6.507 6.507 0 0 0-4.666-5.5c.123.181.24.365.353.552.714 1.192 1.436 2.874 1.58 4.948Z',
};

function Glyph({ name }: { name: keyof typeof GLYPHS }) {
  return (
    <svg className="ib-tl-ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path fillRule="evenodd" d={GLYPHS[name]} />
    </svg>
  );
}

function ForgeMark({ platform }: { platform: ForgePlatform }) {
  return platform === 'github' ? <GitHubIcon className="ib-tl-ic" /> : <GitLabIcon className="ib-tl-ic" />;
}

/** A row's PR or issue, read once the row is on screen. Null until it answers, and when it cannot. */
function useForgeItem(href: string, wanted: boolean): [React.RefObject<HTMLLIElement | null>, ForgeRefCardData | null] {
  const row = useRef<HTMLLIElement>(null);
  const [item, setItem] = useState<ForgeRefCardData | null>(null);
  useEffect(() => {
    const el = row.current;
    const target = wanted ? refCardTarget(href) : null;
    if (!el || !target || typeof IntersectionObserver === 'undefined') return;
    let gone = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void loadRefCard(href, target).then((answer) => {
        if (!gone && answer?.ok) setItem(answer.data);
      });
    });
    observer.observe(el);
    return () => {
      gone = true;
      observer.disconnect();
    };
  }, [href, wanted]);
  return [row, item];
}

function Row({ link }: { link: ThreadLink }) {
  const isRef = link.kind === 'pull' || link.kind === 'issue';
  const [row, item] = useForgeItem(link.href, isRef);
  // GitHub's answer knows what it is: `/issues/12` may be a PR, and `#12` says nothing.
  const refKind = item ? (item.kind === 'pull' ? 'pr' : 'issue') : link.kind === 'pull' ? 'pr' : 'issue';
  const state = item?.state ?? 'unknown';
  const stateWords = isRef ? markStateWords(refKind, state) : null;
  // A bare `#1290` takes the forge's title; words the message wrote for it stay.
  const filled = isRef && !link.lead && item?.title ? { lead: link.text, text: item.title } : { lead: link.lead, text: link.text };
  const icon = link.kind === 'pull' || link.kind === 'issue' ? (
    <RefMarkIcon kind={refKind} state={state} size={16} />
  ) : link.kind ? (
    <Glyph name={link.kind} />
  ) : link.platform ? (
    <ForgeMark platform={link.platform} />
  ) : (
    <Glyph name="site" />
  );
  const text = (
    <span className="ib-tl-text" dir="auto">
      {filled.text}
    </span>
  );
  return (
    <li ref={row} className="ib-tl-row">
      <a className="ib-tl-a" href={link.href} target="_blank" rel="noopener noreferrer" data-thread-link="" data-link-kind={link.kind ?? undefined}>
        {icon}
        {filled.lead && <span className="ib-tl-lead">{filled.lead}</span>}
        {/* A PR or an issue has its hover card. A file names its path on hover; anything else its address, only when cut. */}
        {isRef ? (
          text
        ) : link.path ? (
          <Tip content={link.path}>{text}</Tip>
        ) : (
          <Tip content={link.href} cut>
            {text}
          </Tip>
        )}
        {stateWords && <span className="ib-sr">, {stateWords}</span>}
        {link.tail && (
          <bdi className="ib-tl-tail" dir="auto">
            {link.tail}
          </bdi>
        )}
      </a>
    </li>
  );
}

function Repo({ group }: { group: RepoGroup }) {
  const publicForge = group.host === 'github.com' || group.host === 'gitlab.com';
  return (
    <section className="ib-tl-repo" data-link-repo={group.path}>
      <h3 className="ib-tl-rh">
        <a className="ib-tl-a" href={group.href} target="_blank" rel="noopener noreferrer">
          <ForgeMark platform={group.platform} />
          <span className="ib-tl-text ib-tl-name">{group.path}</span>
          {!publicForge && <span className="ib-tl-tail">{group.host}</span>}
        </a>
      </h3>
      {group.links.length > 0 && (
        <ul className="ib-tl-rows">
          {group.links.map((link) => (
            <Row key={link.href} link={link} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The view's header: its two sides in the app's segmented control, buttons
 * like the file view's (fileView.ts), so Escape and the app's keys still work
 * from one. A thread with only one of them has nothing to switch: that side's
 * name.
 */
export function ThreadViewSwitch({ links, artifacts, linksOn, onLinks }: { links: number; artifacts: number; linksOn: boolean; onLinks: (on: boolean) => void }) {
  if (links === 0 || artifacts === 0) {
    const count = links || artifacts;
    return (
      <span className="ib-artswitch-one" aria-hidden="true" data-artifacts-switch-one="">
        {links > 0 ? 'Links' : 'Artifacts'}
        {count > 0 && <span className="ib-artswitch-n">{count}</span>}
      </span>
    );
  }
  const sides = [
    { on: false, name: 'Artifacts', count: artifacts },
    { on: true, name: 'Links', count: links },
  ];
  return (
    <div className="ib-seg ib-viewseg ib-artswitch" role="group" aria-label="Show" data-artifacts-switch="">
      {sides.map((side) => (
        <button key={side.name} type="button" className="ib-seg-o" aria-pressed={side.on === linksOn} data-on={side.on === linksOn ? '' : undefined} onClick={() => onLinks(side.on)} data-artifacts-side={side.name}>
          {side.name}
          <span className="ib-artswitch-n">{side.count}</span>
        </button>
      ))}
    </div>
  );
}

/** The row under the thread's bar (a phone's bar holds the switch itself): the way back, then the switch. */
export function ArtifactsBar({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="ib-artbar" data-artifacts-bar="">
      <Tip content="Back to the thread">
        <button type="button" className="ib-iconbtn ib-artbar-back" aria-label="Back to the thread" onClick={onBack} data-artifacts-back="">
          <Icon name="chevL" size={15} />
        </button>
      </Tip>
      {children}
    </div>
  );
}

/** The list. The heading is for a screen reader and for focus: the switch is what the eye reads. */
export const ThreadLinksView = forwardRef<HTMLHeadingElement, { links: ThreadLinks }>(function ThreadLinksView({ links }, headingRef) {
  const region = useRef<HTMLElement>(null);
  const refCard = useRefHoverCards(region);
  return (
    <section ref={region} className="ib-art" aria-labelledby="ib-tl-h" data-links-view="">
      <h2 id="ib-tl-h" ref={headingRef} className="ib-sr" tabIndex={-1}>
        Links
      </h2>
      {links.repos.map((group) => (
        <Repo key={`${group.host}/${group.path}`} group={group} />
      ))}
      {links.others.length > 0 && (
        <ul className="ib-tl-rows ib-tl-others">
          {links.others.map((link) => (
            <Row key={link.href} link={link} />
          ))}
        </ul>
      )}
      {refCard}
    </section>
  );
});
