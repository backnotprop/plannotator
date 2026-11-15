import { createContext } from 'react';
import type { ImageAttachment } from '../types';

export interface HostCommentDraft {
  text: string;
  images: ImageAttachment[];
}

export type HostCommentDraftWrite = 'saved' | { conflict: HostCommentDraft | null };

export interface CommentDraftHost {
  read(key: string): Promise<HostCommentDraft | null>;
  write(key: string, draft: HostCommentDraft | null, options?: { force?: boolean }): Promise<HostCommentDraftWrite>;
}

export const CommentDraftHostContext = createContext<CommentDraftHost | null>(null);
