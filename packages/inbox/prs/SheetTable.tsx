/**
 * The board as a table (approval "inbox-pr-board-bulk"): one row per PR under one row per repository, the columns
 * Pull request, Title, Author, State, Checks, Risk, Updated and Size. A header sorts its column; a stack's layers stay
 * together in landing order, the first with the layers mark (it opens the stack's page), the rest with an elbow.
 * A row's click is a tile's: it opens the PR. Narrow, Risk goes first, then Updated and Size (prs.css).
 */
import type { MouseEvent as ReactMouseEvent } from 'react';
import { inboxPullIsOpen, inboxPullLabel, type InboxPull, type InboxPullRiskJudgment, type InboxPullStack } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { Face, Named } from '../pulls/Face';
import { RiskMark } from '../pulls/RiskMark';
import { riskLevelWord } from '../pulls/risk';
import { facesOnce } from '../pulls/words';
import { ChecksMark } from './ChecksMark';
import { ageShort, isStack, matchesQuery, needsYou, statusParts, type RiskLevels } from './sheetModel';
import { checksWord, pullWords, sortUnits, type SortKey, type TableSort } from './tableModel';

export interface TableSection {
  key: string;
  host: string;
  repo: string;
  label: string;
  outside: boolean;
  units: InboxPullStack[];
  /** The repository row's count: "7 open · 1 landed this week", "3 merged". */
  count: string;
}

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: 'number', label: 'Pull request', className: 'ib-prtb-n' },
  { key: 'title', label: 'Title', className: 'ib-prtb-t' },
  { key: 'author', label: 'Author', className: 'ib-prtb-a' },
  { key: 'state', label: 'State', className: 'ib-prtb-s' },
  { key: 'checks', label: 'Checks', className: 'ib-prtb-ck' },
  { key: 'risk', label: 'Risk', className: 'ib-prtb-risk' },
  { key: 'updated', label: 'Updated', className: 'ib-prtb-upd' },
  { key: 'size', label: 'Size', className: 'ib-prtb-size' },
];

export function SheetTable(props: {
  sections: readonly TableSection[];
  /** The filter field's words: rows that miss are dimmed, as tiles are. */
  query: string;
  now: number;
  risk: RiskLevels;
  /** The agent's judgments, for the Risk mark's sentence; a level alone shows its word. */
  judgments?: Readonly<Record<string, InboxPullRiskJudgment>>;
  sort: TableSort | null;
  onSort: (key: SortKey) => void;
  onRow: (pull: InboxPull, stack: InboxPullStack, event: ReactMouseEvent<HTMLTableRowElement>) => void;
  onOpenStack: (stack: InboxPullStack) => void;
  labelledBy: string;
}) {
  const { now, risk, sort, query } = props;
  const span = COLUMNS.length;

  const row = (pull: InboxPull, stack: InboxPullStack, at: number) => {
    const you = needsYou(pull);
    const open = inboxPullIsOpen(pull);
    const stacked = isStack(stack);
    const judgment = props.judgments?.[pull.key];
    const level = risk[pull.key];
    const word = checksWord(open ? pull.checks : null);
    return (
      <tr
        key={pull.key}
        className="ib-prtb-r"
        data-pr-row={pull.key}
        data-state={pull.state}
        data-you={you ? '' : undefined}
        data-dim={query && !matchesQuery(pull, query) ? '' : undefined}
        onClick={(event) => props.onRow(pull, stack, event)}
      >
        <td className="ib-prtb-n">
          <span className="ib-prtb-nin">
            {stacked && at === 0 && (
              <button
                type="button"
                className="ib-prtb-stack"
                aria-label={`Open the stack: ${stack.layers.length} layers`}
                title={`Open the stack: ${stack.layers.length} layers`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpenStack(stack);
                }}
                data-pr-stack-mark=""
              >
                <Icon name="layers" size={13} />
              </button>
            )}
            {stacked && at > 0 && <i className="ib-prtb-elbow" aria-hidden="true" />}
            <button type="button" className="ib-prtb-open" aria-label={pullWords(pull)} data-pr-open="">
              {pull.state === 'merged' && <Icon name="pullRequest" size={12} />}
              {inboxPullLabel(pull)}
            </button>
          </span>
        </td>
        <td className="ib-prtb-t">
          <span dir="auto" title={pull.title}>
            {pull.title}
          </span>
        </td>
        <td className="ib-prtb-a">
          <span className="ib-prtb-who">
            <Face login={pull.author ?? ''} host={pull.host} size={20} />
            {pull.mine ? 'You' : pull.author && <span>{pull.author}</span>}
          </span>
        </td>
        <td className="ib-prtb-s" data-tone={you ? 'you' : open && pull.checks === 'failure' ? 'bad' : undefined}>
          <span>
            <Named words={facesOnce(statusParts(pull, now))} host={pull.host} />
          </span>
        </td>
        <td className="ib-prtb-ck">
          {word && (
            <span className="ib-prtb-ckin">
              <ChecksMark checks={pull.checks} />
              {word}
            </span>
          )}
        </td>
        <td className="ib-prtb-risk">{judgment ? <RiskMark judgment={judgment} /> : level ? <span className="ib-risk" data-risk={level}>{riskLevelWord[level]}</span> : null}</td>
        <td className="ib-prtb-upd">
          <span>{ageShort(pull.updated_at, now)}</span>
        </td>
        <td className="ib-prtb-size">
          <span>
            <span className="ib-prtb-add">+{pull.additions.toLocaleString()}</span> <span className="ib-prtb-del">−{pull.deletions.toLocaleString()}</span>
          </span>
        </td>
      </tr>
    );
  };

  return (
    <div className="ib-prtb-wrap">
      <table className="ib-prtb" aria-labelledby={props.labelledBy} data-pr-table="">
        <thead>
          <tr>
            {COLUMNS.map((column) => {
              const on = sort?.key === column.key;
              // Updated's first click is the newest first: a descending date.
              const up = on && (column.key === 'updated' ? sort!.dir === -1 : sort!.dir === 1);
              return (
                <th key={column.key} className={column.className} aria-sort={on ? (up ? 'ascending' : 'descending') : undefined} scope="col">
                  <button type="button" className="ib-prtb-sort" onClick={() => props.onSort(column.key)} data-pr-sort={column.key}>
                    {column.label}
                    <span className="ib-prtb-ar" aria-hidden="true">
                      {on && <Icon name={sort!.dir === 1 ? 'arrowUp' : 'arrowDown'} size={11} />}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        {props.sections.map((section) => (
          <tbody key={section.key} data-pr-repo={section.key}>
            <tr className="ib-prtb-g">
              <th colSpan={span} scope="rowgroup">
                <span className="ib-prtb-gin">
                  <span className="ib-prtb-gl" title={`${section.host}/${section.repo}`}>
                    {section.label}
                  </span>
                  {section.outside && <span className="ib-prs-outside">not a project</span>}
                  <span className="ib-prtb-gn">{section.count}</span>
                </span>
              </th>
            </tr>
            {sortUnits(section.units, sort, now, risk).flatMap((stack) => stack.layers.map((layer, at) => row(layer, stack, at)))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
