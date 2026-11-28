import { useEffect, useId, useRef, useState } from 'react';
import type { InboxPullRiskAnswer, InboxPullRiskAuto, InboxPullRiskModels } from '@plannotator/core/inbox-types';
import { modelSelectOptions } from '@plannotator/core/model-catalog';
import { InlinePicker } from '@plannotator/ui/components/InlinePicker';
import { inboxApi } from '../api';
import { HostMark } from '../icons';
import { Modal } from '../components/Updates';
import { riskFilterWords } from './risk';
import { RiskInfo } from './RiskInfo';
import { dismissRanked, RiskAlreadyRanked, riskAlreadyRanked } from './RiskAlreadyRanked';

const PLACEHOLDER = 'It touches billing or auth.\nIt changes how we store user data.';
const LOADING = [{ value: '', label: 'Loading models…' }];
/** What the guided review's picker calls an agent's own default model. */
const AGENT_DEFAULT = { value: '', label: 'Default' };
const AUTO_MAKES = [
  { value: '', label: 'nothing' },
  { value: 'picture_it', label: 'a Picture page' },
  { value: 'guide', label: 'a guided review' },
];
const RULES_INFO = 'Every open pull request is ranked against these rules: not touched is Low, maybe is Medium, definitely is High.';
const AGENT_INFO = 'This agent reads the whole diff of each pull request to rank it. Sonnet, Luna or similar works well.';
const AUTO_INFO = {
  high: 'New pull requests and pushes from your team that rank High get one, once. The rest wait until you ask.',
  medium: 'New pull requests and pushes from your team that rank Medium or High get one, once. The rest wait until you ask.',
} as const;

export function riskAutoToSave(saved: InboxPullRiskAuto | null | undefined, make: string): InboxPullRiskAuto | null | undefined {
  if (make === (saved?.make ?? '')) return undefined;
  if (make !== 'picture_it' && make !== 'guide') return null;
  return { ...saved, level: saved?.level ?? 'high', make };
}

/**
 * "No slop zone rules": the person's words for what a high-risk pull request is, and the
 * agent that ranks the open ones against them. Saved to the Inbox's config, never to a
 * repository. Empty rules turn the judging off.
 */
export function RiskRulesDialog({ answer, onSaved, onClose, onAsked }: { answer: InboxPullRiskAnswer; onSaved: (next: InboxPullRiskAnswer) => void; onClose: () => void; onAsked?: (keys: readonly string[]) => void }) {
  const titleId = useId();
  const rulesId = useId();
  const [rules, setRules] = useState(answer.rules);
  const saved = answer.provider && answer.agents.some((a) => a.id === answer.provider) ? answer.provider : null;
  const [provider, setProvider] = useState<string | null>(saved ?? answer.agents[0]?.id ?? null);
  const [model, setModel] = useState<string | null>(saved ? answer.model : null);
  const [list, setList] = useState<InboxPullRiskModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState<InboxPullRiskAnswer | null>(null);
  // Branch reviews (present only while it is on): rank the branches agents report too. Off until the person ticks it.
  const [branches, setBranches] = useState(answer.branches === true);
  const [make, setMake] = useState<string>(answer.auto?.make ?? '');
  const [autoAgent, setAutoAgent] = useState<Pick<InboxPullRiskAnswer, 'auto_agent' | 'auto_agent_unavailable'> | null>(answer.auto ? answer : null);
  const autoId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  // The words come first: the box takes the focus, not Save.
  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    if (!provider) return;
    const controller = new AbortController();
    setList(null);
    inboxApi
      .pullRiskModels(provider, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setList(next);
        // A saved pick stays while the list can't say otherwise.
        setModel((was) => (was && (next.models.length === 0 || next.models.some((m) => m.id === was)) ? was : next.default_model));
      })
      .catch(() => {
        if (!controller.signal.aborted) setList({ models: [], default_model: null });
      });
    return () => controller.abort();
  }, [provider]);
  useEffect(() => {
    if (!make || autoAgent) return;
    const controller = new AbortController();
    inboxApi
      .pullRisk(controller.signal, true)
      .then((next) => {
        if (!controller.signal.aborted) setAutoAgent(next);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [make, autoAgent]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const auto = riskAutoToSave(answer.auto, make);
      const next = await inboxApi.savePullRisk({ rules, provider, model, ...(answer.branches !== undefined ? { branches } : {}), ...(auto !== undefined ? { auto } : {}) });
      if (make && next.auto_agent && riskAlreadyRanked(next) > 0) {
        onAsked?.(next.auto_waiting ?? []);
        setAsking(next);
      } else onSaved(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The rules could not be saved.');
      setSaving(false);
    }
  };
  // No model yet: wait for the list and the pick it starts on.
  const readingModel = !!provider && !list && !model;
  // No pick to start on means the agent's own default is a choice, as in the guided review (Pi, OpenCode).
  const modelOptions = !list ? LOADING : [...(list.default_model ? [] : [AGENT_DEFAULT]), ...modelSelectOptions(list.models, model ?? undefined)];
  const level = riskFilterWords[answer.auto?.level ?? 'high'];
  if (asking) {
    return (
      <Modal labelledBy={titleId} onClose={() => void dismissRanked(asking.auto_waiting ?? []).then(onSaved, () => onSaved(asking))} testId="pull-risk-rules" className="ib-riskd" ownKeys>
        <RiskAlreadyRanked titleId={titleId} saved={asking} onDone={onSaved} />
      </Modal>
    );
  }
  return (
    <Modal labelledBy={titleId} onClose={onClose} testId="pull-risk-rules" className="ib-riskd" ownKeys>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={titleId}>Risk rules</h2>
        <div className="ib-riskd-say">
          <label className="ib-sub ib-riskd-l" htmlFor={rulesId}>
            What is high risk for you?
          </label>
          <RiskInfo name="rules" label="How ranking works" text={RULES_INFO} />
        </div>
        <textarea ref={field} id={rulesId} className="ib-riskd-t" rows={5} placeholder={PLACEHOLDER} value={rules} onChange={(event) => setRules(event.target.value)} data-pull-risk-rules-text="" />
        {answer.agents.length === 0 ? (
          <p className="ib-quietline" data-pull-risk-no-agent="">
            No agent found on this computer. Install Claude Code, Codex, Pi or OpenCode to rank pull requests.
          </p>
        ) : (
          <>
            <div className="ib-riskd-row ib-riskd-picks">
              <div className="ib-riskd-pick" data-pull-risk-agent={provider ?? ''}>
                <InlinePicker
                  keysStayInList
                  plainGroupLabels
                  label="Agent"
                  value={provider ?? ''}
                  options={answer.agents.map((agent) => ({ value: agent.id, label: agent.label }))}
                  onChange={(next) => {
                    if (next === provider) return;
                    setModel(null);
                    setProvider(next);
                  }}
                />
              </div>
              <div className="ib-riskd-pick" data-pull-risk-model={model ?? ''}>
                <InlinePicker keysStayInList plainGroupLabels label="Model" value={list ? (model ?? '') : ''} options={modelOptions} onChange={(next) => setModel(next || null)} />
              </div>
            </div>
            <div className="ib-riskd-say ib-quietline">
              <p>Diffs go to this provider. A cheap model is enough.</p>
              <RiskInfo name="agent" label="Where diffs go" text={AGENT_INFO} />
            </div>
            {answer.last_failure && (
              <p className="ib-quietline ib-riskd-failed" data-pull-risk-failed="">
                Last ranking failed: {answer.last_failure}
              </p>
            )}
          </>
        )}
        {answer.branches !== undefined && (
          <>
            <label className="ib-opt" data-pull-risk-branches="">
              <input type="checkbox" checked={branches} onChange={(event) => setBranches(event.target.checked)} />
              <span>Also rank branches agents report ready</span>
            </label>
            <p className="ib-quietline" data-pull-risk-branches-words="">
              When an agent reports a branch ready for review, its whole diff against its base (up to 8 MB), pushed or not, goes to the risk agent above and its provider, once per commit, and only when that commit is on this computer. Branches nobody reported are never sent.
            </p>
          </>
        )}
        <div className="ib-riskd-row ib-riskd-auto" role="group" aria-labelledby={autoId} data-pull-risk-auto={make}>
          <span id={autoId}>On {level}, make</span>
          <div className="ib-riskd-make">
            <InlinePicker keysStayInList label="" value={make} options={AUTO_MAKES} onChange={setMake} />
          </div>
          <span className="ib-riskd-tail">
            {make && autoAgent && (
              <span className="ib-riskd-with" data-pull-risk-auto-agent={autoAgent.auto_agent?.agent ?? ''}>
                {autoAgent.auto_agent ? (
                  <>
                    with <HostMark host={autoAgent.auto_agent.agent} /> {autoAgent.auto_agent.name}
                  </>
                ) : (
                  (autoAgent.auto_agent_unavailable ?? 'No agent can be started here.')
                )}
              </span>
            )}
            <RiskInfo name="auto" label="What this makes" text={AUTO_INFO[answer.auto?.level ?? 'high']} />
          </span>
        </div>
        {error && (
          <p className="ib-error" role="alert">
            {error}
          </p>
        )}
        <div className="ib-acts-row ib-riskd-acts">
          <button type="button" className="ib-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ib-btn ib-pri" disabled={saving || readingModel} data-pull-risk-save="">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
