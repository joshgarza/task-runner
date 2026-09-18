#!/usr/bin/env bash
# Deployment source: install at the TaskRunner hub's create-worktree.sh.
# Usage: ./create-worktree.sh <name> [branch-name] [--with-secrets]
set -euo pipefail

hub_dir="$(cd "$(dirname "$0")" && pwd)"
bare_repo="${hub_dir}.git"
main_dir="$hub_dir/main"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <name> [branch-name] [--with-secrets]"
  exit 1
fi
name="$1"
shift
if [[ ! "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || [ "$name" = main ]; then
  echo "ERROR: Expected a feature worktree directory name"
  exit 1
fi
branch=""
copy_secrets=false
for arg in "$@"; do
  case "$arg" in
    --with-secrets) copy_secrets=true ;;
    --*) echo "ERROR: Unknown option: $arg"; exit 1 ;;
    *)
      if [ -n "$branch" ]; then echo "ERROR: Only one branch name may be provided"; exit 1; fi
      branch="$arg"
      ;;
  esac
done
branch="${branch:-feat/$name}"
wt_dir="$hub_dir/$name"
if [ -e "$wt_dir" ] || [ -L "$wt_dir" ]; then
  echo "ERROR: $wt_dir already exists"
  exit 1
fi
git -C "$bare_repo" worktree add "$wt_dir" -b "$branch" main

# Project routing config is non-secret. Credentials are inherited by agents.
if [ -f "$main_dir/task-runner.config.json" ]; then
  cp "$main_dir/task-runner.config.json" "$wt_dir/task-runner.config.json"
fi

# Explicit human opt-in only. Agents must never use this flag.
if [ "$copy_secrets" = true ]; then
  if [ -f "$main_dir/.env" ]; then cp "$main_dir/.env" "$wt_dir/.env"; fi
  if [ -f "$main_dir/.claude/settings.local.json" ]; then
    mkdir -p "$wt_dir/.claude"
    cp "$main_dir/.claude/settings.local.json" "$wt_dir/.claude/settings.local.json"
  fi
fi

cd "$wt_dir"
npm ci
echo "Worktree ready: $wt_dir"
echo "Branch: $branch"
