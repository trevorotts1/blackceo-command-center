# .githooks — Git hooks for the Command Center repo

This directory holds the repo's Git hooks:

| Hook | Type | What it does |
|---|---|---|
| `pre-push` | **Guard** (blocking) | Push-path client-name gate. Refuses the push on any real client name / chat ID / operator path in a tracked file. |
| `post-commit` | **Advisory** (never blocks) | Warns when the checkout's compile-affecting content has moved past the running build. |
| `post-checkout` | **Advisory** (never blocks) | Same advisory after a checkout / branch switch / `git pull` merge. |
| `lib/build-freshness.sh` | (library) | Shared decision logic for the two advisory callbacks. |

## Why

`blackceo-command-center` is a **PUBLIC** repo. The repo-wide rule is that no
real client name, client chat ID, operator machine path, or placeholder leak may
ever appear in a tracked file (see `scripts/qc-assert-no-client-names.sh`). CI
cannot be the only enforcement point: a bare GitHub-hosted runner has no client
roster by design (client PII is intentionally never provisioned into CI
secrets), so the CI tier of the gate is structurally report-only. The push path
— where the real roster exists, on the operator's machine — is where the
authoritative check must run. That is what `pre-push` does.

The `post-commit` / `post-checkout` callbacks exist because a build can go
stale the moment new source content is committed or checked out (PRES-047).
They print a one-line ADVISORY pointing at the canonical deploy procedure —
`bash scripts/atomic-deploy.sh --app-dir <repo-root>` — and nothing else:

* **Advisory only.** They never deploy, restart, post messages, or block the
  Git operation. Exit code is always 0.
* **Side-effect budget.** The only thing they write is one baseline marker,
  `.next/.cc-advisory-digest`. No process or network calls.
* **Content-based, not mtime-based.** A mere `touch`, an empty commit, or an
  mtime-restoring rollback never triggers the advisory — only actual tracked
  content movement does.
* **PRES-046 composition.** When the shared content validator
  (`$CC_BUILD_CONTENT_VALIDATOR` or `scripts/lib/build-content-validator.sh`)
  is present, the callbacks prefer it: exit 0 means content matches (silent),
  exit 3 means mismatch (its reason is quoted in the advisory), anything else
  falls back to the built-in index-based digest check.
* **Missing build ≠ stale build.** Without `.next/BUILD_ID` they stay silent —
  `scripts/cc-start.sh` already fails loud on a missing build.
* **Worktree-safe.** The repo root is derived from the hook file's own
  location, so a linked worktree advises against its own checkout and never
  touches the parent's `.next/`.

## Activation (one-time, per clone/worktree)

Git does **not** run hooks out of `.githooks/` by default. Enable them with:

```bash
git config core.hooksPath .githooks
```

Verify:

```bash
git config --get core.hooksPath
# .githooks
```

The hooks are committed and shared, but the `core.hooksPath` setting is local
to each clone — every new clone/worktree must run the `git config` line once.
Or use the doctor, which does this (with a backup record) and diagnoses the
resulting setup:

```bash
bash scripts/cc-git-hooks-doctor.sh            # diagnose (read-only)
bash scripts/cc-git-hooks-doctor.sh --install  # compose + install, backed up
```

## The installation doctor

`scripts/cc-git-hooks-doctor.sh` closes the "hook installed but never runs"
gap. It resolves the **effective** `core.hooksPath` the way Git does (worktree
config > repo-local > global > `.git/hooks` default), classifies the manager
that owns the path (Husky `_`-shim chains, pre-commit, plain `.githooks`,
default), and for each expected hook checks: present? executable bit? resolved
BODY reachable — a shim that sources a parent body that does not exist (the
ONB `.husky/pre-push/_` pattern) is diagnosed as `NO-OP-SHIM`, not installed.
A global `core.hooksPath` redirect is reported, never changed.

`--install` composes **without overwriting**: if another manager owns
`core.hooksPath`, dispatch shims are written BESIDE it (manager chain first,
advisory callback second); existing hook files are never replaced and no
global Git config is touched. Every install/uninstall change is appended to
`.githooks/backups/manifest.jsonl` with file backups, and `--uninstall` removes
only the doctor-owned entries listed there.

Note: the advisory callbacks are **Git-side** hooks. They are deliberately
NOT registered as Claude runtime hooks (`settings.json` / plugin
`hooks.json`) — different mechanism, different registration, different tests
(see `HOOKS-AND-ENFORCEMENT.md`).

## What the pre-push hook checks

It invokes `scripts/qc-assert-no-client-names.sh` against the current
tracked-file state and refuses the push (non-zero exit) on any hit. It reuses
the gate's own three-tier roster load order verbatim — it does **not**
reimplement it:

1. **Curated roster** (`$OPENCLAW_CLIENT_ROSTER` or `~/.openclaw/client-roster.txt`).
2. **Derived roster** — `scripts/qc-derive-roster-from-accounts.py`, parsed
   structurally from `accounts.md` at runtime (never echoes a name, only a count).
3. **Neither available** — outside CI the hook **fails closed** (exit 2); inside
   CI it is report-only (exit 0, loud `CANNOT VERIFY`).

A pre-push hook is client-side only — GitHub never invokes it on the receiving
end — so in practice it always runs on an operator machine, where the
"neither roster available" branch means FAIL CLOSED. That is the correct default
for a push gate: if the authoritative check cannot run, the push does not go
through either.

## Never bypass it

Do not use `git push --no-verify` to slip a real finding through. If the hook
blocks a push, fix the leak: replace each real client name / chat ID / operator
path with a neutral placeholder (the gate's REMEDY output says how), then commit
and push again.
