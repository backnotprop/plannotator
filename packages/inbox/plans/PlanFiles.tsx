/**
 * A plan's left rail, from the shared frame (@plannotator/ui/components/frame, the Space page screen): the frame's
 * head (back to Plans and the plan's name, the project on a quiet line under it), its "Pages N" heading with Filter
 * files, and its file rows; the plan's main page first, marked "Main" at the row's end, then its other documents by
 * name; the frame's "Artifacts N" heading (no Filter of its own) only when it has some, by name. A row is a link to
 * its file (the address carries it). Read only: no file management, no shortcut. Docked, open, closed, its width
 * (drag or arrow keys) and its sheet (a phone, or a row too narrow to dock it) are the frame's (`DocumentRailShell`,
 * `RailSheet`, PlanPage.tsx).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { PlanArtifact, PlanDocument, PlanDocumentKind } from '@plannotator/core/plans';
import { FileRow, FilesRailFilter, FilesRailHeading, FilesRailNoMatch, FilesRailRows, FilesRailEmpty, PagesRailHead, fileIcon, type FileIconKind } from '@plannotator/ui/components/frame';
import { Icon } from '../icons';
import { hashOf, writeRoute } from '../app/writeRoute';
import { artifactKind, artifactName, byName, noFileMatches, PLAN_FILES_WORDS, type PlanArtifactKind, type PlanDecisionTone } from './words';
import { DecisionMark } from './parts';

/** The file on screen: a document (the main page when it is the plan's own) or an artifact. */
export type PlanFileRef = { kind: 'doc'; id: string } | { kind: 'artifact'; path: string };

/** The rail's open flag and width, in Plannotator's own storage (the frame's `DocumentRailShell` keys). */
export const PLAN_FILES_OPEN_KEY = 'plannotator-inbox-plan-files-open';
export const PLAN_FILES_WIDTH_KEY = 'plannotator-inbox-plan-files-width';

const DOC_ICON: Record<PlanDocumentKind, FileIconKind> = { markdown: 'markdown', html: 'html', mermaid: 'mermaid', graphviz: 'graphviz', image: 'image', data: 'other' };
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

/** The plan's current approval for the rail head: its words ("Approved", "v4 is new and not approved") and tone. */
export interface PlanRailDecision {
  words: string;
  tone: PlanDecisionTone;
}

/**
 * The frame's rail head: back to Plans, with the plan's name; on the quiet line under it the project (when it has
 * one), then the plan's current decision (when there is one), so it shows with the versions panel closed too.
 */
export function PlanRailHead({ name, project, decision }: { name: string; project: string | null; decision: PlanRailDecision | null }) {
  const title = [project, decision?.words].filter(Boolean).join(' · ');
  return (
    <PagesRailHead
      label={name}
      backLink={<a href={hashOf(plansRoute)} onClick={routeClick(() => writeRoute(plansRoute))} data-plan-files-back="" />}
      meta={
        project || decision ? (
          <span className="ib-plan-railmeta" title={title}>
            {project && (
              <span className="ib-plan-railproj" data-plan-rail-project="">
                <Icon name="folder" />
                <span>{project}</span>
              </span>
            )}
            {project && decision && (
              <span className="ib-plan-railsep" aria-hidden="true">
                ·
              </span>
            )}
            {decision && (
              <span className="ib-plan-raildec" data-plan-decision={decision.tone} data-plan-rail-decision="">
                <DecisionMark tone={decision.tone} />
                <span>{decision.words}</span>
              </span>
            )}
          </span>
        ) : null
      }
    />
  );
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
      trailing={
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
          {/* A second heading: the Filter above covers it (no onToggleFilter, no button). */}
          <div className="ib-plan-files-art" data-plan-files-art-heading="">
            <FilesRailHeading label={PLAN_FILES_WORDS.artifacts} count={rows.artifacts.length} countTitle={(n) => `${n} artifact${n === 1 ? '' : 's'}`} />
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
