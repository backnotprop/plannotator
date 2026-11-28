import { useEffect, useState } from 'react';
import type { LinkThroughPairView, LinkThroughRowView, LinkThroughStatus, LinkThroughView } from '@plannotator/core/inbox-link-through';
import { apiPost, InboxApiError } from '../api';
import { Icon } from '../icons';
import { inboxUrl } from '../inboxUrl';
import { errorText } from '../toastError';

/**
 * Settings → Machines: link two of the person's computers through a third ("Link two computers through a third" in
 * docs/agent-guides/inbox-machines.md). On the computer linked to both, one row per two of its links that are not
 * linked to each other ("Laptop and Mini"); on one of the two, one row per computer it reaches only through a link
 * ("Mini · through Studio"). One Link button each: no dialog, no confirmation. Once linked, the row goes and the
 * computer is an ordinary linked row.
 */
export function LinkThroughRows({ view, onChanged }: { view: LinkThroughView | undefined; onChanged: () => void }) {
  // A click shows "Linking…" at once, until this computer's own view says how it stands.
  const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const pairs = view?.pairs ?? [];
  const through = view?.through ?? [];
  // The rows still idle: a press is drawn as under way only while its row is one of them.
  const idle = [...pairs.filter((pair) => pair.status === 'idle').map(pairKey), ...through.filter((row) => row.status === 'idle').map((row) => row.id)].join('|');
  useEffect(() => {
    const still = new Set(idle.split('|'));
    setPressed((current) => {
      const next = [...current].filter((key) => still.has(key));
      return next.length === current.size ? current : new Set(next);
    });
  }, [idle]);
  if (pairs.length === 0 && through.length === 0) return null;

  const unpress = (key: string) => setPressed((current) => (current.has(key) ? new Set([...current].filter((k) => k !== key)) : current));
  const press = async (key: string, body: Record<string, unknown>) => {
    setErrors(({ [key]: _gone, ...rest }) => rest);
    setPressed((current) => new Set([...current, key]));
    // A press the view never picks up (the other computer refused it later) is not drawn as under way for long.
    setTimeout(() => unpress(key), PRESS_SHOWN_MS);
    try {
      await apiPost(inboxUrl('/machines/link-through'), body);
    } catch (cause) {
      unpress(key);
      setErrors((current) => ({ ...current, [key]: cause instanceof InboxApiError ? cause.message : errorText(cause, 'The link did not go through.') }));
    }
    onChanged();
  };

  return (
    <>
      {pairs.map((pair) => {
        const key = pairKey(pair);
        return (
          <Row
            key={key}
            id={`pair:${key}`}
            label={`${pair.a.name} and ${pair.c.name}`}
            idle="Linked here, not to each other"
            status={pressed.has(key) && pair.status === 'idle' ? 'linking' : pair.status}
            waitingFor={pair.waiting_for}
            why={pair.why}
            error={errors[key] ?? null}
            onLink={() => void press(key, { a: pair.a.id, c: pair.c.id })}
          />
        );
      })}
      {through.map((row: LinkThroughRowView) => (
        <Row
          key={row.id}
          id={`through:${row.id}`}
          label={`${row.name} · through ${row.via.name}`}
          idle={`Linked to ${row.via.name}, not to this computer`}
          status={pressed.has(row.id) && row.status === 'idle' ? 'linking' : row.status}
          waitingFor={row.waiting_for}
          why={row.why}
          error={errors[row.id] ?? null}
          onLink={() => void press(row.id, { via: row.via.id, with: row.id })}
        />
      ))}
    </>
  );
}

const pairKey = (pair: Pick<LinkThroughPairView, 'a' | 'c'>) => [pair.a.id, pair.c.id].sort().join(':');
/** How long a press is drawn as under way before this computer's view says how it stands. */
const PRESS_SHOWN_MS = 20_000;

/** How a row stands, in one short line. */
export function linkThroughLine(status: LinkThroughStatus, idle: string, waitingFor: string | null, why: string | null): string {
  if (status === 'linking') return 'Linking…';
  if (status === 'waiting' && waitingFor) return `Waiting for ${waitingFor}: this links when ${waitingFor} is back.`;
  if (status === 'failed') return why ? `Not linked: ${why}` : 'Not linked. Try again.';
  return idle;
}

function Row(props: {
  id: string;
  label: string;
  idle: string;
  status: LinkThroughStatus;
  waitingFor: string | null;
  why: string | null;
  error: string | null;
  onLink: () => void;
}) {
  const line = props.error ? `Not linked: ${props.error}` : linkThroughLine(props.status, props.idle, props.waitingFor, props.why);
  // Link is offered until a link is under way; a refused one offers it again.
  const offered = props.status === 'idle' || props.status === 'failed' || props.error !== null;
  return (
    <div className="ib-prow" data-link-through={props.id} data-link-through-status={props.error ? 'failed' : props.status}>
      <span className="ib-tile">
        <Icon name="system" />
      </span>
      <span className="ib-txt">
        <span className="ib-l">{props.label}</span>
        <span className="ib-desc" role="status">
          {line}
        </span>
      </span>
      <span className="ib-ctl">
        {offered && (
          <button type="button" className="ib-btn" onClick={props.onLink} data-link-through-link="">
            Link
          </button>
        )}
      </span>
    </div>
  );
}
