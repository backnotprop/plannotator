/**
 * Plans' routes as the window reads them (packages/shared/plans/routes.ts, mounted by the Inbox only while
 * config.json `inboxPlans` is on; docs/agent-guides/inbox-plans.md). This computer's own: Plans is not on any door
 * route, so a phone's door or a linked machine gets the unknown-route 404. The one write, a look, carries the page's
 * `serverSession`.
 */
import type { PlanDecision, PlanDocument, PlanEvent, PlanLook, PlanRecord, PlanSummary, PlanVersion } from '@plannotator/core/plans';
import { pageServerSession } from '../api';
import { readJson } from '../apiError';

declare module '../api' {
  interface SettingsModel {
    /** Plans (config.json `inboxPlans`, turned on by `plannotator plans`): present only while on. */
    plans?: { on: boolean };
  }
}

export interface PlansList {
  plans: PlanSummary[];
  /** The import is bringing in plan history: ask again shortly. */
  importing: boolean;
}

export interface PlanRead {
  plan: PlanRecord;
  documents: PlanDocument[];
  decisions: PlanDecision[];
  events: PlanEvent[];
  /** What the person had seen before this visit; null before the first look. */
  look: PlanLook | null;
}

export interface PlanDiffSide {
  version_number: number;
  version: string;
  committed_at: string;
  text: string;
}

export interface PlanDiffTexts {
  document_id: string;
  seen: number | null;
  from: PlanDiffSide | null;
  to: PlanDiffSide | null;
}

const BASE = '/api/plans';
const one = (id: string, rest = '') => `${BASE}/${encodeURIComponent(id)}${rest}`;

async function get<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' }));
}

async function text(path: string): Promise<string> {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) await readJson(response);
  return response.text();
}

export const plansApi = {
  list: () => get<PlansList>(BASE),
  read: (id: string) => get<PlanRead>(one(id)),
  versions: (id: string) => get<{ document_id: string; versions: PlanVersion[] }>(one(id, '/versions')),
  /** One version's text, as saved. */
  version: (id: string, n: number) => text(one(id, `/versions/${n}`)),
  diff: (id: string, from: number, to: number) => get<PlanDiffTexts>(one(id, `/diff?from=${from}&to=${to}`)),
  /** The person read version `seen` of the plan's primary document. */
  look: async (id: string, seen: number) => {
    const session = pageServerSession();
    const response = await fetch(one(id, '/look'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(session ? { seen, serverSession: session } : { seen }),
    });
    return readJson<{ look: PlanLook }>(response);
  },
};
