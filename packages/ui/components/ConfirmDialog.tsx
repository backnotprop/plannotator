/**
 * Reusable confirmation dialog component
 */

import React from 'react';

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  title: string;
  message: React.ReactNode;
  subMessage?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: 'info' | 'warning';
  showCancel?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  subMessage,
  confirmText = 'Got it',
  cancelText = 'Cancel',
  variant = 'info',
  showCancel = false,
}) => {
  if (!isOpen) return null;

  const iconColors = {
    info: 'bg-accent/20 text-accent',
    warning: 'bg-yellow-500/20 text-yellow-500',
  };

  const buttonColors = {
    info: 'bg-primary text-primary-foreground hover:opacity-90',
    warning: 'bg-yellow-600 text-white hover:bg-yellow-500',
  };

  const icons = {
    info: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
      </svg>
    ),
    warning: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-sm shadow-2xl p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${iconColors[variant]}`}>
            {icons[variant]}
          </div>
          <h3 className="font-semibold">{title}</h3>
        </div>
        <div className="text-sm text-muted-foreground mb-2">
          {message}
        </div>
        {subMessage && (
          <div className="text-xs text-muted-foreground mb-6">
            {subMessage}
          </div>
        )}
        {!subMessage && <div className="mb-4" />}
        <div className="flex justify-end gap-2">
          {showCancel && (
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md text-sm font-medium bg-muted text-muted-foreground hover:bg-muted/80 transition-opacity"
            >
              {cancelText}
            </button>
          )}
          <button
            onClick={() => {
              if (onConfirm) {
                onConfirm();
              } else {
                onClose();
              }
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-opacity ${buttonColors[variant]}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
