import React from 'react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { Send, Check } from 'lucide-react';

interface FeedbackButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  label?: string;
  shortLabel?: string;
  loadingLabel?: string;
  shortLoadingLabel?: string;
  title?: string;
  muted?: boolean;
}

export const FeedbackButton: React.FC<FeedbackButtonProps> = ({
  onClick,
  disabled = false,
  isLoading = false,
  label = 'Send Feedback',
  shortLabel,
  loadingLabel = 'Sending...',
  shortLoadingLabel,
  title = 'Send Feedback',
  muted = false,
}) => (
  <Button
    variant="outline"
    size="xs"
    onClick={onClick}
    disabled={disabled}
    title={title}
    iconLeft={<Send className="size-3.5" />}
    className={cn(muted && 'opacity-50 cursor-not-allowed')}
  >
    {shortLabel ? (
      <>
        <span className="hidden md:inline lg:hidden">{isLoading ? (shortLoadingLabel ?? loadingLabel) : shortLabel}</span>
        <span className="hidden lg:inline">{isLoading ? loadingLabel : label}</span>
      </>
    ) : (
      <span className="hidden md:inline">{isLoading ? loadingLabel : label}</span>
    )}
  </Button>
);

export interface ApproveButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  label?: string;
  loadingLabel?: string;
  mobileLabel?: string;
  mobileLoadingLabel?: string;
  title?: string;
  dimmed?: boolean;
  muted?: boolean;
}

export const ApproveButton: React.FC<ApproveButtonProps> = ({
  onClick,
  disabled = false,
  isLoading = false,
  label = 'Approve',
  loadingLabel = 'Approving...',
  mobileLabel = 'OK',
  mobileLoadingLabel = '...',
  title,
  dimmed = false,
  muted = false,
}) => (
  <Button
    variant="success"
    size="xs"
    onClick={onClick}
    disabled={disabled}
    title={title}
    iconLeft={<Check className="size-3.5" />}
    className={cn(
      muted && 'opacity-40 cursor-not-allowed bg-muted text-muted-foreground hover:bg-muted',
      disabled && !muted && 'bg-muted text-muted-foreground hover:bg-muted',
      dimmed && !muted && !disabled && 'bg-success/50 text-success-foreground/70 hover:bg-success hover:text-success-foreground',
    )}
  >
    <span className="md:hidden">{isLoading ? mobileLoadingLabel : mobileLabel}</span>
    <span className="hidden md:inline">{isLoading ? loadingLabel : label}</span>
  </Button>
);

interface ExitButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  title?: string;
}

export const ExitButton: React.FC<ExitButtonProps> = ({
  onClick,
  disabled = false,
  isLoading = false,
  title = 'Close session without sending feedback',
}) => (
  <Button
    variant="secondary"
    size="xs"
    onClick={onClick}
    disabled={disabled || isLoading}
    title={title}
    className="bg-muted text-muted-foreground hover:bg-muted/80"
  >
    <span className="md:hidden">{isLoading ? '...' : '✕'}</span>
    <span className="hidden md:inline">{isLoading ? 'Closing...' : 'Close'}</span>
  </Button>
);
