/**
 * The plan page's right rail (layout B): Versions, newest first, each with who saved it (a display name only), when,
 * and the decision on it; the version the person had seen marked "You saw this"; Compare; then the plan's activity.
 * Artifacts lists the plan's other documents and files. Comments and the plan's thread come later.
 */
import { useId } from 'react';
import type { PlanDecision, PlanVersion } from '@plannotator/core/plans';
import { fullTime, whenTime } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import type { PlanRead } from './client';
import { authorOf, decisionLabel, decisionTone } from './words';
import { DecisionMark } from './parts';

export type PlanRailTab = 'versions' | 'artifacts';

export interface PlanRailProps {
  tab: PlanRailTab;
  onTab: (tab: PlanRailTab) => void;
  versions: readonly PlanVersion[];
  read: PlanRead;
  shown: number;
  head: number;
  /** The version the person had seen when the page opened; null before the first look. */
  seen: number | null;
  compare: { from: number; to: number } | null;
  decisions: ReadonlyMap<number, PlanDecision>;
  onPick: (n: number) => void;
  onCompare: (from: number, to: number) => void;
}

/** The pair Compare offers: the version you saw (else the one before) with the one on screen, older first. */
export function comparePair(shown: number, seen: number | null): { from: number; to: number } | null {
  const other = seen !== null && seen !== shown ? seen : shown - 1;
  if (other < 1) return null;
  return { from: Math.min(other, shown), to: Math.max(other, shown) };
}

export function PlanRail(props: PlanRailProps) {
  const ids = useId();
  const others = props.read.documents.filter((d) => d.id !== props.read.plan.primary_doc_id);
  const tabs: { id: PlanRailTab; label: string; n: number }[] = [
    { id: 'versions', label: 'Versions', n: props.versions.length },
    { id: 'artifacts', label: 'Artifacts', n: others.length },
  ];
  return (
    <div className="ib-plan-railin">
      <div className="ib-plan-tabs" role="tablist" aria-label="Plan">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${ids}-${t.id}`}
            aria-selected={props.tab === t.id}
            aria-controls={`${ids}-${t.id}-panel`}
            data-on={props.tab === t.id ? '' : undefined}
            onClick={() => props.onTab(t.id)}
            data-plan-tab={t.id}
          >
            {t.label} <span className="ib-plans-count">{t.n}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${ids}-${props.tab}-panel`} aria-labelledby={`${ids}-${props.tab}`} className="ib-plan-panel">
        {props.tab === 'versions' ? <Versions {...props} /> : <Artifacts read={props.read} />}
      </div>
    </div>
  );
}

function Versions({ versions, shown, head, seen, compare, decisions, read, onPick, onCompare }: PlanRailProps) {
  const pair = compare ? null : comparePair(shown, seen);
  const newestFirst = [...versions].reverse();
  return (
    <>
      <ol className="ib-plan-versions" aria-label="Versions, newest first">
        {newestFirst.map((v) => {
          const n = v.version_number;
          const author = authorOf(v);
          const decision = decisions.get(n);
          const on = compare ? n === compare.from || n === compare.to : n === shown;
          return (
            <li key={n}>
              <button type="button" className="ib-plan-version" aria-current={on ? 'true' : undefined} data-on={on ? '' : undefined} onClick={() => onPick(n)} data-plan-version={n}>
                <span className="ib-plan-vtop">
                  <b>v{n}</b>
                  {author && <span className="ib-plan-vby">{author}</span>}
                  <time dateTime={v.committed_at} title={fullTime(v.committed_at)}>
                    {whenTime(v.committed_at)}
                  </time>
                  {n === head && <span className="ib-plan-vtag">Newest</span>}
                  {seen === n && n !== head && (
                    <span className="ib-plan-vseen" data-plan-seen="">
                      <Icon name="eye" />
                      You saw this
                    </span>
                  )}
                </span>
                {decision && (
                  <span className="ib-plan-vdec" data-tone={decisionTone(decision.decision)}>
                    <DecisionMark tone={decisionTone(decision.decision)} />
                    {decisionLabel(decision.decision)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      {pair && (
        <button type="button" className="ib-plans-soft ib-plan-compare" onClick={() => onCompare(pair.from, pair.to)} data-plan-compare="">
          <Icon name="sideBySide" />
          Compare v{pair.from} with v{pair.to}
        </button>
      )}
      <Activity versions={versions} read={read} />
    </>
  );
}

function Activity({ versions, read }: { versions: readonly PlanVersion[]; read: PlanRead }) {
  const items = [
    ...versions.map((v) => ({ at: v.committed_at, key: `v${v.version_number}`, line: `v${v.version_number} saved`, tone: null })),
    ...read.decisions.map((d, i) => {
      const tone = decisionTone(d.decision);
      const on = d.version_number ? ` v${d.version_number}` : '';
      return { at: d.at, key: `d${i}`, line: tone === 'approved' ? `You approved${on}` : tone === 'changes' ? `You asked for changes${on ? ` on${on}` : ''}` : decisionLabel(d.decision), tone };
    }),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);
  return (
    <section className="ib-plan-activity" aria-label="Activity">
      <h3>Activity</h3>
      <ol>
        {items.map((item) => (
          <li key={item.key}>
            {item.tone ? <DecisionMark tone={item.tone} /> : <Icon name="doc" />}
            <span>{item.line}</span>
            <time dateTime={item.at} title={fullTime(item.at)}>
              {whenTime(item.at)}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Artifacts({ read }: { read: PlanRead }) {
  const others = read.documents.filter((d) => d.id !== read.plan.primary_doc_id);
  if (others.length === 0) {
    return (
      <p className="ib-plan-empty" data-plan-artifacts-empty="">
        No artifacts on this plan yet. Files kept with a plan show here.
      </p>
    );
  }
  return (
    <ul className="ib-plan-artifacts" data-plan-artifacts="">
      {others.map((d) => (
        <li key={d.id}>
          <Icon name="doc" />
          <span dir="auto">{d.title}</span>
          <span className="ib-plan-vby">v{d.head_version}</span>
        </li>
      ))}
    </ul>
  );
}
