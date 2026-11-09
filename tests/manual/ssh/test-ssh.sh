#!/bin/bash
# Manual QA: runs inside the Docker image with its HOME and Plannotator config, unsandboxed, on purpose. For an isolated test run, use `bun run test:sandbox`.
# Test script to simulate Plannotator running over SSH

# Sample plan JSON input
PLAN_JSON='{"tool_input":{"plan":"# Test Plan\n\n## Overview\nThis is a test plan for SSH remote support.\n\n## Steps\n1. Do something\n2. Do something else\n3. Profit"}}'

# Run plannotator with the test plan
echo "$PLAN_JSON" | bun run /app/apps/hook/server/index.ts
