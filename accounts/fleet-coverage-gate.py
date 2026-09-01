#!/usr/bin/env python3
"""
fleet-coverage-gate.py — the structural tripwire that makes a silently-skipped
fleet box impossible.

WHY THIS EXISTS
---------------
Fleet-wide operations (version/skill rolls, Command-Center pushes, prove-floor,
pm2/port cleanups, secret propagation) used to build their own target list from
whatever source was convenient — Trevor's Hostinger API, the Mac CF-tunnel
tokens, or one machine copy of the roster. Those constructions STRUCTURALLY
exclude boxes on other providers (Contabo) and on a client's OWN separate
provider account (e.g. Dr. Stephanie Brown's private Hostinger). Beverly
Grandison (Contabo) and Dr. Stephanie Brown were silently dropped exactly this
way. A "cover everyone" paragraph in AGENTS.md did not stop it because prose is
not enforcement.

Same failure mode, different layer: probe-fleet.sh's mac-tunnel probe used to
resolve each client's Cloudflare Access service token via a hand-maintained
`case "$client" in ...) _tk=... ;;` switch, DUPLICATED in two places in that
file, with a wildcard default that silently borrowed Teresa Pelham's token for
any unmatched client. Eddie Otts (missing from both switches) and E.R.
Spaulding (present in one, missing from the other) were both reported DOWN
while perfectly healthy. This gate's reconcile mode now ALSO enforces (always,
by default — see cf_token_map_reconcile()) that every roster mac-kind box has
an entry in the single-source accounts/cf-token-map.json that replaced those
switches.

This gate replaces the paragraph with a runnable check. It owns the canonical
roster (accounts/fleet-roster.json, derived from accounts.md) INDEPENDENT of any
op's discovery method, and it fails loudly the moment coverage is incomplete.

TWO MODES
---------
  RECONCILE (default): prove the canonical roster and its two machine copies all
    agree, and (optionally) that no LIVE client infrastructure exists outside the
    roster. Catches drift the instant a box is added to one source but not the
    others. This is the founding-incident detector.

      fleet-coverage-gate.py --reconcile [--check-contabo] \
          [--check-cloudflare] [--check-ghl [--ghl-advisory]] [--check-universe]

    The optional LIVE legs reconcile the roster against the ACTUAL client
    universe, so a client with real infra but NO roster entry (the founding
    "overlook" — e.g. Beverly Grandison) is caught rather than silently dropped:
      --check-contabo     enumerate the Contabo host; flag any oc-* not rostered.
      --check-cloudflare  enumerate LIVE Cloudflare tunnels; FAIL on any active
                          fleet-box (rescue-*) tunnel with no roster entry.
      --check-ghl         reconcile fleet-WIRED GHL locations; FAIL on any wired
                          location that maps to no rostered client. (The 700+
                          agency book-of-business is out of scope by design — only
                          locations a fleet box is wired to are fail-closed.)
      --ghl-advisory      also name-correlate the whole agency (informational).
      --check-universe    = --check-contabo --check-cloudflare --check-ghl.

    ROBUSTNESS: the Cloudflare/GHL legs read creds from ~/.openclaw/secrets/.env
    (masked in all logging). If creds are absent or the API is unreachable they
    WARN-and-SKIP — never crash, never false-fail — and the local reconcile still
    runs. Only genuine "infra but no roster entry" trips a HARD failure. Infra
    that is intentionally not a client box (operator rescue-gw, agency GHL, dead
    tunnels) lives on a documented ignore-list (see DEFAULT_IGNORE, extendable via
    accounts/fleet-coverage-ignore.json).

  COVERAGE: given the exact set of boxes an operation actually touched, fail on
    any roster member the op did not account for. A box you could not reach is
    NOT an omission — record it touched with status DOWN/SKIPPED + a reason. A
    roster box that is simply absent from the touched-set is a HARD STOP.

      <op> | fleet-coverage-gate.py --touched -
      fleet-coverage-gate.py --touched /path/to/touched.txt

      touched-file format, one box per line:
        <box_id_or_registry_id>
        <box_id_or_registry_id>  <STATUS>  <free-text reason>
      STATUS (optional, default OK): OK DONE COVERED UPDATED DOWN SKIPPED
      UNREACHABLE N/A. DOWN/SKIPPED/UNREACHABLE/N/A MUST carry a reason.

EXIT CODES
----------
  0  full coverage / sources in sync.
  1  at least one roster member uncovered or out of sync  -> the op is NOT done.
  2  usage / file / roster error.

The op is not complete until this gate exits 0. Wire it into every fleet op and
into the heartbeat (reconcile mode) so drift cannot survive a single cycle.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
DEFAULT_ROSTER = os.path.join(HERE, "fleet-roster.json")
BOX_REGISTRY = os.path.join(HOME, "clawd", "fleet-prover", "box-registry.json")
PROBE_FLEET = os.path.join(HOME, "clawd", "fleet-heartbeat", "scripts", "probe-fleet.sh")
# SINGLE SOURCE for mac-tunnel CF Access service-token NAMES (keyed by tunnel
# hostname / probe_match). probe-fleet.sh's probe_mac_tunnel() AND its
# auto-update block both read ONLY this file (see _cf_token_for_tunnel()
# there) — no more hand-maintained case statement to forget or let drift.
DEFAULT_CF_TOKEN_MAP = os.path.join(HERE, "cf-token-map.json")

# Where the operator's fleet credentials live (env-var NAMES only are referenced;
# VALUES are never logged — see mask()).
SECRETS_ENV = os.path.join(HOME, ".openclaw", "secrets", ".env")
# Optional operator-editable ignore-list overlay (merged over DEFAULT_IGNORE).
IGNORE_FILE = os.path.join(HERE, "fleet-coverage-ignore.json")

OK_STATUSES = {"OK", "DONE", "COVERED", "UPDATED", "PASS", "ROLLED"}
REASON_REQUIRED_STATUSES = {"DOWN", "SKIPPED", "UNREACHABLE", "N/A", "NA", "FAIL", "BLOCKED"}

# The naming convention every Mac fleet-box Cloudflare tunnel follows
# (roster mac boxes carry probe_match "rescue-<slug>.zerohumanworkforce.com").
FLEET_TUNNEL_PREFIX = "rescue-"

# ---------------------------------------------------------------------------
# DOCUMENTED IGNORE-LIST — infra that is intentionally NOT a client fleet box.
# Anything here is exempt from the fail-closed "infra but no roster entry" rule.
# Keep this list SHORT and each entry commented; prefer adding a roster entry
# over silencing real infra. Operator can extend via accounts/fleet-coverage-
# ignore.json (same shape) without editing this file.
# ---------------------------------------------------------------------------
DEFAULT_IGNORE = {
    # Cloudflare tunnels (match on tunnel NAME) that are operator/shared infra or
    # known dead/dangling — NOT a client OpenClaw box.
    "cloudflare_tunnels": [
        "rescue-gw",       # operator's shared Rescue-Rangers gateway tunnel (not a client box)
        "owl-foundation",  # known dead/dangling tunnel; documented, harmless if already deleted
    ],
    # GHL locations (match on location ID) that are operator / agency infrastructure,
    # not a managed client box.
    "ghl_locations": [
        "Mct54Bwi1KlNouGXQcDX",  # "BlackCEO LLC" — agency HQ / operator's own GHL
        "9hpz6dwEP5pyj7v2WTHO",  # "Convert & Flow" — agency location, not a client box
    ],
}

# Fuzzy client<->location name matching helpers (advisory + lenient wired-ID map).
_NAME_STOPWORDS = {
    "llc", "inc", "the", "and", "co", "corp", "ltd", "group", "enterprises",
    "account", "accounts", "paused", "coaching", "consulting", "services",
    "service", "company", "org", "md", "dr", "mr", "mrs", "ms", "of", "for",
    "solutions", "global", "international", "vps", "mac", "mini", "old",
    "template", "snapshot",
}


def die(msg, code=2):
    sys.stderr.write(f"fleet-coverage-gate: ERROR: {msg}\n")
    sys.exit(code)


def load_roster(path):
    if not os.path.isfile(path):
        die(f"canonical roster not found: {path}")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    boxes = data.get("boxes", {})
    if not boxes:
        die(f"roster {path} has no boxes")
    return boxes


def alias_set(box_id, meta):
    """Every identifier that should count as 'this box was touched'."""
    aliases = {box_id}
    rid = meta.get("registry_id")
    if rid:
        aliases.add(rid)
    pm = meta.get("probe_match")
    if pm:
        aliases.add(pm)
        # the bare slug too (e.g. oc-beverly-grandison from the probe_match)
        aliases.add(pm.split(".")[0])
    return {a.lower() for a in aliases}


# ------------------------------------------------ client-universe utilities ---
def mask(val):
    """Return a log-safe rendering of a secret: ...<last4> (never the full value)."""
    if not val:
        return "(unset)"
    v = str(val)
    return "..." + v[-4:] if len(v) >= 4 else "...***"


def load_secrets():
    """Read CF/GHL creds from ~/.openclaw/secrets/.env, overlaid by the live
    process env (os.environ wins). Values are NEVER logged (see mask()). Missing
    file is fine — we simply fall back to whatever is in os.environ."""
    env = {}
    if os.path.isfile(SECRETS_ENV):
        try:
            with open(SECRETS_ENV, encoding="utf-8", errors="replace") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = re.sub(r"^\s*(export\s+)?", "", key).strip()
                    val = val.strip().strip('"').strip("'")
                    if key:
                        env[key] = val
        except OSError:
            pass
    # live env overrides the file
    for k, v in os.environ.items():
        if v:
            env[k] = v
    return env


def load_ignore():
    """DEFAULT_IGNORE merged with the optional operator overlay file."""
    ignore = {k: list(v) for k, v in DEFAULT_IGNORE.items()}
    if os.path.isfile(IGNORE_FILE):
        try:
            with open(IGNORE_FILE, encoding="utf-8") as f:
                overlay = json.load(f)
            for k, v in (overlay or {}).items():
                if isinstance(v, list):
                    ignore.setdefault(k, [])
                    ignore[k] = list(dict.fromkeys(ignore[k] + v))
        except (OSError, ValueError):
            pass
    return ignore


def _http_get_json(url, headers, timeout=30):
    """GET url -> (status_int_or_None, parsed_json_or_None, err_str_or_None).
    Never raises: any network/parse failure is returned as an error string so a
    leg can WARN-and-skip instead of crashing or false-failing."""
    # leadconnectorhq (GHL) sits behind Cloudflare, which 403s (Error 1010) the
    # default "Python-urllib/*" User-Agent. Present a curl-like UA so the WAF lets
    # the request through, matching how the rest of the fleet tooling calls it.
    headers = dict(headers)
    headers.setdefault("User-Agent", "fleet-coverage-gate/1.0 (+curl)")
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(body), None
            except ValueError:
                return resp.status, None, f"non-JSON response ({body[:120]!r})"
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        return e.code, None, f"HTTP {e.code}: {detail}"
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        return None, None, str(e)[:200]


def _norm_tokens(s):
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    return {t for t in s.split() if len(t) > 1 and t not in _NAME_STOPWORDS}


def _name_overlap(a, b):
    return _norm_tokens(a) & _norm_tokens(b)


def _expected_mac_tunnels(boxes):
    """Map expected tunnel-name -> roster box_id for every Mac fleet box, derived
    from probe_match (rescue-<slug>.zerohumanworkforce.com -> rescue-<slug>)."""
    out = {}
    for box_id, meta in boxes.items():
        if meta.get("kind") != "mac":
            continue
        pm = meta.get("probe_match") or ""
        tunnel = pm.split(".")[0].strip().lower()
        if tunnel:
            out[tunnel] = box_id
    return out


# ------------------------------------------------- cloudflare universe leg ---
def cloudflare_reconcile(boxes, secrets, ignore):
    """Reconcile LIVE Cloudflare tunnels against the roster.

    Fail-CLOSED: any ACTIVE tunnel matching the fleet-box convention
    (name startswith 'rescue-') that is NOT a roster Mac box and NOT on the
    ignore-list is a client with infra but no roster entry -> HARD problem
    (this is the Cloudflare analogue of the Contabo/Beverly-Grandison detector).

    WARN-only (non-fatal): a rostered Mac box whose tunnel is missing or down
    (a client may simply have unplugged their Mac — never false-fail on that),
    and a dangling INACTIVE unrostered rescue-* tunnel.

    Returns (problems, warnings, ran, skip_reason). Non-fleet tunnels (Command
    Centers, brand sites, VPS gateways, webhooks) are out of scope by design.
    """
    problems, warnings = [], []
    token = secrets.get("CLOUDFLARE_API_TOKEN") or secrets.get("CLOUDFLARE_TUNNEL_TOKEN")
    account = secrets.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account:
        return problems, warnings, False, (
            "cloudflare creds absent (need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID "
            f"in {SECRETS_ENV} or env)")

    base = f"https://api.cloudflare.com/client/v4/accounts/{account}/cfd_tunnel"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    live = []  # list of (name, active_bool, status)
    page = 1
    while True:
        url = base + "?" + urllib.parse.urlencode(
            {"is_deleted": "false", "per_page": 200, "page": page})
        status, data, err = _http_get_json(url, headers)
        if err or not (data and data.get("success")):
            reason = err or json.dumps((data or {}).get("errors"))[:160]
            return problems, warnings, False, (
                f"cloudflare API unreachable/failed (token {mask(token)}, "
                f"account {mask(account)}): {reason}")
        result = data.get("result") or []
        for t in result:
            conns = t.get("connections") or []
            active = (t.get("status") == "healthy") or len(conns) > 0
            live.append((t.get("name") or "", active, t.get("status") or "?"))
        info = data.get("result_info") or {}
        if len(result) < int(info.get("per_page", 200) or 200) or not result:
            break
        page += 1
        if page > 25:  # hard safety cap
            break

    ign = {n.lower() for n in ignore.get("cloudflare_tunnels", [])}
    expected = _expected_mac_tunnels(boxes)          # tunnel-name -> box_id
    seen_names = {n.lower() for n, _, _ in live}

    for name, active, status in live:
        low = name.lower()
        if not low.startswith(FLEET_TUNNEL_PREFIX):
            continue  # not a fleet-box tunnel (command center / brand / gateway) — out of scope
        if low in ign:
            continue
        if low in expected:
            continue  # rostered Mac box — good
        if active:
            problems.append((
                "CF_TUNNEL_NOT_IN_ROSTER", name,
                f"ACTIVE Cloudflare tunnel '{name}' (status={status}) matches the fleet-box "
                f"convention but is NOT in fleet-roster.json and NOT on the ignore-list — "
                f"a client has infra with no roster entry (add it, or ignore-list it if non-box)"))
        else:
            warnings.append((
                "CF_TUNNEL_DANGLING", name,
                f"inactive/dangling unrostered tunnel '{name}' (status={status}) — "
                f"decommission it or add to ignore-list"))

    # reverse direction (advisory only — never fail): rostered Mac box lacking a live tunnel
    for tunnel, box_id in expected.items():
        client = boxes[box_id].get("client", box_id)
        if tunnel not in seen_names:
            warnings.append((
                "CF_ROSTER_BOX_NO_TUNNEL", box_id,
                f"{client} — expected tunnel '{tunnel}' not found among live Cloudflare "
                f"tunnels (box may be decommissioned/renamed — verify)"))
        else:
            st = next((s for n, a, s in live if n.lower() == tunnel), "?")
            if st != "healthy":
                warnings.append((
                    "CF_ROSTER_BOX_TUNNEL_DOWN", box_id,
                    f"{client} — tunnel '{tunnel}' present but status={st} (box offline?)"))

    return problems, warnings, True, None


# -------------------------------------------------------- ghl universe leg ---
def _ghl_creds(secrets):
    token = (secrets.get("GHL_AGENCY_PIT") or secrets.get("GOHIGHLEVEL_AGENCY_PIT")
             or secrets.get("GOHIGHLEVEL_CONVERTANDFLOW_AGENCY_PIT"))
    company = (secrets.get("GHL_COMPANY_ID")
               or secrets.get("GOHIGHLEVEL_CONVERTANDFLOW_COMPANY_ID"))
    return token, company


def _wired_ghl_location_ids(boxes, secrets):
    """Every GHL location ID a fleet box is actually wired to: roster-declared
    ghl_location_id fields + any *_GHL_LOCATION_ID / *_LOCATION_ID env whose name
    signals GHL. These are the ONLY GHL locations the gate can fail-closed on
    (the 700+ agency book-of-business is out of scope)."""
    ids = {}
    for box_id, meta in boxes.items():
        lid = meta.get("ghl_location_id")
        if lid:
            ids.setdefault(str(lid), box_id)
    for k, v in secrets.items():
        ku = k.upper()
        if not v:
            continue
        looks_ghl = ("GHL" in ku or "GOHIGHLEVEL" in ku or "HIGHLEVEL" in ku)
        if looks_ghl and "LOCATION_ID" in ku and "COMPANY" not in ku:
            for piece in re.split(r"[,\s]+", v):
                piece = piece.strip()
                # GHL location IDs are ~20-char alphanumerics
                if re.fullmatch(r"[A-Za-z0-9]{18,26}", piece):
                    ids.setdefault(piece, f"env:{k}")
    return ids


def _map_location_to_roster(loc_name, boxes):
    """Return box_id of the rostered client this GHL location belongs to, else None.
    Lenient (any distinctive shared token) so we do NOT false-flag a legit client
    as an orphan; a genuine miss (no shared token with ANY roster client) is what
    trips the fail-closed orphan rule."""
    best, best_id = 0, None
    for box_id, meta in boxes.items():
        ov = len(_name_overlap(loc_name, meta.get("client", "")))
        if ov > best:
            best, best_id = ov, box_id
    return best_id if best >= 1 else None


def ghl_reconcile(boxes, secrets, ignore, advisory=False):
    """Reconcile GoHighLevel client locations against the roster.

    Fail-CLOSED (load-bearing): every GHL location a fleet box is WIRED to must
    map to a rostered client. A wired location whose name matches no roster client
    (and is not on the ignore-list) is an orphan -> HARD problem.

    Advisory (optional, --ghl-advisory; never fatal): enumerate the agency and
    report which rostered clients have / lack a same-named GHL location. The full
    agency (700+ template/cold-email/coaching accounts) is NOT fail-closed against
    — only fleet-wired locations are, by design.

    Returns (problems, warnings, ran, skip_reason).
    """
    problems, warnings = [], []
    token, company = _ghl_creds(secrets)
    if not token or not company:
        return problems, warnings, False, (
            "ghl agency creds absent (need GHL_AGENCY_PIT + GHL_COMPANY_ID in "
            f"{SECRETS_ENV} or env)")

    ign_ids = set(ignore.get("ghl_locations", []))
    headers = {"Authorization": f"Bearer {token}", "Version": "2021-07-28",
               "Accept": "application/json"}

    # --- fail-closed: fleet-wired GHL location IDs must map to a roster client ---
    wired = _wired_ghl_location_ids(boxes, secrets)
    resolved_any = False
    for lid, source in wired.items():
        if lid in ign_ids:
            continue
        status, data, err = _http_get_json(
            f"https://services.leadconnectorhq.com/locations/{lid}", headers)
        if err and status == 404:
            warnings.append(("GHL_WIRED_LOCATION_STALE", lid,
                             f"wired via {source} but GHL returns 404 — stale wiring, clean it up"))
            continue
        if err or not data:
            warnings.append(("GHL_WIRED_LOCATION_UNRESOLVED", lid,
                             f"wired via {source} but could not resolve ({err or 'no data'})"))
            continue
        resolved_any = True
        loc = data.get("location") or data
        loc_name = loc.get("name") or ""
        box_id = _map_location_to_roster(loc_name, boxes)
        if box_id is None:
            problems.append(("GHL_WIRED_LOCATION_NOT_ROSTERED", lid,
                             f"GHL location '{loc_name}' is wired to fleet infra (via {source}) "
                             f"but maps to NO rostered client — add a roster entry or ignore-list it"))

    # --- advisory (optional): agency name-correlation, never fatal ---
    if advisory:
        locs, page_err = [], None
        skip = 0
        while True:
            url = ("https://services.leadconnectorhq.com/locations/search?"
                   + urllib.parse.urlencode({"companyId": company, "limit": 200, "skip": skip}))
            status, data, err = _http_get_json(url, headers, timeout=45)
            if err or not data:
                page_err = err or "no data"
                break
            batch = data.get("locations") or []
            locs.extend(batch)
            if len(batch) < 200:
                break
            skip += 200
            if skip >= 4000:  # safety cap
                break
        if page_err and not locs:
            warnings.append(("GHL_ADVISORY_SKIPPED", "-",
                             f"agency enumeration unavailable ({page_err}) — advisory skipped"))
        else:
            matched, unmatched = [], []
            for box_id, meta in boxes.items():
                if meta.get("provider") == "operator":
                    continue
                client = meta.get("client", box_id)
                hits = [l.get("name") for l in locs
                        if len(_name_overlap(client, l.get("name") or "")) >= 2]
                if hits:
                    matched.append((client, hits[0]))
                else:
                    unmatched.append(client)
            warnings.append(("GHL_ADVISORY", "-",
                             f"agency has {len(locs)} locations; {len(matched)} roster clients "
                             f"strong-match a GHL location, {len(unmatched)} have no obvious match "
                             f"(informational — not every fleet client uses GHL)"))

    if not wired:
        warnings.append(("GHL_NO_WIRED_LOCATIONS", "-",
                         "no fleet-wired GHL location IDs found in roster/secrets — "
                         "nothing to fail-closed on (leg ran, found nothing to check)"))
    return problems, warnings, True, None


# ---------------------------------------------------------------- reconcile ---
def cf_token_map_reconcile(boxes, cf_token_map_path):
    """Structural tripwire for the class of bug that let Eddie Otts and E.R.
    Spaulding fall through to a hand-maintained `case "$client" in ...) _tk=...`
    switch (missing case -> silently borrowed Teresa Pelham's CF Access
    credential -> reported DOWN while healthy).

    Every roster box with kind == "mac" MUST have an entry in the single-source
    CF-token map (accounts/cf-token-map.json), keyed by that box's exact
    probe_match (tunnel hostname) -- the one identifier proven identical across
    fleet-roster.json and probe-fleet.sh's ROSTER array. A roster mac box with
    no entry there is EXACTLY the Eddie Otts incident waiting to happen again;
    it is a HARD problem, not a warning.

    Returns (problems, warnings).
    """
    problems, warnings = [], []

    if not os.path.isfile(cf_token_map_path):
        problems.append(("CF_TOKEN_MAP_MISSING", cf_token_map_path,
                         "single-source CF Access token map absent -- every mac-tunnel "
                         "client would fail-closed as cf_token_unmapped"))
        return problems, warnings

    try:
        with open(cf_token_map_path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        problems.append(("CF_TOKEN_MAP_UNREADABLE", cf_token_map_path, str(e)[:160]))
        return problems, warnings

    tokens = raw.get("tokens") if isinstance(raw, dict) else None
    if not isinstance(tokens, dict):
        problems.append(("CF_TOKEN_MAP_MALFORMED", cf_token_map_path,
                         "expected a top-level {\"tokens\": {...}} object"))
        return problems, warnings

    mac_boxes = {box_id: meta for box_id, meta in boxes.items() if meta.get("kind") == "mac"}

    for box_id, meta in mac_boxes.items():
        client = meta.get("client", box_id)
        pm = meta.get("probe_match")
        if not pm:
            problems.append(("MAC_BOX_NO_PROBE_MATCH", box_id,
                             f"{client} — kind=mac but no probe_match set; cannot be "
                             f"looked up in the CF-token map either"))
            continue
        tok = tokens.get(pm)
        if not tok:
            problems.append(("MISSING_CF_TOKEN_MAPPING", box_id,
                             f"{client} — '{pm}' has no entry in "
                             f"{os.path.basename(cf_token_map_path)}; probe-fleet.sh will "
                             f"fail-closed (DOWN, cf_token_unmapped) for this client, "
                             f"exactly the Eddie Otts incident"))

    # Reverse direction (advisory only): a map entry with no matching roster mac
    # box is stale, not dangerous -- warn, never fail.
    live_probe_matches = {m.get("probe_match") for m in mac_boxes.values() if m.get("probe_match")}
    for pm_key, tok in tokens.items():
        if pm_key not in live_probe_matches:
            warnings.append(("CF_TOKEN_MAP_STALE_ENTRY", pm_key,
                             f"token '{tok}' mapped for '{pm_key}' but no roster mac box has "
                             f"this probe_match — decommissioned client? clean it up"))

    return problems, warnings


def reconcile(boxes, check_contabo, check_cloudflare=False, check_ghl=False,
              ghl_advisory=False, cf_token_map=DEFAULT_CF_TOKEN_MAP):
    problems = []
    warnings = []
    skipped = []  # (leg, reason) for creds-absent / API-unreachable universe legs

    # 1) box-registry.json (prover / prove-floor source)
    reg_keys = set()
    if os.path.isfile(BOX_REGISTRY):
        with open(BOX_REGISTRY, encoding="utf-8") as f:
            reg = json.load(f)
        reg_keys = set(reg.get("boxes", {}).keys())
    else:
        problems.append(("REGISTRY_FILE_MISSING", BOX_REGISTRY, "prover source absent"))

    # 2) probe-fleet.sh ROSTER text (heartbeat / version-roll / CC-push source)
    probe_text = ""
    if os.path.isfile(PROBE_FLEET):
        with open(PROBE_FLEET, encoding="utf-8") as f:
            probe_text = f.read()
        # The heartbeat reads probe-fleet.sh via its bash shebang. If the script
        # has a parse error it emits NOTHING and the heartbeat silently covers
        # EVERY box (this happened 2026-06-18..29: an unquoted space in a case
        # pattern broke parsing for ~11 days, undetected). A roster-reader that
        # cannot run is the worst silent skip — flag it here.
        syn = subprocess.run(["bash", "-n", PROBE_FLEET],
                             capture_output=True, text=True)
        if syn.returncode != 0:
            problems.append(("HEARTBEAT_SCRIPT_BROKEN", PROBE_FLEET,
                             "probe-fleet.sh FAILS `bash -n` — it emits no rows and the "
                             "heartbeat covers nobody: " + (syn.stderr.strip().splitlines() or [""])[0][:120]))
    else:
        problems.append(("HEARTBEAT_FILE_MISSING", PROBE_FLEET, "heartbeat source absent"))

    for box_id, meta in boxes.items():
        client = meta.get("client", box_id)
        provider = meta.get("provider", "?")
        kind = meta.get("kind", "?")

        rid = meta.get("registry_id", box_id)
        if reg_keys and rid not in reg_keys:
            problems.append(("MISSING_FROM_REGISTRY", box_id,
                             f"{client} ({provider}) — registry_id '{rid}' not a key in box-registry.json"))

        if kind == "local":
            continue  # operator/control-plane box is not heartbeat-probed
        pm = meta.get("probe_match")
        if probe_text and pm and pm not in probe_text:
            problems.append(("MISSING_FROM_HEARTBEAT", box_id,
                             f"{client} ({provider}) — '{pm}' not in probe-fleet.sh ROSTER"))

    # 2b) CF Access token mapping (accounts/cf-token-map.json) — every roster
    #     mac-tunnel box must resolve to a token or probe-fleet.sh fail-closes
    #     it as DOWN. This is the structural fix for the Eddie Otts / E.R.
    #     Spaulding incident: a client present in the roster+heartbeat ROSTER
    #     but absent from the (formerly hand-maintained, formerly duplicated)
    #     token switch. Always runs — cheap, local, no network/creds needed.
    p, w = cf_token_map_reconcile(boxes, cf_token_map)
    problems += p
    warnings += w

    # 3) LIVE Contabo enumeration — catches a container provisioned on the host
    #    but never added to the roster (the exact Beverly Grandison failure).
    if check_contabo:
        contabo_aliases = set()
        for box_id, meta in boxes.items():
            if meta.get("provider") == "contabo":
                contabo_aliases |= alias_set(box_id, meta)
        try:
            out = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                 "contabo-host", "docker ps --format '{{.Names}}'"],
                capture_output=True, text=True, timeout=45)
            if out.returncode != 0:
                problems.append(("CONTABO_UNREACHABLE", "contabo-host",
                                 (out.stderr or out.stdout).strip()[:120]
                                 or "ssh failed — cannot verify live Contabo set"))
            else:
                live = [n.strip() for n in out.stdout.splitlines()
                        if n.strip().startswith("oc-")]
                for name in live:
                    if name.lower() not in contabo_aliases:
                        problems.append(("CONTABO_LIVE_NOT_IN_ROSTER", name,
                                         "live oc-* container on contabo-host is NOT in fleet-roster.json — add it"))
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            problems.append(("CONTABO_PROBE_ERROR", "contabo-host", str(e)[:120]))

    # 4) LIVE client-universe reconcile — the roster vs the ACTUAL infrastructure
    #    that exists (Cloudflare tunnels + GHL locations). Catches a client with
    #    real infra but NO roster entry (the founding "overlook" — e.g. Beverly
    #    Grandison). These legs are robust: if creds are absent or the API is
    #    unreachable they WARN-and-skip (never crash, never false-fail); the local
    #    reconcile above always runs regardless.
    if check_cloudflare or check_ghl:
        secrets = load_secrets()
        ignore = load_ignore()
        if check_cloudflare:
            p, w, ran, reason = cloudflare_reconcile(boxes, secrets, ignore)
            problems += p
            warnings += w
            if not ran:
                skipped.append(("cloudflare", reason))
        if check_ghl:
            p, w, ran, reason = ghl_reconcile(boxes, secrets, ignore, advisory=ghl_advisory)
            problems += p
            warnings += w
            if not ran:
                skipped.append(("ghl", reason))

    # report
    counts = {}
    for prov in ("hostinger", "contabo", "mac", "operator"):
        counts[prov] = sum(1 for m in boxes.values() if m.get("provider") == prov)
    legs = ["local", "cf-token-map"]
    if check_contabo:
        legs.append("contabo")
    if check_cloudflare:
        legs.append("cloudflare")
    if check_ghl:
        legs.append("ghl+advisory" if ghl_advisory else "ghl")
    print(f"=== fleet-coverage-gate RECONCILE — canonical roster: {len(boxes)} boxes "
          f"(hostinger={counts['hostinger']} contabo={counts['contabo']} "
          f"mac={counts['mac']} operator={counts['operator']}) | legs: {'+'.join(legs)} ===")

    for leg, reason in skipped:
        print(f"  [SKIP:{leg}] {reason}")
    if warnings:
        print(f"  {len(warnings)} warning(s) (non-fatal):")
        for kind_, box, detail in warnings:
            print(f"    [WARN {kind_}] {box}: {detail}")

    if not problems:
        extras = []
        if check_contabo:
            extras.append("live Contabo host")
        if check_cloudflare:
            extras.append("live Cloudflare tunnels")
        if check_ghl:
            extras.append("fleet-wired GHL locations")
        tail = (" Also reconciled: " + ", ".join(extras) + "." if extras else "")
        print("RESULT: PASS — canonical roster, box-registry.json and probe-fleet.sh "
              "ROSTER are in sync." + tail)
        return 0

    print(f"RESULT: FAIL — {len(problems)} reconciliation problem(s):")
    for kind_, box, detail in problems:
        print(f"  [{kind_}] {box}: {detail}")
    print("\nThe sources are OUT OF SYNC. Fix before running any fleet op: a box "
          "missing from a source (or a client with live infra but no roster entry) "
          "WILL be silently skipped by ops that read it.")
    return 1


# ----------------------------------------------------------------- coverage ---
def parse_touched(path):
    if path == "-":
        lines = sys.stdin.read().splitlines()
    else:
        if not os.path.isfile(path):
            die(f"touched-set file not found: {path}")
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    touched = {}  # token(lower) -> (status, reason)
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"\s+", line, maxsplit=2)
        ident = parts[0]
        status = parts[1].upper() if len(parts) > 1 else "OK"
        reason = parts[2] if len(parts) > 2 else ""
        touched[ident.lower()] = (status, reason)
    return touched


def coverage(boxes, touched_path, include_local):
    touched = parse_touched(touched_path)
    uncovered = []
    bad_status = []
    accounted = 0

    for box_id, meta in boxes.items():
        if meta.get("kind") == "local" and not include_local:
            continue
        aliases = alias_set(box_id, meta)
        hit = next((touched[a] for a in aliases if a in touched), None)
        client = meta.get("client", box_id)
        provider = meta.get("provider", "?")
        if hit is None:
            uncovered.append((box_id, client, provider))
            continue
        accounted += 1
        status, reason = hit
        if status in REASON_REQUIRED_STATUSES and not reason.strip():
            bad_status.append((box_id, client, status))

    total = sum(1 for m in boxes.values()
                if include_local or m.get("kind") != "local")
    print(f"=== fleet-coverage-gate COVERAGE — {accounted}/{total} roster boxes accounted for ===")

    if not uncovered and not bad_status:
        print("RESULT: PASS — every roster box was touched or explicitly recorded.")
        return 0

    if uncovered:
        print(f"RESULT: FAIL — {len(uncovered)} roster box(es) NOT COVERED by this operation:")
        for box_id, client, provider in uncovered:
            print(f"  NOT COVERED: {client} ({provider}) [{box_id}] — absent from touched-set")
    if bad_status:
        print(f"  {len(bad_status)} box(es) recorded DOWN/SKIPPED WITHOUT a reason (reason required):")
        for box_id, client, status in bad_status:
            print(f"    {client} [{box_id}] status={status} — add a reason")
    print("\nThe operation is NOT complete. Reach each uncovered box, or record it "
          "in the touched-set as DOWN/SKIPPED with a reason, then re-run the gate.")
    return 1


def main(argv):
    ap = argparse.ArgumentParser(description="Fleet coverage enforcement gate.")
    ap.add_argument("--roster", default=DEFAULT_ROSTER,
                    help="canonical roster JSON (default: accounts/fleet-roster.json)")
    ap.add_argument("--cf-token-map", default=DEFAULT_CF_TOKEN_MAP,
                    help="single-source CF Access token map (default: accounts/cf-token-map.json); "
                         "every roster mac-kind box must have an entry here or reconcile FAILS")
    ap.add_argument("--reconcile", action="store_true",
                    help="reconcile the roster against its machine copies (default mode)")
    ap.add_argument("--check-contabo", action="store_true",
                    help="also enumerate the live Contabo host and flag any oc-* not in the roster")
    ap.add_argument("--check-cloudflare", action="store_true",
                    help="also enumerate LIVE Cloudflare tunnels; fail on any active fleet-box "
                         "(rescue-*) tunnel with no roster entry (needs CLOUDFLARE_API_TOKEN + "
                         "CLOUDFLARE_ACCOUNT_ID; WARN-skips if absent/unreachable)")
    ap.add_argument("--check-ghl", action="store_true",
                    help="also reconcile fleet-WIRED GHL locations; fail on any wired location "
                         "that maps to no rostered client (needs GHL_AGENCY_PIT + GHL_COMPANY_ID; "
                         "WARN-skips if absent/unreachable)")
    ap.add_argument("--ghl-advisory", action="store_true",
                    help="with --check-ghl: also enumerate the whole agency and report which "
                         "roster clients have/lack a same-named GHL location (advisory, never fails)")
    ap.add_argument("--check-universe", action="store_true",
                    help="shorthand for --check-contabo --check-cloudflare --check-ghl")
    ap.add_argument("--touched", metavar="FILE",
                    help="coverage mode: file (or - for stdin) of box-ids the op touched")
    ap.add_argument("--include-local", action="store_true",
                    help="coverage mode: also require the operator/local box")
    args = ap.parse_args(argv)

    boxes = load_roster(args.roster)

    if args.touched:
        return coverage(boxes, args.touched, args.include_local)

    check_contabo = args.check_contabo or args.check_universe
    check_cloudflare = args.check_cloudflare or args.check_universe
    check_ghl = args.check_ghl or args.check_universe
    return reconcile(boxes, check_contabo, check_cloudflare, check_ghl, args.ghl_advisory,
                      cf_token_map=args.cf_token_map)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
