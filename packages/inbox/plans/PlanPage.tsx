/**
 * One plan (approval "inbox-plans", layout B): the plan takes the page, drawn by the document UI's own Viewer, read
 * only; a right rail holds Versions (newest first, with the activity) and Artifacts. The header says which version is
 * being read ("Reading v5 · newest"); versions change only in the rail, never from a menu in the plan. "Changed since
 * you looked" compares with the version the person had seen when the page opened, and Show changes opens the diff
 * from that version to the newest. Comments, Send and the plan's thread come later. On a phone the rail is a bar at
 * the bottom that opens each part as a sheet.
 */
import { useEffect, useMemo, useState } from 'react';
import type { PlanDecision, PlanVersion } from '@plannotator/core/plans';
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import { writeRoute } from '../app/writeRoute';
import { BottomSheet } from '../components/BottomSheet';
import type { PlanRead } from './client';
import { recordPlanLook, usePlan } from './store';
import { decisionLabel, decisionTone } from './words';
import { DecisionMark, PlansMessage } from './parts';
import { PlanDocument } from './PlanDocument';
import { PlanDiffView } from './PlanDiffView';
import { PlanRail, type PlanRailTab } from './PlanRail';

const toList = () => writeRoute({ page: 'plans', project: null, thread: null });

export interface PlanPageProps {
  id: string;
  /** The version asked for (`&v=`); null: the newest. */
  version: number | null;
  diff: { from: number; to: number } | null;
  phone: boolean;
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

/** The newest decision on each version, and the newest of all. */
function decisionsOf(decisions: readonly PlanDecision[]): { byVersion: Map<number, PlanDecision>; newest: PlanDecision | null } {
  const byVersion = new Map<number, PlanDecision>();
  let newest: PlanDecision | null = null;
  for (const d of [...decisions].sort((a, b) => a.at.localeCompare(b.at))) {
    if (d.version_number) byVersion.set(d.version_number, d);
    newest = d;
  }
  return { byVersion, newest };
}

function PlanLoaded({ id, version, diff, phone, read, versions }: PlanPageProps & { read: PlanRead; versions: readonly PlanVersion[] }) {
  const head = versions[versions.length - 1]!.version_number;
  // What the person had seen when the page opened: the look recorded below must not move it.
  const [seenAtOpen] = useState<number | null>(() => read.look?.docs[read.plan.primary_doc_id] ?? null);
  const known = (n: number | null | undefined) => !!n && versions.some((v) => v.version_number === n);
  const compare = diff && known(diff.from) && known(diff.to) ? { from: Math.min(diff.from, diff.to), to: Math.max(diff.from, diff.to) } : null;
  const shown = compare ? compare.to : known(version) ? version! : head;
  const { byVersion, newest } = useMemo(() => decisionsOf(read.decisions), [read.decisions]);
  const [tab, setTab] = useState<PlanRailTab>('versions');
  const [sheet, setSheet] = useState(false);
  const [sheetHost, setSheetHost] = useState<HTMLElement | null>(null);

  // Reading a version is seeing it (the store keeps the highest seen).
  useEffect(() => recordPlanLook(id, shown), [id, shown]);

  const go = (next: { version?: number | null; diff?: { from: number; to: number } | null }) =>
    writeRoute({ page: 'plans', project: null, thread: null, plan: id, planVersion: next.version && next.version !== head ? next.version : null, planDiff: next.diff ?? null }, { replace: true });
  const changedSince = seenAtOpen !== null && seenAtOpen < head;
  const since = changedSince ? head - seenAtOpen! : 0;
  const project = read.plan.project_name;
  const rail = (
    <PlanRail
      tab={tab}
      onTab={setTab}
      versions={versions}
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
    <section className="ib-plans ib-plan" ref={setSheetHost} aria-label={read.plan.name} data-plan-page={id} data-phone={phone ? '' : undefined}>
      <header className="ib-plan-top">
        <SidebarTrigger />
        <button type="button" className="ib-plans-back" onClick={toList} data-plans-back="">
          <Icon name="chevL" />
          Plans
        </button>
        <span className="ib-plan-crumb" dir="auto">
          {project && <span className="ib-plan-crumb-p">{project} /</span>} <span className="ib-plan-crumb-n">{read.plan.name}</span>
        </span>
      </header>
      <div className="ib-plan-body">
        <div className="ib-plan-main">
          <div className="ib-plan-line">
            {project && <span className="ib-plan-project">{project}</span>}
            <span className="ib-plan-reading" data-plan-reading="">
              {compare ? `Comparing v${compare.from} with v${compare.to}` : shown === head ? `Reading v${shown} · newest` : `Reading v${shown} of ${head}`}
            </span>
            <span className="ib-plan-decision" data-plan-decision={decisionTone(newest?.decision)}>
              <DecisionMark tone={decisionTone(newest?.decision)} />
              {decisionLabel(newest?.decision)}
              {newest?.version_number ? <span className="ib-plan-on"> on v{newest.version_number}</span> : null}
            </span>
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
          <div className="ib-plan-doc">{compare ? <PlanDiffView id={id} from={compare.from} to={compare.to} /> : <PlanDocument id={id} version={shown} />}</div>
        </div>
        {!phone && <aside className="ib-plan-rail" aria-label="Versions and artifacts">{rail}</aside>}
      </div>
      {phone && (
        <>
          <nav className="ib-plan-phonebar" aria-label="Plan">
            <button type="button" onClick={() => (setTab('versions'), setSheet(true))} data-plan-phone-tab="versions">
              <Icon name="stack" />
              Versions {versions.length}
            </button>
            <button type="button" onClick={() => (setTab('artifacts'), setSheet(true))} data-plan-phone-tab="artifacts">
              <Icon name="artifacts" />
              Artifacts
            </button>
          </nav>
          <BottomSheet open={sheet} onClose={() => setSheet(false)} title={read.plan.name} host={sheetHost} attrs={{ 'data-plan-sheet': '' }}>
            {rail}
          </BottomSheet>
        </>
      )}
    </section>
  );
}
