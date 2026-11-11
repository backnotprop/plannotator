import { useId } from 'react';
import { inboxPullIsOpen, inboxPullLabel, inboxPullLandsNext, type InboxPull, type InboxPullStack } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { SidebarTrigger } from '../shell/sidebar';
import { ChecksMark, checksLabel } from './ChecksMark';
import { ageShort, needsYou, stackCounts, statusParts, statusWords, topFirst } from './sheetModel';
import { Named, Person } from '../pulls/Face';
import { facesOnce, person, wordsText, type Words } from '../pulls/words';

export interface StackPageProps {
  stack: InboxPullStack | null;
  loading: boolean;
  repoLabel: string | null;
  phone: boolean;
  onBack: () => void;
  onOpenLayer: (pull: InboxPull) => void;
  now?: number;
}

export function StackPage(props: StackPageProps) {
  const { stack, phone } = props;
  const now = props.now ?? Date.now();
  const titleId = useId();
  const crumb = (
    <nav className="ib-prst-crumb" aria-label="Breadcrumb">
      <SidebarTrigger />
      <button type="button" className="ib-bback" onClick={props.onBack} data-pr-stack-back="">
        <Icon name="chevL" size={15} />
        Pull requests
      </button>
      {props.repoLabel && <span className="ib-prst-repo">/ {props.repoLabel}</span>}
    </nav>
  );
  if (!stack) {
    return (
      <section className="ib-prs ib-prst" aria-labelledby={titleId} data-pr-stack-page="">
        <div className="ib-prs-scroll">
          {crumb}
          {props.loading ? (
            <div className="ib-prs-loading" aria-busy="true" />
          ) : (
            <div className="ib-prs-empty">
              <h1 id={titleId}>This stack isn’t open any more</h1>
              <p>Its layers merged or closed, or the list no longer has them.</p>
            </div>
          )}
        </div>
      </section>
    );
  }
  const counts = stackCounts(stack);
  const next = inboxPullLandsNext(stack);
  const authors = [...new Set(stack.layers.map((l) => l.author).filter((a): a is string => !!a))];
  const owner = stack.layers[stack.layers.length - 1]!.author ?? authors[0] ?? null;
  const rows = topFirst(stack);
  const meta = [
    counts.merged > 0 ? `${counts.merged} merged` : null,
    `${counts.open} open`,
    counts.needYou > 0 ? { you: `${counts.needYou} need you` } : null,
    counts.failing > 0 ? { bad: `${counts.failing} failing` } : null,
    next ? `next to land ${inboxPullLabel(next)}` : null,
    owner ? { by: ['by ', person(owner), ...(authors.length > 1 ? [` and ${authors.length - 1} ${authors.length === 2 ? 'other' : 'others'}`] : [])] as Words } : null,
  ].filter(Boolean) as (string | { you: string } | { bad: string } | { by: Words })[];
  return (
    <section className="ib-prs ib-prst" aria-labelledby={titleId} data-pr-stack-page={stack.id} data-phone={phone ? '' : undefined}>
      <div className="ib-prs-scroll">
        {crumb}
        <header className="ib-prst-head">
          <h1 id={titleId} tabIndex={-1}>
            Stack of {stack.layers.length} into <code>{stack.base}</code>
          </h1>
          <p className="ib-prs-sum">
            {meta.map((m, i) =>
              typeof m === 'string' ? (
                <span key={i}>{m}</span>
              ) : 'by' in m ? (
                <span key={i}>
                  <Named words={m.by} host={stack.layers[0]!.host} />
                </span>
              ) : 'you' in m ? (
                <span key={i} className="ib-prs-you">
                  {m.you}
                </span>
              ) : (
                <span key={i} className="ib-prs-bad">
                  {m.bad}
                </span>
              ),
            )}
          </p>
        </header>
        <ol className="ib-prst-list" aria-label={`Layers, top of the stack first`}>
          {rows.map((pull) => {
            const at = stack.layers.indexOf(pull) + 1;
            const you = needsYou(pull);
            const open = inboxPullIsOpen(pull);
            const lands = next?.key === pull.key;
            const other = pull.author && pull.author !== owner ? pull.author : null;
            const said: Words = lands && open && statusWords(pull, now) === 'Approved · ready to land' ? ['Approved · lands next'] : statusParts(pull, now);
            const status = wordsText(said);
            return (
              <li key={pull.key} className="ib-prst-li">
                <button
                  type="button"
                  className="ib-prst-row"
                  data-state={pull.state}
                  data-you={you ? '' : undefined}
                  data-lands={lands ? '' : undefined}
                  data-fail={open && pull.checks === 'failure' ? '' : undefined}
                  onClick={() => props.onOpenLayer(pull)}
                  aria-label={`Layer ${at}: ${inboxPullLabel(pull)} ${pull.title}, ${status}${checksLabel(pull.checks) && open ? `, ${checksLabel(pull.checks)}` : ''}. Open it.`}
                  data-pr-layer={pull.key}
                >
                  <span className="ib-prst-at">{at}</span>
                  <span className="ib-prst-node" aria-hidden="true" />
                  <span className="ib-prst-n">{inboxPullLabel(pull)}</span>
                  <span className="ib-prst-t" dir="auto">
                    <span className="ib-prst-title">{pull.title || inboxPullLabel(pull)}</span>
                    {other && (
                      <span className="ib-prst-who">
                        <Person login={other} host={pull.host} />
                      </span>
                    )}
                  </span>
                  <span className="ib-prst-ck">{open && <ChecksMark checks={pull.checks} />}</span>
                  <span className="ib-prst-diff">
                    <span className="ib-prst-add">+{pull.additions.toLocaleString()}</span> <span className="ib-prst-del">−{pull.deletions.toLocaleString()}</span>
                  </span>
                  <span className="ib-prst-st" title={status}>
                    <Named words={facesOnce(said, [other])} host={pull.host} />
                  </span>
                  <span className="ib-prst-age">{ageShort(pull.state === 'merged' && pull.merged_at ? pull.merged_at : pull.updated_at, now)}</span>
                </button>
              </li>
            );
          })}
          <li className="ib-prst-li ib-prst-base" aria-label={`${stack.base}, the base branch`}>
            <span className="ib-prst-at" />
            <span className="ib-prst-node" data-base="" aria-hidden="true" />
            <span className="ib-prst-basen">
              <code>{stack.base}</code> · the base branch
            </span>
          </li>
        </ol>
      </div>
    </section>
  );
}
