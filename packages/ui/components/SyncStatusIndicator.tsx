/**
 * Sync Status Indicator
 *
 * Shows the current sync status for collaborative sessions.
 * Displays connection state with appropriate visual feedback.
 */

import React from 'react';
import { SyncStatus } from '../types';

interface SyncStatusIndicatorProps {
  status: SyncStatus;
  error?: string | null;
  sessionUrl?: string | null;
}

export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({
  status,
  error,
  sessionUrl,
}) => {
  const getStatusConfig = () => {
    switch (status) {
      case 'connected':
        return {
          color: 'bg-green-500',
          pulseColor: 'bg-green-400',
          label: 'Synced',
          animate: false,
        };
      case 'connecting':
        return {
          color: 'bg-yellow-500',
          pulseColor: 'bg-yellow-400',
          label: 'Connecting...',
          animate: true,
        };
      case 'syncing':
        return {
          color: 'bg-blue-500',
          pulseColor: 'bg-blue-400',
          label: 'Syncing...',
          animate: true,
        };
      case 'error':
        return {
          color: 'bg-red-500',
          pulseColor: 'bg-red-400',
          label: error || 'Error',
          animate: false,
        };
      case 'disconnected':
      default:
        return {
          color: 'bg-gray-400',
          pulseColor: 'bg-gray-300',
          label: 'Offline',
          animate: false,
        };
    }
  };

  const config = getStatusConfig();

  const handleCopyUrl = async () => {
    if (sessionUrl) {
      try {
        await navigator.clipboard.writeText(sessionUrl);
      } catch (e) {
        console.error('Failed to copy URL:', e);
      }
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Status dot */}
      <div className="relative flex items-center">
        {config.animate && (
          <span
            className={`absolute inline-flex h-2 w-2 rounded-full ${config.pulseColor} opacity-75 animate-ping`}
          />
        )}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${config.color}`}
        />
      </div>

      {/* Status label */}
      <span className="text-xs text-muted-foreground">
        {config.label}
      </span>

      {/* Copy session URL button (only when connected) */}
      {status === 'connected' && sessionUrl && (
        <button
          onClick={handleCopyUrl}
          className="p-1 rounded hover:bg-muted transition-colors"
          title="Copy session URL"
        >
          <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </button>
      )}
    </div>
  );
};
