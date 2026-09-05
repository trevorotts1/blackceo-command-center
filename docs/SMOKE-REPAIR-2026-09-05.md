# Command Center smoke-test repairs — September 5, 2026

This batch fixes findings 45–48 from the consolidated Sept 5 Repo Fixes specification. It changes Command Center only; existing published tags are not moved.

1. **Built-in agent assignment (FIX-45).** Create/update accept the stored UUID and stable slug formats. Selected agents and attributed actors must exist in the authorized task company. Workspace ownership, or a unique durable request identity for an unrouted task, establishes that company; null/default aliases do not authorize access. Assignment and its event commit together. Rejected references leave sibling edits unchanged.
2. **Persona-bundle browser access (FIX-46).** Verified host-bound tenant sessions can read owned bundles while machine callers retain constant-time bearer validation. Missing and foreign tasks share a non-disclosing response; shared-client requests remain on the registered receiver boundary. Loading, a successful empty result, and failures are distinct UI states; failures offer retry and old requests cannot overwrite a newly selected task.
3. **Health truthfulness (FIX-47).** Home, departments and board reuse the same indicator. It combines tiered system probes with migration/embedding readiness and distinguishes healthy, degraded, unavailable, checking and unknown. HTTP 200 alone is insufficient. Timeout, malformed results and request failures cannot retain a stale healthy claim.
4. **Dispatch receipt race (FIX-48).** Automatic and manual dispatch events carry execution_id metadata. The production pipeline test waits up to 15 seconds for the exact task/execution receipt, with last-state diagnostics on timeout. The local gateway deliberately delays the post-acceptance model response by 750 ms. Separate negative tests prove missing, stale, foreign and malformed receipts cannot pass.

## Validation

- Production build and TypeScript validation passed.
- Node unit suite: 2,436/2,436 passed.
- Vitest integration/unit suite: 678/678 passed.
- Real component suite: 231/231 passed (Node 26 invoked with `--no-experimental-webstorage` for jsdom).
- Interview browser suite: 15/15 passed.
- Production Duck pipeline: 20/20 passed with the controlled model-response delay.
- QC guard: 164 checks passed; eight existing advisory warnings. ESLint: zero errors; existing warnings remain.
- New assignment and persona regressions exercise valid and rejected references, two-company ownership, missing identity, atomicity, successful empty results, errors and retry.

## Scope

Runtime smoke verification uses a fresh temporary database/workspace, signed fixture sessions and unusable provider credentials. Gateway execution uses a local stub; these checks do not certify paid provider execution or deployment to existing client installations. Filesystem embedding probes use explicitly isolated WORKSPACE_ROOT/PERSONA_INDEX_DB. The build uses an offline font fixture, so remote font delivery is outside this proof.

The self/operator all-tasks surface is installation-wide. The two-company negative tests here certify assignment and persona-bundle authorization; they are not a claim that every operator read endpoint filters by company. Shared-client isolation continues to use the registered remote-installation proxy.
