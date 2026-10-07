/**
 * Choose where the send goes (⌘K): live sessions, the one a person typed into
 * most recently first. Return picks; the choice holds for this collection.
 */

import { useEffect, useState } from 'react';
import { HOST_LONG_LABELS, type ConnectionView } from '@plannotator/shared/shots/types';
import { AgentMark } from './AgentMark';

interface Props {
  connections: ConnectionView[];
  current: (ConnectionView & { reason: string }) | null;
  title?: string;
  onPick: (connection: ConnectionView) => void;
  onCopy: () => void;
  onClose: () => void;
}

function ago(at: number): string {
  if (!at) return '';
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'typed just now';
  if (minutes < 60) return `typed ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `typed ${hours}h ago` : `typed ${Math.round(hours / 24)}d ago`;
}

function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

export function Picker({ connections, current, title = 'Send to', onPick, onCopy, onClose }: Props) {
  const initial = Math.max(0, connections.findIndex((c) => current && c.host === current.host && c.sessionId === current.sessionId));
  const [index, setIndex] = useState(initial);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') setIndex((i) => Math.min(connections.length - 1, i + 1));
      else if (event.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
      else if (event.key === 'Enter' && connections[index]) onPick(connections[index]!);
      else if (event.key === 'Escape') onClose();
      else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c') onCopy();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [connections, index, onPick, onClose, onCopy]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="picker glass" role="listbox" aria-label={title}>
        <div className="pk-head">
          {title} <span>{connections.length} live</span>
        </div>
        <div className="pk-list">
          {connections.length === 0 && (
            <div className="pk-empty">
              No session. Run <b>/plannotator-screenshot</b> in your agent.
            </div>
          )}
          {connections.map((connection, i) => {
            const isCurrent = !!current && current.host === connection.host && current.sessionId === connection.sessionId;
            const auto = isCurrent && current!.reason !== 'chosen' && current!.reason !== 'summoned';
            const state = connection.host === 'cli-wait' ? 'waiting' : connection.busy ? 'working' : 'idle';
            return (
              <button
                type="button"
                key={connection.id}
                role="option"
                aria-selected={i === index}
                className={`pk-row${i === index ? ' on' : ''}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => onPick(connection)}
              >
                <AgentMark host={connection.host} title={connection.title} size={30} />
                <div>
                  <div className="t" aria-label={`${HOST_LONG_LABELS[connection.host]}, ${connection.project}${auto ? ', automatic choice' : ''}`}>
                    {connection.project || HOST_LONG_LABELS[connection.host]}
                    {auto && <span className="auto"> Auto</span>}
                  </div>
                  <div className="sub">
                    {shortPath(connection.cwd)}
                    {connection.title ? ` · “${connection.title}”` : ''}
                  </div>
                </div>
                <div className="st">
                  {state === 'working' ? <span className="w">working</span> : state}
                  <br />
                  {connection.host === 'cli-wait' ? '' : ago(connection.lastHumanInputAt)}
                </div>
              </button>
            );
          })}
        </div>
        <div className="pk-foot">
          <button type="button" onClick={onCopy}>
            Copy as Markdown <span className="k">⇧⌘C</span>
          </button>
        </div>
      </div>
    </>
  );
}
