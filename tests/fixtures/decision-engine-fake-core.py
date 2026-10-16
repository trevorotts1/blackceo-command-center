#!/usr/bin/env python3
"""JEV-009 offline test double: fake decision-engine core.

Reads ONE DecisionRequest JSON object from stdin (evaluate) or answers a
version probe (capability). Prints canned JSON to stdout. No network, no
imports beyond stdlib. Test behaviour is driven by FAKE_* env knobs so a
single fixture script covers every incompatible case:

  FAKE_MODE=ok            echo request.configRevision back, compatible version
  FAKE_MODE=rev_mismatch  echo a WRONG configRevision back
  FAKE_MODE=no_revision   omit configRevision from the response
  FAKE_MODE=mutation     include a forbidden assigned_agent_id field
  FAKE_MODE=garbage      print non-JSON stdout, exit 0
  FAKE_MODE=slow         sleep FAKE_SLEEP_MS then behave like ok
  FAKE_VERSION=x.y.z     override the reported schemaVersion (probe + evaluate)
  FAKE_EXIT=n            exit nonzero with n before printing anything
  FAKE_SLEEP_MS=n        sleep n ms (used with --sleep-ms probe or slow mode)
"""
import json
import os
import sys
import time


def bridge_version():
    return os.environ.get("FAKE_VERSION", "1.1.0")


def main(argv):
    mode = os.environ.get("FAKE_MODE", "ok")
    if "--capability" in argv:
        sleep_ms = 0
        if "--sleep-ms" in argv:
            idx = argv.index("--sleep-ms")
            try:
                sleep_ms = int(argv[idx + 1])
            except (IndexError, ValueError):
                sleep_ms = 0
        if not sleep_ms:
            try:
                sleep_ms = int(os.environ.get("FAKE_SLEEP_MS", "0"))
            except ValueError:
                sleep_ms = 0
        if sleep_ms > 0:
            time.sleep(sleep_ms / 1000.0)
        try:
            code = int(os.environ.get("FAKE_EXIT", "0"))
        except ValueError:
            code = 0
        if code != 0:
            print("fake core refusing capability probe", file=sys.stderr)
            return code
        print(json.dumps({"schemaVersion": bridge_version()}))
        return 0
    if "--evaluate" in argv:
        try:
            code = int(os.environ.get("FAKE_EXIT", "0"))
        except ValueError:
            code = 0
        if code != 0:
            print("fake core refusing evaluation", file=sys.stderr)
            return code
        raw = sys.stdin.read()
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            print("fake core: stdin not JSON", file=sys.stderr)
            return 2
        if mode == "slow":
            try:
                sleep_ms = int(os.environ.get("FAKE_SLEEP_MS", "0"))
            except ValueError:
                sleep_ms = 0
            time.sleep(sleep_ms / 1000.0)
        if mode == "garbage":
            print("this is not json")
            return 0
        response = {
            "schemaVersion": bridge_version(),
            "configRevision": request.get("configRevision"),
            "recommendation": {
                "roleId": "fake-role",
                "confidence": 0.9,
                "rationale": "canned offline fixture",
            },
            "evaluatedAt": "2026-09-24T00:00:00.000Z",
        }
        if mode == "rev_mismatch":
            response["configRevision"] = "wrong-revision"
        elif mode == "no_revision":
            del response["configRevision"]
        elif mode == "mutation":
            response["assigned_agent_id"] = "agent-1"
        print(json.dumps(response))
        return 0
    print("usage: decision-engine-fake-core.py [--capability] [--evaluate]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
