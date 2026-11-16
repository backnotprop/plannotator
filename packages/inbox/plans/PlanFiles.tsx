/**
 * A plan's left rail, from the shared frame (@plannotator/ui/components/frame, the Space page screen): the frame's
 * head (back to Plans and the plan's name), its "Pages N" heading with Filter files, and its file rows; the plan's
 * main page first, marked "Main", then its other documents by name; "Artifacts" and their count only when it has
 * some, by name. A row is a link to its file (the address carries it). Read only: no file management, no shortcut.
 * Docked, open, closed, its width and its phone sheet are the frame's (`DocumentRailShell`, `RailSheet`, PlanPage.tsx);
 * only a desktop pane too narrow to dock it opens it as our own sheet from the left (`PlanFilesSheet`).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { PlanArtifact, PlanDocument, PlanDocumentKind } from '@plannotator/core/plans';
import { EYEBROW, FileRow, FilesRailFilter, FilesRailHeading, FilesRailNoMatch, FilesRailRows, FilesRailEmpty, PagesRailHead, fileIcon, type FileIconKind } from '@plannotator/ui/components/frame';
import { hashOf, writeRoute } from '../app/writeRoute';
import { artifactKind, artifactName, byName, noFileMatches, PLAN_FILES_WORDS, type PlanArtifactKind } from './words';

/** The file on screen: a document (the main page when it is the plan's own) or an artifact. */
export type PlanFileRef = { kind: 'doc'; id: string } | { kind: 'artifact'; path: string };

/** The rail's open flag and width, in Plannotator's own storage (the frame's `DocumentRailShell` keys). */
export const PLAN_FILES_OPEN_KEY = 'plannotator-inbox-plan-files-open';
export const PLAN_FILES_WIDTH_KEY = 'plannotator-inbox-plan-files-width';

const DOC_ICON: Record<PlanDocumentKind, FileIconKind> = { markdown: 'markdown', html: 'html', mermaid: 'mermaid', graphviz: 'graphviz' };
const ARTIFACT_ICON: Record<PlanArtifactKind, FileIconKind> = { image: 'image', svg: 'image', html: 'html', pdf: 'pdf', video: 'video', other: 'other' };

interface FileRowData {
  key: string;
  ref: PlanFileRef;
  name: string;
  tip: string;
  icon: FileIconKind;
  main: boolean;
}

/** The rail's rows: the main page, the other documents by name, then the artifacts by name. */
export function planFileRows(primary: string, documents: readonly PlanDocument[], artifacts: readonly PlanArtifact[]): { pages: FileRowData[]; artifacts: FileRowData[] } {
  const live = documents.filter((d) => !d.archived_at);
  const main = live.find((d) => d.id === primary);
  const others = live.filter((d) => d.id !== primary).sort((a, b) => byName(a.title, b.title));
  const docRow = (d: PlanDocument, isMain: boolean): FileRowData => ({ key: `d:${d.id}`, ref: { kind: 'doc', id: d.id }, name: d.title || 'Untitled', tip: d.doc_path ?? d.title, icon: DOC_ICON[d.kind], main: isMain });
  return {
    pages: [...(main ? [docRow(main, true)] : []), ...others.map((d) => docRow(d, false))],
    artifacts: [...artifacts]
      .map((a): FileRowData => ({ key: `a:${a.asset_path}`, ref: { kind: 'artifact', path: a.asset_path }, name: artifactName(a), tip: a.asset_path, icon: ARTIFACT_ICON[artifactKind(a.content_type)], main: false }))
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

const plansRoute = { page: 'plans' as const, project: null, thread: null };

/** A link the router follows in place (a plain click), and the browser opens elsewhere (a modified click). */
function routeClick(go: () => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };
}

/** The frame's rail head: back to Plans, with the plan's name. */
export function PlanRailHead({ name }: { name: string }) {
  return <PagesRailHead label={name} backLink={<a href={hashOf(plansRoute)} onClick={routeClick(() => writeRoute(plansRoute))} data-plan-files-back="" />} />;
}

export interface PlanFilesProps {
  plan: string;
  primary: string;
  documents: readonly PlanDocument[];
  artifacts: readonly PlanArtifact[];
  onScreen: PlanFileRef;
  /** A file was picked (a sheet closes). */
  onPicked?: () => void;
}

/** The rail's list: "Pages N" with Filter files, the rows, and "Artifacts N" when there are any. */
export function PlanFiles({ plan, primary, documents, artifacts, onScreen, onPicked }: PlanFilesProps) {
  const rows = useMemo(() => planFileRows(primary, documents, artifacts), [primary, documents, artifacts]);
  const [filtering, setFiltering] = useState(false);
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (filtering) field.current?.focus();
  }, [filtering]);
  const q = query.trim().toLowerCase();
  const keep = (row: FileRowData) => !q || row.name.toLowerCase().includes(q) || row.tip.toLowerCase().includes(q);
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
  const row = (r: FileRowData) => (
    <FileRow
      key={r.key}
      id={r.key}
      name={r.name}
      title={r.tip}
      depth={0}
      active={sameFile(r.ref, onScreen)}
      icon={fileIcon({ kind: r.icon, path: r.tip })}
      link={<a href={hashOf(planFileRoute(plan, primary, r.ref))} aria-current={sameFile(r.ref, onScreen) ? 'page' : undefined} onClick={routeClick(() => open(r.ref))} data-plan-file={r.key} />}
      presence={
        r.main ? (
          <span className="ib-plan-file-main" data-plan-file-main="">
            {PLAN_FILES_WORDS.main}
          </span>
        ) : undefined
      }
    />
  );
  return (
    <nav className="ib-plan-files" aria-label={PLAN_FILES_WORDS.panel} data-plan-files="">
      <FilesRailHeading label={PLAN_FILES_WORDS.pages} count={rows.pages.length} filterVisible={filtering} onToggleFilter={() => (filtering ? (setFiltering(false), setQuery('')) : setFiltering(true))} />
      {filtering && (
        <FilesRailFilter>
          <input ref={field} type="search" className="ib-plan-files-field" placeholder={PLAN_FILES_WORDS.filter} aria-label={PLAN_FILES_WORDS.filter} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onFieldKey} data-plan-files-query="" />
        </FilesRailFilter>
      )}
      {rows.pages.length === 0 ? (
        <FilesRailEmpty>{PLAN_FILES_WORDS.noPages}</FilesRailEmpty>
      ) : (
        <FilesRailRows>
          <div data-plan-files-pages="">{pages.map(row)}</div>
        </FilesRailRows>
      )}
      {rows.artifacts.length > 0 && (
        <>
          {/* The frame's heading always carries Filter files; a second one would repeat it, so this is the frame's eyebrow only. */}
          <div className="ib-plan-files-sec">
            <span className={EYEBROW}>{PLAN_FILES_WORDS.artifacts}</span> <span className="ib-plan-files-count">{rows.artifacts.length}</span>
          </div>
          <FilesRailRows>
            <div data-plan-files-artifacts="">{files.map(row)}</div>
          </FilesRailRows>
        </>
      )}
      {q && pages.length + files.length === 0 && (
        <div data-plan-files-none="">
          <FilesRailNoMatch>{noFileMatches(query.trim())}</FilesRailNoMatch>
        </div>
      )}
    </nav>
  );
}

/** The rail as our own sheet from the left, where a desktop pane cannot dock it: closes on a pick, Escape or the scrim. */
export function PlanFilesSheet({ open, onClose, name, ...props }: PlanFilesProps & { name: string; open: boolean; onClose: () => void }) {
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
      className="ib-plan-filesheet bg-card"
      aria-label={PLAN_FILES_WORDS.panel}
      onClose={onClose}
      onCancel={onClose}
      // A press on the scrim (the dialog itself, outside its panel) closes it.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      data-plan-files-sheet=""
    >
      {open && (
        <div className="ib-plan-filesheet-in">
          <PlanRailHead name={name} />
          <PlanFiles {...props} onPicked={onClose} />
        </div>
      )}
    </dialog>
  );
}
