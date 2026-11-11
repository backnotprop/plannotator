import { createContext } from 'react';

/**
 * The document a comment draft belongs to (the Viewer's draft scope: a file's path, the host's
 * `sourceInfo`, else the document's start).
 */
export const CommentDraftScopeContext = createContext('');
