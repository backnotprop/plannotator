import React, { useState } from 'react';
import type { Annotation, ImageAttachment } from '../types';
import { useCollaborativeSession } from '../hooks/useCollaborativeSession';

interface CollaborativeSessionButtonProps {
  markdown: string;
  annotations: Annotation[];
  globalAttachments: ImageAttachment[];
  setAnnotations: React.Dispatch<React.SetStateAction<Annotation[]>>;
  setGlobalAttachments: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  pasteApiUrl?: string;
}

export const CollaborativeSessionButton: React.FC<CollaborativeSessionButtonProps> = ({
  markdown,
  annotations,
  globalAttachments,
  setAnnotations,
  setGlobalAttachments,
  pasteApiUrl,
}) => {
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);

  const {
    isCollaborativeSession,
    sessionId,
    reviewerCount,
    lastUpdatedAt,
    isLoading,
    error,
    createSession,
    submitAnnotations,
    refreshSession,
  } = useCollaborativeSession(markdown, setAnnotations, setGlobalAttachments, pasteApiUrl);

  const handleCreateSession = async () => {
    const url = await createSession();
    if (url) {
      setShareUrl(url);
      setShowShareDialog(true);
    }
  };

  const handleCopyUrl = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  const handleSubmit = async () => {
    const success = await submitAnnotations(annotations, globalAttachments);
    if (success) {
      alert('Annotations submitted successfully!');
    }
  };

  const handleRefresh = async () => {
    await refreshSession();
  };

  const formatLastUpdate = (timestamp: number) => {
    if (timestamp === 0) return 'Never';
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes === 1) return '1 minute ago';
    if (minutes < 60) return `${minutes} minutes ago`;
    const hours = Math.floor(minutes / 60);
    if (hours === 1) return '1 hour ago';
    return `${hours} hours ago`;
  };

  if (isCollaborativeSession) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-700">
        <div className="flex-1 text-sm">
          <div className="font-medium text-purple-900 dark:text-purple-100">Collaborative Session</div>
          <div className="text-xs text-purple-700 dark:text-purple-300">
            {reviewerCount} reviewer{reviewerCount !== 1 ? 's' : ''} • Updated {formatLastUpdate(lastUpdatedAt)}
          </div>
        </div>

        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="px-3 py-1 text-sm bg-white dark:bg-gray-800 border border-purple-300 dark:border-purple-600 rounded hover:bg-purple-50 dark:hover:bg-purple-900/30 transition-colors disabled:opacity-50"
        >
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </button>

        <button
          onClick={handleSubmit}
          disabled={isLoading}
          className="px-3 py-1 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors disabled:opacity-50"
        >
          {isLoading ? 'Submitting...' : 'Submit'}
        </button>

        {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={handleCreateSession}
        disabled={isLoading}
        className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
        {isLoading ? 'Creating...' : 'Start Collaborative Review'}
      </button>

      {showShareDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">Share Review Session</h3>

            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              Share this URL with your team. Everyone can add annotations, and you can import all feedback at once.
            </p>

            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={shareUrl}
                readOnly
                className="flex-1 px-3 py-2 border rounded text-sm font-mono bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100"
              />
              <button
                onClick={handleCopyUrl}
                className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
              >
                {copySuccess ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <button
              onClick={() => setShowShareDialog(false)}
              className="w-full px-4 py-2 border rounded hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {error && <div className="text-sm text-red-600 dark:text-red-400 mt-2">{error}</div>}
    </>
  );
};
