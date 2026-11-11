import { useEffect, useId, useRef, useState } from 'react';
import type { InboxPullRiskAnswer, InboxPullRiskModels } from '@plannotator/core/inbox-types';
import { modelSelectOptions } from '@plannotator/core/model-catalog';
import { InlinePicker } from '@plannotator/ui/components/InlinePicker';
import { inboxApi } from '../api';
import { Modal } from '../components/Updates';

const PLACEHOLDER = 'It touches billing or auth.\nIt changes how we store user data.';
const LOADING = [{ value: '', label: 'Loading models…' }];
const AGENT_DEFAULT = { value: '', label: 'Default' };

export function RiskRulesDialog({ answer, onSaved, onClose }: { answer: InboxPullRiskAnswer; onSaved: (next: InboxPullRiskAnswer) => void; onClose: () => void }) {
  const titleId = useId();
  const rulesId = useId();
  const [rules, setRules] = useState(answer.rules);
  const saved = answer.provider && answer.agents.some((a) => a.id === answer.provider) ? answer.provider : null;
  const [provider, setProvider] = useState<string | null>(saved ?? answer.agents[0]?.id ?? null);
  const [model, setModel] = useState<string | null>(saved ? answer.model : null);
  const [list, setList] = useState<InboxPullRiskModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
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
        setModel((was) => (was && (next.models.length === 0 || next.models.some((m) => m.id === was)) ? was : next.default_model));
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
  const readingModel = !!provider && !list && !model;
  const modelOptions = !list ? LOADING : [...(list.default_model ? [] : [AGENT_DEFAULT]), ...modelSelectOptions(list.models, model ?? undefined)];
  return (
    <Modal labelledBy={titleId} onClose={onClose} testId="pull-risk-rules" className="ib-riskd" ownKeys>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={titleId}>No slop zone rules</h2>
        <label className="ib-sub ib-riskd-l" htmlFor={rulesId}>
          What makes a pull request high risk for you? Every open one is ranked against this: not touched is low, maybe is medium, definitely is high.
        </label>
        <textarea ref={field} id={rulesId} className="ib-riskd-t" rows={5} placeholder={PLACEHOLDER} value={rules} onChange={(event) => setRules(event.target.value)} data-pull-risk-rules-text="" />
        {answer.agents.length === 0 ? (
          <p className="ib-quietline" data-pull-risk-no-agent="">
            No agent found on this computer. Install Claude Code, Codex, Pi or OpenCode to rank pull requests.
          </p>
        ) : (
          <>
            <div className="ib-riskd-row">
              <div data-pull-risk-agent={provider ?? ''}>
                <InlinePicker
                  keysStayInList
                  plainGroupLabels
                  label="Risk agent"
                  value={provider ?? ''}
                  options={answer.agents.map((agent) => ({ value: agent.id, label: agent.label }))}
                  onChange={(next) => {
                    if (next === provider) return;
                    setModel(null);
                    setProvider(next);
                  }}
                />
              </div>
              <div data-pull-risk-model={model ?? ''}>
                <InlinePicker keysStayInList plainGroupLabels label="Model" value={list ? (model ?? '') : ''} options={modelOptions} onChange={(next) => setModel(next || null)} />
              </div>
            </div>
            <p className="ib-quietline">A cheap model is plenty: Sonnet, Luna or similar. Diffs go only to the provider you choose here.</p>
            {answer.last_failure && (
              <p className="ib-quietline" data-pull-risk-failed="">
                The last ranking didn&rsquo;t finish. {answer.last_failure}
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
          <button type="submit" className="ib-btn ib-pri" disabled={saving || readingModel} data-pull-risk-save="">
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
