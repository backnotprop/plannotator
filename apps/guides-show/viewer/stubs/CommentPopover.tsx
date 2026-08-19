import React from 'react';
/** Build-time stand-in — never rendered in readOnly AllFilesCodeView. Type-only exports keep importers compiling. */
export const CommentPopover: React.FC<Record<string, unknown>> = () => null;
export type CommentAskAIHandler = (...args: unknown[]) => unknown;
export interface CommentTargetChip { label: string; text?: string }
