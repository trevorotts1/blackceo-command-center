#!/usr/bin/env python3
"""Minimal step-gate stub for the interview-lock E2E fixture.

Represents the REAL gate's contract (BU-13): identities, `next` order,
answer acceptance. Serves company_name then industry, in that order,
from the registry's own prompts. Stateful in <state-dir>/gate-state.json.
Not production code; the real gate is the onboarding skill script.
"""
import json
import sys
from pathlib import Path

def parse_args(argv):
    args = {}
    positional = []
    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok.startswith("--"):
            key = tok[2:]
            if "=" in key:
                k, v = key.split("=", 1)
                args[k] = v
            elif i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                args[key] = argv[i + 1]
                i += 1
            else:
                args[key] = True
        else:
            positional.append(tok)
        i += 1
    return positional, args

def load_registry(path):
    try:
        data = json.loads(Path(path).read_text())
        qs = data.get("questions", []) if isinstance(data, dict) else []
        return [q for q in qs if isinstance(q, dict) and q.get("id")]
    except Exception:
        return []

def state_file(state_dir):
    return Path(state_dir) / "gate-state.json"

def load_answered(state_dir):
    try:
        data = json.loads(state_file(state_dir).read_text())
        answered = data.get("answered", []) if isinstance(data, dict) else []
        return [a for a in answered if isinstance(a, str)]
    except Exception:
        return []

def save_answered(state_dir, answered):
    try:
        p = state_file(state_dir)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"answered": answered}))
    except Exception:
        pass

def question_payload(q, answered, total):
    return {
        "done": False,
        "id": q["id"],
        "section": q.get("section"),
        "kind": q.get("kind", "text"),
        "prompt": q["prompt"],
        "help": q.get("help"),
        "example": q.get("example"),
        "choices": q.get("choices"),
        "suggestions": q.get("suggestions"),
        "required": bool(q.get("required", True)),
        "allowSkip": bool(q.get("allowSkip", False)),
        "allowUnsure": bool(q.get("allowUnsure", False)),
        "allowOther": bool(q.get("allowOther", False)),
        "minChars": q.get("minChars"),
        "minWords": q.get("minWords"),
        "knownValue": None,
        "knownSource": None,
        "attempt": 0,
        "requiredTotal": total,
        "requiredAnswered": len(answered),
        "answeredTotal": len(answered),
        "percent": round(100 * len(answered) / total) if total else 0,
    }

def main():
    positional, args = parse_args(sys.argv[1:])
    registry = load_registry(args.get("registry", ""))
    state_dir = args.get("state-dir", ".")
    # Only the first two questions are exercised by this fixture's draft test.
    queue = [q for q in registry if q.get("id") in ("company_name", "industry")]
    if not queue:
        queue = [
            {"id": "company_name", "prompt": "What name should we put on everything we build for you?", "kind": "text", "required": True, "minChars": 2, "minWords": 1},
            {"id": "industry", "prompt": "What kind of business is it?", "kind": "text", "required": True, "minChars": 3, "minWords": 1},
        ]
    total = len(queue)
    answered = [a for a in load_answered(state_dir) if a in [q["id"] for q in queue]]
    verb = positional[0] if positional else ""
    if verb == "next":
        current = next((q for q in queue if q["id"] not in answered), None)
        if current is None:
            print(json.dumps({"done": True, "missingRequired": [], "skippedOpen": [], "requiredTotal": total, "requiredAnswered": len(answered), "answeredTotal": len(answered), "percent": 100}))
        else:
            print(json.dumps(question_payload(current, answered, total)))
        return 0
    if verb == "answer":
        qid = args.get("qid", "")
        current = next((q for q in queue if q["id"] not in answered), None)
        if current is None:
            print(json.dumps({"error": "done", "expected": None}))
            return 2
        if qid != current["id"]:
            print(json.dumps({"error": "out_of_order", "expected": current["id"]}))
            return 2
        if qid not in answered:
            answered.append(qid)
            save_answered(state_dir, answered)
        print(json.dumps({"ok": True, "accepted": True, "questionId": qid, "requiredAnswered": len(answered), "requiredTotal": total}))
        return 0
    if verb == "status":
        print(json.dumps({"done": all(q["id"] in answered for q in queue), "requiredAnswered": len(answered), "requiredTotal": total, "percent": round(100 * len(answered) / total) if total else 0, "skippedOpen": [], "missingRequired": [q["id"] for q in queue if q["id"] not in answered]}))
        return 0
    if verb in ("skip", "unsure"):
        print(json.dumps({"ok": True}))
        return 0
    print(json.dumps({"error": "tooling"}))
    return 1

if __name__ == "__main__":
    sys.exit(main())
