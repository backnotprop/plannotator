/**
 * The line under a person's reply that waits on T3 Code (the owner,
 * 2026-11-14: "one line by the reply saying it's waiting and how to fix it").
 * The thread's own machine writes why (`InboxMessage.t3_wait`, the T3 wake),
 * so a linked machine's thread reads the same here. The sign-in command sits
 * in the line with Copy; where its URL is shows on hover. The words are a
 * proposal until the owner approves them.
 */

import { INBOX_T3_URL_WHERE, inboxT3WaitLine, type InboxT3WaitReason } from '@plannotator/core/inbox-types';
import type { ReactNode } from 'react';
import { Icon } from '../icons';
import { CopyCommand } from './RestartNote';
import { Tip } from './Tip';

export function T3WaitLine({ reason, children }: { reason: InboxT3WaitReason; children?: ReactNode }) {
  const line = inboxT3WaitLine(reason);
  return (
    <div className="ib-delivered" data-delivery="queued" data-t3-wait={reason} tabIndex={-1}>
      <span className="ib-dl-main">
        <Icon name="clock" size={14} />
        <span className="ib-dl-text">
          {line.text}
          {line.command && (
            <>
              {' '}
              <Tip content={INBOX_T3_URL_WHERE}>
                <code className="ib-rl-wrap" data-t3-command="">
                  {line.command}
                </code>
              </Tip>
            </>
          )}
        </span>
      </span>
      {line.command && <CopyCommand text={line.command} label="Copy the T3 sign-in command" announcement="T3 sign-in command copied." />}
      {children}
    </div>
  );
}
