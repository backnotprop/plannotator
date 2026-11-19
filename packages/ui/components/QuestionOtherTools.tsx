import { createContext, type ComponentType, type RefObject } from 'react';

/** An opt-in tool for the editable Other field, not for the note or a text question. */
export const QuestionOtherToolsContext = createContext<ComponentType<{ textareaRef: RefObject<HTMLTextAreaElement | null> }> | null>(null);
