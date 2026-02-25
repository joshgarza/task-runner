#!/usr/bin/env bash
# Claude Code PreToolUse hook: block Edit/Write/MultiEdit on the main branch.
# Reads tool input from stdin (JSON with tool_name, tool_input).

set -euo pipefail

branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")

if [ "$branch" != "main" ]; then
  exit 0
fi

# Extract the file path from the tool input for a helpful error message
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.file_paths[0] // "unknown"' 2>/dev/null || echo "unknown")

cat <<EOF
{"decision":"block","reason":"Cannot edit files on the main branch. File: ${file_path}\nSwitch to a feature branch worktree to make changes."}
EOF
