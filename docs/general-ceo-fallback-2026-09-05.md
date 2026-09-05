# General Task and CEO execution fallback

A missing or unmatched department is not a reason to wait for an owner to correct routing. The company-scoped router selects an installed, available General Task executor, then the company's CEO/orchestrator. When all eligible executors are occupied, the task retains a durable queue assignment. Intake and dispatch-intent workers reconsider it automatically; an accepted or uncertain execution retains its capacity and identity.

## Implementation

1. The router preserves explicit unavailable specialist pins and ambiguous company/department refusals, but missing departments and workerless matches use the catch-all chain. Runtime readiness and actual execution load determine fallback selection. A `[catch-all]` routing reason records the decision.
2. Ingest retains the requested department as provenance and does not create a department-correction hold. Assignment atomically updates the worker, actual workspace/department, assignment revision, routing evidence and eligible intake status.
3. Intake recovery recognizes only the historical `Requested department … is unavailable in this company.` hold. It must not release owner kills, engine-owned work, unrelated holds, or current/uncertain executions. Queued fallback changes use snapshot and execution fences.
4. The dispatcher permits a CEO only for a scoped catch-all assignment. Both routing and dispatch use the same runtime resolver. Migration 133 adds `agents.openclaw_agent_id`; an explicit binding requires a matching runtime in this installation's registry and filesystem. `main` is permitted only for authorized CEO fallback, never inferred from an absent specialist or a display name.
5. The execution prompt identifies the existing task, assigned agent, company/workspace and execution. It tells the fallback executor to produce the deliverable and retain that identity instead of reposting intake or creating another card. Runtime model resolution honors the same explicit binding.
6. Fallback SOP selection completes before persona selection captures its inputs. SOP rescoring preserves a current, company-verified confirmed bundle instead of replacing it with a default voice.
7. Onboarding's companion V3 policy updates the CEO doctrine, workforce templates and managed instruction blocks. Existing assignments execute; new intake routes once. Upgrades preserve owner-authored content and tool restrictions. The plugin must not turn an assigned General Task or specialist executor into a router.

## Verification

Routing and intake regressions exercise same-company General/CEO choices, runtime readiness, occupied and uncertain execution capacity, legacy hold recovery, status normalization, stale edits and forbidden reassignment. Runtime tests cover explicit `main`, unregistered/mismatched bindings and implicit-name refusal.

Run the existing production pipeline with `DUCK_CATCH_ALL=general` and `DUCK_CATCH_ALL=ceo`. Both modes use authenticated HTTP ingest, a local gateway stub, one accepted execution, current execution identity, a mocked artifact and unchanged QC requirements. Both modes passed 20/20 checks on the production build, including the required negative QC control when offline vision verification is unavailable. The default Graphics pipeline also remains covered. These tests do not call paid providers or prove live client delivery.

## Installation requirements

Merge and installation are separate. Upgrade Command Center and the companion onboarding policy together, let migration 133 run, then apply the onboarding managed-policy and verified runtime-binding update. A working local executor, approved tools/credentials, applicable SOP and confirmed persona remain required. Missing credentials, unavailable providers and failed QC must stay visible as actual blockers; none is disguised as completed work. New work must not wait solely because its department label is unknown.

Local validation: 2,462/2,462 Node tests, 678/678 Vitest tests, 11/11 targeted persona ownership tests, production build/typecheck and 164 QC checks passed; ESLint reported zero errors with 132 existing warnings.
