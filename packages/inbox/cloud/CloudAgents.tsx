import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxCloudSetup } from '@plannotator/core/inbox-cloud';
import { inboxApi, type CloudAgentsModel } from '../api';
import { HostMark, Icon } from '../icons';
import { CloudAgentCard } from './CloudAgentCard';
import { CloudPairForm } from './CloudPairForm';
import type { Fresh } from './cloudShared';

const LIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 30_000;

export function CloudAgentsSection() {
  const [model, setModel] = useState<CloudAgentsModel | null>(null);
  const [hidden, setHidden] = useState(false);
  const [adding, setAdding] = useState(false);
  const [fresh, setFresh] = useState<Record<string, Fresh>>({});
  const addButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      setModel(await inboxApi.cloudAgents());
    } catch {
      setHidden(true);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const live = !!model && (Object.keys(fresh).length > 0 || model.agents.some((agent) => agent.link.state !== 'connected'));
  useEffect(() => {
    if (!model || model.agents.length === 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void inboxApi.cloudAgents().then(setModel, () => {});
    }, live ? LIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [model?.agents.length, live]);

  if (hidden || !model || (model.available === false && model.agents.length === 0)) return null;

  const opened = (session: string, setup: InboxCloudSetup | null) => setFresh((all) => ({ ...all, [session]: { setup } }));
  const closed = (session: string) =>
    setFresh((all) => {
      const { [session]: _gone, ...rest } = all;
      return rest;
    });
  const empty = model.agents.length === 0;

  return (
    <section className="ib-sgroup ib-sgroup-first" data-settings-cloud="" aria-label="Cloud agents">
      <div className="ib-agents ib-cl-card">
        {model.agents.map((agent) => (
          <CloudAgentCard
            key={agent.session}
            agent={agent}
            fresh={fresh[agent.session] ?? null}
            onModel={setModel}
            onSetup={(setup) => opened(agent.session, setup)}
            onDone={() => closed(agent.session)}
          />
        ))}
        {adding ? (
          <CloudPairForm
            projects={model.projects}
            onCancel={() => {
              setAdding(false);
              requestAnimationFrame(() => addButton.current?.focus());
            }}
            onPaired={(next, session, setup) => {
              setModel(next);
              setAdding(false);
              opened(session, setup);
            }}
          />
        ) : empty ? (
          <div className="ib-prow">
            <HostMark host="cloud" big />
            <span className="ib-txt">
              <span className="ib-l">No cloud agent paired yet</span>
              <span className="ib-desc">Each one posts under its own name and sees only the threads it is given.</span>
            </span>
            <span className="ib-ctl">
              <button ref={addButton} type="button" className="ib-btn ib-pri" onClick={() => setAdding(true)} data-cloud-pair-start="">
                Pair a cloud agent
              </button>
            </span>
          </div>
        ) : (
          <button ref={addButton} type="button" className="ib-cl-add" onClick={() => setAdding(true)} data-cloud-pair-start="">
            <Icon name="plus" size={15} /> Pair another cloud agent
          </button>
        )}
      </div>
    </section>
  );
}
