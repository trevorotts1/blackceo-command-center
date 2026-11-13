#!/usr/bin/env python3
"""Fail if a test that `npm run test:unit` runs under Node's own runner imports Vitest.

`npm run test:unit` executes tests/unit/*.test.ts with `node --test`, minus the files named in the
`grep -v -E '...'` exclusion in package.json (those run under Vitest). A Vitest import in a file Node runs
dies with "Vitest cannot be imported in a CommonJS module" and shows up as a failure of the whole U55 job.
This guard finds that in seconds. Usage: guard-no-vitest-in-node-unit.py [repo_root]
"""
import json, re, sys
from pathlib import Path

VITEST_IMPORT = re.compile(r"""(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:vitest|vitest/[^'"]*)['"]""")


def node_runner_files(root: Path):
    script = json.loads((root / "package.json").read_text(encoding="utf-8"))["scripts"]["test:unit"]
    m = re.search(r"grep -v -E '([^']*)'", script)
    # package.json holds the pattern JSON-decoded already; the regex uses \\. for a literal dot.
    exclude = re.compile(m.group(1)) if m else None
    for f in sorted((root / "tests" / "unit").glob("*.test.ts")):
        if exclude is None or not exclude.search(f"tests/unit/{f.name}"):
            yield f


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    bad = [f for f in node_runner_files(root) if VITEST_IMPORT.search(f.read_text(encoding="utf-8", errors="replace"))]
    for f in bad:
        print(f"::error file={f.relative_to(root)}::imports vitest but runs under Node's own runner (npm run test:unit). "
              "Move it to the Vitest suite (add it to the exclusion list in package.json test:unit) or rewrite it for node:test.")
    if bad:
        return 1
    print(f"ok: no Vitest import in the Node-runner unit tests ({sum(1 for _ in node_runner_files(root))} files checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
