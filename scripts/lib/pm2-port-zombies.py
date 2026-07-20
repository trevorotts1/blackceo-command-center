#!/usr/bin/env python3
"""Port-aware pm2 helper for the Command Center deploy path.

Reads `pm2 jlist` JSON on stdin. Two modes:

1. ZOMBIE SELECTION (atomic-deploy.sh Phase 1d):

       pm2 jlist | python3 pm2-port-zombies.py CANONICAL_NAME PORT [LISTENER_PID...]

   Prints one pm2 app name per line that is FIGHTING FOR PORT and should be
   removed before an atomic deploy. An app is selected ONLY if BOTH:

     (a) its name differs from CANONICAL_NAME, AND
     (b) it is fighting for PORT — either
         - declared: its start args carry `--port PORT` / `--port=PORT`, or
           (when no --port arg exists) its pm2 env pins CC_PORT/PORT to PORT.
           Args take precedence over env: an app started with `--port 4600`
           is NOT a 4000-fighter even if a stale CC_PORT=4000 leaked into its
           pm2 env. Declared matching catches crashed/looping zombies that
           will grab the port on their next autorestart; or
         - bound: one of LISTENER_PID... (PIDs currently LISTENing on PORT,
           from `lsof -t`) is the app's pm2 pid or a descendant of it (pm2
           runs a launcher whose child binds the socket).

   Name keywords are deliberately NOT grounds for selection. The previous
   keyword match ('mission-control'/'command-center'/'blackceo') was
   port-blind and deleted RUNNING sibling apps that legitimately serve other
   ports (e.g. blackceo-cc-demo-* on :4600/:4601) — production-breaking.
   An app bound to / declared on a different port can NEVER be selected.

   Fail-safe: unparseable stdin selects NOTHING (exit 0, no output) — this
   tool must never cause a blind kill.

2. NAME RESOLUTION (update.sh Step 5):

       pm2 jlist | python3 pm2-port-zombies.py --resolve-name PORT DEFAULT_NAME

   Prints the name of the pm2 app that declares PORT (an `online` app wins
   over a stopped one; ties break by jlist order), or DEFAULT_NAME when no
   app declares it. This lets the updater target the app the box ACTUALLY
   runs (live state) instead of assuming the fleet-canonical name — the
   assumption that made the updater start a duplicate app fighting the live
   one for its port on boxes using a different name.

Test hook: the CC_ZOMBIE_PS_TABLE env var, when set, supplies the "pid ppid"
table (one pair per line) used for the descendant walk instead of shelling
out to `ps`, so unit tests are deterministic. Empty string = empty table.
"""

import json
import os
import subprocess
import sys


def declared_port(pm2_env):
    """Port this app is configured to serve.

    Start args are authoritative (`--port N` / `--port=N`); the pm2 env
    (CC_PORT, then PORT) is only consulted when the args carry no port at
    all — pm2 snapshots the shell env at start time, so an inherited
    CC_PORT can contradict the args and must not override them.
    Returns a string, or None when undeterminable.
    """
    args = pm2_env.get("args")
    if isinstance(args, list):
        tokens = [str(a) for a in args]
    elif isinstance(args, str):
        tokens = args.split()
    else:
        tokens = []
    for i, tok in enumerate(tokens):
        if tok == "--port" and i + 1 < len(tokens):
            return str(tokens[i + 1])
        if tok.startswith("--port="):
            return tok.split("=", 1)[1]
    env = pm2_env.get("env") or {}
    for key in ("CC_PORT", "PORT"):
        val = env.get(key)
        if val not in (None, ""):
            return str(val)
    return None


def load_ppid_map():
    """pid -> ppid map, from CC_ZOMBIE_PS_TABLE (tests) or `ps` (live)."""
    table = os.environ.get("CC_ZOMBIE_PS_TABLE")
    if table is None:
        try:
            table = subprocess.run(
                ["ps", "-axo", "pid=,ppid="],
                capture_output=True, text=True, timeout=10,
            ).stdout
        except Exception:
            table = ""
    ppid_map = {}
    for line in table.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            ppid_map[int(parts[0])] = int(parts[1])
    return ppid_map


def is_self_or_descendant(pid, ancestor, ppid_map):
    hops = 0
    while pid and pid > 1 and hops < 64:
        if pid == ancestor:
            return True
        pid = ppid_map.get(pid)
        hops += 1
    return False


def app_name(app):
    pm2_env = app.get("pm2_env") or {}
    return (pm2_env.get("name") or app.get("name") or "").strip()


def load_apps():
    try:
        apps = json.load(sys.stdin)
    except Exception:
        return []
    return apps if isinstance(apps, list) else []


def select_zombies(canonical, port, listener_pids):
    apps = load_apps()
    ppid_map = load_ppid_map() if listener_pids else {}
    for app in apps:
        pm2_env = app.get("pm2_env") or {}
        name = app_name(app)
        if not name or name == canonical:
            continue
        wants_port = declared_port(pm2_env) == port
        pid = app.get("pid") or 0
        holds_port = bool(pid) and any(
            is_self_or_descendant(lp, pid, ppid_map) for lp in listener_pids
        )
        if wants_port or holds_port:
            print(name)
    return 0


def resolve_name(port, default_name):
    best = None  # (offline_rank, jlist_index, name) — min() picks online-first
    for idx, app in enumerate(load_apps()):
        pm2_env = app.get("pm2_env") or {}
        name = app_name(app)
        if not name or declared_port(pm2_env) != port:
            continue
        rank = 0 if pm2_env.get("status") == "online" else 1
        candidate = (rank, idx, name)
        if best is None or candidate < best:
            best = candidate
    print(best[2] if best else default_name)
    return 0


def main():
    argv = sys.argv[1:]
    if len(argv) >= 3 and argv[0] == "--resolve-name":
        return resolve_name(str(argv[1]), argv[2])
    if len(argv) >= 2:
        canonical = argv[0]
        port = str(argv[1])
        listener_pids = [int(p) for p in argv[2:] if p.isdigit()]
        return select_zombies(canonical, port, listener_pids)
    print(
        "usage: pm2 jlist | pm2-port-zombies.py CANONICAL_NAME PORT [LISTENER_PID...]\n"
        "       pm2 jlist | pm2-port-zombies.py --resolve-name PORT DEFAULT_NAME",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
