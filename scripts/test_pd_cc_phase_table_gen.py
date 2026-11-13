#!/usr/bin/env python3
"""Tests for pd_cc_phase_table_gen.py. STDLIB ONLY (unittest)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, "pd_cc_phase_table_gen.py")
ROOT = os.path.dirname(HERE)
MANIFEST = os.path.join(ROOT, "config", "PIPELINE-MANIFEST.vendored.json")
LABELS = os.path.join(ROOT, "config", "cc-phase-labels.json")


def run(*args):
    proc = subprocess.run(
        [sys.executable, "-I", GEN, *args],
        capture_output=True, text=True, timeout=120,
    )
    return proc.returncode, proc.stdout + proc.stderr


class GeneratorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pdcc-phase-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_labels(self, mutate):
        with open(LABELS, encoding="utf-8") as fh:
            doc = json.load(fh)
        mutate(doc)
        path = os.path.join(self.tmp, "labels.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        return path

    def test_happy_path_writes_and_check_agrees(self):
        out = os.path.join(self.tmp, "phases.ts")
        code, text = run("--manifest", MANIFEST, "--labels", LABELS, "--out", out)
        self.assertEqual(code, 0, text)
        self.assertIn("13 steps", text)
        code, text = run("--manifest", MANIFEST, "--labels", LABELS, "--out", out, "--check")
        self.assertEqual(code, 0, text)
        self.assertIn("current", text)

    def test_check_refuses_a_stale_file(self):
        out = os.path.join(self.tmp, "phases.ts")
        with open(out, "w", encoding="utf-8") as fh:
            fh.write("// stale\n")
        code, text = run("--manifest", MANIFEST, "--labels", LABELS, "--out", out, "--check")
        self.assertEqual(code, 1, text)
        self.assertIn("STALE", text)

    def test_retired_phase_ids_make_it_exit_1(self):
        # The nine phases the old hand-typed table waited on that manifest
        # version 75 no longer has. A label file carrying any of them must be
        # refused, never silently dropped.
        retired = [
            "P-U-DESIGN-SALES", "P-U-DESIGN-RENDER-SALES", "P-U-HTML-SALES",
            "P-U-DESIGN-CHECKOUT", "P-U-DESIGN-RENDER-CHECKOUT", "P-U-HTML-CHECKOUT",
            "P-U-DESIGN-VSL", "P-U-DESIGN-RENDER-VSL", "P-U-HTML-VSL",
        ]

        def mutate(doc):
            for i in retired:
                doc["phase_to_step"][i] = "Sales Page"

        labels = self.write_labels(mutate)
        out = os.path.join(self.tmp, "phases.ts")
        code, text = run("--manifest", MANIFEST, "--labels", labels, "--out", out)
        self.assertEqual(code, 1, text)
        self.assertIn("REFUSED", text)
        self.assertIn("P-U-DESIGN-SALES", text)
        self.assertFalse(os.path.exists(out))

    def test_manifest_phase_with_no_step_is_refused(self):
        def mutate(doc):
            doc["phase_to_step"].pop("P-BUNDLE-GATE")

        labels = self.write_labels(mutate)
        out = os.path.join(self.tmp, "phases.ts")
        code, text = run("--manifest", MANIFEST, "--labels", labels, "--out", out)
        self.assertEqual(code, 1, text)
        self.assertIn("P-BUNDLE-GATE has no step", text)

    def test_human_phase_not_in_owner_action_phases_is_refused(self):
        def mutate(doc):
            doc["owner_action_phases"] = []

        labels = self.write_labels(mutate)
        out = os.path.join(self.tmp, "phases.ts")
        code, text = run("--manifest", MANIFEST, "--labels", labels, "--out", out)
        self.assertEqual(code, 1, text)
        self.assertIn("human phase P-STYLE-PICK", text)

    def test_unknown_branch_step_is_refused(self):
        def mutate(doc):
            doc["branch_steps"]["Not A Step"] = "want_sales_checkout"

        labels = self.write_labels(mutate)
        out = os.path.join(self.tmp, "phases.ts")
        code, text = run("--manifest", MANIFEST, "--labels", labels, "--out", out)
        self.assertEqual(code, 1, text)
        self.assertIn("not in steps", text)


if __name__ == "__main__":
    unittest.main()
