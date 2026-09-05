# Dependency security remediation — September 5, 2026

Command Center v7.1.0 remediates all 15 affected package entries reported for v7.0.0: 2 critical, 9 high, 3 moderate and 1 low. These entries aggregate 50 distinct advisory URLs; they are not 15 distinct CVEs. The exact installed lockfile and production-only graph both report **zero npm advisories** on September 5, 2026. An audit is a point-in-time check of known advisories, not proof that all possible vulnerabilities are absent.

## Package inventory

| Affected package | Previous severity | Previous resolved versions | New resolved versions |
|---|---|---|---|
| @next/eslint-plugin-next | high | 14.2.21 | 16.3.4 |
| @vitest/mocker | moderate | 2.1.9 | 3.2.7 |
| brace-expansion | high | 1.1.15, 2.1.1, 5.0.6 | 1.1.18, 5.0.9 |
| browserslist | high | 4.28.2 | 4.28.9 |
| esbuild | moderate | 0.21.5, 0.28.0 | 0.25.12, 0.28.2 |
| eslint-config-next | high | 14.2.21 | 16.3.4 |
| glob | high | 10.3.10 | Removed |
| js-yaml | high | 4.2.0 | 4.3.2 |
| nanoid | high | 3.3.12 | 3.3.18 |
| next | critical | 14.2.21 | 16.3.4 |
| postcss | high | 8.4.31, 8.5.15 | 8.5.23, 8.5.28 |
| postcss-selector-parser | low | 6.1.2 | 6.1.4 |
| vite | high | 5.4.21 | 6.4.3 |
| vite-node | moderate | 2.1.9 | 3.2.4 |
| vitest | critical | 2.1.9 | 3.2.7 |

Next.js, PostCSS and nanoid occur in the production graph. The other affected entries are development/build/test dependencies. The Vitest critical finding concerns its UI/API server, so a normal `vitest run` alone does not establish an exposed service. Both production and development findings are remediated.

## Implementation

1. Upgrade Next.js to 16.3.4, React/React DOM to 19.2.8 and React-compatible drag and drop; refresh the exact lockfile without force overrides. Next 14 is outside the official support policy. Next 16 provides the maintained framework security line.
2. Await Next request cookies and dynamic route parameters. Propagate asynchronous client selection/context into every caller, including interview routes, client-specific file access, bridge dispatch, tenant-board aliases and server-rendered pages. Preserve authorization, tenant checks and cookie flags.
3. Retain Webpack explicitly in dev/build because the application supplies native SQLite and Edge instrumentation integration. Move stable external-package configuration to its current Next key. Keep Edge middleware behavior; a Node proxy conversion is outside this security migration.
4. Upgrade Vitest/Vite and vulnerable transitive parsers/build tools. Move ESLint to flat configuration and its direct CLI because Next 16 removes `next lint`. Preserve all 98 previously enforced rule severities; retain 14 new React Compiler recommendations as warnings. Repair the internal SOP navigation anchor with Next Link.
5. Add `dependency-audit.yml` to install the exact graph and reject any known low-or-higher npm advisory on main pushes and pull requests, including development dependencies.
6. Match the locked engine requirements: `^20.19.0 || ^22.13.0 || >=24`. Prefer Node 24 LTS for new deployments. On each target runtime run `npm ci` so better-sqlite3 is rebuilt for that runtime. An installation configured with `ignore-scripts=true` needs an explicit `npm rebuild better-sqlite3 --ignore-scripts=false` before runtime verification.
7. Raise onboarding's Command Center minimum and expected release to 7.1.0 and enforce runtime compatibility before install/update work. Preserve its existing strategy of converging main while retaining local commits; do not reintroduce detached old-tag installs.

## Verification

- Fresh isolated install: `npm ci`, native SQLite in-memory query, and dependency peer checks passed.
- Installed graph: `npm audit --json` and `npm audit --omit=dev --json`, both exit 0 with zero vulnerabilities.
- Vitest: 678/678 passed across 49 files.
- React components: 213/213 passed across 24 files.
- ESLint: exit 0, zero errors and 130 warnings. Existing rule severities preserved.
- Production compile and generated route TypeScript checks passed. Build-only Google font responses were mocked through Next's official test hook to keep verification offline; font delivery was not tested.
- Node unit suite: 2,412/2,412 passed. The database guard fixture now invokes the locked local tsx runner instead of npx resolving from an empty temporary directory.
- Production task pipeline: 20/20 passed, including authenticated task creation, assignment, dispatch, QC hold, SSE transitions and artifact access.
- QC: 164 checks passed, 8 existing operational warnings.
- CI-equivalent production build without DATABASE_PATH passed and created no database.
- Browser interview verification is recorded below when completed.

## Remaining maintenance and deployment limits

ESLint 9.39.5 is end-of-life. The current upstream React, import and accessibility plugins do not declare ESLint 10 peer compatibility. Keeping a valid dependency graph avoids forcing an unsupported linter combination; this audit reports no vulnerability for ESLint 9, but its maintenance migration remains open. New React Compiler warnings are visible follow-up work, not suppressed rules. Upgrade ESLint and compatible plugins together when their peer ranges allow it, preserving the recorded lint policy and checking the complete app.

Publishing a tag/release does not deploy to existing client installations. Deploy the tested release through the existing isolated build, health check and rollback process, register tenant/persona contexts and verify the receiver and interview workflow on the target installation. No real client state, owner messages or paid providers are exercised by these local fixtures.

## Primary references

- [Next support policy](https://nextjs.org/support-policy)
- [Next 15 asynchronous request API migration](https://nextjs.org/docs/app/guides/upgrading/version-15)
- [Next 16 migration and Webpack selection](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Vitest critical advisory](https://github.com/advisories/GHSA-5xrq-8626-4rwp)
- [ESLint version support](https://eslint.org/version-support)
