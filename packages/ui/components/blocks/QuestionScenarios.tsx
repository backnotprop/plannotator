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

const PickedNote: React.FC = () => <span className="sr-only">, picked</span>;

const Outcome: React.FC<{ cell: QuestionScenarioCell | undefined; inline: QuestionScenariosProps['inline']; stacked: boolean }> = ({ cell, inline, stacked }) => {
  if (!cell) return null;
  return (
    <>
      {cell.verdict && <span className={stacked ? 'block font-semibold text-foreground' : 'font-semibold text-foreground'}>{inline(cell.verdict)}</span>}
      {cell.detail && (
        <span className="text-muted-foreground">
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
  return (
    <div className="annotation-exclude mt-2.5 text-[12.5px] leading-[1.45]" data-pinpoint-ignore="" data-question-part="scenarios">
      <table
        className={`${at.table} w-full table-fixed border-separate border-spacing-0`}
        data-question-scenarios-table=""
      >
        <caption className="pb-0.5 text-left text-[12.5px] font-semibold text-foreground/85">{title}</caption>
        <thead>
          <tr>
            <th scope="col" className={`${columns.length >= 4 ? 'w-[24%]' : 'w-[30%]'} py-1 pl-0 pr-2 text-left align-top`}>
              <span className="sr-only">Scenario</span>
            </th>
            {columns.map((column, i) => (
              <th
                key={column.choice}
                scope="col"
                className={`${WRAP} rounded-t-[6px] px-2 py-1 text-left align-top text-[12px] font-semibold text-foreground/85 ${on[i] ? ON_FILL : ''}`}
                data-question-scenario-on={on[i] ? '' : undefined}
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
              <th scope="row" className={`${WRAP} border-t border-border/75 py-1.5 pl-0 pr-2 text-left align-top font-medium text-foreground`}>
                {inline(row.situation)}
              </th>
              {columns.map((column, i) => (
                <td
                  key={column.choice}
                  className={`${WRAP} border-t border-border/75 px-2 py-1.5 align-top ${on[i] ? ON_FILL : ''} ${on[i] && r === last ? 'rounded-b-[6px]' : ''}`}
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
        <p className="m-0 pb-0.5 font-semibold text-foreground/85">{title}</p>
        <ul aria-label={title} className="m-0 list-none p-0">
          {rows.map((row, r) => (
            <li key={r} className="border-t border-border/75 pb-1.5 pt-2">
              <p role="heading" aria-level={4} className={`${WRAP} m-0 pb-[3px] text-[13px] font-semibold text-foreground`}>
                {inline(row.situation)}
              </p>
              <ul className="m-0 list-none p-0">
                {columns.map((column, i) => (
                  <li
                    key={column.choice}
                    className={`${WRAP} -mx-1.5 grid grid-cols-[80px_minmax(0,1fr)] gap-x-2.5 rounded-[6px] px-1.5 py-[3px] ${on[i] ? ON_FILL : ''}`}
                    data-question-scenario-on={on[i] ? '' : undefined}
                  >
                    <span className="min-w-0 text-muted-foreground">
                      {inline(column.header)}
                      {on[i] && <PickedNote />}
                    </span>
                    <span className="min-w-0">
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
