/**
 * One plan (approval "inbox-plans", layout B, with a left panel), in one pane as Shape's page: the plan's files a
 * column on the left (PlanFiles.tsx), the file on screen in the middle, and a right rail with that file's versions and
 * its own activity; one top bar across. A document is drawn by the document UI's own Viewer, read only; an artifact
 * by what it is (PlanArtifactView.tsx). The header says which version is being read ("Reading v5 · newest");
 * versions change only in the rail. "Changed since you looked" compares with the version the person had seen of that
 * document when the page opened, and Show changes opens the diff from it to the newest. The address carries the file
 * (`&doc=`, `&file=`); the main page keeps the plan's own address. The rail closes from its head (kept), and
 * "Versions N" on the top bar opens it again. Short of room the rail floats from the top bar first; the files go to a sheet only when even their least width does not fit. On a phone the rail is a bar at the
 * bottom that opens as a sheet, and the files open from the top bar as a sheet from the left. Comments, Send and the
 * plan's thread come later.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PlanArtifact, PlanDecision, PlanDocument as PlanDocumentRecord, PlanVersion } from '@plannotator/core/plans';
import { storage } from '@plannotator/ui/utils/storage';
import { SidebarTrigger } from '../shell/sidebar';
import { CollapsibleEdge, ResizeHandle } from '../shell/CollapsibleEdge';
import { useResizablePanel } from '../shell/useResizablePanel';
import { Icon } from '../icons';
import { writeRoute } from '../app/writeRoute';
import { BottomSheet } from '../components/BottomSheet';
import { Tip } from '../components/Tip';
import type { PlanRead } from './client';
import { recordPlanLook, useDocVersions, usePlan } from './store';
import { artifactKindLabel, artifactName, changedSinceDecision, decisionLabel, decisionTone, PLAN_FILES_WORDS, PLAN_RAIL_WORDS, sizeWords } from './words';
import { DecisionMark, PlansMessage } from './parts';
import { PlanDocument } from './PlanDocument';
import { PlanDiffView } from './PlanDiffView';
import { PlanArtifactView } from './PlanArtifactView';
import { ArtifactRail, PlanRail } from './PlanRail';
import {
  PLAN_DOC_MIN,
  PLAN_FILES_DEFAULT,
  PLAN_FILES_HIDDEN_KEY,
  PLAN_FILES_MAX,
  PLAN_FILES_MIN,
  PLAN_FILES_WIDTH_KEY,
  PlanFiles,
  PlanFilesSheet,
  planFileRoute,
  type PlanFileRef,
} from './PlanFiles';

const toList = () => writeRoute({ page: 'plans', project: null, thread: null });

/** The right rail's width with its hairline (plans.css `.ib-plan-rail`). */
const RAIL_WIDTH = 341;
/** The document's room beside a docked rail: narrower, the rail floats from the top bar instead. */
const PLAN_DOC_ROOM = 560;

/** The rail closed by the person (its Hide versions), kept on this computer as the files panel's fold is. */
export const PLAN_RAIL_HIDDEN_KEY = 'plannotator-inbox-plan-rail-hidden';

/** Where the rail is: beside the document, floating over the pane from the top bar, or a phone's bottom sheet. */
type RailMode = 'docked' | 'float' | 'phone';
interface RailPlacement {
  mode: RailMode;
  /** The top bar's end, where a floating or closed rail's button goes. */
  slot: HTMLElement | null;
  /** Closed by the person: the document takes its width, and "Versions N" on the top bar opens it again. */
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
}

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

/** A kept yes/no (the panel folded), in Plannotator's own storage, as the panel's width is. */
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

function PlanLoaded({ id, version, diff, phone, doc, file, read, versions }: PlanPageProps & { read: PlanRead; versions: readonly PlanVersion[] }) {
  const primary = read.plan.primary_doc_id;
  const artifacts = read.artifacts ?? [];
  const artifact = file ? (artifacts.find((a) => a.asset_path === file) ?? null) : null;
  const document = (doc && read.documents.find((d) => d.id === doc && !d.archived_at)) || read.documents.find((d) => d.id === primary)!;
  const onScreen: PlanFileRef = artifact ? { kind: 'artifact', path: artifact.asset_path } : { kind: 'doc', id: document.id };
  const project = read.plan.project_name;

  // The panel: docked while the pane holds its least width beside the document and the person has not folded it;
  // otherwise Show files opens the sheet. A kept width wider than the room is drawn narrower (the hook's live
  // maximum), never a reason to fold: the fold is decided from the least width only.
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const frameWidth = useWidth(frame);
  const container = useCallback(() => frame, [frame]);
  const [hidden, setHidden] = useStoredFlag(PLAN_FILES_HIDDEN_KEY);
  const resize = useResizablePanel({
    storageKey: PLAN_FILES_WIDTH_KEY,
    defaultWidth: PLAN_FILES_DEFAULT,
    minWidth: PLAN_FILES_MIN,
    maxWidth: PLAN_FILES_MAX,
    side: 'left',
    reserveViewport: PLAN_DOC_MIN,
    container,
    onSnapClose: () => setHidden(true),
    onClick: () => setHidden(true),
  });
  const squeezed = frameWidth > 0 && frameWidth - PLAN_FILES_MIN < PLAN_DOC_MIN;
  const docked = !phone && !hidden && !squeezed;
  const panelWidth = Math.min(resize.width, resize.maxWidth);
  // The rail: beside the document while the document keeps `PLAN_DOC_ROOM` next to it; else it floats over the
  // pane's right side from a "Versions" button on the top bar, as Shape's one panel does.
  const docRoom = frameWidth - (docked ? panelWidth : 0) - RAIL_WIDTH;
  const rail: RailMode = phone ? 'phone' : frameWidth > 0 && docRoom < PLAN_DOC_ROOM ? 'float' : 'docked';
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null);
  const [railHidden, setRailHidden] = useStoredFlag(PLAN_RAIL_HIDDEN_KEY);
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    if (docked) setSheet(false);
  }, [docked]);
  const showFiles = () => (phone || squeezed ? setSheet(true) : setHidden(false));
  const filesProps = { plan: id, name: read.plan.name, primary, documents: read.documents, artifacts, onScreen };
  const place: RailPlacement = { mode: rail, slot: railSlot, hidden: railHidden, setHidden: setRailHidden };

  const middle = artifact ? (
    <ArtifactPane id={id} artifact={artifact} place={place} project={project} />
  ) : (
    <DocPane key={document.id} id={id} document={document} primary={primary} read={read} mainVersions={versions} version={version} diff={diff} place={place} project={project} />
  );
  return (
    <section className="ib-plans ib-plan-frame" ref={setFrame} aria-label={read.plan.name} data-plan-page={id} data-phone={phone ? '' : undefined} data-files={docked ? 'docked' : 'hidden'} data-rail={rail}>
      {docked && (
        <aside className="ib-plan-filespane" style={{ width: panelWidth }} id={`${id}-files`}>
          <PlanFiles {...filesProps} onHide={() => setHidden(true)} start={<SidebarTrigger />} />
          <div className="ib-plan-filesedge">
            <CollapsibleEdge
              label={PLAN_FILES_WORDS.width}
              onCollapse={() => setHidden(true)}
              controls={`${id}-files`}
              isDragging={resize.isDragging}
              resize={{ value: panelWidth, min: resize.minWidth, max: resize.maxWidth, resizeTo: resize.resizeTo }}
            >
              <ResizeHandle {...resize.handleProps} />
            </CollapsibleEdge>
          </div>
        </aside>
      )}
      <div className="ib-plan">
        <header className="ib-plan-top">
          {!docked && <SidebarTrigger />}
          {!docked && (
            <button type="button" className="ib-plans-back ib-plan-showfiles" onClick={showFiles} aria-label={PLAN_FILES_WORDS.show} data-plan-show-files="">
              <Icon name="contents" />
              {!phone && PLAN_FILES_WORDS.show}
            </button>
          )}
          {!docked && (
            <button type="button" className="ib-plans-back" onClick={toList} data-plans-back="">
              <Icon name="chevL" />
              Plans
            </button>
          )}
          <span className="ib-plan-crumb" dir="auto">
            {project && <span className="ib-plan-crumb-p">{project} /</span>} <span className={onScreen.kind === 'doc' && document.id === primary ? 'ib-plan-crumb-n' : 'ib-plan-crumb-p'}>{read.plan.name}</span>
            {(artifact || document.id !== primary) && <span className="ib-plan-crumb-n"> / {artifact ? artifactName(artifact) : document.title}</span>}
          </span>
          <span className="ib-plan-topend" ref={setRailSlot} />
        </header>
        {middle}
      </div>
      {!docked && <PlanFilesSheet {...filesProps} open={sheet} onClose={() => setSheet(false)} />}
    </section>
  );
}

/** The middle and the rail for a document: its versions, its decision, its diff. */
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
}: {
  id: string;
  document: PlanDocumentRecord;
  primary: string;
  read: PlanRead;
  mainVersions: readonly PlanVersion[];
  version: number | null;
  diff: { from: number; to: number } | null;
  place: RailPlacement;
  project: string | null;
}) {
  const isMain = document.id === primary;
  const [retry, setRetry] = useState(0);
  const other = useDocVersions(id, isMain ? null : document.id, retry);
  const versions = isMain ? mainVersions : other.versions;
  if (!isMain && other.error) {
    return (
      <div className="ib-plan-docstate" role="alert">
        <p>
          {document.title} could not be read. {other.error}
        </p>
        <button type="button" className="ib-plans-quiet" onClick={() => setRetry((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!versions) {
    return (
      <div className="ib-plan-docstate" role="status" aria-busy="true">
        <p>Loading {document.title}…</p>
      </div>
    );
  }
  if (versions.length === 0) {
    return (
      <div className="ib-plan-docstate">
        <p>{document.title} has no version yet.</p>
      </div>
    );
  }
  return <DocLoaded id={id} document={document} isMain={isMain} read={read} versions={versions} version={version} diff={diff} place={place} project={project} />;
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
}: {
  id: string;
  document: PlanDocumentRecord;
  isMain: boolean;
  read: PlanRead;
  versions: readonly PlanVersion[];
  version: number | null;
  diff: { from: number; to: number } | null;
  place: RailPlacement;
  project: string | null;
}) {
  const head = versions[versions.length - 1]!.version_number;
  // What the person had seen of this document when the page opened: the look recorded below must not move it.
  const [seenAtOpen] = useState<number | null>(() => read.look?.docs[document.id] ?? null);
  const known = (n: number | null | undefined) => !!n && versions.some((v) => v.version_number === n);
  const compare = diff && known(diff.from) && known(diff.to) ? { from: Math.min(diff.from, diff.to), to: Math.max(diff.from, diff.to) } : null;
  const shown = compare ? compare.to : known(version) ? version! : head;
  const { byVersion, newest } = useMemo(() => decisionsOf(read.decisions, document.id), [read.decisions, document.id]);
  const [sheet, setSheet] = useState(false);
  const [sheetHost, setSheetHost] = useState<HTMLElement | null>(null);
  const docRef = isMain ? null : document.id;

  // Reading a version is seeing it (the store keeps the highest seen).
  useEffect(() => recordPlanLook(id, shown, docRef), [id, shown, docRef]);

  const fileRoute = planFileRoute(id, read.plan.primary_doc_id, { kind: 'doc', id: document.id });
  const go = (next: { version?: number | null; diff?: { from: number; to: number } | null }) =>
    writeRoute({ ...fileRoute, planVersion: next.version && next.version !== head ? next.version : null, planDiff: next.diff ?? null }, { replace: true });
  const changedSince = seenAtOpen !== null && seenAtOpen < head;
  const since = changedSince ? head - seenAtOpen! : 0;
  const rail = (
    <PlanRail
      versions={versions}
      documentId={document.id}
      read={read}
      shown={shown}
      head={head}
      seen={seenAtOpen}
      compare={compare}
      decisions={byVersion}
      onPick={(n) => {
        go({ version: n });
        setSheet(false);
      }}
      onCompare={(from, to) => {
        go({ diff: { from, to } });
        setSheet(false);
      }}
    />
  );
  return (
    <div className="ib-plan-body" ref={setSheetHost}>
      <div className="ib-plan-main">
        <div className="ib-plan-line">
          {project && <span className="ib-plan-project">{project}</span>}
          <span className="ib-plan-reading" data-plan-reading="">
            {compare ? `Comparing v${compare.from} with v${compare.to}` : shown === head ? `Reading v${shown} · newest` : `Reading v${shown} of ${head}`}
          </span>
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
        </div>
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
            <PlanDocument id={id} version={shown} doc={docRef} kind={document.kind} title={document.title} phone={place.mode === 'phone'} />
          )}
        </div>
      </div>
      <RailPlace place={place} rail={rail} count={versions.length} sheet={sheet} setSheet={setSheet} host={sheetHost} title={isMain ? read.plan.name : document.title} />
    </div>
  );
}

/** The middle and the rail for an artifact: the file as it is, and a rail that says it has no versions. */
function ArtifactPane({ id, artifact, place, project }: { id: string; artifact: PlanArtifact; place: RailPlacement; project: string | null }) {
  const [sheet, setSheet] = useState(false);
  const [sheetHost, setSheetHost] = useState<HTMLElement | null>(null);
  return (
    <div className="ib-plan-body" ref={setSheetHost}>
      <div className="ib-plan-main">
        <div className="ib-plan-line">
          {project && <span className="ib-plan-project">{project}</span>}
          <span className="ib-plan-reading" data-plan-reading="">
            {artifactKindLabel(artifact.content_type)} · {sizeWords(artifact.size)}
          </span>
        </div>
        <div className="ib-plan-doc">
          <PlanArtifactView id={id} artifact={artifact} />
        </div>
      </div>
      <RailPlace place={place} rail={<ArtifactRail artifact={artifact} />} count={null} sheet={sheet} setSheet={setSheet} host={sheetHost} title={artifactName(artifact)} />
    </div>
  );
}

/**
 * The rail beside the file on a wide desktop, open until the person closes it (Hide versions in its head, kept on
 * this computer); closed, the document takes its width and "Versions N" at the end of the top bar opens it again.
 * With less room it floats over the pane's right side (Shape's one panel), opened from that same button and closed by
 * its own button, a press outside it or Escape inside it; picking a version closes it. On a phone, a bar at the bottom
 * whose Versions opens it as a sheet.
 */
function RailPlace({ place, rail, count, sheet, setSheet, host, title }: { place: RailPlacement; rail: ReactNode; count: number | null; sheet: boolean; setSheet: (open: boolean) => void; host: HTMLElement | null; title: string }) {
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const hide = useRef<HTMLButtonElement>(null);
  // Where focus goes once a docked rail has closed (its button on the top bar) or opened again (its Hide).
  const focusNext = useRef<'toggle' | 'hide' | null>(null);
  const label = count === null ? 'Versions' : `Versions ${count}`;
  const docked = place.mode === 'docked' && !place.hidden;
  useEffect(() => {
    if (place.mode !== 'float') setSheet(false);
  }, [place.mode, setSheet]);
  useEffect(() => {
    if (place.mode === 'float' && sheet) panel.current?.querySelector<HTMLElement>('[data-plan-rail-close]')?.focus();
  }, [place.mode, sheet]);
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === 'toggle') toggle.current?.focus();
    if (next === 'hide') hide.current?.focus();
  }, [docked, place.slot]);
  // A floating rail closes on a press anywhere outside it (its own button toggles it).
  useEffect(() => {
    if (place.mode !== 'float' || !sheet) return;
    const down = (e: Event) => {
      const target = e.target as Node | null;
      if (target && (panel.current?.contains(target) || toggle.current?.contains(target))) return;
      setSheet(false);
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [place.mode, sheet, setSheet]);
  if (docked) {
    return (
      <aside className="ib-plan-rail" aria-label="Versions and activity">
        <div className="ib-plan-railend">
          <Tip content={PLAN_RAIL_WORDS.hide} side="bottom">
            <button
              ref={hide}
              type="button"
              className="ib-plan-files-icon"
              aria-label={PLAN_RAIL_WORDS.hide}
              onClick={() => {
                focusNext.current = 'toggle';
                place.setHidden(true);
              }}
              data-plan-rail-hide=""
            >
              <Icon name="panelsHide" className="ib-plan-flip" />
            </button>
          </Tip>
        </div>
        {rail}
      </aside>
    );
  }
  if (place.mode === 'docked' || place.mode === 'float') {
    const floating = place.mode === 'float';
    const close = () => {
      setSheet(false);
      toggle.current?.focus();
    };
    const open = () => {
      if (floating) return setSheet(!sheet);
      focusNext.current = 'hide';
      place.setHidden(false);
    };
    return (
      <>
        {place.slot &&
          createPortal(
            <button
              ref={toggle}
              type="button"
              className="ib-plans-back ib-plan-railbtn"
              aria-expanded={floating ? sheet : false}
              aria-controls={floating ? 'ib-plan-railfloat' : undefined}
              onClick={open}
              data-on={floating && sheet ? '' : undefined}
              data-plan-rail-toggle=""
            >
              <Icon name="stack" />
              {label}
            </button>,
            place.slot,
          )}
        {floating && sheet && (
          <aside
            ref={panel}
            id="ib-plan-railfloat"
            className="ib-plan-railfloat"
            role="dialog"
            aria-label="Versions and activity"
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
            data-plan-rail-float=""
          >
            <div className="ib-plan-railfloat-head">
              <span>{title}</span>
              <button type="button" className="ib-plan-files-icon" aria-label="Close" onClick={close} data-plan-rail-close="">
                <Icon name="x" />
              </button>
            </div>
            <div className="ib-plan-railfloat-body">{rail}</div>
          </aside>
        )}
      </>
    );
  }
  return (
    <>
      <nav className="ib-plan-phonebar" aria-label="Plan">
        <button type="button" onClick={() => setSheet(true)} data-plan-phone-tab="versions">
          <Icon name="stack" />
          {label}
        </button>
      </nav>
      <BottomSheet open={sheet} onClose={() => setSheet(false)} title={title} host={host} attrs={{ 'data-plan-sheet': '' }}>
        {rail}
      </BottomSheet>
    </>
  );
}
