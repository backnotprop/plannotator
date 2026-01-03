# Plannotator MCP Server

Interactive plan review for AI coding agents via the **Model Context Protocol (MCP)**.

## Compatible Tools

Works with any MCP-compatible AI coding agent:

| Tool | Status |
|------|--------|
| **Cursor** | ✅ Supported |
| **GitHub Copilot** | ✅ Supported |
| **Windsurf** | ✅ Supported |
| **Cline** | ✅ Supported |
| **RooCode** | ✅ Supported |
| **KiloCode** | ✅ Supported |
| **Google Antigravity** | ✅ Supported |
| **Any MCP-compatible tool** | ✅ Supported |

## Features

- 🎯 **Visual Plan Review** - View implementation plans in a clean, readable UI
- ✏️ **Rich Annotations** - Delete, insert, replace text, or add comments to specific sections
- ✅ **One-Click Approval** - Approve plans to proceed with implementation
- 🔄 **Structured Feedback** - Request changes with detailed, annotated feedback
- 🔗 **Share Plans** - Share plans with team members via URL

## Installation

Add Plannotator to your MCP configuration file. The location and format varies by tool:

### Cursor

Add to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "plannotator": {
      "command": "bunx",
      "args": ["@plannotator/mcp", "--mcp"]
    }
  }
}
```

### GitHub Copilot (VS Code)

Add to your VS Code settings or `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "plannotator": {
      "command": "bunx",
      "args": ["@plannotator/mcp", "--mcp"]
    }
  }
}
```

### Windsurf

Add to `~/.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "plannotator": {
      "command": "bunx",
      "args": ["@plannotator/mcp", "--mcp"]
    }
  }
}
```

### Cline

Add to Cline's MCP settings (accessible via Cline settings panel):

```json
{
  "mcpServers": {
    "plannotator": {
      "command": "bunx",
      "args": ["@plannotator/mcp", "--mcp"]
    }
  }
}
```

### RooCode / KiloCode

Add to your tool's MCP configuration:

```json
{
  "mcpServers": {
    "plannotator": {
      "command": "bunx",
      "args": ["@plannotator/mcp", "--mcp"]
    }
  }
}
```

### Google Antigravity

Add to `%USERPROFILE%\.gemini\antigravity\mcp_config.json` (Windows) or `~/.gemini/antigravity/mcp_config.json` (macOS/Linux):

```json
{
  "mcpServers": {
    "plannotator": {
      "command": "bunx",
      "args": ["@plannotator/mcp", "--mcp"]
    }
  }
}
```

### Using npx instead of bunx

If you prefer Node.js over Bun:

```json
{
  "mcpServers": {
    "plannotator": {
      "command": "npx",
      "args": ["-y", "@plannotator/mcp", "--mcp"]
    }
  }
}
```

After adding the config, restart your tool. The `submit_plan` tool will be available to the agent.

## How It Works

1. **Agent Creates Plan** - When in planning mode, the AI agent generates an implementation plan
2. **Submit for Review** - The agent calls the `submit_plan` tool
3. **Plannotator Opens** - A browser window opens with the visual plan review UI
4. **You Review & Annotate** - You can:
   - Read through the plan
   - Mark sections for deletion (strikethrough)
   - Insert new content
   - Replace text with alternatives
   - Add comments to specific sections
5. **Approve or Request Changes**
   - **Approve** → Agent receives approval and proceeds with implementation
   - **Request Changes** → Annotated feedback is sent back to the agent
6. **Iterate** - If changes are requested, the agent revises and resubmits

## The `submit_plan` Tool

When the MCP server is configured, your AI agent gains access to this tool:

```
Tool: submit_plan

Description: Submit your completed implementation plan for interactive user review.
The user can annotate, approve, or request changes.

Parameters:
  - plan (required): The complete implementation plan in markdown format
  - summary (optional): A brief 1-2 sentence summary of what the plan accomplishes
```

### Example Agent Usage

The agent would use it like this:

```
I've completed my implementation plan. Let me submit it for your review.

[calls submit_plan with plan content]
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PLANNOTATOR_PORT` | Fixed port for the review UI | Random |

## Requirements

- **Bun** (recommended) or **Node.js** (for running the MCP server)
- An MCP-compatible AI coding agent

## Running as a Standalone Server

For testing or debugging, you can run the MCP server directly:

```bash
# With Bun
bunx @plannotator/mcp --mcp

# Or install globally and run
npm install -g @plannotator/mcp
plannotator-mcp --mcp
```

## Troubleshooting

### "Tool not found" in your AI tool

1. Make sure the MCP config file is in the correct location for your tool
2. Restart the AI tool after editing the config
3. Check that Bun or Node.js is installed and in your PATH

### Browser doesn't open automatically

The server URL will be printed to stderr. Open it manually:
```
[Plannotator] Review your plan at: http://localhost:12345
```

### Port already in use

Set a different port via environment variable:
```json
{
  "mcpServers": {
    "plannotator": {
      "command": "bunx",
      "args": ["@plannotator/mcp", "--mcp"],
      "env": {
        "PLANNOTATOR_PORT": "19433"
      }
    }
  }
}
```

### MCP connection issues

Ensure Bun is installed:
```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Or use npm with Node.js
npm install -g @plannotator/mcp
```

## Best Practices

### Plan Format

For best results, structure your plans with:

```markdown
# Implementation Plan: Feature Name

## Overview
High-level description of the approach.

## Phase 1: Setup
- [ ] Task 1
- [ ] Task 2

## Phase 2: Implementation
### Step 2.1: Create Component
- Details...

### Step 2.2: Add Styling
- Details...

## Phase 3: Testing
- Unit test approach
- Integration test plan

## Potential Challenges
1. Challenge 1 and mitigation
2. Challenge 2 and mitigation
```

## Development

```bash
# Clone the repository
git clone https://github.com/backnotprop/plannotator.git
cd plannotator

# Install dependencies
bun install

# Build the UI first
bun run build:hook

# Build the MCP plugin
bun run build:mcp

# Test the MCP server
bun run apps/mcp/index.ts --mcp
```

## License

Copyright (c) 2025 backnotprop.
This project is licensed under the Business Source License 1.1 (BSL).

## Links

- [Plannotator Website](https://plannotator.ai)
- [GitHub Repository](https://github.com/backnotprop/plannotator)
- [MCP Documentation](https://modelcontextprotocol.io)
