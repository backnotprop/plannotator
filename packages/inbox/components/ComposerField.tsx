/**
 * The Inbox's composer field with its voice (ComposerFieldBase.tsx holds the field; this passes VoiceMic.tsx's parts,
 * which load voice code). Every composer of the Inbox's own renders this one; the reply box renders the base, its
 * voice parts coming with its voice (reply/replyVoice.ts).
 */
import { ComposerFieldBase, type InboxComposerFieldProps } from './ComposerFieldBase';
import { fieldVoiceParts } from './VoiceMic';

export * from './ComposerFieldBase';

export function InboxComposerField(props: InboxComposerFieldProps) {
  return <ComposerFieldBase voiceParts={fieldVoiceParts} {...props} />;
}
