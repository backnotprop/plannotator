import { useEffect, useState } from 'react';
import type { InboxRunAgentsModel } from '@plannotator/core/inbox-acp';
import { InboxApiError, inboxApi } from '../api';
import { HostMark } from '../icons';

/**
 * Settings → Agents: "Run in the Inbox" (the ACP runner, packages/server/
 * inbox-acp-runner.ts). Per agent the Inbox can start itself: whether New
 * message offers "New … session", what it runs with, and that Grok
 * Build updates itself when it starts. Only agents installed on this computer
 * are listed, and with none the section is not drawn: someone without Grok
 * Build sees Settings as before (the owner's rule: no change to an existing
 * person's screen without approval). An older Inbox answers 404: nothing is
 * drawn.
 */
export function RunAgentsSettings() {
  const [model, setModel] = useState<InboxRunAgentsModel | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    inboxApi
      .runAgents()
      .then((next) => !gone && setModel(next))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, []);
  const installed = model?.agents.filter((agent) => agent.installed) ?? [];
  if (installed.length === 0) return null;
  const toggle = async (id: (typeof installed)[number]['id'], on: boolean) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      setModel(await inboxApi.setRunEnabled(id, on));
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The setting was not saved.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="ib-sgroup" aria-labelledby="ib-g-run" data-settings-run="">
      <h2 id="ib-g-run">Run in the Inbox</h2>
      <p>
        New message can start a session of these agents itself, in a folder of this Inbox. Every reply in its thread is a real turn, and you watch it work in the
        thread. It runs with its own settings and model, exactly as in its own CLI.
      </p>
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
      <div className="ib-card">
        {installed.map((agent) => (
          <div className="ib-prow" key={agent.id} data-settings-run-agent={agent.id}>
            <HostMark host={agent.id} big />
            <span className="ib-txt">
              <span className="ib-l" id={`ib-run-l-${agent.id}`}>
                {agent.label}
              </span>
              <span className="ib-desc">
                {`Offered in New message as "New ${agent.label} session". Its model is the one ${agent.label} itself uses.`}
                {agent.self_updates && ` ${agent.label} updates itself when it starts, so a session here may bring a new version.`}
              </span>
            </span>
            <span className="ib-ctl">
              <button
                type="button"
                role="switch"
                className="ib-sw"
                aria-checked={agent.enabled}
                aria-labelledby={`ib-run-l-${agent.id}`}
                aria-busy={busy === agent.id || undefined}
                data-settings-run-switch={agent.id}
                onClick={() => void toggle(agent.id, !agent.enabled)}
              />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
