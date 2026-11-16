/**
 * One plan (approval "inbox-plans"), drawn from the shared frame (@plannotator/ui/components/frame, the Space page
 * screen): its top bar outside the cards (the Inbox's sidebar toggle, then Plans / the plan / the file), and from
 * 768 px three cards on the ground: the frame's left rail with the plan's files (PlanFiles.tsx), the frame's page
 * card whose reading line says which version is on screen, holding the file (a Markdown page in the Inbox's own
 * reader, PlanDocument.tsx; an artifact by what it is, PlanArtifactView.tsx), and the frame's versions panel
 * (PlanRail.tsx), open until the person closes it (kept), reopened from the reading line. "Changed since you looked"
 * compares with the version the person had seen of that document when the page opened, and Show changes opens the
 * diff from it to the newest. The address carries the file (`&doc=`, `&file=`); the main page keeps the plan's own
 * address. Short of room the rail gives way first (our sheet from the left), then the versions open as the frame's
 * sheet; on a phone the frame's sheets carry both. Comments, Send and the plan's thread come later.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type MouseEvent, type ReactElement } from 'react';
import type { PlanDecision, PlanDocument as PlanDocumentRecord, PlanVersion } from '@plannotator/core/plans';
import { storage } from '@plannotator/ui/utils/storage';
import {
  AppRail,
  Breadcrumbs,
  DockedPanelClip,
  DocumentRailShell,
  FrameBox,
  FrameButton,
  PageCard,
  PageHeader,
  RailSheet,
  ReadingLine,
  VersionsSheet,
  savedRailWidth,
  useRailMotion,
} from '@plannotator/ui/components/frame';
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import { hashOf, writeRoute } from '../app/writeRoute';
import type { PlanRead } from './client';
import { recordPlanLook, useDocVersions, usePlan } from './store';
import { changedSinceDecision, decisionLabel, decisionTone, PLAN_FILES_WORDS } from './words';
import { DecisionMark, PlansMessage } from './parts';
import { PlanDocument } from './PlanDocument';
import { PlanDiffView } from './PlanDiffView';
import { PlanArtifactView } from './PlanArtifactView';
import { ArtifactLine, PlanVersions } from './PlanRail';
import { PLAN_FILES_OPEN_KEY, PLAN_FILES_WIDTH_KEY, PlanFiles, PlanFilesSheet, PlanRailHead, planFileRoute, type PlanFileRef } from './PlanFiles';

const plansRoute = { page: 'plans' as const, project: null, thread: null };
const toList = () => writeRoute(plansRoute);

/** The versions panel closed by the person (its Close), kept on this computer as the rail's open flag is. */
export const PLAN_RAIL_HIDDEN_KEY = 'plannotator-inbox-plan-rail-hidden';
/** The frame's docked versions panel (`VersionsPanel`, md:w-72). */
const VERSIONS_WIDTH = 288;
/** The frame row's gap between cards (frame.css). */
const CARD_GAP = 8;
/** The document's least width beside the docked rail and versions; narrower, the rail gives way, then the versions. */
export const PLAN_DOC_MIN = 480;

export interface PlanPageProps {
  id: string;
  /** The version asked for (`&v=`); null: the newest. */
  version: number | null;
  diff: { from: number; to: number } | null;
  phone: boolean;
  /** Another document on screen (`&doc=`); null: the main page. */
  doc?: string | null;
  /** An artifact on screen (`&file=`). */
  file?: string | null;
}

export function PlanPage(props: PlanPageProps) {
  const [retry, setRetry] = useState(0);
  const state = usePlan(props.id, retry);
  if (state.missing) return <PlansMessage title="This plan is not here" body="It may have been removed, or Plans was turned off." onBack={toList} />;
  if (state.error) return <PlansMessage title="This plan could not be read" body={state.error} onRetry={() => setRetry((n) => n + 1)} onBack={toList} />;
  if (!state.read || !state.versions) return <PlansMessage busy title="Plan" body="Loading the plan…" onBack={toList} />;
  if (state.versions.length === 0) return <PlansMessage title={state.read.plan.name} body="This plan has no version yet." onBack={toList} />;
  return <PlanLoaded {...props} read={state.read} versions={state.versions} />;
}

/** The newest decision on each version of one document, and the newest of all. */
function decisionsOf(decisions: readonly PlanDecision[], doc: string): { byVersion: Map<number, PlanDecision>; newest: PlanDecision | null } {
  const byVersion = new Map<number, PlanDecision>();
  let newest: PlanDecision | null = null;
  for (const d of [...decisions].filter((d) => d.document_id === doc).sort((a, b) => a.at.localeCompare(b.at))) {
    if (d.version_number) byVersion.set(d.version_number, d);
    newest = d;
  }
  return { byVersion, newest };
}

/** A kept yes/no, in Plannotator's own storage. */
function useStoredFlag(key: string): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => storage.getItem(key) === '1');
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      storage.setItem(key, next ? '1' : '0');
    },
    [key],
  );
  return [value, set];
}

/** An element's width as it changes (0 before layout, or where nothing measures). */
function useWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return width;
}

/** A link the router follows in place (a plain click), and the browser opens elsewhere (a modified click). */
function routeLink(route: Parameters<typeof writeRoute>[0], attrs: Record<string, string> = {}, options?: { replace?: boolean }, after?: () => void): ReactElement<{ className?: string }> {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    writeRoute(route, options);
    after?.();
  };
  return <a href={hashOf(route)} onClick={onClick} {...attrs} />;
}

/** Where the versions are: docked beside the page card, the frame's sheet (a phone, or no room to dock), or none. */
interface VersionsPlace {
  docked: boolean;
  /** Docked: kept open or closed. Sheet: open now. */
  open: boolean;
  setOpen: (open: boolean) => void;
}

function PlanLoaded({ id, version, diff, phone, doc, file, read, versions }: PlanPageProps & { read: PlanRead; versions: readonly PlanVersion[] }) {
  const primary = read.plan.primary_doc_id;
  const artifacts = read.artifacts ?? [];
  const artifact = file ? (artifacts.find((a) => a.asset_path === file) ?? null) : null;
  const document = (doc && read.documents.find((d) => d.id === doc && !d.archived_at)) || read.documents.find((d) => d.id === primary)!;
  const onScreen: PlanFileRef = artifact ? { kind: 'artifact', path: artifact.asset_path } : { kind: 'doc', id: document.id };
  const project = read.plan.project_name;

  // The row's room: the versions dock while the document keeps PLAN_DOC_MIN beside them; the rail docks while it
  // keeps that beside both. Narrower, the rail gives way first (our sheet), then the versions (the frame's sheet).
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const rowWidth = useWidth(row);
  const [versionsHidden, setVersionsHidden] = useStoredFlag(PLAN_RAIL_HIDDEN_KEY);
  const [versionsSheet, setVersionsSheet] = useState(false);
  const versionsFit = !phone && (rowWidth === 0 || rowWidth - VERSIONS_WIDTH - CARD_GAP >= PLAN_DOC_MIN);
  const versionsDocked = versionsFit && !versionsHidden;
  const sideWidth = versionsDocked ? VERSIONS_WIDTH + CARD_GAP : 0;
  const railFits = useCallback((railWidth: number) => rowWidth === 0 || rowWidth - railWidth - CARD_GAP - sideWidth >= PLAN_DOC_MIN, [rowWidth, sideWidth]);
  const railDocks = !phone && railFits(savedRailWidth(PLAN_FILES_WIDTH_KEY));
  const [filesSheet, setFilesSheet] = useState(false);
  useEffect(() => {
    if (railDocks || phone) setFilesSheet(false);
  }, [railDocks, phone]);
  useEffect(() => {
    if (versionsFit) setVersionsSheet(false);
  }, [versionsFit]);
  const place: VersionsPlace = versionsFit
    ? { docked: true, open: !versionsHidden, setOpen: (open) => setVersionsHidden(!open) }
    : { docked: false, open: versionsSheet, setOpen: setVersionsSheet };

  const filesProps = { plan: id, primary, documents: read.documents, artifacts, onScreen };
  // The top bar: Plans / the plan on its main page; Plans / the plan / the file on another (its path when it has one).
  const onMain = !artifact && document.id === primary;
  const fileName = artifact ? artifact.asset_path : document.doc_path || document.title || read.plan.name;
  const head = <PlanRailHead name={read.plan.name} />;
  const band = (
    <AppRail
      variant="dense"
      leading={
        <>
          <SidebarTrigger />
          <RailSheet closeKey={`${document.id}:${file ?? ''}`} head={head} triggerLabel={PLAN_FILES_WORDS.show} triggerTitle={PLAN_FILES_WORDS.panel} title={PLAN_FILES_WORDS.panel} description="This plan's pages and artifacts.">
            <PlanFiles {...filesProps} />
          </RailSheet>
        </>
      }
    >
      <PageHeader
        identity={
          onMain ? (
            <Breadcrumbs collectionName="Plans" collectionLink={routeLink(plansRoute, { 'data-plans-back': '' })} path={read.plan.name} />
          ) : (
            <Breadcrumbs root={{ label: 'Plans', link: routeLink(plansRoute, { 'data-plans-back': '' }) }} collectionName={read.plan.name} collectionLink={routeLink(planFileRoute(id, primary, { kind: 'doc', id: primary }))} path={fileName} />
          )
        }
        actions={
          !railDocks && !phone ? (
            <FrameButton variant="ghost" size="xs" onClick={() => setFilesSheet(true)} aria-label={PLAN_FILES_WORDS.show} data-plan-show-files="">
              <Icon name="contents" />
              {PLAN_FILES_WORDS.show}
            </FrameButton>
          ) : null
        }
      />
    </AppRail>
  );
  return (
    <section className="ib-plans ib-plan-shell" aria-label={read.plan.name} data-plan-page={id} data-phone={phone ? '' : undefined} data-files={railDocks ? 'docked' : 'hidden'} data-rail={place.docked ? (place.open ? 'docked' : 'closed') : phone ? 'phone' : 'sheet'}>
      <FrameBox band={band} rowRef={setRow}>
        <DocumentRailShell head={head} defaults={{ open: true }} enabled={!phone} fitsForWidth={railFits} storageKeys={{ open: PLAN_FILES_OPEN_KEY, width: PLAN_FILES_WIDTH_KEY }}>
          <PlanFiles {...filesProps} />
        </DocumentRailShell>
        {artifact ? (
          <PageCard top={<ArtifactLine artifact={artifact} />}>
            <div className="ib-plan-cardbody">
              <PlanArtifactView id={id} artifact={artifact} />
            </div>
          </PageCard>
        ) : (
          <DocPane key={document.id} id={id} document={document} primary={primary} read={read} mainVersions={versions} version={version} diff={diff} place={place} project={project} phone={phone} />
        )}
      </FrameBox>
      {!railDocks && !phone && <PlanFilesSheet {...filesProps} name={read.plan.name} open={filesSheet} onClose={() => setFilesSheet(false)} />}
    </section>
  );
}

/** The page card and the versions for a document: its versions, its decision, its diff. */
function DocPane({
  id,
  document,
  primary,
  read,
  mainVersions,
  version,
  diff,
  place,
  project,
  phone,
}: {
  id: string;
  document: PlanDocumentRecord;
  primary: string;
  read: PlanRead;
  mainVersions: readonly PlanVersion[];
  version: number | null;
  diff: { from: number; to: number } | null;
  place: VersionsPlace;
  project: string | null;
  phone: boolean;
}) {
  const isMain = document.id === primary;
  const [retry, setRetry] = useState(0);
  const other = useDocVersions(id, isMain ? null : document.id, retry);
  const versions = isMain ? mainVersions : other.versions;
  const state = (body: ReactElement) => (
    <PageCard>
      <div className="ib-plan-cardbody">{body}</div>
    </PageCard>
  );
  if (!isMain && other.error) {
    return state(
      <div className="ib-plan-docstate" role="alert">
        <p>
          {document.title} could not be read. {other.error}
        </p>
        <button type="button" className="ib-plans-quiet" onClick={() => setRetry((n) => n + 1)}>
          Try again
        </button>
      </div>,
    );
  }
  if (!versions) {
    return state(
      <div className="ib-plan-docstate" role="status" aria-busy="true">
        <p>Loading {document.title}…</p>
      </div>,
    );
  }
  if (versions.length === 0) {
    return state(
      <div className="ib-plan-docstate">
        <p>{document.title} has no version yet.</p>
      </div>,
    );
  }
  return <DocLoaded id={id} document={document} isMain={isMain} read={read} versions={versions} version={version} diff={diff} place={place} project={project} phone={phone} />;
}

function DocLoaded({
  id,
  document,
  isMain,
  read,
  versions,
  version,
  diff,
  place,
  project,
  phone,
}: {
  id: string;
  document: PlanDocumentRecord;
  isMain: boolean;
  read: PlanRead;
  versions: readonly PlanVersion[];
  version: number | null;
  diff: { from: number; to: number } | null;
  place: VersionsPlace;
  project: string | null;
  phone: boolean;
}) {
  const head = versions[versions.length - 1]!.version_number;
  // What the person had seen of this document when the page opened: the look recorded below must not move it.
  const [seenAtOpen] = useState<number | null>(() => read.look?.docs[document.id] ?? null);
  const known = (n: number | null | undefined) => !!n && versions.some((v) => v.version_number === n);
  const compare = diff && known(diff.from) && known(diff.to) ? { from: Math.min(diff.from, diff.to), to: Math.max(diff.from, diff.to) } : null;
  const shown = compare ? compare.to : known(version) ? version! : head;
  const { byVersion, newest } = useMemo(() => decisionsOf(read.decisions, document.id), [read.decisions, document.id]);
  const docRef = isMain ? null : document.id;
  const motion = useRailMotion(place.docked && place.open, VERSIONS_WIDTH);

  // Reading a version is seeing it (the store keeps the highest seen).
  useEffect(() => recordPlanLook(id, shown, docRef), [id, shown, docRef]);

  const fileRoute = planFileRoute(id, read.plan.primary_doc_id, { kind: 'doc', id: document.id });
  const routeOf = (next: { version?: number | null; diff?: { from: number; to: number } | null }) => ({ ...fileRoute, planVersion: next.version && next.version !== head ? next.version : null, planDiff: next.diff ?? null });
  const go = (next: { version?: number | null; diff?: { from: number; to: number } | null }) => writeRoute(routeOf(next), { replace: true });
  const closeSheet = () => {
    if (!place.docked) place.setOpen(false);
  };
  const changedSince = seenAtOpen !== null && seenAtOpen < head;
  const since = changedSince ? head - seenAtOpen! : 0;
  const copyLink = (n: number) => {
    const url = `${window.location.href.split('#')[0]}${hashOf({ ...fileRoute, planVersion: n, planDiff: null })}`;
    void navigator.clipboard?.writeText(url).catch(() => {});
  };
  const panel = (
    <PlanVersions
      versions={versions}
      documentId={document.id}
      read={read}
      shown={shown}
      head={head}
      seen={seenAtOpen}
      compare={compare}
      decisions={byVersion}
      rowLink={(n) => routeLink(routeOf({ version: n }), { 'data-plan-version': String(n) }, { replace: true })}
      onPicked={closeSheet}
      onCompare={(from, to) => {
        go({ diff: { from, to } });
        closeSheet();
      }}
      onCopyLink={copyLink}
      onClose={() => place.setOpen(false)}
    />
  );
  const decision = (isMain || newest || project) && (
    <span className="ib-plan-readend">
      {project && <span className="ib-plan-project">{project}</span>}
      {(isMain || newest) && (
    <span className="ib-plan-decision" data-plan-decision={decisionTone(newest?.decision)}>
      <DecisionMark tone={decisionTone(newest?.decision)} />
      {decisionLabel(newest?.decision)}
      {newest?.version_number ? (
        <span className="ib-plan-on">
          {' '}
          on v{newest.version_number}
          {changedSinceDecision(newest, head)}
        </span>
      ) : null}
    </span>
      )}
    </span>
  );
  const older = !compare && shown !== head ? { back: routeLink(routeOf({ version: null }), { 'data-plan-newest': '' }, { replace: true }), restore: null } : null;
  return (
    <>
      <PageCard
        top={
          <div data-plan-reading="" className="ib-plan-reading">
            <ReadingLine shownNumber={shown} currentNumber={head} versionsOpen={place.open} onToggleVersions={place.setOpen} approved={decision || null} older={older} />
          </div>
        }
      >
        <div className="ib-plan-cardbody">
          {compare ? (
            <div className="ib-plan-banner" data-plan-banner="diff">
              <Icon name="sideBySide" />
              <p>
                Showing what changed from <b>v{compare.from}</b>
                {compare.from === seenAtOpen ? ', the one you saw,' : ''} to <b>v{compare.to}</b>.
              </p>
              <button type="button" className="ib-plans-quiet" onClick={() => go({ version: compare.to })} data-plan-only="">
                Show v{compare.to} only
              </button>
            </div>
          ) : changedSince ? (
            <div className="ib-plan-banner" data-plan-banner="changed">
              <Icon name="eye" />
              <p>
                <b>Changed since you looked.</b> You saw v{seenAtOpen}. {since === 1 ? `v${head} came since.` : `v${seenAtOpen! + 1} to v${head} came since.`}
              </p>
              <button type="button" className="ib-plans-soft" onClick={() => go({ diff: { from: seenAtOpen!, to: head } })} data-plan-show-changes="">
                Show changes
              </button>
            </div>
          ) : null}
          <div className="ib-plan-doc">
            {compare ? (
              <PlanDiffView id={id} from={compare.from} to={compare.to} doc={docRef} kind={document.kind} />
            ) : (
              <PlanDocument id={id} version={shown} doc={docRef} kind={document.kind} title={document.title} phone={phone} />
            )}
          </div>
        </div>
      </PageCard>
      {place.docked ? (
        motion.mounted && <DockedPanelClip motion={motion}>{panel}</DockedPanelClip>
      ) : (
        <VersionsSheet open={place.open} onClose={() => place.setOpen(false)}>
          {panel}
        </VersionsSheet>
      )}
    </>
  );
}

