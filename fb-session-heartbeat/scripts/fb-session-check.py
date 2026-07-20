#!/usr/bin/env python3
# =============================================================================
# FB-SESSION HEARTBEAT -- recurring authenticated-read check of Trevor's saved
# Facebook sessions in THREE browsers on the operator box:
#   1. openclaw-browser  (OpenClaw gateway browser, profile "openclaw", CDP 18800)
#   2. agent-browser     (Vercel agent-browser daemon, live temp Chrome profile)
#   3. playwright        (Playwright MCP persistent Chrome profile in
#                         ~/Library/Caches/ms-playwright-mcp/mcp-chrome-*)
#
# WHY THIS SIGNAL: Facebook serves a perfectly fine-looking page to a
# logged-out session, so "page loaded" or "no login form" is worthless. This
# check performs an AUTHENTICATED READ: it navigates to
# https://www.facebook.com/me inside each browser's own session context.
#   - A LIVE session redirects to the real profile and the page embeds
#     CurrentUserInitialData with "ACCOUNT_ID":"<nonzero>".
#   - A DEAD/absent session redirects to /login/ and embeds "ACCOUNT_ID":"0".
# Only a valid logged-in session can produce a nonzero ACCOUNT_ID. The
# discrimination of this signal is PROVEN by the --negative-test mode, which
# runs the identical probe in a fresh cookie-less profile and must report DEAD.
#
# AGNES: per Trevor's direction the check uses his Agnes API
# (agnes/agnes-2.0-flash via `openclaw infer model run`). Agnes receives the
# probe evidence (final URL, title, ACCOUNT_ID state, visible-text snippet --
# NEVER cookies or credentials) and issues an independent LIVE/DEAD judgment.
# Deterministic signal and Agnes must AGREE for a session to count as LIVE;
# disagreement is alerted as SUSPECT (fail-safe). If the Agnes call itself
# fails, the deterministic verdict still governs and an agnes_error alert is
# raised (deduped) so the degradation is never silent.
#
# ALERTING: routes through scripts/alert-dedup.py (adapted from the podcast
# engine's Guardrail-7 dedup -- 6h dedup window, storm cap, recovery messages),
# which itself sends ONLY via `openclaw message send` (the gateway). Target:
# operator DM via $OPERATOR_TELEGRAM_CHAT_ID. Never client-facing.
#
# HARD RULES HONORED:
#   * No cookie/credential/session value is ever read, printed, or logged.
#   * No automated Facebook login is ever attempted. Read-only navigation.
#   * Every subprocess has a hard timeout; no unbounded waits.
#   * Every run appends to logs/runs.jsonl and rewrites state/last-run.json
#     with a generated_at timestamp -- consumers must treat age > 40 min as
#     stale; scripts/freshness-guard.sh enforces that with an alert.
# =============================================================================
import fcntl
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = "/Users/blackceomacmini/clawd/fb-session-heartbeat"
SCRIPTS = os.path.join(ROOT, "scripts")
LOGS = os.path.join(ROOT, "logs")
STATE = os.path.join(ROOT, "state")
ALERT_STATE = os.path.join(STATE, "alerts")

OPENCLAW = "/Users/blackceomacmini/.local/bin/openclaw"
AGENT_BROWSER = "/Users/blackceomacmini/.npm-global/bin/agent-browser"
NODE = "/usr/local/bin/node"
PY = sys.executable or "/opt/homebrew/bin/python3"

CHECK_URL = "https://www.facebook.com/me"
PW_PROFILE_GLOB = (
    "/Users/blackceomacmini/Library/Caches/ms-playwright-mcp/mcp-chrome-*"
)
AGNES_MODEL = "agnes/agnes-2.0-flash"
CLIENT = "operator"

# Page probe: same JS everywhere. Returns a JSON string. Reads ONLY public page
# state (URL, title, embedded ACCOUNT_ID marker, visible text) -- never cookies.
PROBE_JS = (
    "() => JSON.stringify({"
    "u: location.href,"
    "t: document.title,"
    "a: (document.documentElement.innerHTML.match(/\"ACCOUNT_ID\":\"(\\d+)\"/)||[])[1] || 'absent',"
    "x: ((document.body && document.body.innerText) || '').replace(/\\s+/g,' ').slice(0,300)"
    "})"
)


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def log(msg):
    line = "[%s] %s" % (now_iso(), msg)
    print(line, flush=True)
    with open(os.path.join(LOGS, "heartbeat.log"), "a") as f:
        f.write(line + "\n")


def run_cmd(argv, timeout, env=None):
    """Bounded subprocess. Returns (rc, stdout, stderr); rc=124 on timeout."""
    try:
        p = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout, env=env
        )
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", "timeout after %ss" % timeout
    except FileNotFoundError as e:
        return 127, "", str(e)


def parse_probe(raw):
    """Extract the probe JSON object from noisy CLI output."""
    # openclaw evaluate prints the value JSON-quoted; agent-browser prints raw.
    for line in reversed([l.strip() for l in raw.splitlines() if l.strip()]):
        if line.startswith('"') and line.endswith('"'):
            try:
                inner = json.loads(line)
                return json.loads(inner)
            except (ValueError, TypeError):
                continue
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def det_verdict(probe):
    """Deterministic verdict from the authenticated-read evidence."""
    if not probe:
        return "ERROR", "no probe data"
    # Login-flow URLs can carry multi-KB opaque params; keep reasons (and the
    # Telegram alerts built from them) readable and under message size limits.
    url = probe.get("u", "")
    if len(url) > 120:
        url = url[:120] + "...(truncated)"
    acct = str(probe.get("a", "absent"))
    if "/login" in url or "login.php" in url or acct == "0":
        return "DEAD", "login redirect or ACCOUNT_ID=0 (url=%s, account_id=%s)" % (
            url, "zero" if acct == "0" else acct if acct == "absent" else "nonzero")
    if acct.isdigit() and acct != "0":
        return "LIVE", "ACCOUNT_ID nonzero on %s" % url
    return "ERROR", "indeterminate (url=%s, account_id=%s)" % (url, acct)


# ---------------------------------------------------------------------------
# leg 1: OpenClaw gateway browser
# ---------------------------------------------------------------------------
def check_openclaw():
    rc, out, err = run_cmd([OPENCLAW, "browser", "start"], 60)
    if rc != 0:
        return None, "openclaw browser start rc=%d %s" % (rc, err.strip()[-200:])
    rc, out, err = run_cmd([OPENCLAW, "browser", "open", CHECK_URL], 60)
    if rc != 0:
        return None, "openclaw browser open rc=%d %s" % (rc, err.strip()[-200:])
    m = re.search(r"tab:\s*(\S+)", out)
    tab = m.group(1) if m else None
    probe = None
    try:
        for attempt in (1, 2):
            time.sleep(5)
            rc, out, err = run_cmd(
                [OPENCLAW, "browser", "evaluate", "--fn", PROBE_JS], 45)
            probe = parse_probe(out)
            if probe and probe.get("u") not in (None, "", "about:blank"):
                break
    finally:
        if tab:
            run_cmd([OPENCLAW, "browser", "close", tab], 30)
    if probe is None:
        return None, "probe unparsable (rc=%d)" % rc
    return probe, None


# ---------------------------------------------------------------------------
# leg 2: Vercel agent-browser daemon
# ---------------------------------------------------------------------------
def check_agent_browser():
    rc, out, err = run_cmd([AGENT_BROWSER, "get", "url"], 30)
    if rc != 0:
        return None, "agent-browser daemon unreachable rc=%d %s" % (
            rc, (err or out).strip()[-200:])
    rc, out, err = run_cmd([AGENT_BROWSER, "tab", "new"], 30)
    if rc != 0:
        return None, "tab new failed rc=%d %s" % (rc, (err or out).strip()[-200:])
    probe = None
    try:
        rc, out, err = run_cmd([AGENT_BROWSER, "open", CHECK_URL], 60)
        for attempt in (1, 2):
            time.sleep(5)
            rc, out, err = run_cmd([AGENT_BROWSER, "eval", PROBE_JS[6:]], 45)
            # PROBE_JS is "() => JSON.stringify(...)"; agent-browser eval wants
            # a bare expression, so strip the arrow prefix.
            probe = parse_probe(out)
            if probe and probe.get("u") not in (None, "", "about:blank"):
                break
    finally:
        run_cmd([AGENT_BROWSER, "tab", "close"], 30)
    if probe is None:
        return None, "probe unparsable (rc=%d)" % rc
    return probe, None


# ---------------------------------------------------------------------------
# leg 3: Playwright MCP persistent profile (clone + headless authenticated read)
# ---------------------------------------------------------------------------
def newest_pw_profile():
    candidates = sorted(
        glob.glob(PW_PROFILE_GLOB),
        key=lambda p: os.path.getmtime(p),
        reverse=True,
    )
    return candidates[0] if candidates else None


def check_playwright(fresh=False):
    argv = [NODE, os.path.join(SCRIPTS, "playwright-leg.mjs"), "--url", CHECK_URL]
    if fresh:
        argv.append("--fresh")
    else:
        prof = newest_pw_profile()
        if not prof:
            return None, "no ms-playwright-mcp profile found"
        argv += ["--profile", prof]
    rc, out, err = run_cmd(argv, 150)
    for line in out.splitlines():
        if line.startswith("RESULT:"):
            try:
                return json.loads(line[len("RESULT:"):]), None
            except ValueError:
                pass
    return None, "playwright leg rc=%d %s" % (rc, (err or out).strip()[-300:])


# ---------------------------------------------------------------------------
# Agnes judgment (one call for all legs; evidence only, never secrets)
# ---------------------------------------------------------------------------
def agnes_judge(evidence):
    # Keep the prompt small: cap text snippets at 200 chars per leg.
    evidence = {
        k: ({**v, "x": v.get("x", "")[:200]} if isinstance(v, dict) else v)
        for k, v in evidence.items()
    }
    prompt = (
        "You are a Facebook session health judge. For each browser below, an "
        "automated probe navigated to https://www.facebook.com/me inside that "
        "browser's saved session. A LIVE authenticated session redirects to the "
        "user's real profile and embeds a nonzero ACCOUNT_ID. A DEAD/logged-out "
        "session redirects to a login page and/or embeds ACCOUNT_ID 0. Facebook "
        "may serve a normal-looking page to a dead session, so judge by the "
        "evidence, not by whether the page loaded.\n\n"
        "Evidence (JSON): %s\n\n"
        "Reply with STRICT JSON only, no prose, of the form "
        '{"<browser>": {"verdict": "LIVE"|"DEAD", "reason": "<short>"}, ...} '
        "with one entry per browser key given in the evidence."
        % json.dumps(evidence)
    )
    # --gateway: the always-on Gateway answers in ~12s; --local re-runs doctor
    # checks on every invocation and was measured blowing a 90s budget.
    rc, out, err = run_cmd(
        [OPENCLAW, "infer", "model", "run", "--model", AGNES_MODEL,
         "--gateway", "--json", "--prompt", prompt],
        120,
    )
    if rc != 0:
        return None, "agnes rc=%d %s" % (rc, (err or out).strip()[-200:])
    text = None
    try:
        doc = json.loads(out)

        def find_text(o):
            if isinstance(o, dict):
                if isinstance(o.get("text"), str):
                    return o["text"]
                for v in o.values():
                    r = find_text(v)
                    if r:
                        return r
            elif isinstance(o, list):
                for v in o:
                    r = find_text(v)
                    if r:
                        return r
            return None

        text = find_text(doc)
    except ValueError:
        text = out
    if not text:
        return None, "agnes returned no text"
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None, "agnes reply not JSON: %s" % text[:200]
    try:
        return json.loads(m.group(0)), None
    except ValueError:
        return None, "agnes JSON unparsable: %s" % text[:200]


# ---------------------------------------------------------------------------
# alerting through the dedup guardrail (gateway-only egress)
# ---------------------------------------------------------------------------
def alert(action, service, failure_class=None, message=None):
    argv = [PY, os.path.join(SCRIPTS, "alert-dedup.py"), action,
            "--state-dir", ALERT_STATE, "--client", CLIENT,
            "--service", service]
    if failure_class:
        argv += ["--failure-class", failure_class]
    if message:
        argv += ["--message", message]
    rc, out, err = run_cmd(argv, 90)
    decision = None
    for line in (out or "").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                decision = json.loads(line)
            except ValueError:
                pass
    log("alert %s service=%s class=%s rc=%d decision=%s" % (
        action, service, failure_class, rc,
        json.dumps(decision) if decision else (err or out).strip()[-150:]))
    return decision


# ---------------------------------------------------------------------------
def negative_test():
    """Mandatory discrimination proof: identical probe, cookie-less profile.
    Must come back DEAD. Exit 0 iff it does."""
    log("NEGATIVE TEST: probing %s in a fresh cookie-less profile" % CHECK_URL)
    probe, perr = check_playwright(fresh=True)
    det, dreason = det_verdict(probe)
    log("NEGATIVE TEST deterministic verdict=%s (%s)" % (det, dreason))
    agnes, aerr = agnes_judge({"fresh-cookieless-profile": probe or {"error": perr}})
    averdict = None
    if agnes:
        entry = agnes.get("fresh-cookieless-profile") or next(iter(agnes.values()), {})
        averdict = entry.get("verdict")
        log("NEGATIVE TEST Agnes verdict=%s (%s)" % (
            averdict, entry.get("reason", "")))
    else:
        log("NEGATIVE TEST Agnes error: %s" % aerr)
    ok = det == "DEAD" and (averdict in (None, "DEAD"))
    print("NEGATIVE-TEST-%s det=%s agnes=%s" % (
        "PASS" if ok else "FAIL", det, averdict))
    return 0 if ok else 1


def main():
    # Self-contained alert target: a manual run without run.sh's exports must
    # still deliver (first run fail-closed on NO_FOUNDER without this).
    os.environ.setdefault("OPERATOR_TELEGRAM_CHAT_ID", "5252140759")

    if "--negative-test" in sys.argv:
        return negative_test()

    os.makedirs(LOGS, exist_ok=True)
    os.makedirs(STATE, exist_ok=True)
    os.makedirs(ALERT_STATE, exist_ok=True)

    lock_f = open(os.path.join(STATE, ".lock"), "w")
    try:
        fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another run holds the lock; exiting")
        return 0

    started = now_iso()
    t0 = time.time()
    legs = {}
    evidence = {}

    for name, fn in (
        ("openclaw-browser", check_openclaw),
        ("agent-browser", check_agent_browser),
        ("playwright", check_playwright),
    ):
        leg_t0 = time.time()
        probe, perr = fn()
        det, dreason = det_verdict(probe) if perr is None else ("ERROR", perr)
        legs[name] = {
            "probe": probe, "probe_error": perr,
            "det": det, "det_reason": dreason,
            "ms": int((time.time() - leg_t0) * 1000),
        }
        evidence[name] = probe if probe else {"error": perr}
        log("leg %s det=%s (%s) %dms" % (name, det, dreason, legs[name]["ms"]))

    agnes, aerr = agnes_judge(evidence)
    if agnes is None:
        log("Agnes judgment FAILED: %s (deterministic verdicts govern)" % aerr)
        alert("raise", "heartbeat", "agnes_error",
              "Agnes (agnes/agnes-2.0-flash) judgment call failed in the "
              "fb-session heartbeat: %s. Deterministic checks still ran." % aerr)
    else:
        alert("recover", "heartbeat", "agnes_error")

    statuses = {}
    for name, leg in legs.items():
        a = (agnes or {}).get(name, {}) if agnes else {}
        averdict = a.get("verdict")
        areason = a.get("reason", "")
        det = leg["det"]
        if det == "LIVE" and averdict in ("LIVE", None):
            status = "LIVE"
        elif det == "LIVE" and averdict == "DEAD":
            status = "SUSPECT"
        elif det == "DEAD":
            status = "DEAD"
        else:
            status = "CHECK_ERROR"
        statuses[name] = {"status": status, "det": det,
                          "det_reason": leg["det_reason"],
                          "agnes": averdict, "agnes_reason": areason}
        log("leg %s FINAL=%s (det=%s agnes=%s)" % (name, status, det, averdict))

        checked_at = now_iso()
        if status == "DEAD":
            alert("raise", name, "session_dead",
                  "Facebook session DEAD in %s. Evidence: %s. Agnes: %s. "
                  "Log in again by hand in that browser. Checked %s."
                  % (name, leg["det_reason"], areason or "n/a", checked_at))
        elif status == "SUSPECT":
            alert("raise", name, "session_suspect",
                  "Facebook session SUSPECT in %s: deterministic check says "
                  "LIVE but Agnes judged DEAD (%s). Evidence: %s. Checked %s."
                  % (name, areason, leg["det_reason"], checked_at))
        elif status == "CHECK_ERROR":
            alert("raise", name, "check_error",
                  "fb-session heartbeat could NOT verify the %s Facebook "
                  "session: %s. The session may be fine; the CHECK failed. "
                  "Checked %s." % (name, leg["det_reason"], checked_at))
        else:  # LIVE -> clear any active alerts for this browser (noop if none)
            alert("recover", name, None,
                  "Facebook session in %s verified LIVE again." % name)

    record = {
        "generated_at": now_iso(),
        "started_at": started,
        "duration_ms": int((time.time() - t0) * 1000),
        "check_url": CHECK_URL,
        "agnes_model": AGNES_MODEL,
        "agnes_ok": agnes is not None,
        "legs": {n: {k: v for k, v in s.items()} for n, s in statuses.items()},
    }
    with open(os.path.join(STATE, "last-run.json"), "w") as f:
        json.dump(record, f, indent=2)
    with open(os.path.join(LOGS, "runs.jsonl"), "a") as f:
        f.write(json.dumps(record) + "\n")
    log("run complete in %dms: %s" % (
        record["duration_ms"],
        ", ".join("%s=%s" % (n, s["status"]) for n, s in statuses.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
