## [v7.3.3] — 2026-09-11 — Manual dispatch could not reach departments auto-dispatch could

### Fixed
- **`src/app/api/tasks/[id]/dispatch/route.ts` now probes canonical → legacy-alias runtime dirs, matching the other dispatch path.** `resolveSpecialistSessionKey` exists in two implementations: `src/lib/routing/executor-runtime.ts` (used by auto-dispatch and the execution watcher, and re-exported by `src/lib/task-dispatcher.ts`) and this API route (manual "Send to Agent"). The executor copy was fixed to probe every raw spelling that canonicalizes to the same department via `expandDeptSlugAliases`; the route copy still carried the old `canonicalSlug !== candidateSlug` guard, which skips the entire alias block whenever the workspace slug is **already canonical**. The two paths therefore disagreed: auto-dispatch could reach a department that manual dispatch declared unreachable with `no_specialist_runtime`. On a live client Mac mini every Billing and Legal Compliance agent sat in a canonical workspace (`billing-finance`, `legal`) whose OpenClaw runtime directory is provisioned under the legacy alias (`dept-billing`, `dept-legal-compliance`), so those tasks were held as "routed but not dispatched" and surfaced to the owner by her own agent as "we're not wired up". The route now runs the same alias probe, so both directions resolve: legacy-alias slug → canonical runtime, and canonical slug → legacy-alias runtime.

### Tests
- `tests/unit/dispatch-route-alias-lockstep.test.sh` → new `tests/unit/dispatch-route-alias-lockstep.test.ts`: pins every copy that *implements* `resolveSpecialistSessionKey` to probe `expandDeptSlugAliases` and to be free of the retired `canonicalSlug !== candidateSlug` short-circuit (comments stripped first, so prose describing the retired guard cannot trip it). A module that merely re-exports the resolver is skipped, since it inherits the fixed behaviour. Also asserts `expandDeptSlugAliases('billing-finance')` yields `dept-billing` and `expandDeptSlugAliases('legal')` yields `dept-legal-compliance`. Fail-first verified: re-introducing the guard fails the test; removing it passes.
- `tests/unit/dispatch-canonical-alias-reverse-probe.test.ts` already proved the behaviour for the executor copy; this release closes the remaining implementation.

### Compatibility and scope
- One route file plus one new test. No migrations, no dependency changes, no API surface change, no schema change.
- Boxes whose departments were already reachable are unaffected — the new probe only runs after the canonical dir lookup fails, which previously returned `no_specialist_runtime`.
- Publishing this code does not deploy or verify it on client installations.

