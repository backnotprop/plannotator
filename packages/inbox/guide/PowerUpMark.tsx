import { createPortal } from 'react-dom';
import { PowerUpStatusSlot } from '@plannotator/review-editor/semDiff/PowerUpStatusSlot';
import type { InboxPowerUp } from './usePowerUp';

/**
 * Power Up's status in a review's bar, beside Global comment (code review's slot): what the model added, or why it is
 * unavailable with Retry. On a phone the face alone, whose press opens the same words. Nothing while Power Up is not
 * asked. The Inbox has no provider form yet, so the card says where the key is set (code review's Settings).
 * `host`: draw it in this element of the page's instead (the PR page's phone row), never on a row of its own.
 */
export function PowerUpMark({ power, compact, host }: { power: InboxPowerUp; compact: boolean; host?: HTMLElement | null }) {
  if (!power.powerUp || !power.status) return null;
  const mark = (
    <span className="ib-powerup" data-inbox-power-up="">
      <PowerUpStatusSlot status={power.status} provider={power.provider} {...(power.endpoint ? { endpoint: power.endpoint } : {})} onRetry={power.retry} compact={compact} keyFromEnv={power.keyFromEnv} />
    </span>
  );
  return host ? createPortal(mark, host) : mark;
}
