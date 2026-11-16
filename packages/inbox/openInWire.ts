/** The Open in routes' wire shapes, and the addresses of a file a message names (packages/server/inbox-open-in.ts). */
import { inboxUrl, machineOf } from './inboxUrl';

/** Where a referenced file's project-relative path starts: the server finds the folder (packages/server/inbox-open-in.ts). */
/** `from: 'root'`: a diff's path, which starts at the top of the repository wherever the agent stood. */
export type OpenInFileScope = { thread: string; message?: string; from?: 'root' } | { shape: string } | { repo: string; pull?: string };

/** A referenced file's text for its hover: this computer's, or a pull request's at its head commit (`pull`). */
export type OpenInFileCode = { found: false } | { found: true; contents: string; pull?: { label: string; platform: 'github' | 'gitlab'; url: string } };

/**
 * A file an agent's message names, for the pane (approval "inbox-file-refs-open-viewer"): text whole, an image or a
 * film read by `referencedFileRawUrl`, any other kind by name only. `attachment_id`: the message already carries it
 * (the pane opens that attachment instead). `reason`: not on this computer, or a file the Inbox never shows (a secret).
 */
export type ReferencedFileView =
  | { found: false; name: string; path: string; reason: 'missing' | 'refused' }
  | {
      found: true;
      name: string;
      path: string;
      kind: string;
      contents?: string;
      tooLarge?: boolean;
      attachment_id?: string;
      pull?: { label: string; platform: 'github' | 'gitlab'; url: string };
      /** With `pull`: the file on this computer is that same text, so a comment (which attaches it) is taken. */
      local_matches?: boolean;
    };

/** Where a file a message names is asked about: its thread (whose machine holds it) and the message. */
export type ReferencedFileScope = { thread: string; message: string };

export const referencedFileUrl = (route: 'view' | 'raw', scope: ReferencedFileScope, path: string) =>
  inboxUrl(`/open-in/file/${route}`, new URLSearchParams({ thread: scope.thread, message: scope.message, path }).toString(), machineOf(scope.thread));

/** An image's or a film's bytes, of a file a message names: through its thread's machine, as every route of it. */
export const referencedFileRawUrl = (scope: ReferencedFileScope, path: string) => referencedFileUrl('raw', scope, path);
