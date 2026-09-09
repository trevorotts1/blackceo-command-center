#!/usr/bin/env python3
"""Send this installation's private weekly planner link; never print credentials."""
import argparse, json, os, pathlib, urllib.request, urllib.error

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--week', help='Monday date, YYYY-MM-DD; defaults to current local week')
    parser.add_argument('--renew', action='store_true', help='Send a fresh link to the same unfinished draft')
    args = parser.parse_args()
    app = pathlib.Path(__file__).resolve().parent.parent
    settings = {}
    for name in ['.env', '.env.local']:
        path = app / name
        if path.exists():
            for line in path.read_text().splitlines():
                key, sep, value = line.strip().removeprefix('export ').partition('=')
                if sep and not key.startswith('#'):
                    settings[key.strip()] = value.strip().strip('\"').strip("'")
    token = os.environ.get('MC_API_TOKEN') or settings.get('MC_API_TOKEN')
    if not token:
        print(json.dumps({'ok': False, 'error': 'local_operator_credentials_missing'})); return 1
    body = {'renew': args.renew}
    if args.week: body['week_start_local'] = args.week
    req = urllib.request.Request('http://127.0.0.1:4000/api/social-theme/send-link', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=90) as response: result = json.load(response)
    except urllib.error.HTTPError as error:
        try: result = json.load(error)
        except Exception: result = {'ok': False, 'error': 'social_link_request_failed'}
    except Exception:
        result = {'ok': False, 'error': 'social_link_delivery_unconfirmed'}
    print(json.dumps(result))
    return 0 if result.get('ok') else 1
if __name__ == '__main__': raise SystemExit(main())
