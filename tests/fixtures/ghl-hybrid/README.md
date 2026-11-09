# WF22 GHL Hybrid fixtures (Command Center copy)

Fake-only fixtures for the cross-repository integration checks. Synthetic
tenant, location, run and object identifiers only; no client data, no
credentials, no owner notification, no network.

`contracts/` is a byte-identical copy of the onboarding
`06-ghl-install-pages/tests/ghl_hybrid_fixtures/contracts/` snapshot. The
authoritative shared schemas belong to WF00 (`shared-utils/ghl/contracts/`);
this copy exists because Command Center must validate without GitHub access.
`contracts/contract-manifest.json` names the assumed checkpoint (WF00-CP01)
until that record is published.
