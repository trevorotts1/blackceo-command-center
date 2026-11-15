# Fish Audio Client Voice

Call Mode's Fish Audio route follows Skill 30's `production-policy.json`, vendored
as `config/fish-audio-policy.vendored.json` with a SHA-256 pin. BlackCEO adopted
Drama-3 in onboarding PR #2754. Fish Audio's server default is S2.1 Pro, so every
request must send the model header. The route sends `drama-3` unless the client or
operator explicitly sets `FISH_AUDIO_MODEL=s2.1-pro`. Free, legacy, empty and
unknown IDs fail before the paid call. There is no automatic model downgrade.

Configure `FISH_AUDIO_API_KEY`, `FISH_AUDIO_VOICE_ID` and the installation's actual
`MC_COMPANY_ID` in the service environment. A nonempty voice ID or a successful
API-key proof does not show that this is the intended client voice. Provider
model catalog entries are not client approval records.

The route reads `<resolved OpenClaw root>/config/fish-audio-voice.json`, or the
absolute path in `FISH_AUDIO_VOICE_BINDING_FILE`. Keep this runtime record outside
the repository and skill folder. Skill 30 QC and Command Center must use the same
root/path and company identity. The record must contain:

```json
{
  "schema_version": 1,
  "company_id": "<installed MC_COMPANY_ID>",
  "voice_id_sha256": "<SHA-256 of the separately owner-approved voice ID>",
  "approval_ref": "<owner confirmation message/ticket reference>"
}
```

These placeholders intentionally fail validation. Follow Skill 30's
`references/client-voice-approval.md` to create the file with permissions `600`
from the owner's confirmed voice selection. Never compute an expected fingerprint
from the active `FISH_AUDIO_VOICE_ID`, create a second expected-value env variable,
or auto-approve an installed voice. The record is an operator-maintained approval,
not cryptographic proof of who approved it. No client voice is bundled in code.

Missing approval, a company mismatch, an unprovisioned company identity, or a wrong
voice makes Fish Audio unavailable in the provider list. Selecting Fish Audio
explicitly or through `DEFAULT_CALL_TTS_PROVIDER` then returns a safe error and
blocks server/browser voice substitution. Request voice overrides must match
the same approval. Provider failures, empty audio and non-audio responses also
fail without a model, voice or provider retry. Other provider selection behavior
for other explicitly selected providers is unchanged. Failed or invalid provider
metadata cannot establish a browser fallback: Call Mode remains stopped until
voice settings can be verified.

Existing installations need that independent approval before this path is ready.
Deploying a PR or passing offline tests does not approve a client voice. After an
authorized deployment, run Skill 30 configuration QC, then separately authorize
the paid smoke test and arrange a listening review against the client's approved
sample. A matching voice ID alone cannot prove acoustic likeness or availability.
Report live synthesis/listening as NOT RUN until performed.

To refresh the vendored policy, run `python3 scripts/sync-fish-audio-policy.py
--source-root /path/to/openclaw-onboarding` after reviewing the Skill 30 policy
change. Commit the policy, fingerprint and source record together. The `--check`
mode verifies parity without writing. The unit test checks the pinned fingerprint;
the cross-repository check additionally compares the exact upstream bytes.

Onboarding's `cc-compat.json` pins the Command Center deployment release. This fix
does not change that pin, merge, deploy, restart a service, or assert any client's
installed/fleet state. The two PRs have separate review and release lifecycles.
