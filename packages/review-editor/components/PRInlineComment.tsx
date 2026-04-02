import React, { useState } from 'react';
import type { PRInlineComment as PRInlineCommentType } from '@plannotator/shared/pr-provider';

interface PRInlineCommentProps {
  comment: PRInlineCommentType;
  onRespond: (commentId: number, response: string) => void;
}

export function PRInlineComment({ comment, onRespond }: PRInlineCommentProps) {
  const [isResponding, setIsResponding] = useState(false);
  const [response, setResponse] = useState('');

  return (
    <div className="pr-inline-comment">
      <div className="pr-inline-comment-header">
        <span className="pr-inline-comment-author">@{comment.author}</span>
        <span className="pr-inline-comment-sep">&middot;</span>
        <span className="pr-inline-comment-date">{new Date(comment.createdAt).toLocaleDateString()}</span>
      </div>
      <div className="pr-inline-comment-body">{comment.body}</div>
      {!isResponding ? (
        <button
          onClick={() => setIsResponding(true)}
          className="pr-inline-comment-reply-btn"
        >
          Reply with annotation
        </button>
      ) : (
        <div className="pr-inline-comment-reply-form">
          <textarea
            value={response}
            onChange={(e) => setResponse(e.target.value)}
            placeholder="Your response..."
            className="pr-inline-comment-textarea"
            rows={2}
            autoFocus
          />
          <div className="pr-inline-comment-reply-actions">
            <button
              onClick={() => {
                if (response.trim()) {
                  onRespond(comment.id, response.trim());
                  setResponse('');
                  setIsResponding(false);
                }
              }}
              className="pr-inline-comment-btn-add"
            >
              Add
            </button>
            <button
              onClick={() => { setIsResponding(false); setResponse(''); }}
              className="pr-inline-comment-btn-cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
