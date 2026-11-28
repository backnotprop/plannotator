import { useEffect, useRef } from 'react';
import { HostMark } from '../icons';
import { whenTime } from '../format';
import { tagOptions, type TagOption } from '../tags';
import { useTaggable } from '../components/TagPicker';
import { swarmEscapeIsOurs } from './escape';

/**
 * The status view's Add an agent list: every agent the thread can reach (the reply's `@` list, `threads/:id/taggable`:
 * this computer's and each linked computer's), less the swarm's members. Drawn as the reply's "to" list is (the `@`
 * list's box and rows, ReplyRecipient.tsx), over the foot. A press on a row adds that agent (`swarmApi.add`), Escape or
 * a press outside closes it.
 */
export function SwarmAddList({ threadId, members, onPick, onClose }: { threadId: string; members: ReadonlySet<string>; onPick: (option: TagOption) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const model = useTaggable(threadId, true);
  const options = tagOptions(model, null, null, whenTime).filter((o) => !members.has(o.id) && o.taggable);

  useEffect(() => {
    const press = (event: PointerEvent) => {
      const anchor = box.current?.parentElement;
      if (anchor && !anchor.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !swarmEscapeIsOurs(event, box.current)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', press, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  return (
    <div ref={box} className="ib-tg-menu ib-swarm-addlist" role="group" aria-label="Add an agent" data-swarm-add-list="">
      {model && options.length === 0 && <p className="ib-swarm-addnone">No other agent is running.</p>}
      {options.map((o) => (
        <div key={o.id} className="ib-rpick-row" data-swarm-add-row={o.id}>
          <button type="button" className="ib-rpick-name" onClick={() => onPick(o)}>
            <HostMark host={o.host} agent={o.id} />
            <span className="ib-rpick-ol">
              <span className="ib-rpick-l" dir="auto">
                {o.label}
              </span>
              <span className="ib-rpick-d" dir="auto">
                {o.detail}
              </span>
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
