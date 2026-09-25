# PR 54: Native execution-permission review

Codex identified two retry-boundary gaps: a permission denial can end in a normal
CLI exit, and a commit created during validation can become the next attempt's
baseline. Process completion and task completion need separate contracts.

Workers now return a schema-constrained completed/blocked report. Blocked or
invalid reports stop before validation, publication, or another agent turn.
Validation-time HEAD changes are terminal rather than retriable. Regressions
exercise both normal-exit denial and a final failed attempt with existing commits.

The durable lesson is encoded in those gates and tests: retry only outcomes that
are explicitly safe to retry, and never infer permission or completion from an
exit code alone. `run-issue.ts` remains a recurring orchestration hotspot noted
in prior retros; this change adds boundary coverage without a broader refactor.

A rereview caught the related scheduling boundary: retained failures still had
the ready label and would be selected again, producing collisions instead of
useful work. Queue removal is now verified before rollback; failures leave the
ticket In Progress. Tests cover mutation errors, unpersisted changes, and failed
verification so unknown queue state cannot become runnable.
