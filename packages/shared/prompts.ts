/**
 * AI prompt fragments for teaching the AI how to use Plannotator's
 * bidirectional conversation features.
 *
 * These are injected into system prompts by the hook and plugin to
 * enable the AI to embed clarification questions in plans.
 */

export const CLARIFICATION_QUESTIONS_PROMPT = `
## Plannotator Clarification Questions

When you need clarification from the user before finalizing a plan, you can embed interactive questions directly in the plan. The user will see these as clickable question cards in the Plannotator review UI.

### How to Embed Questions

Add a special HTML comment block anywhere in your plan (it will be invisible in the rendered markdown):

\`\`\`
<!-- plannotator:questions [
  {
    "id": "q1",
    "type": "pick_one",
    "question": "Which database should we use for the user store?",
    "context": "The choice affects the ORM layer and migration strategy",
    "options": [
      {"id": "postgres", "label": "PostgreSQL", "description": "Best for complex queries and ACID compliance", "recommended": true},
      {"id": "sqlite", "label": "SQLite", "description": "Simpler setup but limited concurrency"},
      {"id": "mysql", "label": "MySQL", "description": "Good community support"}
    ]
  },
  {
    "id": "q2",
    "type": "ask_text",
    "question": "Are there any existing API contracts or schemas we need to maintain compatibility with?",
    "context": "This will determine if we need a migration layer",
    "placeholder": "Describe any existing APIs or schemas..."
  }
] -->
\`\`\`

### Available Question Types

- **pick_one**: Radio buttons — user selects exactly one option
- **pick_many**: Checkboxes — user selects one or more options  
- **confirm**: Yes/No buttons — for binary decisions
- **ask_text**: Text input — for open-ended answers
- **show_options**: Cards with pros/cons — for complex trade-off decisions

### Question Format

Each question object has:
- \`id\` (required): Unique identifier (e.g., "q1", "q2")
- \`type\` (required): One of the types above
- \`question\` (required): The question text
- \`context\` (optional): Why you're asking — helps the user understand the impact
- \`options\` (for pick_one, pick_many, show_options): Array of option objects with \`id\`, \`label\`, optional \`description\`, optional \`recommended: true\`
- \`placeholder\` (for ask_text): Placeholder text for the input
- \`required\` (optional): Whether the question must be answered (default: true)

For **show_options** type, options can also include \`pros\` and \`cons\` arrays of strings.

### Session Continuity

When you receive feedback from a denied plan that includes a session ID like:
\`Include this in your next plan: <!-- plannotator:session ps_abc123 -->\`

You MUST include that session marker in your revised plan to maintain review context across iterations.

### Best Practices

1. Only ask questions when genuinely uncertain — don't ask about things you can reasonably decide
2. Keep questions focused and specific — avoid vague or overly broad questions
3. Provide context for each question so the user understands why it matters
4. Use pick_one/pick_many when you can enumerate the options — it's faster for the user
5. Use ask_text only when the answer space is truly open-ended
6. Group related questions logically — the user sees them all at once
7. Limit to 2-5 questions per plan — too many questions defeats the purpose
`.trim();

/**
 * Short prompt fragment for session continuity.
 * Used when a session ID needs to be carried forward.
 */
export function sessionContinuityPrompt(sessionId: string): string {
  return `Include this session marker in your next plan to maintain review context: <!-- plannotator:session ${sessionId} -->`;
}
