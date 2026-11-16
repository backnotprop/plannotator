/**
 * The plan page's right rail (layout B): the versions of the file on screen, newest first, each with who saved it (a
 * display name only), when, and the decision on it; the version the person had seen marked "You saw this"; Compare;
 * then that file's own activity (its versions saved, the decisions on it; nothing plan-wide, so another page never
 * reads as the main page's history). The plan's files are in the left panel (PlanFiles.tsx). An artifact has no
 * versions: the rail says so, with what the file is and when it was kept. Comments and the plan's thread come later.
 */
import type { PlanArtifact, PlanDecision, PlanVersion } from '@plannotator/core/plans';
import { fullTime, whenTime } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import type { PlanRead } from './client';
import { artifactKindLabel, authorOf, decisionLabel, decisionTone, PLAN_FILES_WORDS, sizeWords } from './words';
import { DecisionMark } from './parts';

export interface PlanRailProps {
  /** The versions of the document on screen. */
  versions: readonly PlanVersion[];
  /** The document on screen: its activity is its own versions and the decisions on it, nothing plan-wide. */
  documentId: string;
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
  return (
    <div className="ib-plan-railin">
      <h2 className="ib-plan-railh">
        Versions <span className="ib-plans-count">{props.versions.length}</span>
      </h2>
      <Versions {...props} />
    </div>
  );
}

/** The rail beside an artifact: no versions, said plainly, then what the file is and when it was kept. */
export function ArtifactRail({ artifact }: { artifact: PlanArtifact }) {
  return (
    <div className="ib-plan-railin">
      <h2 className="ib-plan-railh">Versions</h2>
      <p className="ib-plan-empty" data-plan-no-versions="">
        {PLAN_FILES_WORDS.noVersions}
      </p>
      <dl className="ib-plan-facts" data-plan-artifact-facts="">
        <dt>Kind</dt>
        <dd>{artifactKindLabel(artifact.content_type)}</dd>
        <dt>Size</dt>
        <dd>{sizeWords(artifact.size)}</dd>
        <dt>Kept</dt>
        <dd>
          <time dateTime={artifact.created_at} title={fullTime(artifact.created_at)}>
            {whenTime(artifact.created_at)}
          </time>
        </dd>
      </dl>
    </div>
  );
}

function Versions({ versions, documentId, shown, head, seen, compare, decisions, read, onPick, onCompare }: PlanRailProps) {
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
      <Activity versions={versions} decisions={read.decisions.filter((d) => d.document_id === documentId)} />
    </>
  );
}

/** One document's history: when each of its versions was saved and the decisions on it. */
function Activity({ versions, decisions }: { versions: readonly PlanVersion[]; decisions: readonly PlanDecision[] }) {
  const items = [
    ...versions.map((v) => ({ at: v.committed_at, key: `v${v.version_number}`, line: `v${v.version_number} saved`, tone: null })),
    ...decisions.map((d, i) => {
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
