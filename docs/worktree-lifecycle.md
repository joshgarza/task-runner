# Worktree capacity and lifecycle management

JOS-295 implements Josh's approved policy for TaskRunner-owned local work across
all configured repositories. Manual worktrees, permanent checkouts and unrelated
PRs are outside its authority. Ownership is explicit, never inferred from a
branch name, directory name, old heartbeat or Linear state.

## Policy

| Config key under `lifecycle` | Default |
| --- | --- |
| `maxWorktrees` | 5 physical checkouts, including reservations and retained failures |
| `maxUnfinished` | 5 unfinished tickets, including PR review waiting |
| `timeboxHours` | 72 hours from original execution to resolution |
| `diskStopGiB` | Stop below 10 GiB free |
| `diskResumeGiB` | Resume only above 15 GiB free |
| `diskCheckMs` | 10000 milliseconds |

Capacity and any overdue ticket block new starts across projects and queue labels.
Existing registered tickets may continue, including review fixes, but a new
checkout always requires a physical slot. Failures, retries, progress and checkout
recreation do not reset the clock. Removing a checkout releases only physical
capacity. A matching merged PR resolves its ticket; a closed unmerged PR does
not. Active work or a different local revision prevents merge resolution.
Lifecycle records completion for capacity accounting; Linear merge/close
transitions and associated comments remain owned by `pr-health`.
Josh can explicitly cancel a ticket. Cancellation preserves any checkout and
recovery refs; it does not close PRs or delete output.

Only Josh can extend deadlines or authorize deferral, cancellation,
reprioritization or scope changes. A deferral retains unfinished capacity and its
clock. Extend its deadline separately if needed. No extension bypasses disk or
capacity holds. Admission resumes automatically when applicable holds clear.

## Registry and restart recovery

The default registry is `~/.local/state/task-runner/lifecycle.sqlite`, outside
Git worktrees. All launch checkouts must use the same absolute `registryPath` and
policy configuration. SQLite WAL, full synchronous commits and `BEGIN IMMEDIATE`
serialize admissions and mutations across processes and projects. The registry
stores tickets, checkout reservations/ownership, original clocks, process
identities, PR revisions, holds, assessments, notification deduplication and
consumed human authorizations. Back up this database with SQLite's backup tools,
not by copying a live database without its WAL. Never delete it to clear a hold.

Linux process identity includes PID, boot identity and process start ticks.
Restart reconciliation checks Git registrations, actual paths and process cwd/open
file metadata. It never reads process environments or open-file contents. An
unknown or still-active process protects output. A checkout is absent only when
both Git registration and filesystem absence agree. Historical unregistered
checkouts are reported as protected inventory and require explicit adoption.
Legacy runner-start comments also require adopting the original clock before a
new run, including tickets whose old checkout is gone.

## Assessment and cleanup

The existing scheduled drain evaluates lifecycle state even on an empty queue,
before admission and after execution. It runs a separate native Codex read-only
assessment when capacity is reached or a deadline expires. `controlCheckout`
identifies a permanent checkout (by default the configured TaskRunner main).
Assessment consumes no worktree slot. It has read-only sandboxing, no approvals
or network access, and schema-validated output containing cause, evidence,
cleanup candidates and a decision needed from Josh. No generated command is
executed. Assessments are deduplicated by trigger episode and material evidence;
failed/inconclusive reports leave underlying holds intact. Explicit retry is
available for restored dependencies.

Normal post-PR cleanup and assessment cleanup use the same gate. The checkout
must be registered, inactive, unlocked and unprotected. File names are checked
for suspected secrets before Git content checks; suspected secrets stop cleanup
without opening them. Dirty and untracked output or unknown ignored files stop
cleanup. Only project `disposableFolders` are allowed as ignored output; the
initial TaskRunner default is `node_modules`. Secrets override that allowance,
including secret-looking dependency paths. Nothing is automatically committed,
checkpointed or copied. Local HEAD, branch, remote repository and current PR
revision must agree. Open or closed unmerged PRs also need the exact remote
branch revision. Matching merged PR evidence preserves the published revision.

Immediately before removal, ownership, activity, local and remote revision and
file checks run again under the registry transaction lock. Cleanup creates a
recovery ref, preserves branch refs, conditionally removes the verified checkout,
and checks both directory and Git registration absence before releasing its slot.
Errors remain visible in the registry, CLI results, Linear and standup. No PRs
are closed, projects archived or unpublished output discarded.

## Disk guardrails

TaskRunner checks filesystems containing configured repositories, the registry,
its current working directory and additional absolute `diskPaths`. On WSL it
also discovers this distribution's backing directory from Windows installation
metadata and calls Windows `GetDiskFreeSpaceEx`. An unavailable probe holds
execution. [Microsoft documents why WSL virtual capacity can exceed the available
Windows storage](https://learn.microsoft.com/en-us/windows/wsl/disk-space).

During execution the monitor cancels native SDK turns through their AbortSignal
and terminates runner-owned validation process groups. Validation runs
asynchronously in monitored worker threads. Native turns also have an independent
monitoring event loop, so synchronous coordinator Git calls cannot delay their
disk checks. A disk pause preserves
output and queue labels, does not add failure markers or consume attempts, and
leaves the registered ticket eligible for continuation after recovery. Both
standup and lifecycle status surface holds.

These are monitored guardrails, not hard quotas. Fast writes can overshoot between
samples, OS scheduling and slow filesystem probes can delay checks,
and unrelated processes may consume space. Cancellation cannot retract bytes
already written. Preserved output, unknown processes or inaccessible disk probes
may require human intervention. The registry is an operator-owned local control
plane; an actor with unrestricted access to the operator account can change it.
Native workers do not receive Linear credentials or write access to its location.

## CLI

Run through `node --experimental-strip-types src/cli.ts`:

- `lifecycle status`: read durable state, current clocks and holds.
- `lifecycle check --dry-run`: inspect all configured projects and disk evidence
  without registry writes, agents, cleanup or Linear mutations.
- `lifecycle check` (or `assess`): reconcile, assess trigger episodes and run
  independently verified cleanup. `--retry-assessment` retries unchanged evidence.
- `lifecycle extend JOS-123 --deadline <ISO-with-timezone> --reason <reason>
  --authorization-comment <id>`: extend only this ticket's deadline.
- `lifecycle disposition JOS-123 --action <defer|cancel|resume|reprioritize|scope-change>
  --reason <reason> --authorization-comment <id>`: apply an approved disposition.
  `reprioritize` requires `--priority <0..4>` for local queue scheduling.
  `scope-change` requires `--scope <complete-approved-worker-scope>`.
  Dispositions affect TaskRunner; they do not close PRs or rewrite Linear issues.
- `lifecycle adopt JOS-123 --project <name> --started-at <original-ISO-time>
  [--path <existing-checkout>] --reason <reason> --authorization-comment <id>`:
  explicitly register historical work. Omitting `--path` adopts only its clock.

Set `lifecycle.joshUserId` to Josh's Linear user ID. Authorizations are exact,
single-use Josh-authored comments on the affected issue, with this body:

```text
TaskRunner lifecycle authorization
{"action":"extend","identifier":"JOS-123","reason":"Awaiting review","deadline":"2026-10-01T00:00:00Z"}
```

The command verifies author, ticket, action and all parameters against Linear,
then records the consumed comment. A CLI flag claiming to be Josh is insufficient.
Agents may record/execute an authorization only after Josh explicitly approves
that exact action, deadline and reason. Local registry permissions and the native
sandbox are the enforcement boundary; author attribution alone does not prove
that an API call using Josh's credentials came from a human.

## Rollout and verification

Before implementation, main was synchronized to merged JOS-294 PR #54 at
`359a8c9`. Its feature branch was clean and pushed. Read-only inventory found
legacy TaskRunner/Atlas output and permanent/manual checkouts; none were adopted
or removed. A real WSL probe observed about 893 GiB virtual free space versus
119 GiB on the Windows backing volume. Two local processes were inaccessible to
process inspection, so production cleanup preserves output until that uncertainty
clears. Do not weaken the gate to make a cleanup test succeed.

Tests use isolated Git repositories, cross-process admissions, fake disk samples,
a fake native executable and controlled process metadata. They cover both
counters, persistent clocks, global overdue holds, authorization, PID reuse,
restart preservation, live processes, dirty/unpublished/ignored output, secret
name detection without secret-file access, stale evidence, failed removals,
assessment deduplication/schema failures, Windows headroom hysteresis, native
cancellation and cancellation during tests. No test fills the actual disk. A live native read-only assessment smoke test
completed in 8.4 seconds, returned schema-valid unknown-cause evidence, and
proposed no deletion without preservation evidence.

Merge only after current-head native code/security review and required checks.
Deploy reviewed code and dependencies in the scheduled launch checkout. Preserve
the non-secret launch configuration before changing lifecycle settings. Re-run
dry-run inventory, keep ambiguous output protected, explicitly adopt JOS-291's
original September 18 start, and resume it as existing work under Josh's
approved plan. Its overdue deadline blocks new starts, not its own continuation;
no deadline extension is necessary. The CLI requires an inherited `LINEAR_API_KEY`; the connected
Linear app does not export one. Never source secret files or invoke cron wrappers
from an agent to work around that boundary.
