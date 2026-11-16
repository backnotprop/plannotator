/**
 * Plans' home (approval "inbox-plans", the mix): before any plan is here, the get-started screen; once there are
 * plans, the list (the H1 list): "Plans", search, a project menu and New plan, then "Since you looked" (the plans
 * that changed since you opened them) and the rest by project. Each row: its name, its news, its decision and what
 * it holds, its last change and how many versions are new.
 */
import { useId, useMemo, useState } from 'react';
import type { PlanSummary } from '@plannotator/core/plans';
import { formatCount, fullTime, shortTime } from '@plannotator/core/inbox-format';
import { SidebarTrigger } from '../shell/sidebar';
import { Icon } from '../icons';
import { writeRoute } from '../app/writeRoute';
import { PlansGetStarted } from './PlansGetStarted';
import { readPlans, usePlansPage } from './store';
import { decisionLabel, decisionTone, filterPlans, holdsLine, newSince, newsLine, planGroups, planProjects } from './words';
import { DecisionMark, ImportErrorNote, PlansMessage } from './parts';

const openPlan = (id: string) => writeRoute({ page: 'plans', project: null, thread: null, plan: id });

export function PlansHome({ showStart }: { showStart: boolean }) {
  const snap = usePlansPage();
  if (snap.off) return <PlansMessage title="Plans is off" body="Its plans stay on this computer." onBack={() => writeRoute({ page: 'inbox', project: null, thread: null })} backLabel="Inbox" />;
  if (!snap.plans) {
    if (snap.error) return <PlansMessage title="Plans could not be read" body={snap.error} onRetry={() => void readPlans()} />;
    return <PlansMessage busy title="Plans" body="Loading plans…" />;
  }
  if (snap.plans.length === 0 || showStart) {
    return (
      <PlansGetStarted
        importing={snap.importing && snap.plans.length === 0}
        note={snap.importError && !snap.importing ? <ImportErrorNote error={snap.importError} onRetry={() => void readPlans(true)} /> : undefined}
        onBack={snap.plans.length > 0 ? () => writeRoute({ page: 'plans', project: null, thread: null }) : undefined}
      />
    );
  }
  return <PlansList plans={snap.plans} importing={snap.importing} error={snap.error} importError={snap.importing ? null : snap.importError} />;
}

function PlansList({ plans, importing, error, importError }: { plans: readonly PlanSummary[]; importing: boolean; error: string | null; importError: string | null }) {
  const [query, setQuery] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const projects = useMemo(() => planProjects(plans), [plans]);
  const shown = useMemo(() => filterPlans(plans, query, project), [plans, query, project]);
  const groups = useMemo(() => planGroups(shown), [shown]);
  const searchId = useId();
  return (
    <section className="ib-dpage ib-plans ib-plans-home" aria-labelledby={`${searchId}-h`} data-plans-home="">
      <div className="ib-plans-col">
        <div className="ib-dh">
          <SidebarTrigger />
          <h1 id={`${searchId}-h`} tabIndex={-1}>
            Plans
          </h1>
        </div>
        <p className="ib-plans-sub">Every plan from every project, with its versions and files. Newest activity first.</p>
        <div className="ib-plans-bar" role="search">
          <label className="ib-plans-search">
            <Icon name="search" />
            <span className="sr-only">Search plans</span>
            <input type="search" placeholder="Search plans" value={query} onChange={(e) => setQuery(e.target.value)} data-plans-search="" />
          </label>
          {projects.length > 1 && (
            <label className="ib-plans-project">
              <span className="sr-only">Project</span>
              <select value={project ?? ''} onChange={(e) => setProject(e.target.value || null)} data-plans-project="">
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <Icon name="chevD" />
            </label>
          )}
          <button type="button" className="ib-plans-primary ib-plans-new" onClick={() => writeRoute({ page: 'plans', project: null, thread: null, planNew: true })} data-plans-new="">
            <Icon name="plus" />
            New plan
          </button>
        </div>
        {importing && (
          <p className="ib-plans-note" role="status">
            Bringing in the plans you reviewed before…
          </p>
        )}
        {importError && <ImportErrorNote error={importError} onRetry={() => void readPlans(true)} />}
        {error && (
          <p className="ib-plans-note" role="alert">
            {error}{' '}
            <button type="button" className="ib-plans-link" onClick={() => void readPlans()}>
              Try again
            </button>
          </p>
        )}
        {groups.length === 0 ? (
          <div className="ib-plans-none" data-plans-none="">
            <p>{query.trim() ? `No plan matches “${query.trim()}”.` : 'No plans in this project.'}</p>
            <button
              type="button"
              className="ib-plans-link"
              onClick={() => {
                setQuery('');
                setProject(null);
              }}
            >
              Show every plan
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="ib-plans-group" aria-labelledby={`${searchId}-${group.key}`} data-plans-group={group.key}>
              <h2 id={`${searchId}-${group.key}`}>
                {group.title} <span className="ib-plans-count">{formatCount(group.plans.length)}</span>
              </h2>
              <ul className="ib-plans-rows">
                {group.plans.map((plan) => (
                  <PlanRow key={plan.id} plan={plan} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </section>
  );
}

function PlanRow({ plan }: { plan: PlanSummary }) {
  const fresh = newSince(plan);
  const tone = decisionTone(plan.decision?.decision);
  return (
    <li>
      <button type="button" className="ib-plans-row" onClick={() => openPlan(plan.id)} data-plan-row={plan.id} data-changed={plan.changed ? '' : undefined}>
        <PlanThumb id={plan.id} />
        <span className="ib-plans-row-main">
          <span className="ib-plans-row-name" dir="auto">
            {plan.name}
          </span>
          <span className="ib-plans-row-news">{newsLine(plan)}</span>
          <span className="ib-plans-row-holds">
            <DecisionMark tone={tone} />
            <span data-plan-decision={tone}>{decisionLabel(plan.decision?.decision)}</span>
            <span aria-hidden="true">·</span>
            <span>{holdsLine(plan)}</span>
            {plan.project_name && <span className="ib-plans-row-project"> · {plan.project_name}</span>}
          </span>
        </span>
        <span className="ib-plans-row-end">
          <time dateTime={plan.updated_at} title={fullTime(plan.updated_at)}>
            {shortTime(plan.updated_at)}
          </time>
          {fresh > 0 && (
            <span className="ib-plans-new-n" data-plan-changed="">
              {fresh} new<span className="sr-only">, changed since you looked</span>
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** A plan's page in miniature: lines of a document, the same for the same plan. Decoration only. */
function PlanThumb({ id }: { id: string }) {
  let seed = 0;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) >>> 0;
  const widths = Array.from({ length: 6 }, (_, i) => 48 + ((seed >> (i * 3)) % 7) * 7);
  return (
    <span className="ib-plans-thumb" aria-hidden="true">
      <span className="ib-plans-thumb-h" />
      {widths.map((w, i) => (
        <span key={i} className={i === 2 ? 'ib-plans-thumb-s' : undefined} style={{ width: `${w}%` }} />
      ))}
    </span>
  );
}
