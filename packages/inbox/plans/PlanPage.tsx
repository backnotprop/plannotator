/**
 * One plan (approval "inbox-plans"), drawn from the shared frame (@plannotator/ui/components/frame, the Space page
 * screen) on its ground (`FrameGround as="div"`, theme colours): its top bar outside the cards (the Inbox's sidebar
 * toggle, then Plans / the project / the plan on the main page, Plans / the plan / the file on another), and from
 * 768 px three cards: the frame's left rail with the plan's files (PlanFiles.tsx; its head's quiet line carries the
 * project and the plan's current decision), the frame's page card whose reading line says which version is on screen
 * (or which two are compared) and how many there are, holding the file (a Markdown page in the Inbox's own file viewer with its toolbars and comments, PlanAnnotate.tsx; a diagram or HTML page in PlanDocument.tsx; an artifact
 * by what it is, PlanArtifactView.tsx), with Edit, Approve and Restore and the approval's line in the reading line
 * (PlanEditing.tsx, approval "plans-editing"), and the frame's versions panel (PlanRail.tsx), open until the person closes
 * it (kept), reopened from the reading line. "Changed since you looked" compares with the version the person had
 * seen of that document when the page opened, and Show changes opens the diff from it to the newest. The address
 * carries the file (`&doc=`, `&file=`); the main page keeps the plan's own address. Short of room the rail gives way
 * first (the frame's sheet, `RailSheet docked={false}`), then the versions open as the frame's sheet; on a phone the
 * frame's sheets carry both. A write of the page's own (a version, an approval, a Send) reads the plan again in place.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { planApprovalState, planDecisionVersion, planDocumentFileName, type PlanDecision, type PlanDocument as PlanDocumentRecord, type PlanVersion } from '@plannotator/core/plans';
import { storage } from '@plannotator/ui/utils/storage';
import {
  AppRail,
  Breadcrumbs,
  DockedPanelClip,
  DocumentRailShell,
  FrameBox,
  FrameGround,
  PageCard,
  PageHeader,
  RailSheet,
  ReadingLine,
  VersionsSheet,
  useRailMotion,
} from '@plannotator/ui/components/frame';
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import { hashOf, writeRoute } from '../app/writeRoute';
import { plansApi, type PlanRead } from './client';
import type { PaneHostHandle } from '../parts/paneHost';
import { PlanBarTitle, PlanChromeContext, PlanMenu, planMenuItems, usePlanChrome, type PlanBarState, type PlanDocActs } from './PlanChrome';
import { recordPlanLook, useDocVersions, usePlan, usePlanShareOn } from './store';
import { PlanShare } from './PlanShare';
import { approvalTone, approvalWords, PLAN_FILES_WORDS } from './words';
import { usePlanEditing } from './PlanEditing';
import { flushQueuedPlanSent, planAgentOf } from './deliver';
import { useComposeSessions } from '../compose/useComposeSessions';
import { PlansMessage } from './parts';
import { closeSpace } from './spacesMotion';
import { PlanDocument } from './PlanDocument';
import { PlanAnnotate } from './PlanAnnotate';
import { PlanDiffView } from './PlanDiffView';
import { PlanArtifactView } from './PlanArtifactView';
import { ArtifactLine, PlanVersions } from './PlanRail';
import { PlanBar, PlanVersionsMark } from './PlanBar';
import { PlanDecisionMark } from './PlanDecision';
import { createPortal } from 'react-dom';
import { PLAN_FILES_OPEN_KEY, PLAN_FILES_WIDTH_KEY, PlanBackLink, PlanFiles, PlanRailHead, planFileRoute, type PlanFileRef, type PlanRailDecision } from './PlanFiles';

const plansRoute = { page: 'plans' as const, project: null, thread: null };
const toList = () => writeRoute(plansRoute);

/** The versions panel closed ('1', and before the person ever opened it) or open ('0'), kept on this computer as the rail's open flag is. */
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
  const [fresh, setFresh] = useState(0);
  const onChanged = useCallback(() => setFresh((n) => n + 1), []);
  const state = usePlan(props.id, retry, fresh);
  // A Send that went but was not recorded then (deliver.ts) is recorded now, and the plan read again.
  useEffect(() => {
    void flushQueuedPlanSent().then((landed) => landed > 0 && onChanged());
  }, [props.id, onChanged]);
  if (state.missing) return <PlansMessage title="This plan is not here" body="It may have been removed, or Spaces was turned off." onBack={toList} />;
  if (state.error) return <PlansMessage title="This plan could not be read" body={state.error} onRetry={() => setRetry((n) => n + 1)} onBack={toList} />;
  if (!state.read || !state.versions) return <PlansMessage busy title="Plan" body="Loading the plan…" onBack={toList} />;
  if (state.versions.length === 0) return <PlansMessage title={state.read.plan.name} body="This plan has no version yet." onBack={toList} />;
  return <PlanLoaded {...props} read={state.read} versions={state.versions} fresh={fresh} onChanged={onChanged} />;
}

/** The newest decision on each version of one document, and the newest of all. */
function decisionsOf(decisions: readonly PlanDecision[], doc: string): { byVersion: Map<number, PlanDecision>; newest: PlanDecision | null } {
  const byVersion = new Map<number, PlanDecision>();
  let newest: PlanDecision | null = null;
  for (const d of [...decisions].filter((d) => d.document_id === doc).sort((a, b) => a.at.localeCompare(b.at))) {
    byVersion.set(planDecisionVersion(d), d);
    newest = d;
  }
  return { byVersion, newest };
}

/** A kept yes/no, in Plannotator's own storage ('1' or '0'; `fallback` until one is kept). */
function useStoredFlag(key: string, fallback = false): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => {
    const kept = storage.getItem(key);
    return kept === null ? fallback : kept === '1';
  });
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

/** A computer's crumbs, the panel's back arrow first (approval P2); a phone's as they were. */
function PlanCrumbs({ back, children }: { back: ReactNode; children: ReactNode }) {
  return back ? (
    <span className="ib-plan-crumbs">
      {back}
      {children}
    </span>
  ) : (
    <>{children}</>
  );
}

/** The "Spaces" crumb: back to the home the plan was opened from, its document shrinking into its card (a plain click). */
function spacesLink(id: string): ReactElement<{ className?: string }> {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    closeSpace(id);
  };
  return <a href={hashOf(plansRoute)} onClick={onClick} data-plans-back="" />;
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

function PlanLoaded({ id, version, diff, phone, doc, file, read, versions, fresh, onChanged }: PlanPageProps & { read: PlanRead; versions: readonly PlanVersion[]; fresh: number; onChanged: () => void }) {
  const primary = read.plan.primary_doc_id;
  const artifacts = read.artifacts ?? [];
  const artifact = file ? (artifacts.find((a) => a.asset_path === file) ?? null) : null;
  const document = (doc && read.documents.find((d) => d.id === doc && !d.archived_at)) || read.documents.find((d) => d.id === primary)!;
  const onScreen: PlanFileRef = artifact ? { kind: 'artifact', path: artifact.asset_path } : { kind: 'doc', id: document.id };
  const project = read.plan.project_name;

  // The row's room: the versions dock while the document keeps PLAN_DOC_MIN beside them; the rail docks while it
  // keeps that beside both. Narrower, the rail gives way first (the frame's sheet), then the versions (the frame's
  // sheet). The rail's open flag is ours (the frame's key and format), so a rail that does not fit draws no tab that
  // would open nothing, and the person's choice waits for a row that fits.
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const rowWidth = useWidth(row);
  // Closed until the person opens it from the bar's clock (approval A2); once opened it stays open until they close it.
  const [versionsHidden, setVersionsHidden] = useStoredFlag(PLAN_RAIL_HIDDEN_KEY, true);
  const [versionsSheet, setVersionsSheet] = useState(false);
  const versionsFit = !phone && (rowWidth === 0 || rowWidth - VERSIONS_WIDTH - CARD_GAP >= PLAN_DOC_MIN);
  const versionsDocked = versionsFit && !versionsHidden;
  const sideWidth = versionsDocked ? VERSIONS_WIDTH + CARD_GAP : 0;
  const railFits = useCallback((railWidth: number) => rowWidth === 0 || rowWidth - railWidth - CARD_GAP - sideWidth >= PLAN_DOC_MIN, [rowWidth, sideWidth]);
  const [railDocks, setRailDocks] = useState(!phone);
  const [filesOpen, setFilesOpen] = useStoredFlag(PLAN_FILES_OPEN_KEY, true);
  useEffect(() => {
    if (versionsFit) setVersionsSheet(false);
  }, [versionsFit]);
  const place: VersionsPlace = versionsFit
    ? { docked: true, open: !versionsHidden, setOpen: (open) => setVersionsHidden(!open) }
    : { docked: false, open: versionsSheet, setOpen: setVersionsSheet };

  const filesProps = { plan: id, primary, documents: read.documents, artifacts, onScreen };
  // The top bar: Plans / the project / the plan on its main page (the project is words: the Plans list has no address
  // for one project); Plans / the plan / the file on another (its path when it has one).
  const onMain = !artifact && document.id === primary;
  const fileName = artifact ? artifact.asset_path : document.doc_path || document.title || read.plan.name;
  // The plan's approval on its main page's newest version, in the rail head so it shows with the versions closed. An
  // approval of an older version is never current (approval "plans-editing"): "v4 is new and not approved".
  const mainHead = versions[versions.length - 1]!.version_number;
  const planApproval = planApprovalState(read.events, primary, mainHead, { cleared: read.plan.last_approval_cleared, moved: read.plan.last_approval_moved });
  const railDecision: PlanRailDecision | null = planApproval.kind === 'none' ? null : { words: approvalWords(planApproval), tone: approvalTone(planApproval) };
  const head = <PlanRailHead name={read.plan.name} project={project} decision={railDecision} />;
  // Share this space (approval "share-this-space"): at the right end of the top bar, only while its switch is on. On a
  // phone it sits in the bar's own end slot, so it stays on the first row.
  const shareOn = usePlanShareOn();
  const share = shareOn ? <PlanShare id={id} phone={phone} fresh={fresh} /> : null;
  // The header (approval "inbox-plan-page-header-a3", PlanChrome.tsx). A phone: the bar holds the project (the plan's
  // name once the document's title is out of view), Share and the page's menu, which holds Files and the document's
  // actions; the document hands those up (`acts`) and says whether its state line is above its title (`bar.a3`).
  const acts = useRef<PlanDocActs | null>(null);
  const [bar, setBar] = useState<PlanBarState>({ a3: false, shown: null, away: null, line: null, editing: false });
  const [marks, setMarks] = useState<HTMLSpanElement | null>(null);
  const chrome = useMemo(() => ({ acts, setBar, marks }), [marks]);
  const [filesSheet, setFilesSheet] = useState(false);
  const fileCount = read.documents.filter((d) => !d.archived_at).length + artifacts.length;
  const menu = phone ? <PlanMenu phone items={() => planMenuItems({ phone: true, acts: acts.current, files: { count: fileCount, open: () => setFilesSheet(true) }, close: toList })} /> : null;
  const band = (
    <AppRail
      variant="dense"
      account={
        phone ? (
          <>
            <span className="ib-plan-topmarks" ref={setMarks} data-plan-topmarks="" />
            {share}
            {menu}
          </>
        ) : null
      }
      leading={
        <>
          <SidebarTrigger />
          {/* A computer: the panel has no head (approval P2), its back arrow is the crumbs' first; a phone's sheet keeps it. */}
          <RailSheet closeKey={`${document.id}:${file ?? ''}`} docked={railDocks ? undefined : false} head={phone ? head : null} triggerLabel={PLAN_FILES_WORDS.show} triggerTitle={PLAN_FILES_WORDS.panel} title={PLAN_FILES_WORDS.panel} description="This plan's pages and artifacts." open={filesSheet} onOpenChange={setFilesSheet} trigger={!phone}>
            <PlanFiles {...filesProps} />
          </RailSheet>
        </>
      }
    >
      <PageHeader
        identity={
          // While editing, a phone's bar is Done and Cancel and "…": crumbs cut to a few letters say nothing, so there
          // are none (the page's region keeps the plan's name, `aria-label` below).
          phone && bar.editing ? null : phone && bar.line ? (
            <span className="ib-plan-barline" role="status" data-plan-barline="">
              {bar.line}
            </span>
          ) : phone && bar.a3 ? (
            <PlanBarTitle rest={project ?? 'Spaces'} name={read.plan.name} away={bar.away} shown={bar.shown} versionsOpen={place.open} onVersions={place.setOpen} />
          ) : (
            <PlanCrumbs back={phone ? null : <PlanBackLink />}>
              {onMain && project ? (
                <Breadcrumbs root={{ label: 'Spaces', link: spacesLink(id) }} collectionName={project} collectionLink={<span data-plan-crumb-project="" />} path={read.plan.name} />
              ) : onMain ? (
                <Breadcrumbs collectionName="Spaces" collectionLink={spacesLink(id)} path={read.plan.name} />
              ) : (
                // Another page: the crumbs have three places (Spaces, the plan, the file), and with the panel's head gone
                // on a computer the project would be nowhere on screen, so it joins the first crumb there.
                <Breadcrumbs root={{ label: !phone && project ? `Spaces / ${project}` : 'Spaces', link: spacesLink(id) }} collectionName={read.plan.name} collectionLink={routeLink(planFileRoute(id, primary, { kind: 'doc', id: primary }))} path={fileName} />
              )}
            </PlanCrumbs>
          )
        }
        actions={phone ? null : share}
      />
    </AppRail>
  );
  return (
    <PlanChromeContext.Provider value={chrome}>
    <FrameGround as="div" colors="theme">
      <section className="ib-plans ib-plan-page" aria-label={read.plan.name} data-plan-page={id} data-phone={phone ? '' : undefined} data-files={railDocks ? (filesOpen ? 'docked' : 'closed') : phone ? 'phone' : 'sheet'} data-rail={place.docked ? (place.open ? 'docked' : 'closed') : phone ? 'phone' : 'sheet'} data-plan-header={phone && bar.a3 ? (bar.away ? 'name' : 'project') : undefined}>
        <FrameBox band={band} rowRef={setRow}>
          <DocumentRailShell
            head={null}
            defaults={{ open: true }}
            enabled={!phone}
            fitsForWidth={railFits}
            onFitChange={setRailDocks}
            open={filesOpen}
            // Short of room our own sheet (RailSheet docked={false}) is the way to the files: the frame shows no tab then.
            narrowRail="host"
            onOpenChange={setFilesOpen}
            storageKeys={{ open: PLAN_FILES_OPEN_KEY, width: PLAN_FILES_WIDTH_KEY }}
          >
            <PlanFiles {...filesProps} />
          </DocumentRailShell>
          {artifact ? (
            <PageCard top={<ArtifactLine artifact={artifact} />}>
              <div className="ib-plan-cardbody">
                <PlanArtifactView id={id} artifact={artifact} />
              </div>
            </PageCard>
          ) : (
            <DocPane key={document.id} id={id} document={document} primary={primary} read={read} mainVersions={versions} version={version} diff={diff} place={place} phone={phone} fresh={fresh} onChanged={onChanged} />
          )}
        </FrameBox>
      </section>
    </FrameGround>
    </PlanChromeContext.Provider>
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
  phone,
  fresh,
  onChanged,
}: {
  id: string;
  document: PlanDocumentRecord;
  primary: string;
  read: PlanRead;
  mainVersions: readonly PlanVersion[];
  version: number | null;
  diff: { from: number; to: number } | null;
  place: VersionsPlace;
  phone: boolean;
  fresh: number;
  onChanged: () => void;
}) {
  const isMain = document.id === primary;
  const [retry, setRetry] = useState(0);
  const other = useDocVersions(id, isMain ? null : document.id, retry, fresh);
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
  return <DocLoaded id={id} document={document} isMain={isMain} read={read} versions={versions} version={version} diff={diff} place={place} phone={phone} onChanged={onChanged} />;
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
  phone,
  onChanged,
}: {
  id: string;
  document: PlanDocumentRecord;
  isMain: boolean;
  read: PlanRead;
  versions: readonly PlanVersion[];
  version: number | null;
  diff: { from: number; to: number } | null;
  place: VersionsPlace;
  phone: boolean;
  onChanged: () => void;
}) {
  const head = versions[versions.length - 1]!.version_number;
  // What the person had seen of this document when the page opened: the look recorded below must not move it.
  // The person's own version (an edit or a Restore, always made on the newest) is seen by making it.
  const [lookedAtOpen] = useState<number | null>(() => read.look?.docs[document.id] ?? null);
  const ownLast = versions.reduce((n, v) => (v.source === 'person' ? Math.max(n, v.version_number) : n), 0);
  const seenAtOpen = lookedAtOpen === null ? null : Math.max(lookedAtOpen, ownLast);
  const known = (n: number | null | undefined) => !!n && versions.some((v) => v.version_number === n);
  const compare = diff && known(diff.from) && known(diff.to) ? { from: Math.min(diff.from, diff.to), to: Math.max(diff.from, diff.to) } : null;
  const shown = compare ? compare.to : known(version) ? version! : head;
  const { byVersion } = useMemo(() => decisionsOf(read.decisions, document.id), [read.decisions, document.id]);
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
  // Whom Send goes to, as the page reads the Inbox's live sessions (found again as it is pressed).
  const live = useComposeSessions(true).model;
  const agent = useMemo(() => planAgentOf(read.plan, versions, live), [read.plan, versions, live]);
  const editing = usePlanEditing({ read, document, docRef, versions, head, shown, comparing: !!compare, onChanged, toNewest: () => go({ version: null }), showChanges: (from, to) => go({ diff: { from, to } }) });
  // An older version is read, compared or restored (approval "plans-editing"): never edited.
  const older = !compare && shown !== head ? { back: routeLink(routeOf({ version: null }), { 'data-plan-newest': '' }, { replace: true }), restore: editing.restore } : null;

  // The header (approval "inbox-plan-page-header-a3", PlanChrome.tsx). The Markdown file pane, out of full screen,
  // draws its controls in the page's bars; its Viewer's actions are reached through `paneHandle`.
  const chrome = usePlanChrome();
  const [full, setFull] = useState(false);
  const paneHandle = useRef<PaneHostHandle | null>(null);
  const contentsOpen = useRef<((back: HTMLElement | null) => void) | null>(null);
  const onContents = useCallback((open: ((back: HTMLElement | null) => void) | null) => void (contentsOpen.current = open), []);
  const annotated = document.kind === 'markdown' && !compare && !editing.editing;
  // A phone on the main page's newest version, read: the document's own title is the header (A3).
  const a3 = phone && isMain && annotated && shown === head;
  const pageActs: PlanDocActs = {
    older: phone && older ? { head, shown, back: () => go({ version: null }), restore: editing.restoreNow } : null,
    edit: phone ? editing.edit : null,
    versions: phone && editing.editing ? () => place.setOpen(true) : null,
    pane: annotated ? paneHandle : null,
    get contents() {
      return phone && annotated ? contentsOpen.current : null;
    },
    download: annotated ? { href: plansApi.versionUrl(id, shown, docRef), name: planDocumentFileName(document) } : null,
    full: !phone && annotated ? () => setFull(true) : null,
  };
  useLayoutEffect(() => {
    if (!chrome) return;
    chrome.acts.current = pageActs;
    return () => void (chrome.acts.current = null);
  });
  // A phone's one bar says what is on screen when it is not the newest version (the frame's reading line's words).
  const line = !phone ? null : compare ? `Comparing v${compare.from} with v${compare.to}` : older ? `v${shown} of ${head}, an older version` : null;
  const barEditing = phone && editing.editing;
  useEffect(() => {
    chrome?.setBar((b) => (b.a3 === a3 && b.shown === shown && b.line === line && b.editing === barEditing ? b : { ...b, a3, shown, line, editing: barEditing }));
  }, [chrome, a3, shown, line, barEditing]);
  useEffect(() => () => chrome?.setBar(() => ({ a3: false, shown: null, away: null, line: null, editing: false })), [chrome]);
  const onTitleAway = useCallback((away: boolean) => chrome?.setBar((b) => (b.away === away ? b : { ...b, away })), [chrome]);
  const decisionMark = <PlanDecisionMark info={editing.decision} phone={phone} />;
  // A phone: Approve, the decision's mark and the clock are the top bar's, nothing under it. While editing, Done and
  // Cancel take their room (a 320 px bar holds no more): the clock is a row of "…", the mark and Share wait for Done.
  const topMarks =
    phone && chrome?.marks
      ? createPortal(
          <>
            {editing.start}
            {!editing.editing && decisionMark}
            {!editing.editing && <PlanVersionsMark shown={shown} head={head} open={place.open} onToggle={place.setOpen} phone />}
          </>,
          chrome.marks,
        )
      : null;
  const menu = phone ? null : <PlanMenu phone={false} items={() => planMenuItems({ phone: false, acts: pageActs, files: null, close: toList })} />;
  const annotateChrome = { full, onFull: setFull, handle: paneHandle, a3, onContents, onTitleAway: a3 ? onTitleAway : null };
  return (
    <>
      {topMarks}
      <PageCard
        top={
          phone ? null : (
          <div data-plan-reading="" className="ib-plan-reading">
            {compare ? (
              <ReadingLine shownNumber={shown} currentNumber={head} versionsOpen={place.open} onToggleVersions={place.setOpen} older={null} comparing={`Comparing v${compare.from} with v${compare.to}`} count={versions.length} start={null} approved={decisionMark} />
            ) : (
              // The bar (approval A2): nothing on the left; Approve, the decision's mark, the pencil, the clock and the menu at the end.
              <PlanBar shown={shown} head={head} start={editing.start} decision={decisionMark} edit={editing.edit} busy={editing.busy} older={older} versionsOpen={place.open} onVersions={place.setOpen} menu={menu} />
            )}
          </div>
          )
        }
      >
        <div className="ib-plan-cardbody">
          {editing.banner}
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
          ) : changedSince && !editing.editing && !editing.kept ? (
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
            ) : editing.editing ? (
              editing.editor
            ) : (
              document.kind === 'markdown' ? (
                // A Markdown page in the Inbox's own file viewer, with its toolbars and comments (PlanAnnotate.tsx); × goes back to Plans.
                <PlanAnnotate read={read} document={document} docRef={docRef} versions={versions} shown={shown} phone={phone} agent={agent} onClose={toList} onChanged={onChanged} chrome={annotateChrome} />
              ) : (
                <PlanDocument id={id} version={shown} doc={docRef} kind={document.kind} title={document.title} phone={phone} />
              )
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

