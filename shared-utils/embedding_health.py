#!/usr/bin/env python3
"""
embedding_health.py — Dual-store embedding health surface (F2.3 / DEP-11).

The persona system runs on TWO parallel embedding stores that can degrade
INDEPENDENTLY, and until now nothing reported them side-by-side:

  1. PERSONA INDEX  (Skill-22/23 coaching-personas)
       DB   : <workspace>/data/coaching-personas/gemini-index.sqlite
       Table: embeddings (columns: provider, model, dim, vector, ...)
       Policy: Gemini-ONLY by design — gemini-embedding-2 @ 3072 dims.
       Consumer: persona-selector-v2.py Layer-5 semantic scoring.

  2. SOP / ROUTING INDEX  (Command Center)
       DB   : <cwd>/mission-control.db (or $DATABASE_PATH)
       Table: sop_embeddings (columns: embedding_model, embedding_dims, ...)
       Policy: provider-flexible — google (gemini-embedding-2 @3072) is the
               pinned contract, OpenAI (text-embedding-3-small @1536) is an
               explicit optional fallback; auto-selects per key availability.
       Consumer: department-router.ts semantic routing + SOP search.

THE ASYMMETRY THIS SURFACES
  A box with only an OpenAI key gets SEMANTIC routing (SOP store embeds at
  1536) but the persona index is Gemini-only, so its rows can no longer be
  refreshed and Layer-5 falls back to KEYWORD-only. Semantic routing +
  keyword-only persona matching is a silent, asymmetric degradation that no
  status surface reported. This script reports BOTH stores' (provider, model,
  row-model histogram, stale count) together and flags the asymmetry.

DESIGN POSTURE (fail-open / degrade-loudly — never a hard gate)
  * Reads ONLY row metadata (provider/model/dim/counts). It NEVER reads,
    resolves, or prints an API key or any secret.
  * NEVER raises to the caller. Any error is captured into the JSON as a
    degraded store with an `error` field; exit code stays 0 unless --strict.
  * A missing DB / missing table is a real operational state (fresh box,
    migration not run), reported as available=false + degraded=true, not a
    crash.

USAGE
  python3 embedding_health.py --format json
  python3 embedding_health.py --format line
  python3 embedding_health.py --sop-db /path/mission-control.db \
        --persona-db /path/gemini-index.sqlite --sop-active-provider google
  python3 embedding_health.py --strict     # exit 2 if either store degraded

EXIT CODES
  0  reported (default — even when degraded; this is a status surface)
  2  --strict was passed AND at least one store is degraded
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Pinned constants — mirror shared-utils/embedding_engine.py (persona index)
# and src/lib/sop-embeddings.ts (SOP index). Kept in sync by qc-cc section 12.
# ---------------------------------------------------------------------------

GEMINI_MODEL = "gemini-embedding-2"          # GA persona/SOP-google model
GEMINI_DIMS = 3072
OPENAI_MODEL = "text-embedding-3-small"      # SOP optional fallback
OPENAI_DIMS = 1536

# Model slugs whose vectors are INCOMPATIBLE with the pinned GA model and must
# be re-embedded. gemini-embedding-001 hard-retires 2026-07-14.
RETIRED_GEMINI_MODELS = frozenset({
    "gemini-embedding-001",
    "gemini-embedding-2-preview",
    "gemini-embedding-exp-03-07",
})

# model slug -> logical provider. Used to infer a store's effective provider
# from its row histogram when it is not supplied out-of-band.
PROVIDER_BY_MODEL = {
    GEMINI_MODEL: "google",
    "gemini-embedding-001": "google",
    "gemini-embedding-2-preview": "google",
    "gemini-embedding-exp-03-07": "google",
    OPENAI_MODEL: "openai",
    "text-embedding-3-large": "openai",
    "text-embedding-ada-002": "openai",
}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Path resolution (mirrors embedding_engine.py workspace resolution)
# ---------------------------------------------------------------------------

def resolve_workspace_root() -> str:
    root = os.environ.get("WORKSPACE_ROOT")
    if root and os.path.isdir(root):
        return root
    mac = os.path.expanduser("~/.openclaw/workspace")
    if os.path.isdir(mac):
        return mac
    vps = "/data/.openclaw/workspace"
    if os.path.isdir(vps):
        return vps
    # Return the Mac default even if absent so the reported path is meaningful.
    return mac


def resolve_persona_db(explicit: str | None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("PERSONA_INDEX_DB")
    if env:
        return env
    return os.path.join(
        resolve_workspace_root(), "data", "coaching-personas", "gemini-index.sqlite"
    )


def resolve_sop_db(explicit: str | None) -> str:
    if explicit:
        return explicit
    env = os.environ.get("DATABASE_PATH")
    if env:
        return env
    return os.path.join(os.getcwd(), "mission-control.db")


# ---------------------------------------------------------------------------
# Store inspection (metadata only — no vectors, no secrets)
# ---------------------------------------------------------------------------

def _table_exists(cur: sqlite3.Cursor, table: str) -> bool:
    row = cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def _columns(cur: sqlite3.Cursor, table: str) -> set:
    return {r[1] for r in cur.execute(f"PRAGMA table_info({table})")}


def _dominant(hist: dict) -> str | None:
    """Return the model with the most rows, or None for an empty histogram."""
    if not hist:
        return None
    return max(hist.items(), key=lambda kv: kv[1])[0]


def inspect_store(
    *,
    store: str,
    db_path: str,
    table: str,
    model_col: str,
    dims_col: str,
    canonical_model: str,
    canonical_provider: str,
    canonical_dims: int,
) -> dict:
    """Inspect one embedding store. Never raises — errors land in the dict."""
    result = {
        "store": store,
        "db_path": db_path,
        "table": table,
        "available": False,
        "total_rows": 0,
        "provider": None,
        "model": None,
        "canonical_model": canonical_model,
        "canonical_provider": canonical_provider,
        "canonical_dims": canonical_dims,
        "model_histogram": {},
        "stale_rows": 0,
        "foreign_provider_rows": 0,
        "semantic_ready": False,
        "degraded": True,
        "notes": [],
        "error": None,
    }

    if not os.path.exists(db_path):
        result["notes"].append(
            f"{store} index DB not found at {db_path} — store not provisioned "
            f"on this box (semantic {store} matching is keyword-only)."
        )
        return result

    conn = None
    try:
        # read-only, immutable=0; short timeout so a busy DB can't hang health.
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
        cur = conn.cursor()

        if not _table_exists(cur, table):
            result["notes"].append(
                f"{store}: table '{table}' missing (migration not yet run) — "
                f"keyword-only fallback."
            )
            return result

        cols = _columns(cur, table)
        if model_col not in cols:
            result["notes"].append(
                f"{store}: column '{model_col}' absent from '{table}'; "
                f"cannot build model histogram."
            )
            return result

        result["available"] = True

        total = cur.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        result["total_rows"] = int(total or 0)

        # Model histogram (COALESCE null/empty model to '(unknown)').
        hist = {}
        for model, cnt in cur.execute(
            f"SELECT COALESCE(NULLIF({model_col}, ''), '(unknown)') AS m, "
            f"COUNT(*) FROM {table} GROUP BY m"
        ):
            hist[str(model)] = int(cnt)
        result["model_histogram"] = hist

        dominant = _dominant(hist)
        result["model"] = dominant
        result["provider"] = PROVIDER_BY_MODEL.get(dominant or "", "unknown")

        # stale = rows whose model is a known-retired gemini slug.
        stale = 0
        foreign = 0
        for model, cnt in hist.items():
            if model in RETIRED_GEMINI_MODELS:
                stale += cnt
            provider_of_model = PROVIDER_BY_MODEL.get(model, "unknown")
            if provider_of_model != canonical_provider and model != "(unknown)":
                foreign += cnt
        result["stale_rows"] = stale
        result["foreign_provider_rows"] = foreign

        canonical_rows = hist.get(canonical_model, 0)
        result["semantic_ready"] = canonical_rows > 0

        # degraded when there are no usable canonical-model rows, OR any stale
        # rows exist (they poison the space and can't be cross-compared).
        result["degraded"] = (canonical_rows == 0) or (stale > 0) or (foreign > 0)

        if result["total_rows"] == 0:
            result["notes"].append(
                f"{store}: table present but EMPTY — no embeddings stored yet "
                f"(keyword-only until the index is built)."
            )
        if stale > 0:
            result["notes"].append(
                f"{store}: {stale} row(s) on a RETIRED model "
                f"({sorted(m for m in hist if m in RETIRED_GEMINI_MODELS)}) — "
                f"re-embed with {canonical_model} before 2026-07-14 shutdown."
            )
        if foreign > 0:
            result["notes"].append(
                f"{store}: {foreign} row(s) on a foreign provider (expected "
                f"{canonical_provider}/{canonical_model}) — cross-model cosine "
                f"is disabled for those rows; matching falls back to keyword."
            )
        if canonical_rows == 0 and result["total_rows"] > 0:
            result["notes"].append(
                f"{store}: ZERO rows match the active model {canonical_model} — "
                f"semantic matching is DISABLED (keyword-only)."
            )
        return result
    except Exception as exc:  # noqa: BLE001 — health surface must not raise
        result["available"] = False
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["notes"].append(
            f"{store}: could not read index ({result['error']}) — treating as "
            f"degraded/keyword-only."
        )
        return result
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Dual-store report + asymmetry detection
# ---------------------------------------------------------------------------

def build_report(
    *,
    sop_db: str,
    persona_db: str,
    sop_active_provider: str | None,
) -> dict:
    # SOP canonical model follows the box's active provider when known
    # (passed in by the CC, which resolves it from key availability WITHOUT
    # exposing the key to this script). Default to the pinned google contract.
    ap = (sop_active_provider or "google").strip().lower()
    if ap == "openai":
        sop_canon_model, sop_canon_provider, sop_canon_dims = (
            OPENAI_MODEL, "openai", OPENAI_DIMS
        )
    elif ap == "none":
        # No provider configured — nothing is semantic-ready by definition.
        sop_canon_model, sop_canon_provider, sop_canon_dims = ("", "none", 0)
    else:
        sop_canon_model, sop_canon_provider, sop_canon_dims = (
            GEMINI_MODEL, "google", GEMINI_DIMS
        )

    persona = inspect_store(
        store="persona_index",
        db_path=persona_db,
        table="embeddings",
        model_col="model",
        dims_col="dim",
        canonical_model=GEMINI_MODEL,
        canonical_provider="google",
        canonical_dims=GEMINI_DIMS,
    )
    sop = inspect_store(
        store="sop_index",
        db_path=sop_db,
        table="sop_embeddings",
        model_col="embedding_model",
        dims_col="embedding_dims",
        canonical_model=sop_canon_model,
        canonical_provider=sop_canon_provider,
        canonical_dims=sop_canon_dims,
    )
    if ap == "none":
        sop["notes"].append(
            "sop_index: no embedding provider key configured on this box — "
            "SOP routing is keyword-only regardless of stored rows."
        )
        sop["semantic_ready"] = False
        sop["degraded"] = True

    # ── asymmetry detection ────────────────────────────────────────────────
    # The headline case: one store semantic while the other is keyword-only,
    # OR both semantic but on DIFFERENT providers (different vector spaces).
    asymmetric = False
    detail = "both stores agree (same provider, both semantic-ready or both keyword-only)."

    p_ready = bool(persona["semantic_ready"])
    s_ready = bool(sop["semantic_ready"])
    p_prov = persona["provider"]
    s_prov = sop["provider"]

    if p_ready != s_ready:
        asymmetric = True
        semantic = "sop" if s_ready else "persona"
        keyword = "persona" if s_ready else "sop"
        detail = (
            f"ASYMMETRIC: {semantic}_index is semantic-ready but {keyword}_index "
            f"is keyword-only (empty/missing/all-stale/no-provider). This is the "
            f"class of split the analysis calls out — e.g. an OpenAI-only box gets "
            f"semantic SOP routing but keyword-only persona Layer-5."
        )
    elif p_ready and s_ready and p_prov and s_prov and p_prov != s_prov:
        asymmetric = True
        detail = (
            f"ASYMMETRIC: persona_index effective provider is '{p_prov}' but "
            f"sop_index is '{s_prov}' — the two stores embed into DIFFERENT "
            f"vector spaces; matching quality is inconsistent across layers."
        )

    degraded = bool(persona["degraded"] or sop["degraded"] or asymmetric)

    return {
        "check": "dual_store_embedding_health",
        "generated_at": _now(),
        "status": "degraded" if degraded else "ok",
        "degraded": degraded,
        "asymmetric": asymmetric,
        "asymmetric_detail": detail,
        "persona_index": persona,
        "sop_index": sop,
    }


def format_line(report: dict) -> str:
    def one(store: dict) -> str:
        prov = store.get("provider") or "none"
        model = store.get("model") or "-"
        return (
            f"{store['store']}={prov}/{model} "
            f"rows={store['total_rows']} stale={store['stale_rows']} "
            f"semantic={'yes' if store['semantic_ready'] else 'NO'}"
        )

    flag = "ASYMMETRIC" if report["asymmetric"] else report["status"].upper()
    return f"[embedding-health {flag}] {one(report['persona_index'])} | {one(report['sop_index'])}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Dual-store embedding health (persona index + SOP index)."
    )
    parser.add_argument("--sop-db", default=None, help="Path to mission-control.db")
    parser.add_argument("--persona-db", default=None, help="Path to gemini-index.sqlite")
    parser.add_argument(
        "--sop-active-provider",
        default=None,
        choices=["google", "openai", "none"],
        help="Active SOP provider resolved by the CC (no secret is passed).",
    )
    parser.add_argument("--format", default="json", choices=["json", "line"])
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit 2 when any store is degraded (for CI); default exits 0.",
    )
    args = parser.parse_args(argv)

    try:
        report = build_report(
            sop_db=resolve_sop_db(args.sop_db),
            persona_db=resolve_persona_db(args.persona_db),
            sop_active_provider=args.sop_active_provider,
        )
    except Exception as exc:  # noqa: BLE001 — last-resort guard, never crash
        report = {
            "check": "dual_store_embedding_health",
            "generated_at": _now(),
            "status": "degraded",
            "degraded": True,
            "asymmetric": False,
            "asymmetric_detail": f"health probe error: {type(exc).__name__}: {exc}",
            "persona_index": None,
            "sop_index": None,
            "error": f"{type(exc).__name__}: {exc}",
        }

    if args.format == "line":
        print(format_line(report))
    else:
        print(json.dumps(report, indent=2))

    if args.strict and report.get("degraded"):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
