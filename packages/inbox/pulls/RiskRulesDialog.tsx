import { useEffect, useId, useRef, useState } from 'react';
import { INBOX_PULL_RISK_RULES_MAX, type InboxPullRiskAnswer, type InboxPullRiskModels } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { Modal } from '../components/Updates';

const PLACEHOLDER = 'It touches billing or auth.\nIt changes how we store user data.';

/**
 * "No slop rules": the person's words for what a high-risk pull request is, and the
 * agent that judges each new one against them. Saved to the Inbox's config, never to a
 * repository. Empty rules turn the judging off.
 */
export function RiskRulesDialog({ answer, onSaved, onClose }: { answer: InboxPullRiskAnswer; onSaved: (next: InboxPullRiskAnswer) => void; onClose: () => void }) {
  const titleId = useId();
  const rulesId = useId();
  const agentId = useId();
  const modelId = useId();
  const [rules, setRules] = useState(answer.rules);
  const saved = answer.provider && answer.agents.some((a) => a.id === answer.provider) ? answer.provider : null;
  const [provider, setProvider] = useState<string | null>(saved ?? answer.agents[0]?.id ?? null);
  const [model, setModel] = useState<string | null>(saved ? answer.model : null);
  const [list, setList] = useState<InboxPullRiskModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
        setModel((was) => (was && next.models.some((m) => m.id === was) ? was : next.default_model));
      })
      .catch(() => {
        if (!controller.signal.aborted) setList({ models: [], default_model: null });
      });
    return () => controller.abort();
  }, [provider]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await inboxApi.savePullRisk({ rules, provider, model }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The rules could not be saved.');
      setSaving(false);
    }
  };
  const agentName = answer.agents.find((a) => a.id === provider)?.label;
  return (
    <Modal labelledBy={titleId} onClose={onClose} testId="pull-risk-rules" className="ib-riskd" ownKeys>
      <form
        className="ib-dlg-in"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={titleId}>No slop rules</h2>
        <label className="ib-sub ib-riskd-l" htmlFor={rulesId}>
          What makes a pull request high risk for you? Each new one is checked against this: not touched is low, maybe is medium, definitely is high.
        </label>
        <textarea ref={field} id={rulesId} className="ib-riskd-t" rows={5} maxLength={INBOX_PULL_RISK_RULES_MAX} placeholder={PLACEHOLDER} value={rules} onChange={(event) => setRules(event.target.value)} data-pull-risk-rules-text="" />
        {answer.agents.length === 0 ? (
          <p className="ib-quietline" data-pull-risk-no-agent="">
            No agent found on this computer. Install Claude Code, Codex, Pi or OpenCode to run the checks.
          </p>
        ) : (
          <>
            <div className="ib-riskd-row">
              <label htmlFor={agentId}>
                <span>Risk agent</span>
                <select
                  id={agentId}
                  className="ib-riskd-s"
                  value={provider ?? ''}
                  onChange={(event) => {
                    setModel(null);
                    setProvider(event.target.value);
                  }}
                  data-pull-risk-agent=""
                >
                  {answer.agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.label}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor={modelId}>
                <span>Model</span>
                <select id={modelId} className="ib-riskd-s" value={model ?? ''} disabled={!list || list.models.length === 0} onChange={(event) => setModel(event.target.value)} data-pull-risk-model="">
                  {!list && <option value={model ?? ''}>{model ?? 'Reading models…'}</option>}
                  {list && list.models.length === 0 && <option value="">Its default model</option>}
                  {list?.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="ib-quietline">A cheap model is plenty: Sonnet, Terra or similar. Diffs go only to the provider you choose here.</p>
            {answer.agent_failed && (
              <p className="ib-quietline" data-pull-risk-failed="">
                The last check didn&rsquo;t finish. Check that {agentName ?? 'the agent'} works on this computer.
              </p>
            )}
          </>
        )}
        {error && (
          <p className="ib-error" role="alert">
            {error}
          </p>
        )}
        <div className="ib-acts-row ib-riskd-acts">
          <button type="button" className="ib-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ib-btn ib-pri" disabled={saving} data-pull-risk-save="">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
