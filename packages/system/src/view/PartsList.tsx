// The parts a change touches, beside the full view (walkthrough screen 6):
// each part with its number on the sheet, its name in its ink, the PR's files
// it rests on with their counts, and "diff ›", which asks the host to open
// that file in the review. Props only.
import { useMemo } from 'react';
import type { Revision, SystemModel } from '../format/types.ts';
import type { GateResult } from '../gate/gate.ts';
import { changeSummary, isRevision, type ChangeFile, type ChangeSummary } from '../change/summary.ts';

export type PartsListProps = {
  model: SystemModel;
  /** The change: a PR's revision, a plan, or the gate's touched parts. */
  revision: Revision | GateResult;
  /** The PR's changed files with their counts, when the host has them: they name each part's files. */
  files?: ChangeFile[];
  /** "diff ›" and a file: the host opens that file of the PR in its review. */
  onOpenFile(path: string, part: string): void;
  /** The part picked here or on the sheet: its row takes the selected fill. */
  selected?: string | null;
  /** A row was picked (the view shows that part on the sheet). */
  onSelect?(part: string): void;
  /** A row is under the pointer or has the focus: the view lights the part. */
  onHover?(part: string | null): void;
  /** Already worked out by the caller (the view shares one with its tally). */
  summary?: ChangeSummary;
};

/** The last two folders of a path: "main/frame.ts". The whole path is in its tooltip. */
const shortPath = (p: string) => p.split('/').slice(-2).join('/');
const MINUS = '−';
const counts = (f?: ChangeFile) => (f ? [f.additions ? `+${f.additions}` : '', f.deletions ? `${MINUS}${f.deletions}` : ''].filter(Boolean).join(' ') : '');

export function PartsList({ model, revision, files, onOpenFile, selected = null, onSelect, onHover, summary }: PartsListProps) {
  const sum = useMemo(() => summary ?? changeSummary(model, revision, files), [summary, model, revision, files]);
  const plan = isRevision(revision) && revision.pr == null;
  const byPath = useMemo(() => new Map((files ?? []).map((f) => [f.path, f])), [files]);
  const head = plan ? 'Parts in this plan' : 'Parts in this PR';
  return (
    <section className="sys sys-plist" aria-label={head}>
      <h2 className="sys-plist-h">{head}</h2>
      <ol className="sys-plist-rows">
        {sum.parts.map((p, i) => {
          const first = p.files[0];
          return (
            <li key={p.id} className="sys-plist-row" data-status={p.is} data-row={p.id} aria-current={selected === p.id ? 'true' : undefined}>
              <button type="button" className="sys-plist-pick" onClick={() => onSelect?.(p.id)} onPointerEnter={() => onHover?.(p.id)} onPointerLeave={() => onHover?.(null)} onFocus={() => onHover?.(p.id)} onBlur={() => onHover?.(null)}
                aria-label={`${i + 1}. ${p.name}, ${p.is}${p.lines ? `, ${p.lines}` : ''}`}>
                <span className="sys-plist-n">{i + 1}</span>
                <span className="sys-plist-name">{p.name}</span>
              </button>
              {first && !plan && (
                <button type="button" className="sys-plist-diff" onClick={() => onOpenFile(first, p.id)} aria-label={`Open ${first} in the diff`}>
                  diff<svg width="7" height="10" viewBox="0 0 7 10" aria-hidden="true"><path d="M1.5 1.5L5 5L1.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
              {p.files.length > 0 ? (
                <div className="sys-plist-files">
                  {p.files.map((f) => (
                    plan ? <span key={f} className="sys-plist-file sys-mono" title={f}>{shortPath(f)}</span> : (
                      <button key={f} type="button" className="sys-plist-file sys-mono" title={f} onClick={() => onOpenFile(f, p.id)}>
                        {shortPath(f)}{counts(byPath.get(f)) && <span className="sys-plist-c"> {counts(byPath.get(f))}</span>}
                      </button>
                    )
                  ))}
                </div>
              ) : p.lines ? (
                <div className="sys-plist-files"><span className="sys-plist-file sys-mono">{p.lines}</span></div>
              ) : null}
            </li>
          );
        })}
        {sum.flows.filter((f) => f.is === 'removed').map((f) => (
          <li key={f.id} className="sys-plist-row sys-plist-line" data-status="removed">
            <span className="sys-plist-pick"><span className="sys-plist-n" aria-hidden="true" /><span className="sys-plist-name">{f.says || f.id}</span></span>
            <div className="sys-plist-files"><span className="sys-plist-file">a line, removed</span></div>
          </li>
        ))}
      </ol>
      {!plan && sum.parts.some((p) => p.files.length) && <p className="sys-plist-foot">A part opens its file in the diff. The guide stays in Start review.</p>}
    </section>
  );
}
