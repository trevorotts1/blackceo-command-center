#!/usr/bin/env python3
"""
scripts/pm2-analyze-cc.py — CC-scoped pm2 topology analyser.

Reads pm2 jlist JSON from stdin, scopes to CC apps only, and emits a JSON
summary used by cc-health-check.sh.

Usage:
  pm2 jlist | python3 scripts/pm2-analyze-cc.py --port PORT [--canonical-dir DIR]
                                                [--app-name NAME]

TARGET SCOPING (Trap-4 fix):
  A box may legitimately run MORE THAN ONE Command-Center-ish pm2 app — e.g. a
  production instance on the deploy port plus demo/staging instances on other
  ports.  The deploy gate must verify THE TARGET APP (identified by its pm2 name
  and the port being deployed), not assert that it is the only CC-ish process on
  the machine.  An app is TARGET only when:
      (a) it declares the target port (PORT env or --port/-p in args), OR
      (b) its pm2 name equals --app-name AND it declares no port at all.
  Every other CC-ish app is reported under other_cc_apps for a WARN — it never
  contributes to app_count, crash_loopers, cwd_ok, or null_cwd_count, and so can
  never fail a deploy of a different app on a different port.

  A genuine duplicate (two apps claiming the SAME target port, or two apps
  carrying the target name with no declared port) still lands in the target set
  and still FAILs via app_count > 1.  This is a precision fix, not a weakening.

Output JSON keys:
  app_count       — number of TARGET apps found (0 = missing, >1 = real duplicate)
  crash_loopers   — list of {name, reason} for errored/stopped TARGET apps
  db_path_set     — bool: any TARGET app has DATABASE_PATH in pm2 env
  cwd_ok          — bool: all TARGET apps have a non-null cwd matching canonical_dir
                    (when canonical_dir is set); False if any app has null/wrong cwd
  null_cwd_count  — number of TARGET apps with null/empty pm_cwd
  other_cc_apps   — list of {name, port, status, reason} for CC-ish apps that are
                    NOT the target (other ports / other names). WARN-only: the
                    caller logs these and does NOT fail on them.
  other_cc_count  — len(other_cc_apps)
  target_app      — the --app-name this run scoped to
  target_port     — the --port this run scoped to

Exit codes:
  0 = topology OK (app_count >= 1, no crash-loopers, cwd_ok = True)
  1 = topology problem (exit code not used by cc-health-check.sh directly;
      caller reads the JSON and makes its own verdict)

Vitest tests in tests/unit/cc-probe-pm2.test.ts exercise this module directly
using pm2 jlist fixture JSON files from tests/fixtures/pm2-stubs/.
"""

import sys
import json
import os
import re
import argparse


def ev(env: dict, key: str) -> str:
    """Extract an env var from a pm2_env dict, checking env_data and env layers."""
    for layer in ('env_data', 'env'):
        e = env.get(layer) or {}
        if isinstance(e, dict):
            v = e.get(key) or e.get(key.lower())
            if v:
                return str(v)
    v = env.get(key) or env.get(key.lower())
    return str(v) if v else ''


def declared_port(app: dict) -> str:
    """Return the port this app DECLARES, or '' when it declares none.

    Two declaration sites, in precedence order:
      1. PORT in the pm2 env layers (env_data / env / flat)
      2. `--port N` / `-p N` in the pm2 args
    '' means "this app did not declare a port anywhere pm2 can see" — which is
    NOT the same as "this app is on the target port".  Treating those two as
    equivalent is the Trap-4 bug: a demo instance whose PORT comes from a .env
    file (invisible in `pm2 jlist`) was counted as a duplicate of production.
    """
    env = app.get('pm2_env') or {}
    pe = ev(env, 'PORT')
    if pe:
        return pe
    args = env.get('args') or ''
    if isinstance(args, list):
        args = ' '.join(str(x) for x in args)
    m = re.search(r'(?:--port|-p)\s+(\d+)', str(args))
    return m.group(1) if m else ''


def app_name_of(app: dict) -> str:
    """pm2 app name (pm2_env.name, falling back to the top-level name)."""
    env = app.get('pm2_env') or {}
    return str(env.get('name') or app.get('name') or '')


def port_match(app: dict, port_str: str) -> bool:
    """Return True if the app DECLARES the target port."""
    return declared_port(app) == port_str


def is_cc_ish(app: dict, target_name: str) -> bool:
    """Return True if this app is a Command-Center-family app at all.

    Candidate set only — being CC-ish does not make an app the deploy target.
    Matches the historic keyword list plus the caller's own --app-name, so a
    box that names its production app something outside the keyword list (e.g.
    a site-specific name) is still discoverable by name.
    """
    name = app_name_of(app).lower()
    if not name:
        return False
    if target_name and name == target_name.lower():
        return True
    return any(kw in name for kw in ('mission-control', 'command-center', 'blackceo'))


def is_target(app: dict, port_str: str, target_name: str) -> bool:
    """Return True if this app IS the app being deployed/gated.

    (a) declares the target port          → definitively the target
    (b) carries the target pm2 name AND declares no port at all → the target
        (pm2 simply cannot see its port; the name is the only evidence we have)
    Anything else that is merely CC-ish is a DIFFERENT instance.
    """
    dp = declared_port(app)
    if dp == port_str:
        return True
    return dp == '' and bool(target_name) and app_name_of(app).lower() == target_name.lower()


def get_cwd(app: dict) -> str:
    """Get pm_cwd from a pm2 app record."""
    env = app.get('pm2_env') or {}
    return env.get('pm_cwd') or env.get('cwd') or ''


def analyse(pm2_json: list, port_str: str, canon_dir: str,
            target_name: str = 'mission-control') -> dict:
    """Analyse a pm2 jlist and return the cc-health topology summary.

    Partitions CC-ish apps into the deploy TARGET (gating) and OTHER CC
    instances (WARN-only).  Every gating sub-check below is computed over the
    target set ONLY — otherwise a stopped demo instance or a demo instance
    running from another directory would fail an unrelated production deploy.
    """
    apps = pm2_json or []
    candidates = [a for a in apps if is_cc_ish(a, target_name) or port_match(a, port_str)]

    cc, others = [], []
    for a in candidates:
        (cc if is_target(a, port_str, target_name) else others).append(a)

    other_cc = []
    for a in others:
        env = a.get('pm2_env') or {}
        dp = declared_port(a)
        other_cc.append({
            'name': app_name_of(a) or 'unknown',
            'port': dp or 'undeclared',
            'status': env.get('status') or 'unknown',
            'reason': (
                f'declared port {dp} != target port {port_str}' if dp
                else f'no declared port and name != target app "{target_name}"'
            ),
        })

    crash = []
    for a in cc:
        env = a.get('pm2_env') or {}
        st = env.get('status') or ''
        if st in ('errored', 'stopped'):
            crash.append({'name': env.get('name') or 'unknown', 'reason': f'status={st}'})

    db_set = any(ev(a.get('pm2_env') or {}, 'DATABASE_PATH') for a in cc)
    null_c = [a for a in cc if not get_cwd(a)]

    if null_c:
        cwd_ok = False
    elif cc and canon_dir:
        cwd_ok = all(
            os.path.normpath(get_cwd(a)) == os.path.normpath(canon_dir)
            for a in cc
        )
    else:
        cwd_ok = bool(cc)

    return {
        'app_count': len(cc),
        'crash_loopers': crash,
        'db_path_set': db_set,
        'cwd_ok': cwd_ok,
        'null_cwd_count': len(null_c),
        'other_cc_apps': other_cc,
        'other_cc_count': len(other_cc),
        'target_app': target_name,
        'target_port': port_str,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', default='4000')
    parser.add_argument('--canonical-dir', default='')
    parser.add_argument('--app-name', default='mission-control',
                        help='pm2 name of the app being gated (the deploy target)')
    args = parser.parse_args()

    try:
        raw = sys.stdin.read()
        pm2_list = json.loads(raw) if raw.strip() else []
        result = analyse(pm2_list, args.port, args.canonical_dir, args.app_name)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({
            'error': str(e),
            'app_count': 0,
            'crash_loopers': [],
            'db_path_set': False,
            'cwd_ok': False,
            'null_cwd_count': 0,
            'other_cc_apps': [],
            'other_cc_count': 0,
            'target_app': args.app_name,
            'target_port': args.port,
        }))


if __name__ == '__main__':
    main()
