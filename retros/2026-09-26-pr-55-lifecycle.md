# PR 55: Worktree lifecycle boundaries

Native review found that lifecycle checks were directly transitioning merged
issues in Linear. That duplicated `pr-health` ownership and made admission and
scheduled drain paths perform a second merge-reconciliation workflow. Lifecycle
now records matching merge evidence only for capacity accounting. Linear state
transitions and their associated comments remain in `pr-health`.

The durable boundary is encoded in the dependency direction: lifecycle no longer
imports Linear transition operations. AGENTS.md distinguishes capacity accounting
from Linear reconciliation. The existing native review/fix/re-review protocol
remains required before merge.

A fresh-checkout verification also found standup tests relying on the ignored
launch config. Tests now inject their lifecycle state, and an empty-activity
regression verifies that lifecycle holds still appear. The full suite passes
with the local config absent, matching isolated scheduled worker checkouts.

The runtime cancellation test blocks the coordinator event loop while an
independent worker monitor cancels validation. This guards against synchronous
Git operations delaying a concurrent run's disk safety checks. Cleanup tests
control process evidence explicitly; production unknown-process checks stay
conservative and do not silently discard output to satisfy a test. A nested Git
checkout also overrides a disposable-directory allowance so an embedded manual
checkout cannot be removed with its parent.

No scope changes were deferred. The live CLI credential check remains a rollout
prerequisite. JOS-291 resumes as already-approved existing work with its original
clock preserved; overdue status blocks new starts, not that continuation.
