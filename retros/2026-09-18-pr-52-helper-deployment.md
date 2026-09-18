# PR 52: Hub helper deployment

Codex caught a missing executable Git mode on the creation helper. The test
launched it through Bash, hiding the permission failure a fresh deployment would
encounter with the documented `./create-worktree.sh` command.

The helper is now tracked as executable. The integration test copies it to a
fresh temporary hub and invokes it directly, so deployment mode is exercised
alongside behavior. Test the user-facing entry point, including file mode, when
shipping standalone scripts.
