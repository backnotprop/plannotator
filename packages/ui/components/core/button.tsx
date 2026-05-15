import React from 'react';

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'icon' | 'danger';
type ButtonSize = 'sm' | 'md' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({
  className,
  variant = 'outline',
  size = 'md',
  active = false,
  type = 'button',
  ...props
}, ref) => (
  <button
    ref={ref}
    type={type}
    className={cx(
      'inline-flex items-center justify-center gap-2 rounded-md text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' && 'h-8 px-2.5',
      size === 'md' && 'h-9 px-3',
      size === 'icon' && 'h-8 w-8',
      variant === 'primary' && 'bg-primary text-primary-foreground hover:opacity-90',
      variant === 'outline' && 'border border-border bg-card text-foreground hover:bg-muted',
      variant === 'ghost' && 'text-muted-foreground hover:bg-muted hover:text-foreground',
      variant === 'icon' && (active
        ? 'border border-primary/50 bg-primary/10 text-primary'
        : 'border border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'),
      variant === 'danger' && 'border border-border bg-background text-muted-foreground hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive',
      className
    )}
    {...props}
  />
));
Button.displayName = 'Button';
