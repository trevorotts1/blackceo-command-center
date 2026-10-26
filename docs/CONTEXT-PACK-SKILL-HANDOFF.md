# Context-pack skill handoff (l23, oct-2026)

`src/lib/context-pack.ts` assembles the typed handoff the dispatcher gives a
receiving agent: task-targeted excerpts of the department's core files plus
pointer references to where the rest of the documentation lives. The skill layer
of that pack is governed by an explicit resolution contract.

## Skill resolution contract

`matchSkillsForTask()` classifies the skill layer BEFORE matching:

| Status | Meaning | Handoff behaviour |
|---|---|---|
| `ok` | configuration resolved; matches are trustworthy | matched skills handed over |
| `no_skills_installed` | roots exist but hold no `SKILL.md` | no skills; handoff proceeds |
| `config_absent` | onboarding tree not on this box (no skill roots, no dept map) | no skills; handoff proceeds |
| `deps_unresolvable` | configuration present but what it names is missing — dept-map path missing/unparseable, every bound skill absent from disk, dangling skill symlink | **handoff blocked**; `[]` returned with a warning naming the missing paths |

Only `ok` / `no_skills_installed` may hand off. A configured dependency that
cannot be resolved is a missing-dependency state, never a fallback to unrelated
filesystem candidates: before this contract, an absent onboarding tree or a
dangling skill symlink looked like a normal match and handed the doer a skill
nobody wired.

`resolveSkillDependencies()` exposes the same classification so dispatch can
record why it refused. `SkillResolution.detail` names the offending paths;
`SkillResolution.missingPaths` lists them.

`CONTEXT_PACK_VERSION` (currently 1) bumps whenever the `ContextPack` shape
changes, mirroring the repo's `*_V1` marker convention.
