/**
 * The reply box's voice entry: the only way voice reaches the box (ReplyBox.tsx imports no voice code). A host with
 * voice imports this module (statically, as the Inbox's Thread.tsx does, or with `import()`) and hands
 * `replyVoiceParts` to the box beside its voice session (`ReplyBoxVoice`); a host without voice never imports it, so
 * no recorder, session engine or microphone code is in its bundle (replyBoxVoiceSeam.test.ts walks the graph).
 */
import { fieldVoiceParts, VoiceMicButton, VoiceStatusLine } from '../VoiceMic';
import type { ReplyVoiceParts } from './replyBoxSeams';

export const replyVoiceParts: ReplyVoiceParts = { ...fieldVoiceParts, MicButton: VoiceMicButton, StatusLine: VoiceStatusLine };
