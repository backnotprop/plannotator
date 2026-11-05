/**
 * The review's chapter list, folded into one control in its top bar (approval "review-deslop", r7).
 *
 * The button says where the person is ("2 of 3 The worker, and the email at the end", a tick once reviewed); the menu
 * under it lists the Overview and every chapter, with the count reviewed at its foot. In All files the same control
 * lists the changed files with their Viewed ticks. Together with Walkthrough | All files beside it, this is what the
 * review's left rail held, so the diffs get the window's width.
 *
 * No new keyboard shortcuts: it is the Inbox's menu (Enter opens it; Tab leaves it; the arrows and Enter pick, as in
 * every menu here), and Escape closes it without leaving the review.
 */

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@plannotator/ui/components/ui/dropdown-menu';
import { Icon } from '../icons';
import { isTextCut, Tip } from './Tip';

export interface ReviewJumpChapter {
  title: string;
  reviewed: boolean;
}

export interface ReviewJumpFile {
  path: string;
  additions: number;
  deletions: number;
  viewed: boolean;
}

export interface ReviewJumpProps {
  /** Above the rows (a phone: the title and the mode switch, which have no room in its bar). */
  head?: React.ReactNode;
  mode: 'walkthrough' | 'files';
  chapters: readonly ReviewJumpChapter[];
  /** In the order the review draws them. */
  files: readonly ReviewJumpFile[];
  /** Walkthrough: the chapter in view (null: the overview, above the first). All files: the file in view. */
  current: number | null;
  onChapter: (index: number | null) => void;
  onFile: (path: string) => void;
}

/** A chapter or file counts as "in view" once its top is this far under the top of the review's scroll. */
const IN_VIEW_LINE = 72;

/**
 * The chapter whose top has passed the top of the review's scroll; null while the overview is still there. A card
 * past the chapters ("Everything else") is no chapter of the menu's: the last chapter stays named.
 */
export function chapterInView(body: HTMLElement, chapterCount: number): number | null {
  const line = body.getBoundingClientRect().top + IN_VIEW_LINE;
  let at: number | null = null;
  for (const el of body.querySelectorAll<HTMLElement>('[data-guide-section]')) {
    const index = Number(el.dataset.guideSection);
    if (index < chapterCount && el.getBoundingClientRect().top <= line) at = index;
  }
  return at;
}

/** The file whose top has passed the top of the review's scroll: its path, or null above the first. */
export function fileInView(body: HTMLElement): string | null {
  const line = body.getBoundingClientRect().top + IN_VIEW_LINE;
  let at: string | null = null;
  for (const el of body.querySelectorAll<HTMLElement>('[data-guide-file-shell]')) {
    if (el.getBoundingClientRect().top <= line) at = el.dataset.guideFileShell ?? at;
  }
  return at;
}

/** Where the person is, for the button and for a phone's list: "2 of 3" and the name. */
export function jumpPlace({ mode, chapters, files, current }: Pick<ReviewJumpProps, 'mode' | 'chapters' | 'files' | 'current'>): { lead: string; name: string; done: boolean } {
  if (mode === 'walkthrough') {
    const chapter = current === null ? undefined : chapters[current];
    return chapter ? { lead: `${current! + 1} of ${chapters.length}`, name: chapter.title, done: chapter.reviewed } : { lead: '', name: 'Overview', done: false };
  }
  const index = current ?? 0;
  const file = files[index];
  if (!file) return { lead: '', name: plural(files.length, 'file'), done: false };
  return { lead: `${index + 1} of ${files.length}`, name: file.path.slice(file.path.lastIndexOf('/') + 1), done: file.viewed };
}

/** The menu's foot: how far the review has come, in the rail's words. */
export function jumpProgress({ mode, chapters, files }: Pick<ReviewJumpProps, 'mode' | 'chapters' | 'files'>): string {
  return mode === 'walkthrough'
    ? `${chapters.filter((chapter) => chapter.reviewed).length} of ${plural(chapters.length, 'chapter')} reviewed`
    : `${files.filter((file) => file.viewed).length} of ${plural(files.length, 'file')} viewed`;
}

export function ReviewJump({ mode, chapters, files, current, onChapter, onFile, head }: ReviewJumpProps) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const walk = mode === 'walkthrough';
  const { lead, name, done } = jumpPlace({ mode, chapters, files, current });

  // Many chapters: the menu opens with the one in view in view.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => listRef.current?.querySelector('[data-on]')?.scrollIntoView?.({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={setOpen}
    >
      <Tip content={name} when={(trigger) => isTextCut(trigger.querySelector('.ib-rj-name'))}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="ib-rj-btn"
              aria-label={`${walk ? 'Chapters' : 'Files'}: ${lead ? `${lead}, ` : ''}${name}${done ? (walk ? ', reviewed' : ', viewed') : ''}`}
              data-review-jump={mode}
            />
          }
        >
          {lead && <span className="ib-rj-lead">{lead}</span>}
          <span className={`ib-rj-name${walk ? '' : ' ib-rj-mono'}`}>{name}</span>
          {done && <Icon name="check" size={13} className="ib-rj-done" />}
          <Icon name="chevD" size={13} className="ib-rj-chev" />
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" sideOffset={6} className="ib-rj-menu" aria-label={walk ? 'Chapters' : 'Files'} data-review-jump-menu={mode}>
        {head}
        <div ref={listRef} className="ib-rj-list" {...(walk ? { 'data-review-chapters': '' } : { 'data-review-files': '' })}>
          {walk ? (
            <>
              <DropdownMenuItem className="ib-rj-row" data-on={current === null || !chapters[current] ? '' : undefined} onClick={() => onChapter(null)} data-review-jump-row="overview">
                <span className="ib-rj-mark" aria-hidden="true" />
                <span className="ib-rj-t">Overview</span>
              </DropdownMenuItem>
              {chapters.map((chapter, index) => (
                <DropdownMenuItem
                  key={`${chapter.title}:${index}`}
                  className="ib-rj-row"
                  data-on={current === index ? '' : undefined}
                  onClick={() => onChapter(index)}
                  aria-label={`Chapter ${index + 1}: ${chapter.title}${chapter.reviewed ? ', reviewed' : ''}`}
                  data-review-jump-row={index}
                >
                  <span className="ib-rj-mark" data-done={chapter.reviewed ? '' : undefined} aria-hidden="true">
                    {chapter.reviewed ? <Icon name="check" size={12} /> : index + 1}
                  </span>
                  <span className="ib-rj-t">{chapter.title}</span>
                </DropdownMenuItem>
              ))}
            </>
          ) : (
            files.map((file, index) => {
              const slash = file.path.lastIndexOf('/');
              return (
                <DropdownMenuItem
                  key={file.path}
                  className="ib-rj-row"
                  data-on={(current ?? 0) === index ? '' : undefined}
                  onClick={() => onFile(file.path)}
                  aria-label={`${file.path}${file.viewed ? ', viewed' : ''}`}
                  data-review-jump-row={file.path}
                >
                  <span className="ib-rj-mark" data-done={file.viewed ? '' : undefined} aria-hidden="true">
                    {file.viewed ? <Icon name="check" size={12} /> : null}
                  </span>
                  <span className="ib-rj-t">
                    <Tip content={file.path} cut>
                      <span className="ib-rj-path">
                        {/* Cut at the start (the box is right to left); the path itself reads left to right, a leading dot included. */}
                        <bdi dir="ltr">
                          {slash >= 0 && <span className="ib-rj-dir">{file.path.slice(0, slash + 1)}</span>}
                          {file.path.slice(slash + 1)}
                        </bdi>
                      </span>
                    </Tip>
                  </span>
                  <span className="ib-rj-n">
                    <span className="ib-add">+{formatCount(file.additions)}</span>
                    {file.deletions > 0 && <span className="ib-del"> -{formatCount(file.deletions)}</span>}
                  </span>
                </DropdownMenuItem>
              );
            })
          )}
        </div>
        <p className="ib-rj-foot" aria-live="polite" data-review-progress="">
          {jumpProgress({ mode, chapters, files })}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
