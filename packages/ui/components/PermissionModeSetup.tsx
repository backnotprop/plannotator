import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PermissionMode,
  PERMISSION_MODE_OPTIONS,
  savePermissionModeSettings,
} from '../utils/permissionMode';

interface PermissionModeSetupProps {
  isOpen: boolean;
  onComplete: (mode: PermissionMode) => void;
}

export const PermissionModeSetup: React.FC<PermissionModeSetupProps> = ({
  isOpen,
  onComplete,
}) => {
  const [selectedMode, setSelectedMode] = useState<PermissionMode>('acceptEdits');

  if (!isOpen) return null;

  const handleConfirm = () => {
    savePermissionModeSettings(selectedMode);
    onComplete(selectedMode);
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-primary/15">
              <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
              </svg>
            </div>
            <h3 className="font-semibold text-base">New: Permission Mode Preservation</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Claude Code 2.1.7+ supports preserving your permission mode after plan approval.
            Choose your preferred automation level.
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Requires Claude Code 2.1.7 or later. Run <code className="bg-muted px-1 rounded">claude update</code> to update.
          </p>
        </div>

        {/* Options */}
        <div className="p-4 space-y-2">
          {PERMISSION_MODE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-all border ${
                selectedMode === option.value
                  ? 'border-primary bg-primary/10'
                  : 'border-transparent bg-muted/50 hover:bg-muted'
              }`}
            >
              <input
                type="radio"
                name="permissionMode"
                value={option.value}
                checked={selectedMode === option.value}
                onChange={() => setSelectedMode(option.value)}
                className="mt-0.5 accent-primary"
              />
              <div className="flex-1">
                <div className="text-sm font-medium">{option.label}</div>
                <div className="text-xs text-muted-foreground">{option.description}</div>
              </div>
            </label>
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex justify-between items-center">
          <p className="text-xs text-muted-foreground">
            You can change this later in Settings.
          </p>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Continue
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
