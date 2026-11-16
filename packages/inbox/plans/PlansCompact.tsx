/**
 * The Plans home's compact list: one line per plan in a table (name, project, version, decision, last change), the
 * second view beside the rows with previews. "Since you looked" first, then every other plan newest first
 * (`compactGroups`). Each name is a link to the plan, stretched over its whole line, so the line is the click target
 * and a screen reader reads a table of links. Lines show hover and keyboard focus by fill only. On a phone the table
 * keeps name, decision mark and date, with project and version on a quiet second line under the name: it never
 * scrolls sideways.
 */
import type { MouseEvent } from 'react';
import type { PlanSummary } from '@plannotator/core/plans';
import { formatCount, fullTime, shortTime } from '@plannotator/core/inbox-format';
import { hashOf, writeRoute } from '../app/writeRoute';
import { compactGroups, decisionTone, newSince, planDecisionWords, PLANS_COMPACT_COLUMNS } from './words';
import { DecisionMark } from './parts';

const planRoute = (id: string) => ({ page: 'plans' as const, project: null, thread: null, plan: id });

/** A plain click opens the plan in this window; a modified one (new tab, new window) is the browser's. */
function openHere(e: MouseEvent<HTMLAnchorElement>, id: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  writeRoute(planRoute(id));
}

export function PlansCompact({ plans, labelledBy }: { plans: readonly PlanSummary[]; labelledBy: string }) {
  const groups = compactGroups(plans);
  const c = PLANS_COMPACT_COLUMNS;
  return (
    <table className="ib-plans-table" aria-labelledby={labelledBy} data-plans-compact="">
      <thead>
        <tr>
          <th scope="col">{c.name}</th>
          <th scope="col" className="ib-plans-c-project">
            {c.project}
          </th>
          <th scope="col" className="ib-plans-c-version">
            {c.version}
          </th>
          <th scope="col" className="ib-plans-c-decision">
            {c.decision}
          </th>
          <th scope="col" className="ib-plans-c-date">
            {c.date}
          </th>
        </tr>
      </thead>
      {groups.map((group) => (
        <tbody key={group.key} data-plans-group={group.key}>
          {group.title && (
            <tr className="ib-plans-c-group">
              <th scope="rowgroup" colSpan={5}>
                {group.title} <span className="ib-plans-count">{formatCount(group.plans.length)}</span>
              </th>
            </tr>
          )}
          {group.plans.map((plan) => (
            <CompactRow key={plan.id} plan={plan} />
          ))}
        </tbody>
      ))}
    </table>
  );
}

function CompactRow({ plan }: { plan: PlanSummary }) {
  const fresh = newSince(plan);
  const tone = decisionTone(plan.decision?.decision);
  const version = `v${plan.head_version_number}`;
  return (
    <tr className="ib-plans-c-row" data-plan-row={plan.id} data-changed={plan.changed ? '' : undefined}>
      <td className="ib-plans-c-name">
        <a href={hashOf(planRoute(plan.id))} title={plan.name} dir="auto" onClick={(e) => openHere(e, plan.id)}>
          {plan.name}
        </a>
        <span className="ib-plans-c-sub" aria-hidden="true">
          {plan.project_name ? `${plan.project_name} · ${version}` : version}
        </span>
      </td>
      <td className="ib-plans-c-project" title={plan.project_name ?? undefined}>
        {plan.project_name ?? '—'}
      </td>
      <td className="ib-plans-c-version">{version}</td>
      <td className="ib-plans-c-decision" title={planDecisionWords(plan)}>
        <span className="ib-plans-c-dec">
          <DecisionMark tone={tone} />
          <span className="ib-plans-c-dwords" data-plan-decision={tone}>
            {planDecisionWords(plan)}
          </span>
        </span>
      </td>
      <td className="ib-plans-c-date">
        <time dateTime={plan.updated_at} title={fullTime(plan.updated_at)}>
          {shortTime(plan.updated_at)}
        </time>
        {fresh > 0 && (
          <span className="ib-plans-new-n" data-plan-changed="">
            {fresh} new<span className="sr-only">, changed since you looked</span>
          </span>
        )}
      </td>
    </tr>
  );
}
