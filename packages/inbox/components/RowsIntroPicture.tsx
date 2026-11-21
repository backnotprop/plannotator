/**
 * The picture at the top of "Choose how your list looks" (approval "inbox-rows-dialog", round 7b, take C): an Inbox
 * window with example projects, the sidebar open beside the list. As the dialog opens a short demo plays on it
 * (listIntro.ts `rowsIntroScene`): letter marks pop into the rows and the sidebar, the projects' logos land, the row
 * marks turn over to the projects and back to the stacked look (the thread's letters, the project's logo on its
 * corner), and a card in the notes look rises in at the bottom right. Then it holds.
 *
 * It follows the window's mode (the owner, q-fd707b9e: "follow the mode"). No agent icons. Not interactive and not
 * announced: the dialog's words say what it is. The example projects' logos are bundled (assets/rows-intro), so the
 * picture never asks anyone for anything.
 */
import type { CSSProperties } from 'react';
import { hueOf, markLetters } from '../letterMarks';
import type { RowsIntroScene } from '../listIntro';
import { Icon } from '../icons';
import { inboxSearchShortcuts } from '../search/searchShortcut';
import { ShortcutHint } from '../shortcuts/hint';
import plannotatorLogo from '../assets/rows-intro/plannotator.webp';
import bunLogo from '../assets/rows-intro/oven-sh.webp';
import supabaseLogo from '../assets/rows-intro/supabase.webp';
import viteLogo from '../assets/rows-intro/vitejs.webp';
import dockerLogo from '../assets/rows-intro/docker.webp';
import zedLogo from '../assets/rows-intro/zed-industries.webp';
import huggingfaceLogo from '../assets/rows-intro/huggingface.webp';
import redisLogo from '../assets/rows-intro/redis.webp';
import vercelLogo from '../assets/rows-intro/vercel.webp';

interface ExampleRow {
  project: string;
  title: string;
  preview: string;
  time: string;
  questions?: number;
  logo?: string;
}

const WAITING: readonly ExampleRow[] = [
  { project: 'plannotator', title: 'Review the inbox header change', preview: 'Two layouts to pick from, both in the thread', questions: 1, time: '2:41 PM', logo: plannotatorLogo },
  { project: 'bun', title: 'Bump the test runner timeout', preview: 'bun test hits 5 s on the slow CI runners', questions: 1, time: '2:17 PM', logo: bunLogo },
  { project: 'supabase', title: 'Add a row-level policy example', preview: 'Which table should the example use?', questions: 1, time: '1:58 PM', logo: supabaseLogo },
];
const NEW: readonly ExampleRow[] = [
  { project: 'vite', title: 'Bump the dev server to 6.1', preview: 'Two plugins need a new peer range', time: '1:12 PM', logo: viteLogo },
  { project: 'compose', title: 'Fix the volume mount order', preview: 'Named volumes now mount before binds', time: '12:46 PM', logo: dockerLogo },
  { project: 'zed', title: 'Speed up the project search', preview: 'Search over 40k files drops from 1.9 s to 0.4 s', time: '11:30 AM', logo: zedLogo },
  { project: 'transformers', title: 'Update the tokenizer docs', preview: 'The fast tokenizer page had the old flags', time: '10:05 AM', logo: huggingfaceLogo },
  { project: 'redis', title: 'Tidy the eviction settings', preview: 'maxmemory-policy moves next to maxmemory', time: '9:48 AM', logo: redisLogo },
  { project: 'next.js', title: 'Fix the image loader cache key', preview: 'Width was missing from the key', time: '9:20 AM', logo: vercelLogo },
];
/** The sidebar's projects, in the order the Inbox lists them; `waiting`: threads waiting on you. Two have no logo. */
const PROJECTS: readonly { name: string; waiting?: number; logo?: string }[] = [
  { name: 'plannotator', waiting: 1, logo: plannotatorLogo },
  { name: 'bun', waiting: 1, logo: bunLogo },
  { name: 'supabase', waiting: 1, logo: supabaseLogo },
  { name: 'vite', logo: viteLogo },
  { name: 'dotfiles' },
  { name: 'compose', logo: dockerLogo },
  { name: 'zed', logo: zedLogo },
  { name: 'transformers', logo: huggingfaceLogo },
  { name: 'infra-terraform' },
  { name: 'redis', logo: redisLogo },
  { name: 'next.js', logo: vercelLogo },
];

/** The notes look's two invented threads (approval round 3: "Spring newsletter", waiting; "Trip plan: Lisbon", done). */
const NOTES: readonly { title: string; preview: string; time: string; status: 'waiting' | 'done' }[] = [
  { title: 'Spring newsletter', preview: 'The intro still runs long. Should I cut the second story, or move it to the end?', time: '3:12 PM', status: 'waiting' },
  { title: 'Trip plan: Lisbon', preview: 'Flights and the flat are booked. The day-by-day list is pinned in the thread.', time: '11:05 AM', status: 'done' },
];

/** The ids the marks' hues are keyed on (the production rule: the hue from the id). */
const threadSeed = (row: ExampleRow) => `thr_f_${row.project}_${row.title}`;
const projectSeed = (name: string) => `prj_${name}`;

/** A letter mark (letterMarks.tsx's rules and classes), its logo shown once `logos` is on. */
function Mark({ name, seed, size, logo, className, i }: { name: string; seed: string; size: 14 | 20 | 30; logo?: string; className?: string; i?: number }) {
  const letters = markLetters(name);
  return (
    <span className={`ib-lm${logo ? ' ib-rl-logo' : ''}${className ? ` ${className}` : ''}`} data-hue={hueOf(seed)} data-size={size} data-solid="" data-kind={letters.kind} data-n={letters.count} style={i === undefined ? undefined : ({ '--i': i } as CSSProperties)}>
      {letters.text}
      {logo && <img src={logo} alt="" decoding="async" />}
    </span>
  );
}

function Row({ row, i }: { row: ExampleRow; i: number }) {
  return (
    <div className="ib-rl-row" style={{ '--i': i } as CSSProperties}>
      <span className="ib-rl-av">
        <span className="ib-rl-pop">
          <span className="ib-rl-flip">
            <Mark name={row.title} seed={threadSeed(row)} size={30} className="ib-rl-face" />
            <Mark name={row.project} seed={projectSeed(row.project)} size={30} logo={row.logo} className="ib-rl-face ib-rl-back" i={i} />
          </span>
        </span>
        <Mark name={row.project} seed={projectSeed(row.project)} size={14} logo={row.logo} className="ib-rl-badge ib-rl-pop" i={i} />
      </span>
      <div className="ib-rl-l1">
        <span className="ib-rl-proj">{row.project}</span>
        <span className="ib-rl-time">{row.time}</span>
      </div>
      <div className="ib-rl-l2">{row.title}</div>
      <div className="ib-rl-l3">
        <span className="ib-rl-prev">{row.preview}</span>
        {row.questions ? (
          <span className="ib-rl-q">
            <Icon name="questionBubble" size={14} />
            {row.questions}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function StatusMark({ status }: { status: 'waiting' | 'done' }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      {status === 'waiting' ? <path d="M4.25 8.75h7.5a3.75 3.75 0 0 1-7.5 0Z" fill="currentColor" stroke="none" /> : <path d="m5.4 8.2 1.8 1.8 3.4-3.6" />}
    </svg>
  );
}

/**
 * The example window (`scene`'s marks and logos) in its frame. `moving`: the demo plays, so the marks pop, the logos
 * land and the marks turn with motion; otherwise each change is instant (reduced motion, the held picture after a
 * key or a click).
 */
export function RowsIntroWindow({ scene, moving }: { scene: RowsIntroScene; moving: boolean }) {
  const waiting = WAITING.length;
  return (
    <div className="ib-rl-comp" data-marks={scene.marks} data-logos={scene.logos ? '' : undefined} data-moving={moving ? '' : undefined}>
      <aside className="ib-rl-sb">
        <div className="ib-rl-brand">
          Plannotator<span>Inbox</span>
        </div>
        <div className="ib-rl-search">
          <span className="ib-rl-box">
            <Icon name="search" size={16} />
            Search
            <ShortcutHint scope={inboxSearchShortcuts} action="openSearch" className="ib-kbd ib-rl-kbd" />
          </span>
          <span className="ib-rl-new">
            <Icon name="compose" size={16} />
          </span>
        </div>
        <div className="ib-rl-nav">
          <Icon name="inbox" size={17} />
          Inbox<span className="ib-rl-n">{waiting}</span>
        </div>
        <div className="ib-rl-phead">
          <Icon name="folder" size={17} />
          Projects
        </div>
        {PROJECTS.map((project, j) => (
          <div className="ib-rl-prow" key={project.name}>
            <Mark name={project.name} seed={projectSeed(project.name)} size={20} logo={project.logo} className="ib-rl-sbm" i={j} />
            <span className="ib-rl-pn">{project.name}</span>
            {project.waiting ? <span className="ib-rl-n">{project.waiting}</span> : null}
          </div>
        ))}
      </aside>
      <div className="ib-rl-lp">
        <div className="ib-rl-lhead">
          <Icon name="panelsHide" size={18} />
          <span className="ib-rl-h">Inbox</span>
          <Icon name="dots" size={18} />
        </div>
        <div className="ib-rl-lbody">
          <div className="ib-rl-band">
            Waiting on you <span className="ib-rl-n">{waiting}</span>
          </div>
          {WAITING.map((row, i) => (
            <Row key={row.title} row={row} i={i} />
          ))}
          <div className="ib-rl-band">
            New since you looked <span className="ib-rl-n">{NEW.length}</span>
          </div>
          {NEW.map((row, i) => (
            <Row key={row.title} row={row} i={i + WAITING.length} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The notes look, stacked on the picture's bottom right (approval round 3): it rises in as the demo lands. */
export function RowsIntroNotes({ shown, moving }: { shown: boolean; moving: boolean }) {
  return (
    <div className="ib-rl-stack" data-off={shown ? undefined : ''} data-moving={moving ? '' : undefined} aria-hidden="true">
      {NOTES.map((note) => (
        <div className="ib-rl-nrow" data-status={note.status} key={note.title}>
          <div className="ib-rl-nt">{note.title}</div>
          <div className="ib-rl-np">{note.preview}</div>
          <div className="ib-rl-nb">
            <span>{note.time}</span>
            <span className="ib-rl-stm">
              <StatusMark status={note.status} />
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
