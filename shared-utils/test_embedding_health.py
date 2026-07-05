#!/usr/bin/env python3
"""
Unit tests for embedding_health.py — the dual-store embedding health surface
(F2.3 / DEP-11).

Covers the mixed-row fixture matrix the analysis QC calls for:
  * both stores Gemini semantic-ready       -> ok, NOT asymmetric
  * OpenAI-only box (SOP semantic, persona   -> ASYMMETRIC (headline case)
    keyword-only / empty)
  * both semantic but different providers    -> ASYMMETRIC (split vector space)
  * retired gemini-embedding-001 rows        -> stale_rows>0, degraded
  * missing DB / missing table               -> available=False, degraded, NO throw
  * model histogram is exact

Run:  python3 -m unittest shared-utils.test_embedding_health   (from repo root)
  or: python3 shared-utils/test_embedding_health.py
"""

import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import embedding_health as eh  # noqa: E402


def _make_persona_db(path, rows):
    """rows: list of (model, dim) — builds the coaching-personas embeddings table."""
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE embeddings (id TEXT PRIMARY KEY, file_path TEXT, "
        "chunk_index INTEGER, content TEXT, vector BLOB, last_updated REAL, "
        "provider TEXT, model TEXT, dim INTEGER)"
    )
    for i, (model, dim) in enumerate(rows):
        provider = eh.PROVIDER_BY_MODEL.get(model, "unknown")
        conn.execute(
            "INSERT INTO embeddings (id, model, dim, provider, vector) VALUES (?,?,?,?,?)",
            (f"p{i}", model, dim, provider, b"\x00\x00\x00\x00"),
        )
    conn.commit()
    conn.close()


def _make_sop_db(path, rows):
    """rows: list of (model, dim) — builds the CC sop_embeddings table."""
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE sop_embeddings (sop_id TEXT PRIMARY KEY, embedding BLOB, "
        "embedding_model TEXT, embedding_dims INTEGER, embedded_at TEXT)"
    )
    for i, (model, dim) in enumerate(rows):
        conn.execute(
            "INSERT INTO sop_embeddings (sop_id, embedding_model, embedding_dims, "
            "embedded_at) VALUES (?,?,?,?)",
            (f"s{i}", model, dim, "2026-07-05T00:00:00Z"),
        )
    conn.commit()
    conn.close()


class EmbeddingHealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="emb-health-")
        self.persona_db = os.path.join(self.tmp, "gemini-index.sqlite")
        self.sop_db = os.path.join(self.tmp, "mission-control.db")

    def _report(self, sop_provider="google"):
        return eh.build_report(
            sop_db=self.sop_db,
            persona_db=self.persona_db,
            sop_active_provider=sop_provider,
        )

    def test_both_gemini_healthy_not_asymmetric(self):
        _make_persona_db(self.persona_db, [("gemini-embedding-2", 3072)] * 5)
        _make_sop_db(self.sop_db, [("gemini-embedding-2", 3072)] * 8)
        r = self._report("google")
        self.assertFalse(r["asymmetric"], r["asymmetric_detail"])
        self.assertFalse(r["degraded"])
        self.assertEqual(r["status"], "ok")
        self.assertTrue(r["persona_index"]["semantic_ready"])
        self.assertTrue(r["sop_index"]["semantic_ready"])
        self.assertEqual(r["persona_index"]["total_rows"], 5)
        self.assertEqual(r["sop_index"]["total_rows"], 8)

    def test_openai_only_box_is_asymmetric_headline(self):
        # Persona index empty (Gemini-only, can't refresh w/o Google key);
        # SOP index has OpenAI rows and is semantic-ready.
        _make_persona_db(self.persona_db, [])  # empty table
        _make_sop_db(self.sop_db, [("text-embedding-3-small", 1536)] * 4)
        r = self._report("openai")
        self.assertTrue(r["asymmetric"], "OpenAI-only split must be flagged")
        self.assertIn("keyword-only persona", r["asymmetric_detail"])
        self.assertTrue(r["sop_index"]["semantic_ready"])
        self.assertFalse(r["persona_index"]["semantic_ready"])
        self.assertTrue(r["degraded"])

    def test_both_semantic_different_providers_is_asymmetric(self):
        _make_persona_db(self.persona_db, [("gemini-embedding-2", 3072)] * 3)
        _make_sop_db(self.sop_db, [("text-embedding-3-small", 1536)] * 3)
        r = self._report("openai")
        self.assertTrue(r["asymmetric"])
        self.assertEqual(r["persona_index"]["provider"], "google")
        self.assertEqual(r["sop_index"]["provider"], "openai")

    def test_retired_model_rows_are_stale_and_degraded(self):
        _make_persona_db(
            self.persona_db,
            [("gemini-embedding-2", 3072)] * 2 + [("gemini-embedding-001", 3072)] * 3,
        )
        _make_sop_db(self.sop_db, [("gemini-embedding-2", 3072)] * 4)
        r = self._report("google")
        self.assertEqual(r["persona_index"]["stale_rows"], 3)
        self.assertTrue(r["persona_index"]["degraded"])
        self.assertTrue(r["degraded"])
        self.assertEqual(
            r["persona_index"]["model_histogram"],
            {"gemini-embedding-2": 2, "gemini-embedding-001": 3},
        )

    def test_missing_db_is_degraded_not_crash(self):
        # Neither DB created.
        r = self._report("google")
        self.assertFalse(r["persona_index"]["available"])
        self.assertFalse(r["sop_index"]["available"])
        self.assertTrue(r["degraded"])
        self.assertTrue(r["persona_index"]["degraded"])
        # Asymmetry: both keyword-only -> NOT asymmetric (both equally down).
        self.assertFalse(r["asymmetric"])

    def test_sop_provider_none_forces_keyword_only(self):
        _make_persona_db(self.persona_db, [("gemini-embedding-2", 3072)] * 3)
        _make_sop_db(self.sop_db, [("gemini-embedding-2", 3072)] * 3)
        r = self._report("none")
        self.assertFalse(r["sop_index"]["semantic_ready"])
        self.assertTrue(r["asymmetric"])  # persona semantic, sop keyword-only

    def test_line_format_never_raises(self):
        _make_persona_db(self.persona_db, [("gemini-embedding-2", 3072)])
        _make_sop_db(self.sop_db, [("gemini-embedding-2", 3072)])
        line = eh.format_line(self._report("google"))
        self.assertIn("persona_index=", line)
        self.assertIn("sop_index=", line)


if __name__ == "__main__":
    unittest.main(verbosity=2)
