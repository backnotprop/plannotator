import type { InboxAttachmentState, InboxGuideRef, InboxMessageWire } from '@plannotator/core/inbox-types';
import { isInboxAnnotatableKind } from '@plannotator/core/inbox-types';
import { agentName, whenTime } from './format';

interface ArtifactOrigin {
  messageId: string;
  sender: string;
  sentAt: string;
  at: string;
  fromPerson: boolean;
  host: string | null;
}

export interface FileArtifact extends ArtifactOrigin {
  type: 'file';
  attachment: InboxAttachmentState;
  inline: boolean;
  alsoIds: readonly string[];
}

export interface GuideArtifact extends ArtifactOrigin {
  type: 'guide';
  guide: InboxGuideRef;
}

export type Artifact = FileArtifact | GuideArtifact;

export function artifactKey(artifact: Artifact): string {
  return artifact.type === 'file' ? artifact.attachment.id : `guide:${artifact.messageId}`;
}

export function originOf(message: Pick<InboxMessageWire, 'id' | 'author' | 'created_at'>): ArtifactOrigin {
  const fromPerson = message.author.kind === 'person';
  return {
    messageId: message.id,
    sender: fromPerson ? 'You' : agentName(message.author),
    sentAt: whenTime(message.created_at),
    at: message.created_at,
    fromPerson,
    host: message.author.kind === 'agent' ? message.author.host : null,
  };
}

export function threadArtifacts(
  messages: readonly InboxMessageWire[],
  attachments: readonly InboxAttachmentState[],
  inlineImages: readonly InboxAttachmentState[] = [],
): Artifact[] {
  const out: Artifact[] = [];
  const placed = new Set<string>();
  for (const message of messages) {
    const origin = originOf(message);
    const files: FileArtifact[] = [];
    for (const image of inlineImages) {
      if (image.message_id !== message.id || placed.has(image.id)) continue;
      placed.add(image.id);
      files.push({ type: 'file', ...origin, attachment: image, inline: true, alsoIds: [] });
    }
    for (const attachment of attachments) {
      if (attachment.message_id !== message.id || placed.has(attachment.id)) continue;
      placed.add(attachment.id);
      const twin = files.find((f) => f.inline && f.attachment.path === attachment.path);
      if (twin) {
        twin.alsoIds = [...twin.alsoIds, attachment.id];
        continue;
      }
      files.push({ type: 'file', ...origin, attachment, inline: false, alsoIds: [] });
    }
    out.push(...files);
    if (message.guide) out.push({ type: 'guide', ...origin, guide: message.guide });
  }
  for (const [list, inline] of [
    [inlineImages, true],
    [attachments, false],
  ] as const) {
    for (const attachment of list) {
      if (placed.has(attachment.id)) continue;
      placed.add(attachment.id);
      out.push({ type: 'file', messageId: attachment.message_id, sender: 'the agent', sentAt: whenTime(attachment.sent_at), at: attachment.sent_at, fromPerson: false, host: null, attachment, inline, alsoIds: [] });
    }
  }
  return out;
}

export function artifactsNewestFirst(artifacts: readonly Artifact[]): Artifact[] {
  const groups: Artifact[][] = [];
  for (const artifact of artifacts) {
    const last = groups.at(-1);
    if (last && last[0]!.messageId === artifact.messageId) last.push(artifact);
    else groups.push([artifact]);
  }
  return groups.reverse().flat();
}

export function artifactOfFile(artifacts: readonly Artifact[], attachmentId: string): FileArtifact | null {
  for (const artifact of artifacts) {
    if (artifact.type !== 'file') continue;
    if (artifact.attachment.id === attachmentId || artifact.alsoIds.includes(attachmentId)) return artifact;
  }
  return null;
}

export function openArtifactKey(artifacts: readonly Artifact[], attachmentId: string): string {
  const artifact = artifactOfFile(artifacts, attachmentId);
  return artifact ? artifactKey(artifact) : attachmentId;
}

export function newestViewableFile(artifacts: readonly Artifact[]): FileArtifact | null {
  for (const artifact of artifactsNewestFirst(artifacts)) {
    if (artifact.type !== 'file') continue;
    if (isInboxAnnotatableKind(artifact.attachment.kind)) return artifact;
  }
  return null;
}
