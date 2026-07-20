# Config Directory

`company-config.json`, `departments.json`, and `board-slas.json` are per-box
runtime data. They are intentionally gitignored so an application write can
never conflict with an upstream update. On first use the application copies the
matching tracked `*.example.json` template. `update.sh` performs the same
migration for existing installs and preserves customized files byte-for-byte.

Never commit the runtime files. Change an `*.example.json` file only when the
fresh-install default or schema itself needs to change.

`departments.json` is EMPTY by default. Skill 23 (AI Workforce Blueprint)
generates this file based on the client's interview answers. If this file is
empty, run Skill 23 first.

Do NOT use hardcoded department data. The departments come from the client's choices.

## board-slas.json (U101)

Per-department overrides for the board-hygiene (`src/lib/jobs/board-hygiene.ts`)
and stale-task-sweep (`src/lib/jobs/stale-task-sweep.ts`) lane thresholds.
EMPTY by default (`{}`) — an empty/absent file means every department uses
the global default (env-var-tunable, unchanged behavior).

Shape: `{ "<department-slug>": { "<thresholdKey>": <positive number>, ... } }`.
See `src/lib/board-slas.ts` for the full key list, the matching env var for
each key, and the precedence rule (explicit env var always wins globally;
a department entry here only applies when no env var is set for that key).

This file is rendered READ-ONLY on the Settings → Board SLAs surface
(`/settings/board-slas`) so the operator can see the active effective table
per department. It is loaded fail-closed: a missing file, unparseable JSON,
or an individual malformed department/field is dropped (logged) rather than
crashing either job — the affected scope always falls back to the
already-shipped global-default behavior, never to an undefined/corrupt value.

Example:
```json
{
  "finance-accounting": {
    "blockedOperatorEscalateHours": 24
  }
}
```
