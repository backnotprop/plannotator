## Web Researcher Subagent

### Changes

**New file: `home/dot_config/opencode/exact_agents/web-researcher.md`**

Subagent definition with:
- Model: kimi-k2p5-turbo (matches other subagents)
- Mode: subagent (not hidden; available for direct user invocation too)
- Permissions: blanket deny, then allow only `web *` and `jq *` (bash), plus Context7 MCP tools
- Prompt covering:
  - Fallback priority: Context7 (curated library docs) → web search → web fetch
  - Error surfacing: MUST report all tool failures (auth errors, timeouts, HTTP errors, empty
    results) unconditionally and verbatim to the caller
  - Progressive refinement: if initial results are thin, refine query and search again
  - Constraint on max iterations to prevent runaway cycles
  - "When stuck" guidance
  - Output template (enforced structure for quality):
