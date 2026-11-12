import { createContext, type ComponentType, type RefObject } from 'react';

export interface CommentCardToolsProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  phone: boolean;
  onBusyChange: (busy: boolean) => void;
}

export const CommentCardToolsContext = createContext<ComponentType<CommentCardToolsProps> | null>(null);
