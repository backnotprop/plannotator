/**
 * A message's `:::run` or `:::secret` block drawn as its card (RunCard, SecretCard), found by the block's opening
 * line as the core readers number it. A block the readers do not take (no fence, two fences, a name that is not
 * one) is not drawn here: it stays text, each command with its own Copy.
 */
import { useMemo } from 'react';
import { parseInboxRunBlocks, parseInboxSecretBlocks } from '@plannotator/core/inbox-run-blocks';
import { useRunState } from '../../data/runStore';
import { RunCard } from './RunCard';
import { SecretCard } from './SecretCard';

/** Whether a body has a block this file draws, so the host asks for it only then. */
export function hasRunBlocks(body: string): boolean {
  return parseInboxRunBlocks(body).length > 0 || parseInboxSecretBlocks(body).length > 0;
}

/** The card for the block opening on `startLine`, or undefined (the block stays text). */
export function runBlockFor(message: { id: string; body: string }, block: { startLine: number; directiveKind?: string }, agent: string) {
  if (block.directiveKind === 'run' && parseInboxRunBlocks(message.body).some((b) => b.startLine === block.startLine)) {
    return <RunBlock message={message} startLine={block.startLine} kind="run" agent={agent} />;
  }
  if (block.directiveKind === 'secret' && parseInboxSecretBlocks(message.body).some((b) => b.startLine === block.startLine)) {
    return <RunBlock message={message} startLine={block.startLine} kind="secret" agent={agent} />;
  }
  return undefined;
}

function RunBlock({ message, startLine, kind, agent }: { message: { id: string; body: string }; startLine: number; kind: 'run' | 'secret'; agent: string }) {
  const { state, cardRef } = useRunState(message.id);
  const run = useMemo(() => (kind === 'run' ? (parseInboxRunBlocks(message.body).find((b) => b.startLine === startLine) ?? null) : null), [message.body, startLine, kind]);
  const secret = useMemo(() => (kind === 'secret' ? (parseInboxSecretBlocks(message.body).find((b) => b.startLine === startLine) ?? null) : null), [message.body, startLine, kind]);
  if (run) return <RunCard messageId={message.id} block={run} state={state} agent={agent} cardRef={cardRef} />;
  if (secret) return <SecretCard messageId={message.id} secret={secret} state={state} agent={agent} cardRef={cardRef} />;
  return null;
}
