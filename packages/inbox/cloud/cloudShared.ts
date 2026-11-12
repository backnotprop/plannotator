import type { KeyboardEvent } from 'react';
import type { InboxCloudPreset, InboxCloudSetup } from '@plannotator/core/inbox-cloud';
import { InboxApiError } from '../api';

export type Fresh = { setup: InboxCloudSetup | null };

export type WakeHint = { url: string; key: string; where: string };

const OTHER_HINT: WakeHint = {
  url: 'https://…',
  key: 'Sent as Authorization: Bearer',
  where: 'Any address that takes a POST with a Bearer key and a JSON body.',
};

const WAKE_HINTS: Partial<Record<InboxCloudPreset, WakeHint>> = {
  'claude-routine': {
    url: 'https://api.anthropic.com/v1/claude_code/routines/trig_…/fire',
    key: 'sk-ant-oat01-…',
    where: 'In the routine on claude.ai/code: Edit → add an API trigger → Generate token. Copy the Fire URL and the token.',
  },
  'grok-bot': {
    url: 'The routine’s “POST to” address',
    key: 'The routine’s key',
    where: 'On the desktop app, open the routine’s Webhook section: copy “POST to” and the key.',
  },
};

export const wakeHintOf = (preset: InboxCloudPreset): WakeHint => WAKE_HINTS[preset] ?? OTHER_HINT;

export const errorText = (cause: unknown) => (cause instanceof InboxApiError ? cause.message : 'The Inbox did not answer. Try again.');

export const noEnter = (event: KeyboardEvent) => {
  if (event.key === 'Enter') event.preventDefault();
};
