#!/usr/bin/env python3
"""pm2's app list as JSON, whatever else the pm2 CLI printed around it.

A pm2 CLI newer or older than the running daemon prints a banner on STDOUT
before the list (">>>> In-memory PM2 is out-of-date, do: >>>> $ pm2 update"),
and "[PM2] ..." lines can appear too. Every caller that ran json.loads on the
whole output read that as "no apps": the health check then failed with "no pm2
app for target" and atomic-deploy rolled back a healthy Command Center.

As a module: load(raw) -> list, version_mismatch(raw) -> bool.
As a filter:  <pm2 app list output> | python3 pm2_json.py   prints the clean
list (or [] when there is none) and, on a banner, a stderr diagnostic.
"""
import json
import sys

MISMATCH_BANNER = "In-memory PM2 is out-of-date"


def load(raw: str) -> list:
    """The first JSON array of objects in `raw`; [] for empty output."""
    if not (raw or "").strip():
        return []
    dec = json.JSONDecoder()
    i = raw.find("[")
    while i != -1:
        try:
            val, _ = dec.raw_decode(raw, i)
            if isinstance(val, list) and all(isinstance(x, dict) for x in val):
                return val
        except ValueError:
            pass
        i = raw.find("[", i + 1)
    raise ValueError("no pm2 app list in the pm2 output")


def version_mismatch(raw: str) -> bool:
    return MISMATCH_BANNER in (raw or "")


if __name__ == "__main__":
    raw = sys.stdin.read()
    if version_mismatch(raw):
        print("pm2 CLI/daemon version mismatch: the CLI printed 'In-memory PM2 is out-of-date'; "
              "the app list was read past the banner (run `pm2 update` in a maintenance window)",
              file=sys.stderr)
    try:
        print(json.dumps(load(raw)))
    except ValueError:
        print("[]")
        sys.exit(1)
