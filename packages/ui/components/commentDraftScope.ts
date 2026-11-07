import { createContext } from 'react';

/**
 * The document a comment draft belongs to (the Viewer's draft scope: a file's path, the host's `sourceInfo`, else
 * the document's start), for composers deep in its blocks that keep their own drafts (a diagram part's card). Absent
 * (outside a Viewer): ''.
 */
export const CommentDraftScopeContext = createContext('');
