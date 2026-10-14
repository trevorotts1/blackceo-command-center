# B10 navigation binding record (CWE-031)

Binding B10 (Directive Section 2.4): CWE-031/CWE-033 record the exact
navigation registry/export and create one council entry. Closure proof: all
authorized entry points route to the same scoped page, and a hidden menu is
not the sole access control.

This record contains only facts verified by reading the code at Command
Center commit `6502d9c5f94defbf131e48067ca7d852a1b9027b` (the CWE-031 CC
base). CWE-031 records the facts and the entry specification; CWE-033
creates the entry (it owns `src/app/council/page.tsx` and the entry
links). Status of B10 after CWE-031: facts VERIFIED from code, entry
creation assigned to CWE-033, closure proof pending CWE-033.

## Verified facts

1. **The AppShell sidebar is retired.** `src/app/layout.tsx` carries the
   comment "Top header + breadcrumbs handle navigation; AppShell sidebar
   import also retired", and the import is commented out. The root layout
   mounts, in order: `BrandTheme`, `InterviewGateSync`,
   `InterviewBypassBanner`, the page children, `CommandPalette`,
   `MobileNav`, and `AppWalkthrough`. Any plan that registers navigation
   only in AppShell registers it nowhere live.
2. **AppShell still exists as a component** (`src/components/AppShell.tsx`)
   with a static `NAV_ITEMS` array: Home `/`, CEO Board `/ceo-board`,
   Departments `/workspace`, Departments `/ceo-board/departments`,
   Settings `/settings`. It also demonstrates the engine-gated item
   pattern (below) for a Podcast entry. It is not mounted by the root
   layout at this commit.
3. **Live phone navigation is `src/components/MobileNav.tsx`**, mounted by
   the root layout below the `md` breakpoint, with its own item list:
   Home `/`, Tasks `/tasks/all`, Board `/ceo-board`, Operator `/operator`,
   Settings `/settings`.
4. **Per-page top header is `src/components/Header.tsx`** (links to `/`,
   `/workspace`, `/operator` observed), and `src/components/Breadcrumb.tsx`
   exists alongside it.
5. **The engine-gated navigation registry pattern is
   `src/lib/nav-gating.ts`**: `shouldShowEngineNavItem(status, slugs,
   slug)` fails closed (hidden while the workspace fetch is loading or
   errored) and `insertEngineNavItem(items, afterHref, item, show)`
   inserts an item after an anchor href. The signal is the workspace slug
   set from `GET /api/workspaces`, parsed by
   `src/lib/dashboard-workspaces.ts` (`parseWorkspaceSlugs`,
   `selectProducerCardSlugs`).
6. **The home page (`src/app/page.tsx`) gates its producer-board entry
   cards by the same slug signal**, explicitly so a deployment without an
   engine never renders a dead-link card. Entry cards and nav items share
   one presence signal; this is the "existing navigation registry" the
   directive's Section 21.1 refers to in this codebase.
7. **The operator console has its own sidebar**
   (`src/components/OperatorSidebar.tsx`, items under `/operator/*`). It
   is a separate surface; the council entry does not belong there.
8. **Route protection anchors observed**: `src/middleware.ts` and
   `src/lib/bearer-required-routes.ts` exist. No file named
   `src/lib/route-permissions.ts` exists at this commit; the CWE-001 recon
   anchor of that name does not match this checkout and should be
   corrected in the binding inventory to the two files above plus the
   tenant context in `src/lib/auth/tenant-context.ts`.
9. **Brand theming**: `src/components/BrandTheme.tsx` is mounted first in
   the root layout and rewrites the `--brand-*` scale and `--bcc-*`
   variables from the selected client's primary color. Fallback values in
   `src/app/globals.css`: `--bcc-bg #F8F9FB`, `--bcc-white #FFFFFF`,
   `--bcc-border #E5E7EB`, `--bcc-text #1A1D26`,
   `--bcc-text-secondary #6B7280`, `--bcc-primary #43A047`,
   `--bcc-primary-hover #388E3C`, `--bcc-primary-light #E8F5E9`.
   `tailwind.config.ts` mirrors the same palette. The interview feature's
   scoped `--iv-*` layer in globals.css (with
   `src/components/interview/interview-theme.ts`) is the repo's precedent
   for a feature-scoped visual system riding the `--brand-*` scale; the
   council system in this folder follows it.

## The one council entry (specification for CWE-033)

- Exactly ONE navigation entry, label **Council of Wise Elders**, target
  route **`/council`**, added through the patterns above: a nav item in
  the live navigation surfaces plus a home entry card, both driven by the
  same presence/permission signal. Never hardcode the link separately
  into multiple menus (Section 21.1).
- The home dashboard card, the AI CEO chat action, and the task detail
  action may all link into the same `/council` route (Section 21.1); they
  are links to the one entry, not separate registrations.
- Placement: the strategy/leadership neighborhood of the existing
  navigation (alongside CEO Board), not the operator console.
- Access control is the route's own authorization, never the menu's
  visibility: a hidden menu item is not the sole access control, and a
  visible one is not a permission grant (B10 closure proof, tested by
  CWE-033/CWE-044 with direct-URL checks per Section 28.2).
