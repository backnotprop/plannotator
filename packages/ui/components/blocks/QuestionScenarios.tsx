import React from 'react';
import type { QuestionScenarioCell, QuestionScenarioTable } from '@plannotator/core/question-block';

/**
 * A question's scenario table (approval "question-scenario-table", design A):
 * under Why, always open, titled "Scenarios". A card wide enough for its
 * columns draws a real table, scenarios as rows and options as columns; a
 * narrower card (a phone) draws the same facts as a list, each scenario a
 * heading with one line per option, so nothing ever scrolls sideways. Only
 * one of the two shows (container query on the card, `qcard`); the hidden
 * one is `display: none`, out of the accessibility tree. The picked option's
 * column (or line) takes the picked row's fill (`data-question-scenario-on`;
 * the Inbox paints it with its own picked fill), and says "picked" to a
 * screen reader.
 */
export interface QuestionScenariosProps {
  table: QuestionScenarioTable;
  /** The labels picked now (the card's selection). */
  picked: ReadonlyArray<string>;
  /** The card's inline markdown renderer. */
  inline: (text: string) => React.ReactNode;
}

// The card width the table needs, by its number of option columns; below it the list shows. Whole class names, so
// Tailwind sees each one.
const TABLE_AT: Record<number, { table: string; list: string }> = {
  3: { table: 'hidden @min-[480px]/qcard:table', list: '@min-[480px]/qcard:hidden' },
  4: { table: 'hidden @min-[560px]/qcard:table', list: '@min-[560px]/qcard:hidden' },
  5: { table: 'hidden @min-[640px]/qcard:table', list: '@min-[640px]/qcard:hidden' },
};

const ON_FILL = 'bg-primary/12';
const WRAP = '[overflow-wrap:anywhere]';
// The list form's option-name column: as wide as the longest name (`--qs-name`, in `ch`) up to 40% of the line, the
// same on every line so the outcomes line up. A name wraps between words; only a word wider than the column breaks.
const NAME_COLUMN = 'grid-cols-[min(var(--qs-name),40%)_minmax(0,1fr)]';

const PickedNote: React.FC = () => <span className="sr-only">, picked</span>;

const Outcome: React.FC<{ cell: QuestionScenarioCell | undefined; inline: QuestionScenariosProps['inline']; stacked: boolean }> = ({ cell, inline, stacked }) => {
  if (!cell) return null;
  return (
    <>
      {cell.verdict && <span className={stacked ? 'block font-semibold text-foreground' : 'font-semibold text-foreground'} dir="auto">{inline(cell.verdict)}</span>}
      {cell.detail && (
        <span className="text-muted-foreground" dir="auto">
          {!stacked && cell.verdict ? ' — ' : stacked ? <span className="sr-only"> — </span> : null}
          {inline(cell.detail)}
        </span>
      )}
    </>
  );
};

export const QuestionScenarios: React.FC<QuestionScenariosProps> = ({ table, picked, inline }) => {
  const { columns, rows } = table;
  const on = columns.map((c) => picked.includes(c.choice));
  const at = TABLE_AT[Math.max(3, Math.min(5, columns.length))]!;
  const title = rows.length === 1 ? 'Scenario' : 'Scenarios';
  const last = rows.length - 1;
  const nameWidth = { '--qs-name': `${Math.max(1, ...columns.map((c) => [...c.header].length)) + 1}ch` } as React.CSSProperties;
  return (
    <div className="annotation-exclude mt-2.5 text-[12.5px] leading-[1.45]" data-pinpoint-ignore="" data-question-part="scenarios">
      <table
        className={`${at.table} w-full table-fixed border-separate border-spacing-0`}
        data-question-scenarios-table=""
      >
        <caption className="pb-0.5 text-start text-[12.5px] font-semibold text-foreground/85">{title}</caption>
        <thead>
          <tr>
            <th scope="col" className={`${columns.length >= 4 ? 'w-[24%]' : 'w-[30%]'} py-1 ps-0 pe-2 text-start align-top`}>
              <span className="sr-only">Scenario</span>
            </th>
            {columns.map((column, i) => (
              <th
                key={column.choice}
                scope="col"
                className={`${WRAP} rounded-t-[6px] px-2 py-1 text-start align-top text-[12px] font-semibold text-foreground/85 ${on[i] ? ON_FILL : ''}`}
                data-question-scenario-on={on[i] ? '' : undefined}
                dir="auto"
              >
                {inline(column.header)}
                {on[i] && <PickedNote />}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              <th scope="row" className={`${WRAP} border-t border-border/75 py-1.5 ps-0 pe-2 text-start align-top font-medium text-foreground`} dir="auto">
                {inline(row.situation)}
              </th>
              {columns.map((column, i) => (
                <td
                  key={column.choice}
                  className={`${WRAP} border-t border-border/75 px-2 py-1.5 text-start align-top ${on[i] ? ON_FILL : ''} ${on[i] && r === last ? 'rounded-b-[6px]' : ''}`}
                  data-question-scenario-on={on[i] ? '' : undefined}
                >
                  <Outcome cell={row.cells[i]} inline={inline} stacked />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className={at.list} data-question-scenarios-list="">
        <p className="m-0 pb-0.5 text-start font-semibold text-foreground/85">{title}</p>
        <ul aria-label={title} className="m-0 list-none p-0">
          {rows.map((row, r) => (
            <li key={r} className="border-t border-border/75 pb-1.5 pt-2">
              <p role="heading" aria-level={4} className={`${WRAP} m-0 pb-[3px] text-start text-[13px] font-semibold text-foreground`} dir="auto">
                {inline(row.situation)}
              </p>
              <ul className="m-0 list-none p-0">
                {columns.map((column, i) => (
                  <li
                    key={column.choice}
                    className={`-mx-1.5 grid ${NAME_COLUMN} gap-x-2.5 rounded-[6px] px-1.5 py-[3px] ${on[i] ? ON_FILL : ''}`}
                    style={nameWidth}
                    data-question-scenario-on={on[i] ? '' : undefined}
                  >
                    <span className="min-w-0 text-start text-muted-foreground [overflow-wrap:break-word]" dir="auto" data-question-scenario-name="">
                      {inline(column.header)}
                      {on[i] && <PickedNote />}
                    </span>
                    <span className={`${WRAP} min-w-0 text-start`}>
                      <Outcome cell={row.cells[i]} inline={inline} stacked={false} />
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
