import React, { useState } from 'react';

interface InstructionsPromptProps {
  value: string;
  onChange: (value: string) => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
  disabled?: boolean;
}

export const InstructionsPrompt: React.FC<InstructionsPromptProps> = ({
  value,
  onChange,
  isExpanded,
  onToggleExpand,
  disabled = false,
}) => {
  return (
    <div className="w-full max-w-3xl mb-3 md:mb-4">
      <button
        onClick={onToggleExpand}
        className="w-full flex items-center justify-between px-3 py-2 bg-card/80 border border-border/50 rounded-lg hover:bg-card transition-colors"
        disabled={disabled}
      >
        <div className="flex items-center gap-2">
          <svg
            className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-sm font-medium text-foreground">Instructions for Claude</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {value.trim() ? 'Configured' : 'Default'}
        </span>
      </button>

      {isExpanded && (
        <div className="mt-2 border border-border/50 rounded-lg overflow-hidden bg-card/50">
          <div className="px-3 py-2 border-b border-border/30 bg-muted/30">
            <p className="text-xs text-muted-foreground">
              These instructions are sent to Claude with your approval or feedback.
              They guide how Claude handles the plan but are NOT saved with it.
            </p>
          </div>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder="Enter instructions for Claude..."
            className="w-full h-48 px-3 py-2 bg-transparent text-sm font-mono text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
};

/**
 * Generate default instructions based on the plan content.
 * Attempts to infer a reasonable file path from the plan title/content.
 */
export function generateDefaultInstructions(planMarkdown: string): string {
  // Try to extract plan title from first heading
  const titleMatch = planMarkdown.match(/^#\s+(.+?)(?:\n|$)/m);
  const planTitle = titleMatch ? titleMatch[1].trim() : '';

  // Convert title to a kebab-case file name
  const fileName = planTitle
    ? planTitle
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 50) // Limit length
    : 'plan';

  // Try to infer namespace from content (e.g., feature area, component name)
  // Look for patterns like "## Phase:", "## Component:", etc.
  let namespace = 'general';

  // Check for common patterns that might indicate the plan's domain
  const phaseMatch = planMarkdown.match(/##\s+(?:Phase\s+\d+[:\s]*)?(.+?)(?:\n|$)/);
  if (phaseMatch) {
    const phaseName = phaseMatch[1].toLowerCase();
    if (phaseName.includes('infrastructure') || phaseName.includes('setup')) {
      namespace = 'infrastructure';
    } else if (phaseName.includes('api') || phaseName.includes('backend')) {
      namespace = 'backend';
    } else if (phaseName.includes('ui') || phaseName.includes('frontend') || phaseName.includes('component')) {
      namespace = 'frontend';
    } else if (phaseName.includes('test')) {
      namespace = 'testing';
    } else if (phaseName.includes('deploy') || phaseName.includes('release')) {
      namespace = 'deployment';
    }
  }

  // Check for code blocks to infer language/tech
  const codeBlockMatch = planMarkdown.match(/```(\w+)/);
  if (codeBlockMatch) {
    const lang = codeBlockMatch[1].toLowerCase();
    if (['tsx', 'jsx', 'react'].includes(lang)) {
      namespace = 'frontend';
    } else if (['sql', 'postgres', 'mysql'].includes(lang)) {
      namespace = 'database';
    } else if (['dockerfile', 'yaml', 'yml'].includes(lang)) {
      namespace = 'infrastructure';
    }
  }

  const defaultPath = `./docs/specs/${namespace}/${fileName}.md`;

  return `# On Plan Approval

- Save this plan to: ${defaultPath}
- Do NOT implement the plan automatically unless explicitly requested

# On Changes Requested / Denial

- Handle the feedback as expected and revise the plan
- Consider any additional context provided in the feedback`;
}
