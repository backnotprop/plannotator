/**
 * The files suite and the documents suite: what a file's tile and viewer say
 * of it, how a file is drawn, and the blocks a Markdown file is split into.
 * scripts/mobile/vectors.ts writes vectors/files.json and
 * vectors/documents.json from them.
 *
 * What the app's conformance tests hold to: a size in words, a kind's name,
 * the line under a tile's name, a moment in a video, the kind a file is drawn
 * as (a log or a data file is code), the size past which text is not drawn;
 * and, for a document, each block's id, type, words and line, so a place in a
 * document on the phone is the same place in the window.
 */
import { shouldStripFrontmatter } from '../../packages/core/annotatable';
import { formatInboxVideoTime, inboxAttachmentKindLabel, INBOX_VIEW_MAX_BYTES, type InboxAttachmentState } from '../../packages/core/inbox-attachments';
import { formatBytes } from '../../packages/core/inbox-format';
import { inboxViewKind } from '../../packages/inbox/attachments';
import { sizeLine } from '../../packages/inbox/components/AttachmentTiles';
import { computeListIndices, parseMarkdownToBlocks } from '../../packages/ui/utils/parser';
import { readRepoText } from './lib';

export const FILES_FIXTURE = 'apps/mobile/contract/fixtures/files.json';
export const DOCUMENTS_FIXTURE = 'apps/mobile/contract/fixtures/documents.json';

type FileCase = { kind: string; name: string; size: number; media_type?: string; width?: number; height?: number; duration_ms?: number; current_size?: number };

export function fileVectors(about: string): unknown {
  const fixture = JSON.parse(readRepoText(FILES_FIXTURE)) as { sizes: number[]; moments: number[]; files: FileCase[] };
  return {
    about,
    view_max_bytes: INBOX_VIEW_MAX_BYTES,
    sizes: fixture.sizes.map((bytes) => ({ bytes, words: formatBytes(bytes) })),
    moments: fixture.moments.map((seconds) => ({ seconds, words: formatInboxVideoTime(seconds) })),
    files: fixture.files.map((c) => {
      const { current_size, ...record } = c;
      const state = {
        ...record, id: 'att_F', path: `/work/${c.name}`, sent_sha256: '', sent_at: '', sent_mtime: '', message_id: 'msg_F', changed_since_sent: current_size !== undefined, unavailable: null,
        current: current_size === undefined ? null : { sha256: '', size: current_size, mtime: '' },
      } as unknown as InboxAttachmentState;
      return { ...c, label: inboxAttachmentKindLabel(c.kind, c.name, c.media_type), detail: sizeLine(state), view_kind: inboxViewKind(c.kind, c.name) };
    }),
  };
}

export function documentVectors(about: string): unknown {
  const fixture = JSON.parse(readRepoText(DOCUMENTS_FIXTURE)) as { documents: { name: string; note: string; text: string }[] };
  return {
    about,
    documents: fixture.documents.map((d) => {
      const strips = shouldStripFrontmatter(d.name);
      const blocks = parseMarkdownToBlocks(d.text, strips ? undefined : { frontmatter: false });
      const numbers = computeListIndices(blocks);
      return {
        ...d,
        strips_frontmatter: strips,
        blocks: blocks.map((b, i) => ({
          id: b.id, type: b.type, content: b.content, level: b.level ?? null, language: b.language ?? null, checked: b.checked ?? null, ordered: b.ordered === true,
          ordered_start: b.orderedStart ?? null, alert_kind: b.alertKind ?? null, directive_kind: b.directiveKind ?? null, start_line: b.startLine,
          number: b.type === 'list-item' ? numbers[i] ?? null : null,
        })),
      };
    }),
  };
}
