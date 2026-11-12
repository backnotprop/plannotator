import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { INBOX_ARTIFACTS_PAGE, INBOX_ARTIFACTS_PAGE_MAX, type InboxArtifactRow, type InboxArtifactsPage, type InboxArtifactType } from '@plannotator/core/inbox-artifact-pins';
import { inboxApi } from '../api';
import { originOf, type Artifact } from '../artifacts';
import { useArtifactPins } from '../artifactPins';
import { dayWords, formatCount, plural } from '../format';
import { Icon } from '../icons';
import { SidebarTrigger } from '../shell/sidebar';
import { ArtifactPinButton } from './ArtifactPinButton';
import { useNear } from './ArtifactsView';
import { usePdfPages, WallFace } from './WallFace';
import { wallTypeLabel } from '../wallFaceText';
import { Tip } from './Tip';

const TYPES: { id: InboxArtifactType; name: string }[] = [
  { id: 'images', name: 'Images' },
  { id: 'pages', name: 'Pages' },
  { id: 'documents', name: 'Documents' },
  { id: 'other', name: 'Other files' },
];

const SIZE_KEY = 'plannotator-inbox-artifacts-wall-size';
type WallSize = 'small' | 'large';
function readSize(): WallSize {
  try {
    return localStorage.getItem(SIZE_KEY) === 'large' ? 'large' : 'small';
  } catch {
    return 'small';
  }
}

export function wallArtifact(row: InboxArtifactRow): Artifact {
  const origin = originOf({ id: row.message_id, author: row.author, created_at: row.at });
  if (row.attachment) return { type: 'file', ...origin, attachment: row.attachment, inline: row.inline, alsoIds: [] };
  return { type: 'guide', ...origin, guide: row.guide! };
}

function nameOf(row: InboxArtifactRow): string {
  return row.attachment ? row.attachment.name : (row.guide?.title ?? 'Guided review');
}

function dayOf(iso: string): string {
  const words = dayWords(iso);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function WallTile({ row, onOpen }: { row: InboxArtifactRow; onOpen: (row: InboxArtifactRow) => void }) {
  const [ref, near] = useNear<HTMLLIElement>();
  const artifact = wallArtifact(row);
  const name = nameOf(row);
  const pages = usePdfPages(row.attachment, near);
  const type = wallTypeLabel(row, pages);
  return (
    <li className="ib-wall-cell" ref={ref} data-wall-artifact={row.key}>
      <button type="button" className="ib-wall-tile" onClick={() => onOpen(row)} aria-label={`${name}, ${type}, in ${row.thread_title}, ${artifact.sender} at ${artifact.sentAt}`}>
        <span className="ib-wall-stage">
          <WallFace row={row} near={near} guide={artifact.type === 'guide' ? artifact : null} pages={pages} />
        </span>
        <span className="ib-wall-cap" aria-hidden="true">
          <span className="ib-wall-cap-nm" dir="auto" data-wall-name={name}>
            {name}
          </span>
          <span className="ib-wall-cap-sub" dir="auto">
            <span className="ib-wall-cap-ty" data-wall-type-label="">
              {type}
            </span>
            <span className="ib-wall-cap-th"> · {row.thread_title}</span>
          </span>
        </span>
      </button>
      <ArtifactPinButton threadId={row.thread_id} artifactKey={row.key} name={name} surface="wall" />
    </li>
  );
}

function FilterGlyph({ size }: { size: number }) {
  return (
    <svg className="ib-ic" viewBox="0 0 24 24" style={{ width: size, height: size }} aria-hidden="true" focusable="false">
      <path d="M3 6h18M7 12h10M10 18h4" />
    </svg>
  );
}

function WallFilterMenu({ archived, onArchived, phone }: { archived: boolean; onArchived: (on: boolean) => void; phone: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  return (
    <Menu.Root modal={false}>
      <Tip content="Filter">
        <Menu.Trigger ref={trigger} className="ib-bflt-btn ib-wall-fbtn" aria-label={archived ? 'Filter: showing archived' : 'Filter'} data-on={archived ? '' : undefined} data-wall-filter="">
          <FilterGlyph size={phone ? 20 : 16} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={phone ? '' : undefined}>
          <Menu.Popup className="ib-pm ib-bflt-menu" aria-label="Filter" data-wall-filter-menu="">
            <Menu.CheckboxItem className="ib-pmi" label="Show archived" checked={archived} onCheckedChange={(on: boolean) => onArchived(on)} data-wall-show-archived="">
              <span className="ib-pmi-box" aria-hidden="true" data-on={archived ? '' : undefined}>
                {archived && <Icon name="check" size={11} />}
              </span>
              <span className="ib-pmi-l">Show archived</span>
            </Menu.CheckboxItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export interface ArtifactsWallProps {
  pinned: boolean;
  onPinned: (pinned: boolean) => void;
  onOpen: (row: InboxArtifactRow) => void;
  phone: boolean;
  read?: typeof inboxApi.artifacts;
}

export function ArtifactsWall({ pinned, onPinned, onOpen, phone, read = inboxApi.artifacts }: ArtifactsWallProps) {
  const [type, setType] = useState<InboxArtifactType | null>(null);
  const [archived, setArchived] = useState(false);
  const [size, setSize] = useState<WallSize>(readSize);
  const [page, setPage] = useState<{ rows: InboxArtifactRow[]; next: string | null; counts: InboxArtifactsPage['counts'] | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const loaded = useRef(0);
  const reads = useRef(0);
  const { pins } = useArtifactPins();

  const load = useCallback(
    (limit: number) => {
      const at = ++reads.current;
      void read({ pinned, type, archived, limit: Math.min(INBOX_ARTIFACTS_PAGE_MAX, Math.max(INBOX_ARTIFACTS_PAGE, limit)) }).then(
        (answer) => {
          if (at !== reads.current) return;
          loaded.current = answer.artifacts.length;
          setFailed(false);
          setPage({ rows: answer.artifacts, next: answer.next_cursor, counts: answer.counts });
        },
        () => at === reads.current && setFailed(true),
      );
    },
    [read, pinned, type, archived],
  );
  useEffect(() => {
    setPage(null);
    load(INBOX_ARTIFACTS_PAGE);
  }, [load]);
  const firstPins = useRef(true);
  useEffect(() => {
    if (firstPins.current) {
      firstPins.current = false;
      return;
    }
    const timer = setTimeout(() => load(loaded.current), 120);
    return () => clearTimeout(timer);
  }, [pins]);

  const loadMore = useCallback(() => {
    if (!page?.next || more) return;
    setMore(true);
    const at = reads.current;
    void read({ pinned, type, archived, cursor: page.next }).then(
      (answer) => {
        setMore(false);
        if (at !== reads.current) return;
        setPage((now) => (now ? { rows: [...now.rows, ...answer.artifacts], next: answer.next_cursor, counts: answer.counts } : now));
        loaded.current += answer.artifacts.length;
      },
      () => setMore(false),
    );
  }, [page, more, read, pinned, type, archived]);

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = end.current;
    if (!el || !page?.next || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '600px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [page, loadMore]);

  const pickSize = (next: WallSize) => {
    setSize(next);
    try {
      localStorage.setItem(SIZE_KEY, next);
    } catch {
    }
  };

  const days: { day: string; rows: InboxArtifactRow[] }[] = [];
  for (const row of page?.rows ?? []) {
    const day = dayOf(row.at);
    const last = days.at(-1);
    if (last && last.day === day) last.rows.push(row);
    else days.push({ day, rows: [row] });
  }
  const counts = page?.counts ?? null;

  return (
    <section className="ib-dpage ib-wall" aria-label="Artifacts" data-artifacts-wall="" data-size={size} data-phone={phone ? '' : undefined}>
      <div className="ib-dh ib-wall-h">
        <SidebarTrigger />
        <h1 tabIndex={-1}>Artifacts</h1>
      </div>
      <div className="ib-wall-bar" role="toolbar" aria-label="Filter artifacts">
        <div className="ib-seg" role="group" aria-label="Show">
          <button type="button" className="ib-seg-o" aria-pressed={!pinned} data-on={!pinned ? '' : undefined} onClick={() => onPinned(false)} data-wall-show="all">
            All{counts && <span className="ib-wall-n">{formatCount(counts.all)}</span>}
          </button>
          <button type="button" className="ib-seg-o" aria-pressed={pinned} data-on={pinned ? '' : undefined} onClick={() => onPinned(true)} data-wall-show="pinned">
            Pinned{counts && <span className="ib-wall-n">{formatCount(counts.pinned)}</span>}
          </button>
        </div>
        <div className="ib-wall-types" role="group" aria-label="Type">
          {TYPES.map((t) => (
            <button key={t.id} type="button" className="ib-wall-type" aria-pressed={type === t.id} data-on={type === t.id ? '' : undefined} onClick={() => setType(type === t.id ? null : t.id)} data-wall-type={t.id}>
              {t.name}
            </button>
          ))}
        </div>
        <div className="ib-wall-end">
          {!phone && (
            <div className="ib-wall-size" role="group" aria-label="Size">
              <Tip content="Smaller">
                <button type="button" className="ib-wall-sizeb" aria-label="Smaller" aria-pressed={size === 'small'} data-on={size === 'small' ? '' : undefined} onClick={() => pickSize('small')}>
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    {[1, 6, 11].flatMap((x) => [1, 6, 11].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" rx="1" />))}
                  </svg>
                </button>
              </Tip>
              <Tip content="Larger">
                <button type="button" className="ib-wall-sizeb" aria-label="Larger" aria-pressed={size === 'large'} data-on={size === 'large' ? '' : undefined} onClick={() => pickSize('large')}>
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    {[1, 9].flatMap((x) => [1, 9].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="6" height="6" rx="1.5" />))}
                  </svg>
                </button>
              </Tip>
            </div>
          )}
          <WallFilterMenu archived={archived} onArchived={setArchived} phone={phone} />
        </div>
      </div>
      {page === null ? (
        failed ? (
          <p className="ib-wall-load" role="alert">
            The artifacts could not be read.{' '}
            <button type="button" className="ib-wall-linkbtn" onClick={() => load(INBOX_ARTIFACTS_PAGE)}>
              Try again
            </button>
          </p>
        ) : (
          <p className="ib-wall-load" aria-busy="true">
            Loading the artifacts…
          </p>
        )
      ) : page.rows.length === 0 ? (
        <div className="ib-art-empty" data-wall-empty="">
          <span className="ib-art-empty-ic">
            <Icon name={pinned ? 'pin' : 'artifacts'} size={28} />
          </span>
          <b>{pinned ? 'No pinned artifacts yet' : 'No artifacts yet'}</b>
          <span>{pinned ? 'Pin a file in a thread’s Artifacts, or in the viewer, and it shows here.' : 'Files, images and guided reviews from your threads show here.'}</span>
        </div>
      ) : (
        <>
          {days.map((d) => (
            <section key={d.day} className="ib-wall-day" aria-label={d.day}>
              <h2 className="ib-wall-day-h">{d.day}</h2>
              <ul className="ib-wall-grid" aria-label={plural(d.rows.length, 'artifact')}>
                {d.rows.map((row) => (
                  <WallTile key={`${row.thread_id}:${row.key}`} row={row} onOpen={onOpen} />
                ))}
              </ul>
            </section>
          ))}
          <div ref={end} className="ib-wall-more">
            {page.next && (
              <button type="button" className="ib-wall-linkbtn" onClick={loadMore} disabled={more} aria-busy={more || undefined}>
                {more ? 'Loading…' : 'Show more'}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
