/**
 * The plan page's versions, in the shared frame's versions panel (@plannotator/ui/components/frame `VersionsPanel`,
 * the Space page screen's): the versions of the file on screen, newest first, consecutive saves by one author within
 * 30 minutes folded; who saved each (a display name only, "You" for the person's own edit or Restore; no author line
 * at all while no version has one) and when; the decision on its version (an approval, or "Changes asked"): history,
 * kept on the row of the version it was given on (approval "plans-editing"); "You saw this" under the version the
 * person had seen, "Restored v2" under a Restore. Under the version on screen: the frame's Compare and Copy link (`VersionActions`), with our Compare of the
 * version you saw with the newest between them when the newest is on screen. Under the list (its footer): that
 * file's own activity (its versions saved, the decisions on it; nothing plan-wide). An artifact has no versions: the
 * page's line says so (`ArtifactLine`).
 */
import type { ReactElement } from 'react';
import type { PlanArtifact, PlanDecision, PlanVersion } from '@plannotator/core/plans';
import { fullTime, whenTime } from '@plannotator/core/inbox-format';
import { FrameButton, VersionActions, VersionsPanel, type FrameVersionEntry, type VersionAuthor } from '@plannotator/ui/components/frame';
import { Icon } from '../icons';
import type { PlanRead } from './client';
import { artifactKindLabel, authorOf, decisionLabel, decisionTone, PLAN_FILES_WORDS, sizeWords } from './words';
import { DecisionMark } from './parts';

export interface PlanVersionsProps {
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
  /** A version's link (the address carries `&v=`). */
  rowLink: (n: number) => ReactElement;
  /** After a version opens (a phone's sheet closes). */
  onPicked: () => void;
  onCompare: (from: number, to: number) => void;
  onCopyLink: (n: number) => void;
  onClose?: () => void;
}

/** The pair our Compare offers: the version you saw (else the one before) with the one on screen, older first. */
export function comparePair(shown: number, seen: number | null): { from: number; to: number } | null {
  const other = seen !== null && seen !== shown ? seen : shown - 1;
  if (other < 1) return null;
  return { from: Math.min(other, shown), to: Math.max(other, shown) };
}

function author(v: PlanVersion): VersionAuthor {
  if (v.source === 'person' && !authorOf(v)) return { kind: 'person', name: 'You', key: 'person' };
  const name = authorOf(v);
  // A version with no name has no author line (the frame's "none"; not "No name recorded").
  return name ? { kind: 'person', name, key: `name:${name}` } : { kind: 'none' };
}

/** "you" or "you, with notes": the frame writes "Approved by …" (a denial has no place there; Activity has it). */
function approvalWords(decision: PlanDecision | undefined): string | null {
  if (!decision || decisionTone(decision.decision) !== 'approved') return null;
  return decision.decision === 'approved-with-notes' ? 'you, with notes' : 'you';
}

/** "Changes asked" on a version the person sent back (an approval is the frame's own line, `approval`). */
function decisionOf(decision: PlanDecision | undefined): FrameVersionEntry['decision'] {
  if (!decision || decisionTone(decision.decision) !== 'changes') return null;
  return { label: decisionLabel(decision.decision), tone: 'negative' };
}

/** The plan's versions as the frame's entries, newest first. */
export function planVersionEntries(versions: readonly PlanVersion[], shown: number, head: number, decisions: ReadonlyMap<number, PlanDecision>): FrameVersionEntry[] {
  return [...versions]
    .sort((a, b) => b.version_number - a.version_number)
    .map((v, i, all) => ({
      key: String(v.version_number),
      version: String(v.version_number),
      number: v.version_number,
      createdAt: v.committed_at,
      author: author(v),
      current: v.version_number === head,
      viewing: v.version_number === shown,
      linked: true,
      sameAsOlder: !!all[i + 1] && all[i + 1]!.version === v.version,
      approval: approvalWords(decisions.get(v.version_number)),
      decision: decisionOf(decisions.get(v.version_number)),
      canCompare: v.version_number !== head,
    }));
}

export function PlanVersions(props: PlanVersionsProps) {
  const { versions, documentId, read, shown, head, seen, compare, decisions, rowLink, onPicked, onCompare, onCopyLink, onClose } = props;
  const entries = planVersionEntries(versions, shown, head, decisions);
  const pair = compare || shown !== head ? null : comparePair(shown, seen);
  // Plans keep a display name only when one was given: with none on any version, no "No name recorded" lines.
  const authors = entries.some((e) => e.author.kind === 'person');
  return (
    <VersionsPanel
      status="success"
      entries={entries}
      place={{
        rowLink: (entry) => rowLink(entry.number!),
        onRowOpen: () => onPicked(),
        authors,
        note: (entry) => {
          const restored = versions.find((v) => v.version_number === entry.number)?.restored_from;
          const saw = seen !== null && entry.number === seen && seen !== head;
          if (!saw && !restored) return null;
          return (
            <>
              {saw && (
                <span className="ib-plan-seen" data-plan-seen="">
                  <Icon name="eye" />
                  You saw this
                </span>
              )}
              {restored ? (
                <span className="ib-plan-seen" data-plan-restored="">
                  <Icon name="restart" />
                  Restored v{restored}
                </span>
              ) : null}
            </>
          );
        },
      }}
      onRetry={() => {}}
      onClose={onClose}
      // During a diff both compared rows are marked.
      comparing={compare ? { from: String(compare.from), to: String(compare.to) } : undefined}
      onScreenActions={(onScreen) => (
        <VersionActions
          version={onScreen.version}
          number={onScreen.number}
          currentNumber={head}
          canCompare={!compare && onScreen.canCompare}
          soft
          onCompare={() => onCompare(onScreen.number!, head)}
          onCopyLink={() => onCopyLink(onScreen.number!)}
          actions={
            pair && (
              <FrameButton variant="outline" size="sm" onClick={() => onCompare(pair.from, pair.to)} data-plan-compare="">
                Compare v{pair.from} with v{pair.to}
              </FrameButton>
            )
          }
        />
      )}
      footer={<Activity versions={versions} decisions={read.decisions.filter((d) => d.document_id === documentId)} />}
    />
  );
}

/** An artifact's line on the page card: no versions, said plainly, then what the file is and when it was kept. */
export function ArtifactLine({ artifact }: { artifact: PlanArtifact }) {
  return (
    <div className="ib-plan-artline" data-plan-artifact-facts="">
      <span data-plan-no-versions="">{PLAN_FILES_WORDS.noVersions}</span>
      <span className="ib-plan-artline-facts">
        {artifactKindLabel(artifact.content_type)} · {sizeWords(artifact.size)} · kept{' '}
        <time dateTime={artifact.created_at} title={fullTime(artifact.created_at)}>
          {whenTime(artifact.created_at)}
        </time>
      </span>
    </div>
  );
}

/** One document's history: when each of its versions was saved and the decisions on it. */
function Activity({ versions, decisions }: { versions: readonly PlanVersion[]; decisions: readonly PlanDecision[] }) {
  const items = [
    ...versions.map((v) => ({
      at: v.committed_at,
      key: `v${v.version_number}`,
      line: v.source !== 'person' ? `v${v.version_number} saved` : v.restored_from ? `You restored v${v.restored_from} as v${v.version_number}` : `You saved v${v.version_number}`,
      tone: null,
    })),
    ...decisions.map((d, i) => {
      const tone = decisionTone(d.decision);
      const on = d.version_number ? ` v${d.version_number}` : '';
      if (d.moved_from && d.version_number) return { at: d.at, key: `d${i}`, line: `Your approval moved to v${d.version_number}`, tone };
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
