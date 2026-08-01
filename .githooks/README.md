# .githooks — pre-push client-name guard

This directory holds git hooks for the Command Center repo. Today it ships one
hook: **`pre-push`**, the push-path client-name gate.

## Why

`blackceo-command-center` is a **PUBLIC** repo. The repo-wide rule is that no
real client name, client chat ID, operator machine path, or placeholder leak may
ever appear in a tracked file (see `scripts/qc-assert-no-client-names.sh`). CI
cannot be the only enforcement point: a bare GitHub-hosted runner has no client
roster by design (client PII is intentionally never provisioned into CI
secrets), so the CI tier of the gate is structurally report-only. The push path
— where the real roster exists, on the operator's machine — is where the
authoritative check must run. That is what this hook does.

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

The hook is committed and shared, but the `core.hooksPath` setting is local to
each clone — every new clone/worktree must run the `git config` line once.

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
