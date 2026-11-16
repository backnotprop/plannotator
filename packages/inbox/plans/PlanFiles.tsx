/**
 * A plan's left panel, as a Workspaces space's (the owner, 2026-11-16: "the same panel we have in spaces"): this
 * plan's files in one flat list, read only. Head: back to Plans and the plan's name. "Pages" and their count, with
 * Filter files; the plan's main page first, marked "Main", then its other documents by name. "Artifacts" and their
 * count only when it has some, by name. A row is a link to its file (the address carries it); the file on screen is
 * a soft tinted row with primary text, never an outline or a side bar.
 *
 * Docked on a desktop (a pane of its own, 306 px, 240–400 by its edge, the width kept; a click on the edge, a drag
 * under half its least width or Hide files folds it, kept too, and Show files brings it back). It gives way first
 * when the document would get narrower than `PLAN_DOC_MIN`: then Show files opens it as a sheet from the left, as on
 * a phone, where it is never docked. No file management, no shortcut.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { PlanArtifact, PlanDocument, PlanDocumentKind } from '@plannotator/core/plans';
import { Icon, type IconName } from '../icons';
import { Tip } from '../components/Tip';
import { hashOf, writeRoute } from '../app/writeRoute';
import { artifactKind, artifactName, byName, noFileMatches, PLAN_FILES_WORDS, type PlanArtifactKind } from './words';

/** The file on screen: a document (the main page when it is the plan's own) or an artifact. */
export type PlanFileRef = { kind: 'doc'; id: string } | { kind: 'artifact'; path: string };

export const PLAN_FILES_DEFAULT = 306;
export const PLAN_FILES_MIN = 240;
export const PLAN_FILES_MAX = 400;
/** The document's least width beside the docked panel and the rail; narrower, the panel gives way first. */
export const PLAN_DOC_MIN = 480;
export const PLAN_FILES_WIDTH_KEY = 'plannotator-inbox-plan-files-width';
export const PLAN_FILES_HIDDEN_KEY = 'plannotator-inbox-plan-files-hidden';

const DOC_ICON: Record<PlanDocumentKind, IconName> = { markdown: 'doc', html: 'code', mermaid: 'diagram', graphviz: 'layers' };
const ARTIFACT_ICON: Record<PlanArtifactKind, IconName> = { image: 'photo', svg: 'photo', html: 'frame', pdf: 'book', video: 'film', other: 'clip' };

interface FileRow {
  key: string;
  ref: PlanFileRef;
  name: string;
  tip: string;
  icon: IconName;
  main: boolean;
}

/** The panel's rows: the main page, the other documents by name, then the artifacts by name. */
export function planFileRows(primary: string, documents: readonly PlanDocument[], artifacts: readonly PlanArtifact[]): { pages: FileRow[]; artifacts: FileRow[] } {
  const live = documents.filter((d) => !d.archived_at);
  const main = live.find((d) => d.id === primary);
  const others = live.filter((d) => d.id !== primary).sort((a, b) => byName(a.title, b.title));
  const docRow = (d: PlanDocument, isMain: boolean): FileRow => ({ key: `d:${d.id}`, ref: { kind: 'doc', id: d.id }, name: d.title || 'Untitled', tip: d.doc_path ?? d.title, icon: DOC_ICON[d.kind], main: isMain });
  return {
    pages: [...(main ? [docRow(main, true)] : []), ...others.map((d) => docRow(d, false))],
    artifacts: [...artifacts]
      .map((a): FileRow => ({ key: `a:${a.asset_path}`, ref: { kind: 'artifact', path: a.asset_path }, name: artifactName(a), tip: a.asset_path, icon: ARTIFACT_ICON[artifactKind(a.content_type)], main: false }))
      .sort((a, b) => byName(a.name, b.name)),
  };
}

const sameFile = (a: PlanFileRef, b: PlanFileRef) => (a.kind === 'doc' && b.kind === 'doc' ? a.id === b.id : a.kind === 'artifact' && b.kind === 'artifact' && a.path === b.path);

export function planFileRoute(plan: string, primary: string, ref: PlanFileRef) {
  return {
    page: 'plans' as const,
    project: null,
    thread: null,
    plan,
    planDoc: ref.kind === 'doc' && ref.id !== primary ? ref.id : null,
    planFile: ref.kind === 'artifact' ? ref.path : null,
  };
}

export interface PlanFilesProps {
  plan: string;
  name: string;
  primary: string;
  documents: readonly PlanDocument[];
  artifacts: readonly PlanArtifact[];
  onScreen: PlanFileRef;
  /** A file was picked (the sheet closes). */
  onPicked?: () => void;
  /** Docked: Hide files folds it. Absent in the sheet. */
  onHide?: () => void;
}

export function PlanFiles({ plan, name, primary, documents, artifacts, onScreen, onPicked, onHide }: PlanFilesProps) {
  const rows = useMemo(() => planFileRows(primary, documents, artifacts), [primary, documents, artifacts]);
  const [filtering, setFiltering] = useState(false);
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (filtering) field.current?.focus();
  }, [filtering]);
  const q = query.trim().toLowerCase();
  const keep = (row: FileRow) => !q || row.name.toLowerCase().includes(q) || row.tip.toLowerCase().includes(q);
  const pages = rows.pages.filter(keep);
  const files = rows.artifacts.filter(keep);
  const open = (ref: PlanFileRef) => {
    writeRoute(planFileRoute(plan, primary, ref));
    onPicked?.();
  };
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (query) setQuery('');
      else setFiltering(false);
    } else if (e.key === 'Enter') {
      const all = [...pages, ...files];
      if (all.length === 1) open(all[0]!.ref);
    }
  };
  const row = (r: FileRow) => {
    const on = sameFile(r.ref, onScreen);
    const click = (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      open(r.ref);
    };
    return (
      <li key={r.key}>
        <a className="ib-plan-file" href={hashOf(planFileRoute(plan, primary, r.ref))} title={r.tip} aria-current={on ? 'page' : undefined} data-on={on ? '' : undefined} onClick={click} data-plan-file={r.key}>
          <Icon name={r.icon} />
          <span className="ib-plan-file-n" dir="auto">
            {r.name}
          </span>
          {r.main && (
            <span className="ib-plan-file-main" data-plan-file-main="">
              {PLAN_FILES_WORDS.main}
            </span>
          )}
        </a>
      </li>
    );
  };
  return (
    <nav className="ib-plan-files" aria-label={PLAN_FILES_WORDS.panel} data-plan-files="">
      <div className="ib-plan-files-head">
        <button type="button" className="ib-plan-files-icon" onClick={() => writeRoute({ page: 'plans', project: null, thread: null })} aria-label={PLAN_FILES_WORDS.back} data-plan-files-back="">
          <Icon name="chevL" />
        </button>
        <span className="ib-plan-files-name" dir="auto" title={name}>
          {name}
        </span>
        {onHide && (
          <Tip content={PLAN_FILES_WORDS.hide} side="bottom">
            <button type="button" className="ib-plan-files-icon" onClick={onHide} aria-label={PLAN_FILES_WORDS.hide} data-plan-files-hide="">
              <Icon name="panelsHide" />
            </button>
          </Tip>
        )}
      </div>
      <div className="ib-plan-files-body">
        <div className="ib-plan-files-sec">
          <h2>
            {PLAN_FILES_WORDS.pages} <span className="ib-plans-count">{rows.pages.length}</span>
          </h2>
          <Tip content={PLAN_FILES_WORDS.filter} side="bottom">
            <button type="button" className="ib-plan-files-icon" aria-label={PLAN_FILES_WORDS.filter} aria-pressed={filtering} data-on={filtering ? '' : undefined} onClick={() => (filtering ? (setFiltering(false), setQuery('')) : setFiltering(true))} data-plan-files-filter="">
              <Icon name="search" />
            </button>
          </Tip>
        </div>
        {filtering && (
          <input ref={field} type="search" className="ib-plan-files-field" placeholder={PLAN_FILES_WORDS.filter} aria-label={PLAN_FILES_WORDS.filter} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onFieldKey} data-plan-files-query="" />
        )}
        {rows.pages.length === 0 ? (
          <p className="ib-plan-files-none">{PLAN_FILES_WORDS.noPages}</p>
        ) : (
          <ul className="ib-plan-files-list" data-plan-files-pages="">
            {pages.map(row)}
          </ul>
        )}
        {rows.artifacts.length > 0 && (
          <>
            <div className="ib-plan-files-sec">
              <h2>
                {PLAN_FILES_WORDS.artifacts} <span className="ib-plans-count">{rows.artifacts.length}</span>
              </h2>
            </div>
            <ul className="ib-plan-files-list" data-plan-files-artifacts="">
              {files.map(row)}
            </ul>
          </>
        )}
        {q && pages.length + files.length === 0 && (
          <p className="ib-plan-files-none" role="status" data-plan-files-none="">
            {noFileMatches(query.trim())}
          </p>
        )}
      </div>
    </nav>
  );
}

/** The panel as a sheet from the left (a phone; a desktop with no room to dock it): closes on a pick, Escape or the scrim. */
export function PlanFilesSheet({ open, onClose, ...props }: PlanFilesProps & { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal?.();
    if (!open && el.open) el.close?.();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="ib-plan-filesheet"
      aria-label={PLAN_FILES_WORDS.panel}
      onClose={onClose}
      onCancel={onClose}
      // A press on the scrim (the dialog itself, outside its panel) closes it.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      data-plan-files-sheet=""
    >
      {open && <PlanFiles {...props} onPicked={onClose} />}
    </dialog>
  );
}
