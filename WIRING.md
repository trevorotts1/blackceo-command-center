# Wiring SkillRunsPanel into the department board (Item 26)

The panel ships at `src/components/skill-runs/SkillRunsPanel.tsx` and
reads `GET /api/skill-runs`. It belongs on the web-development
department's board page: Skill 71's registry entry
(`71-blackceo-signature-page/repo-integration/skill-department-map-entry.json`
in the onboarding repo) names `web-development` as its primary
department, and `src/lib/context-pack.ts` normalizes the map to those
canonical department slugs.

Two hunks in `src/app/ceo-board/[dept]/page.tsx`:

**1. Import** (with the other component imports, e.g. beside
`DepartmentBlockersPanel`):

```tsx
import { SkillRunsPanel } from '@/components/skill-runs/SkillRunsPanel';
```

**2. Section**: gate it on the department, following the page's existing
per-department boolean pattern (`const appdevDept = deptId === 'appdev'`
and friends near the top of the component). Add the boolean:

```tsx
  const webDevDept = deptId === 'web-development';
```

and render the section after the `DepartmentBlockersPanel` section:

```tsx
          {webDevDept && (
            <motion.section variants={sectionVariants} initial="hidden" animate="visible" transition={{ delay: 0.06 }}>
              <SkillRunsPanel />
            </motion.section>
          )}
```

**Verification gap, stated plainly:** this build grounded the page's
structure at repo HEAD (the boolean-flag pattern, the
`DepartmentBlockersPanel` anchor, the canonical slug in the registry
entry and context-pack), but it did not run the app. At integration,
open the web-development department board page and confirm (a) `deptId`
there is exactly `web-development` (if the board resolves that
department under a different id, change the one boolean, nothing else),
and (b) the panel renders and its rows expand. The panel degrades to an
empty-state message when no runs have been delivered, so a wiring
mistake shows as an empty panel, never as a broken page.
