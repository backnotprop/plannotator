import React from 'react';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

const fieldSizing = { fieldSizing: 'content' } as React.CSSProperties;

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(({
  className,
  style,
  ...props
}, ref) => (
  <textarea
    ref={ref}
    className={cx(
      'min-h-24 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60 focus:ring-2 focus:ring-primary/15',
      className
    )}
    style={{ ...fieldSizing, ...style }}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
