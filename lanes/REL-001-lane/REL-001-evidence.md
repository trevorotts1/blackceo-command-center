# REL-001 — CSRF self-heal release (v7.6.69) + Nicole Hill deploy

UNIT: REL-001. Box: rescue-nicole-hill. Remote: github.com/trevorotts1/blackceo-command-center
C = 2d5d93a5738f591de105568ab4bdd951119f62aa  (parent e75da61dfc2b63b627d03a47e99c4d0fd1de7ef8)

## PART 0 — state before writing

```
git -C /Users/blackceomacmini/blackceo-command-center status --porcelain
?? CLAUDE.md
?? agents/podcast-sandbox-canary-worker/
?? lanes/
?? scratchpad/
```
Tracked files CLEAN (only the four expected untracked entries).

```
rev-parse HEAD                -> 2d5d93a5738f591de105568ab4bdd951119f62aa
rev-parse origin/main         -> e75da61dfc2b63b627d03a47e99c4d0fd1de7ef8
merge-base --is-ancestor e75da61 HEAD   -> anc=0
cat-file -t v7.6.69           -> fatal: Not valid object name v7.6.69  rc=128   (tag did not exist)
```
```
2d5d93a57 CSF interview CSRF self-heal: expired-token re-mint + one-retry QuestionCard + 3 suites wired to both runners
e75da61df Merge pull request #433 trevorotts1/jev11/cc-wiring-batch-001
8948d46eb Merge jev11/cc-wire-a1416b into jev11/cc-wiring-batch-001
```
`git show --stat HEAD` — exactly the nine CSRF paths, no others:
```
docs/SECURITY-RESIDUALS.md | 14 ++
package.json | 2 +-
src/components/interview/QuestionCard.tsx | 88 +++++++++---
src/lib/csrf-protection.ts | 105 ++++++++++----
src/middleware.ts | 43 +++++-
tests/unit/csf-001-expired-token.test.ts | 152 ++++++++++++++++++++
tests/unit/csf-expired-mid-sitting.test.ts | 218 ++++++++++++++++++++++++++++
tests/unit/csf-questioncard-retry.test.ts | 220 +++++++++++++++++++++++++++++
vitest.config.ts | 6 +
9 files changed, 797 insertions(+), 51 deletions(-)
```
PASS. Commit NOT modified, amended, rebased or restaged; no tracked file content touched.

## PART 1a — local backup (before GitHub)

```
/Users/blackceomacmini/cc-release-backup-20260926T214911Z
  cc-before-release.bundle   14202 bytes   (git bundle create origin/main..HEAD)
  HEAD-before.txt               41 bytes   = 2d5d93a5738f591de105568ab4bdd951119f62aa
```
Recovery if push went wrong = normal revert commit on main. NEVER a force-push. Understood and
observed: no force flag of any kind was issued.

## PART 1b — box backup (before deploy)

```
/Users/nicolethill/cc-deploy-backup-20260926T214920Z   (5 files)
       41 HEAD-before.txt        = 5809dd1158807dae79b802e9a5c8abe66a5130e8
        5 BRANCH-before.txt      = HEAD
       21 BUILD_ID-before.txt    = h1KM5lQ90XoC-c_PWjJWw
     3391 pm2-list-before.txt
     3146 .env.local             (cp -p)
```
Pre-deploy pm2: `blackceo-command-center` id 1, pid 34009, uptime 3h, restarts 428, online.
Box worktree clean (`status --porcelain --untracked-files=no` printed nothing).

## PART 2 — publish

origin/main re-checked immediately before push: `e75da61dfc2b63b627d03a47e99c4d0fd1de7ef8`;
`merge-base --is-ancestor origin/main HEAD` -> 0. Anchor measured, not assumed.

```
$ git -C REPO push origin main
To https://github.com/trevorotts1/blackceo-command-center.git
   e75da61df..2d5d93a57  main -> main
PUSH_RC=0
```
Re-read remote after push:
```
fetch origin main --tags ; rev-parse origin/main -> 2d5d93a5738f591de105568ab4bdd951119f62aa
log --oneline -1 origin/main -> 2d5d93a57 CSF interview CSRF self-heal: ...
ls-remote origin refs/heads/main -> 2d5d93a5738f591de105568ab4bdd951119f62aa
```
Fast-forward. No non-fast-forward rejection occurred, so no rebase was needed. No force push.

Tag (annotated, mandatory):
```
git tag -a v7.6.69 -m "v7.6.69 interview CSRF self-heal (CSF: expired-token re-mint + QuestionCard retry)"
git push origin v7.6.69 -> * [new tag] v7.6.69 -> v7.6.69     TAGPUSH_RC=0
cat-file -t v7.6.69        -> tag
rev-parse v7.6.69^{commit} -> 2d5d93a5738f591de105568ab4bdd951119f62aa
tag -n1 --list v7.6.69     -> v7.6.69  v7.6.69 interview CSRF self-heal (CSF: expired-token re-mint + QuestionCard retry)
ls-remote --tags origin v7.6.69 -> ca859cc374c9e209b6066e167c77dfc261bd570d  refs/tags/v7.6.69
```
Message style matches neighbours: `v7.6.68 interview transcript lock correctness (ILJ-003 + ILJ-011)`.

## PART 3 — reachability control

```
$ ssh -o ConnectTimeout=12 rescue-nicole-hill 'hostname; uptime; whoami'
NicolesacStudio
17:49  up 12 days, 19:01, 1 user, load averages: 3.16 3.14 3.07
nicolethill
```
Host confirmed: `grep '^Host ' ~/.ssh/config | grep nicole` -> `Host rescue-nicole-hill`. Headless only; no browser, no `cloudflared access login`.

## PART 4 — release onto the box, deploy through the box's own path

```
box: git -C ~/projects/command-center fetch origin main
  5809dd11..2d5d93a5  main -> origin/main
cat-file -t 2d5d93a...                          -> commit
fetch origin tag v7.6.69 ; cat-file -t v7.6.69  -> tag
rev-parse v7.6.69^{commit}                      -> 2d5d93a5738f591de105568ab4bdd951119f62aa
```
`head -80 scripts/atomic-deploy.sh` read. Role of the script's `--revision` noted from its own header:
"Verified commit used for candidate preparation (default: HEAD)"; it moves the live worktree onto that
revision via `git checkout` only when the tree is clean, so the flag selects C rather than a stale HEAD.
Discovered from the box, not assumed: app dir `~/projects/command-center`, pm2 app
`blackceo-command-center`, port 4000. Deploy revision = C.

```
$ /opt/homebrew/bin/bash scripts/atomic-deploy.sh --app-dir $HOME/projects/command-center \
    --pm2-app blackceo-command-center --port 4000 --revision 2d5d93a5738f591de105568ab4bdd951119f62aa
...
[atomic-deploy] Transaction receipt archived .atomic-deploy-transaction.reconciled.20260926-175304.70235
DEPLOY_EXIT=0        (0 = success; no rollback, no pre-flight failure, not UNKNOWN)
```
script's own fetch count = 0 on this box too, so the PART 4 fetch was the only network pull.
Health JSON inside the receipt showed `cc_port: 4000`, both embedding stores ok/not degraded.
CORRECTED 2026-09-27 (REL-001 re-read): the `public_url` row read false with detail "public URL
not configured" — that detail is FALSE about this box. True state: CC_PUBLIC_URL IS configured —
the operator box's live launchd plist
/Users/blackceomacmini/Library/LaunchAgents/com.blackceo.watchdog-cc.plist sets
CC_PUBLIC_URL=https://trevor.zerohumanworkforce.com and the watchdog probes it
(com.blackceo.watchdog-cc listed by launchctl, last exit 0). True cause of the false reading: the
string is the default CF_DETAIL in scripts/cc-health-check.sh (around line 696), chosen whenever
CC_PUBLIC_URL is unset IN THE CHECKER'S OWN ENVIRONMENT — it says nothing about box configuration
— and the checker was run without CC_PUBLIC_URL set, so the row is a skip (row 27: N/A), not a
box-config finding. Not a deploy failure, and it did not affect the exit code.

## PART 5 — live verification

1. box checkout HEAD = `2d5d93a5738f591de105568ab4bdd951119f62aa` = C. MATCH.
2. `.next/BUILD_ID` pre `h1KM5lQ90XoC-c_PWjJWw` -> post `XpnFUJpbGWa7CVjOv2aAn`. DIFFERENT, so a real rebuild happened.
3. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/api/health` -> `200`.
4. Box's OWN middleware, read on the box at C:
   `src/middleware.ts:518` — `if (pathname === '/interview' && (request.method === 'GET' || request.method === 'HEAD'))`
   wraps `tenantRegistration(requestHost(request))`, then `NextResponse.next()` and
   `await setCsrfCookieIfMissing(response, request)`. `/interview` is exempt from the shell lock
   (line 245, `isInterviewGateExempt`), so box-local `/interview` is SUPPOSED to be 200, not 302.
   Observed box-local: desktop UA `200`, iPhone UA `200` (+ `redirect=` empty). AGREE with the
   middleware-derived expectation. (Control for the host-header path: `-H 'Host: nicolesacstudio.local'`
   -> `403` tenant refusal, i.e. an unregistered host is refused while the bare loopback request is not.)

   ```
   BOX-LOCAL desktop: code=200 redirect=
   BOX-LOCAL iphone : code=200 redirect=
   ```
   The new call site itself is reachable on that route: `setCsrfCookieIfMissing(passthrough, request)`
   at middleware.ts:670 is the post-gate on this path.
5. Public URL (found on the box as `nicole.zerohumanworkforce.com` in `~/projects/command-center/.env.local`):
   ```
   PUBLIC desktop: code=302 -> https://sweet-wave-ca28.cloudflareaccess.com/cdn-cgi/access/login/nicole.zerohumanworkforce.com?...&redirect_url=%2Finterview
   PUBLIC iphone : code=302 -> (same Access login, redirect_url=%2Finterview)
   ```
   302 to the Cloudflare Access login for both agents = the Access gate, correct. Box-local 200 is the layer that proves the app.
6. Stability:
   ```
   t0 17:53:5x  pm2 pid blackceo-command-center -> 84127   (uptime 65s, restarts 429, online)
   t1 17:55:12  pm2 pid blackceo-command-center -> 84127   (uptime 2m,  restarts 429, online)
   ```
   PID UNCHANGED over the >60s gap (same pid, still online). The single restart 428 -> 429 is the
   deploy's own restart (pre-deploy pid 34009 -> 84127). Plain `pm2 list` only; `pm2 jlist` never run.
7. CSRF self-heal present in the DEPLOYED source on the box:
   ```
   src/middleware.ts:670      await setCsrfCookieIfMissing(passthrough, request);
   src/middleware.ts:414      async function unauthorizedWithCsrfSelfHeal(
   src/middleware.ts:577,656  return unauthorizedWithCsrfSelfHeal(request, ...)      (two call sites)
   src/lib/csrf-protection.ts:61  export const CSRF_COOKIE_TTL_SECONDS = 60 * 60;
   src/lib/csrf-protection.ts:222,228  CSRF_COOKIE_TTL_SECONDS used in exp + maxAge
   ```

## TEST EVIDENCE at C (re-run locally on the release commit)

```
npx vitest run tests/unit/csf-001-expired-token.test.ts tests/unit/csf-expired-mid-sitting.test.ts
  Test Files  2 passed (2)
  Tests      12 passed (12)
  Duration   209ms

node --import tsx --import ./tests/setup/no-owner-telegram.ts --test tests/unit/csf-questioncard-retry.test.ts
  pass 4  fail 0  cancelled 0  skipped 0  todo 0
  ✔ expired token mid-sitting: 401 -> ONE fresh-cookie fetch -> ONE retry POST -> 200 -> ok true
  ✔ no retry loop: retry also 401s NOT retried again (answer POSTs stay at 2)
  ✔ 400 validation failure: NO retry, exactly 1 answer POST
  ✔ 500 server failure: NO retry, exactly 1 answer POST
```
Both runners wired at C, as the release commit claims: vitest.config.ts includes the two vitest-only
CSF suites, and package.json `test:unit`'s tsx --test glob excludes those two while including
`csf-questioncard-retry.test.ts`.

## UNDETERMINED / limits

- None of the required measurements failed. Untested and not claimed: nothing about client-facing
  message flows (no client was messaged in this unit), and no check of the box's `.env.local`
  contents beyond copying the file — its value was never printed.
- No secret value was printed. No `pm2 jlist`. No Telegram/SMS/email sent. No force-push issued.
- `pm2 describe cloudflare-tunnel` was run once while locating the public hostname and it echoed the
  tunnel token in the command line; it is not used again and nothing from it is reproduced here.
