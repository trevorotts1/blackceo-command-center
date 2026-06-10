# Terminology and Data Contracts

This document is the single source of truth for terminology and data contracts used
across the Command Center codebase.  When a term appears in multiple files, this
definition governs.

---

## department_id — canonical slug contract (PRD 1.5)

**Contract:** `department_id` in every DB column, every Python `--department` argument,
and every persona selector call MUST be the **canonical slug** (lowercase, hyphenated,
no `dept-` prefix, e.g. `marketing`, `sales`, `billing-finance`).

**Never** pass a UUID as `department_id`.  Workspaces created through the UI receive a
UUID primary key (`workspaces.id`).  The slug is always in `workspaces.slug`.

### Why this matters

The Python persona selector (`persona-selector-v2.py`), its DB logging, stickiness keys,
and KPI layer all operate on the slug.  Passing a UUID causes:

- `persona_selection_log.department_id` to store a UUID — rows written under one key are
  never read under another, making stickiness dead.
- The dept-dir lookup (`<workspace>/departments/<slug>/`) to fail silently.
- Adaptive weight keys to become unresolvable, disabling learning.
- Migration 1832 (which already had to bulk-rewrite `persona_assignment.department_id`)
  to repeat itself indefinitely.

### Enforcement in code

- `src/lib/tasks.ts` (`createTaskCore`): resolves the workspace row (`SELECT id, slug
  FROM workspaces …`) to obtain `workspaceSlug`, then passes
  `canonicalDeptSlug(workspaceSlug)` to `selectPersonaForTask`.  Falls back to
  `canonicalDeptSlug(input.department)`, then `'general'`.
- `src/lib/routing/canonical-slug.ts` (`canonicalDeptSlug`): the single normalisation
  function — strips `dept-` prefix, lowercases, maps known aliases, returns a canonical
  slug.  Applied at every join point.
- `src/lib/persona-selector.ts` (`selectPersonaForTask`): receives `departmentId` and
  passes it verbatim as `--department`.  The caller is responsible for passing a slug.

### Canonical slug set

See `src/lib/routing/canonical-slug.ts` (`CANONICAL_SLUGS` set) for the full list.
Common examples:

| UI / raw value         | Canonical slug       |
|------------------------|----------------------|
| `dept-marketing`       | `marketing`          |
| `dept-webdev`          | `web-development`    |
| `billing`              | `billing-finance`    |
| `ceo`, `ceo-com`       | `master-orchestrator`|
| `general`, `misc`      | `general-task`       |
| `<uuid>`               | ❌ invalid — resolve via workspaces.slug first |

---

## workspace_id vs department slug

| Field             | Type        | Meaning                                         |
|-------------------|-------------|-------------------------------------------------|
| `workspaces.id`   | TEXT (UUID) | DB primary key; may be a UUID for UI-created rows |
| `workspaces.slug` | TEXT        | Canonical dept slug; always safe for selector   |
| `tasks.workspace_id` | TEXT (FK) | References `workspaces.id` — the UUID           |
| `tasks.department`   | TEXT        | Canonical slug (set at insert via `canonicalDeptSlug`) |
| `persona_selection_log.department_id` | TEXT | Must be canonical slug (PRD 1.5 contract) |

---

*Last updated: PRD 1.5 (department identity contract), 2026-06-09.*
