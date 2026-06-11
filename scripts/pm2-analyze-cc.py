#!/usr/bin/env python3
"""
scripts/pm2-analyze-cc.py — CC-scoped pm2 topology analyser.

Reads pm2 jlist JSON from stdin, scopes to CC apps only, and emits a JSON
summary used by cc-health-check.sh.

Usage:
  pm2 jlist | python3 scripts/pm2-analyze-cc.py --port PORT [--canonical-dir DIR]

Output JSON keys:
  app_count       — number of CC apps found
  crash_loopers   — list of {name, reason} for errored/stopped CC apps
  db_path_set     — bool: any CC app has DATABASE_PATH in pm2 env
  cwd_ok          — bool: all CC apps have a non-null cwd matching canonical_dir
                    (when canonical_dir is set); False if any app has null/wrong cwd
  null_cwd_count  — number of CC apps with null/empty pm_cwd

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


def port_match(app: dict, port_str: str) -> bool:
    """Return True if the app is bound to port_str."""
    env = app.get('pm2_env') or {}
    if ev(env, 'PORT') == port_str:
        return True
    args = env.get('args') or ''
    if isinstance(args, list):
        args = ' '.join(str(x) for x in args)
    return bool(re.search(r'(?:--port|-p)\s+' + re.escape(port_str) + r'(?!\d)', str(args)))


def name_match(app: dict, port_str: str) -> bool:
    """Return True if the app name looks like a CC app and port doesn't conflict."""
    env = app.get('pm2_env') or {}
    name = (env.get('name') or app.get('name') or '').lower()
    if not any(kw in name for kw in ('mission-control', 'command-center', 'blackceo')):
        return False
    pe = ev(env, 'PORT')
    return not (pe and pe != port_str)


def get_cwd(app: dict) -> str:
    """Get pm_cwd from a pm2 app record."""
    env = app.get('pm2_env') or {}
    return env.get('pm_cwd') or env.get('cwd') or ''


def analyse(pm2_json: list, port_str: str, canon_dir: str) -> dict:
    """Analyse a pm2 jlist and return the cc-health topology summary."""
    apps = pm2_json or []
    cc = [a for a in apps if port_match(a, port_str) or name_match(a, port_str)]

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
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', default='4000')
    parser.add_argument('--canonical-dir', default='')
    args = parser.parse_args()

    try:
        raw = sys.stdin.read()
        pm2_list = json.loads(raw) if raw.strip() else []
        result = analyse(pm2_list, args.port, args.canonical_dir)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({
            'error': str(e),
            'app_count': 0,
            'crash_loopers': [],
            'db_path_set': False,
            'cwd_ok': False,
            'null_cwd_count': 0,
        }))


if __name__ == '__main__':
    main()
