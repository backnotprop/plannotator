/**
 * The guided review on a phone (the surface's 6.1 and 6.2): the guide's
 * title, intent and counts with its sections as a list, each with its
 * reviewed tick, and Continue; then one section per screen, drawn by
 * Plannotator's own `GuideSectionCard` over the read-only diff renderer the
 * Inbox window uses (unified and wrapped: the surface sets those settings),
 * with Previous, Reviewed and Next at the thumb.
 *
 * Mounted only through SurfaceGuide's dynamic import (`#surface-guide-reader`,
 * tests/entry-assets.test.ts). Its own classes are `sf-` rules in
 * surface.css; nothing is added to the guide chain, so the guides.show viewer
 * and its pinned manifest are unchanged.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GuideSection } from '@plannotator/core/guide';
import { GuideHostProvider, GuideSectionCard, GuideViewportProvider, renderInlineMarkdown, resolveGuideSectionFiles, type DiffFile } from '@plannotator/guide-viewer';
import { parseDiffToFiles } from '@plannotator/guide-viewer/diffParser';
import { ReadOnlyDiff } from './GuideReader';
import type { SurfaceGuideReaderProps } from './types';
import type ReaderShape from './surface-reader-module';

// A phone's diff header: the review app's compact touch layout (the whole path, 44 pt targets).
const phoneRendererProps = () => ({ compactTouchLayout: true });
const two = (n: number) => String(n + 1).padStart(2, '0');

interface Page {
  section: GuideSection;
  files: DiffFile[];
  /** The "Everything else" page carries no tick. */
  reviewable: boolean;
}

function Counts({ files }: { files: readonly DiffFile[] }) {
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <>
      {additions > 0 && <span className="sf-add">+{additions}</span>}
      {additions > 0 && deletions > 0 && ' '}
      {deletions > 0 && <span className="sf-del">−{deletions}</span>}
    </>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <span className={`sf-tick${on ? ' sf-on' : ''}`} aria-hidden="true">
      {on && (
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

export default function SurfaceGuideReader({ snapshot, reviewed, onReviewedChange, section, onSection }: SurfaceGuideReaderProps) {
  const files = useMemo(() => parseDiffToFiles(snapshot.review.rawPatch), [snapshot.review.rawPatch]);
  const guide = snapshot.guide;
  const pages = useMemo<Page[]>(() => {
    const resolved = resolveGuideSectionFiles({ ...guide, reviewed: [...guide.reviewed] }, files);
    const list: Page[] = guide.sections.map((s, i) => ({ section: s, files: resolved.sectionFiles[i] ?? [], reviewable: true }));
    if (resolved.unplacedFiles.length > 0) {
      list.push({
        section: { title: 'Everything else', overview: "Changed files the guide didn't place into a section.", diffs: resolved.unplacedFiles.map((f) => ({ file: f.path })) },
        files: resolved.unplacedFiles,
        reviewable: false,
      });
    }
    return list;
  }, [guide, files]);
  const ticks = useMemo(() => guide.sections.map((_, i) => reviewed[i] ?? guide.reviewed[i] ?? false), [guide.sections, guide.reviewed, reviewed]);
  const toggle = useCallback((index: number) => onReviewedChange(ticks.map((v, i) => (i === index ? !v : v))), [ticks, onReviewedChange]);
  const go = useCallback((next: number | null) => onSection(next, pages.length), [onSection, pages.length]);
  const host = useMemo(() => ({ files, DiffRenderer: ReadOnlyDiff, getDiffRendererProps: phoneRendererProps }), [files]);
  const [focusedFile, setFocusedFile] = useState<string | null>(null);

  const page = section === null ? null : pages[section] ?? null;
  // A new screen starts at its top.
  useEffect(() => {
    window.scrollTo(0, 0);
    document.scrollingElement?.scrollTo(0, 0);
    setFocusedFile(null);
  }, [section]);

  if (page === null || section === null) {
    const next = ticks.findIndex((t) => !t);
    const continueAt = next < 0 ? 0 : next;
    return (
      <div className="sf-glist">
        <h1 className="sf-gtitle">{guide.title}</h1>
        {guide.intent && <p className="sf-gintent">{renderInlineMarkdown(guide.intent)}</p>}
        <p className="sf-gcounts">
          {guide.sections.length} section{guide.sections.length === 1 ? '' : 's'} · {files.length} file{files.length === 1 ? '' : 's'} · <Counts files={files} />
        </p>
        <h2 className="sf-gsechead">Sections</h2>
        <ol className="sf-gsections">
          {pages.map((p, i) => (
            <li key={`${p.section.title}:${i}`} className="sf-gsection" data-section={i}>
              <button type="button" className="sf-grow" onClick={() => go(i)}>
                <span className="sf-gnum">{two(i)}</span>
                <span className="sf-gtext">
                  <span className="sf-gname">{p.section.title}</span>
                  <span className="sf-gmeta">
                    {p.files.length} file{p.files.length === 1 ? '' : 's'} · <Counts files={p.files} />
                  </span>
                </span>
              </button>
              {p.reviewable && (
                <button
                  type="button"
                  className="sf-gtickbtn"
                  aria-pressed={ticks[i]}
                  aria-label={`${two(i)} ${p.section.title}: reviewed`}
                  onClick={() => toggle(i)}
                >
                  <Tick on={ticks[i]} />
                </button>
              )}
            </li>
          ))}
        </ol>
        <div className="sf-gfoot">
          <button type="button" className="sf-gcontinue" onClick={() => go(continueAt)}>
            Continue with {two(continueAt)}
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <GuideHostProvider value={host}>
      <div className="sf-gpage" data-section-page={section}>
        <GuideViewportProvider className="sf-gcard" eager>
          <GuideSectionCard
            section={page.section}
            files={page.files}
            index={section}
            total={pages.length}
            showReviewed={false}
            focusedFile={focusedFile}
            revealTarget={null}
            onActivate={setFocusedFile}
            onRequestReveal={setFocusedFile}
          />
        </GuideViewportProvider>
        <nav className="sf-gnav" aria-label="Sections">
          {section > 0 ? (
            <button type="button" className="sf-gnavbtn" onClick={() => go(section - 1)} aria-label={`Previous: ${two(section - 1)}`}>
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M10 3.5L5.5 8 10 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {two(section - 1)}
            </button>
          ) : (
            <span />
          )}
          {page.reviewable ? (
            <button type="button" className="sf-gnavbtn sf-greviewed" aria-pressed={ticks[section]} onClick={() => toggle(section)}>
              <Tick on={ticks[section]} />
              Reviewed
            </button>
          ) : (
            <span />
          )}
          {section < pages.length - 1 ? (
            <button type="button" className="sf-gnavbtn" onClick={() => go(section + 1)} aria-label={`Next: ${two(section + 1)}`}>
              {two(section + 1)}
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            <span />
          )}
        </nav>
      </div>
    </GuideHostProvider>
  );
}

// Held to the shape the strict typecheck reads (surface-reader-module.d.ts).
SurfaceGuideReader satisfies typeof ReaderShape;
