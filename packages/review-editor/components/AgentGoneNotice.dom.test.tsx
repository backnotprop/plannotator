/**
 * The notice a code review shows when its agent is gone (AgentGoneNotice.tsx,
 * DOM_TESTS=1).
 *
 * What regresses if this fails: the stream saying it again (a reconnect, a
 * second look) stacks a second notice; the notice cannot be taken down when
 * the agent is back; a Send refused because the agent is gone leaves two
 * toasts saying the same thing, or a Send that failed for another reason
 * takes down the only line saying nobody is listening; Copy feedback copies
 * something other than what Send would send; a refused Send's toast says
 * an agent is gone when it never had a session, or gives no reason.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Toaster } from 'sonner';
import { AGENT_AWAY_REASON, AGENT_GONE_REASON, NO_SESSION_REASON } from '@plannotator/shared/review-agent-gone-words';
import { DecisionSendError } from '@plannotator/ui/utils/sendFailure';
import { agentGoneReasonFor, dismissAgentGoneNotice, noteSendFailureForAgentGone, showAgentGoneNotice } from './AgentGoneNotice';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => dismissAgentGoneNotice());
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  delete (navigator as { clipboard?: unknown }).clipboard;
});

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function mountToaster(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Toaster />));
}

/** The notices on screen (sonner keeps a dismissed toast a moment, marked removed). */
function notices(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-sonner-toast]'))
    .filter((el) => el.getAttribute('data-removed') !== 'true')
    .filter((el) => el.textContent?.includes(AGENT_GONE_REASON));
}

describe.if(hasDom)('the agent-gone notice', () => {
  test('said twice, it shows once; taken down when the agent is back, it can show again', async () => {
    await mountToaster();
    await act(async () => {
      showAgentGoneNotice({ copyText: () => 'x' });
      showAgentGoneNotice({ copyText: () => 'x' });
    });
    await settle();
    expect(notices()).toHaveLength(1);

    await act(async () => dismissAgentGoneNotice());
    await settle();
    expect(notices()).toHaveLength(0);

    await act(async () => showAgentGoneNotice({ copyText: () => 'x' }));
    await settle();
    expect(notices()).toHaveLength(1);
  });

  test('a Send refused because the agent is gone takes it down; a Send that failed for another reason does not', async () => {
    await mountToaster();
    await act(async () => showAgentGoneNotice({ copyText: () => 'x' }));
    await settle();
    await act(async () => noteSendFailureForAgentGone(new DecisionSendError({ kind: 'rejected', status: 500 })));
    await settle();
    expect(notices()).toHaveLength(1);
    await act(async () => noteSendFailureForAgentGone(new DecisionSendError({ kind: 'agent-gone' })));
    await settle();
    expect(notices()).toHaveLength(0);
  });

  test('Copy feedback copies what Send would send, read when clicked', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text); } },
    });
    await mountToaster();
    let feedback = '# Code Review Feedback\n\nfirst';
    await act(async () => showAgentGoneNotice({ copyText: () => feedback }));
    await settle();
    feedback = '# Code Review Feedback\n\nfirst\n\nsecond';
    const copy = notices()[0]!.querySelector<HTMLButtonElement>('[data-send-failure-copy]')!;
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    await settle();
    expect(written).toEqual([feedback]);
    expect(copy.textContent).toBe('Copied');
  });

  test("a refused Send's reason: gone, away and no session each say their own; anything else keeps the page's usual reason", () => {
    expect(agentGoneReasonFor(new DecisionSendError({ kind: 'agent-gone' }))).toBe(AGENT_GONE_REASON);
    expect(agentGoneReasonFor(new DecisionSendError({ kind: 'agent-away' }))).toBe(AGENT_AWAY_REASON);
    expect(agentGoneReasonFor(new DecisionSendError({ kind: 'no-session' }))).toBe(NO_SESSION_REASON);
    expect(AGENT_AWAY_REASON).not.toBe(AGENT_GONE_REASON);
    expect(NO_SESSION_REASON).not.toBe(AGENT_GONE_REASON);
    expect(agentGoneReasonFor(new DecisionSendError({ kind: 'unreachable' }))).toBeUndefined();
  });
});
