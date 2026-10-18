#!/usr/bin/env python3
"""Build the nine Council portrait variants from prepared PNG masters.

Inputs: <masters>/<seat-id>.png and a provenance.json object keyed by the
canonical nine seat IDs. Requires Pillow (development tool only).
Outputs under <out>/: <seat-id>-{room,detail,thumb}.webp + manifest.json.
No completed asset set is published unless all nine inputs validate.
Default mode requires reviewed original RGBA art. The explicit owner-selected
mode accepts cropped existing photographs and retains unverified rights.
This is not a portrait generator.
"""
import argparse
from datetime import datetime
import hashlib
import io
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("Pillow is required to build council portraits. Install Pillow in the asset build environment.") from exc

SEATS = {
    "simon-sinek": "Simon Sinek",
    "td-jakes": "T. D. Jakes",
    "oprah-winfrey": "Oprah Winfrey",
    "tiffany-aliche": "Tiffany Aliche",
    "russell-brunson": "Russell Brunson",
    "michelle-obama": "Michelle Obama",
    "brene-brown": "Brené Brown",
    "dennis-kimbro": "Dr. Dennis Kimbro",
    "les-brown": "Les Brown",
}
VARIANTS = {
    "room": (512, 640, 200 * 1024),
    "detail": (800, 1000, 350 * 1024),
    "thumb": (160, 200, 30 * 1024),
}
TOTAL_ROOM_BUDGET = 1800 * 1024
MASTER_SIZE = (1024, 1280)
MAX_PROVENANCE_TEXT = 2048


class PortraitError(Exception):
    pass


def _text(value, field):
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_PROVENANCE_TEXT:
        raise PortraitError(f"{field} must be a nonempty bounded string")
    return value.strip()


def _provenance(path, *, allow_test_fixtures=False, owner_selected=False):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise PortraitError(f"Invalid provenance JSON: {path}") from exc
    if not isinstance(payload, dict) or set(payload) != set(SEATS):
        raise PortraitError("Provenance must list exactly the nine approved seat IDs")
    result = {}
    for seat, raw in payload.items():
        if not isinstance(raw, dict):
            raise PortraitError(f"Provenance for {seat} must be an object")

        if owner_selected:
            subject = _text(raw.get("selected_subject"), f"{seat}.selected_subject")
            if subject != SEATS[seat]:
                raise PortraitError(f"Portrait subject mismatch for {seat}")
            digest = _text(raw.get("selected_master_sha256"), f"{seat}.selected_master_sha256")
            if not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise PortraitError(f"Portrait {seat} selection must bind a SHA-256 digest")
            # Selection records factual provenance without claiming an art,
            # identity or rights approval that did not happen.
            if raw.get("rights_status") != "unverified":
                raise PortraitError(f"Owner-selected {seat} must retain unverified rights")
            result[seat] = {
                "selected_subject": subject,
                "selected_master_sha256": digest,
                "rights_status": "unverified",
                **{field: _text(raw.get(field), f"{seat}.{field}") for field in
                   ("creation_method", "source_note", "alt_text")},
            }
            continue

        # A correctly named file is not proof it depicts the right person.
        # A human art/identity reviewer must sign off on the exact master
        # bytes BEFORE the nine images can be published.
        approved_subject = _text(raw.get("approved_subject"), f"{seat}.approved_subject")
        if approved_subject != SEATS[seat]:
            raise PortraitError(
                f"Portrait subject mismatch for {seat}: "
                f"approved_subject must be exactly {SEATS[seat]}"
            )
        review_status = _text(raw.get("identity_review_status"), f"{seat}.identity_review_status")
        if review_status != "approved":
            raise PortraitError(f"Portrait {seat} has no completed identity review")
        approved_by = _text(raw.get("approved_by"), f"{seat}.approved_by")
        reviewed_at = _text(raw.get("reviewed_at"), f"{seat}.reviewed_at")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", reviewed_at):
            raise PortraitError(f"Portrait {seat} has no UTC identity review timestamp")
        try:
            datetime.fromisoformat(reviewed_at)
        except ValueError as exc:
            raise PortraitError(f"Portrait {seat} has no valid UTC identity review timestamp") from exc
        master_sha = _text(raw.get("reviewed_master_sha256"), f"{seat}.reviewed_master_sha256")
        if len(master_sha) != 64 or any(ch not in "0123456789abcdef" for ch in master_sha):
            raise PortraitError(f"Portrait {seat} review must bind a lowercase SHA-256 digest")
        rights = _text(raw.get("rights_status"), f"{seat}.rights_status")
        allowed_rights = {"owned_original", "licensed_original", "owned_generated"}
        if rights == "test_only" and allow_test_fixtures:
            pass
        elif rights not in allowed_rights:
            raise PortraitError(
                f"Portrait {seat} rights are not approved for release: {rights}"
            )
        if approved_by == "synthetic-unit-test-harness" and not allow_test_fixtures:
            raise PortraitError(f"Portrait {seat} requires a real identity reviewer for release")
        result[seat] = {
            "approved_subject": approved_subject,
            "identity_review_status": review_status,
            "approved_by": approved_by,
            "reviewed_at": reviewed_at,
            "reviewed_master_sha256": master_sha,
            "identity_review_note": _text(raw.get("identity_review_note"), f"{seat}.identity_review_note"),
            "creation_method": _text(raw.get("creation_method"), f"{seat}.creation_method"),
            "rights_status": rights,
            "source_note": _text(raw.get("source_note"), f"{seat}.source_note"),
            "alt_text": _text(raw.get("alt_text"), f"{seat}.alt_text"),
        }
    return result


def _read_master(path, seat, *, owner_selected=False):
    if not path.is_file() or path.is_symlink():
        raise PortraitError(f"Missing or linked original master for {seat}: {path}")
    # Decode and bind the same immutable bytes, even if the file is replaced
    # while this build is running.
    master_bytes = path.read_bytes()
    master_sha = hashlib.sha256(master_bytes).hexdigest()
    with Image.open(io.BytesIO(master_bytes)) as opened:
        opened.load()
        if owner_selected:
            if opened.format != "PNG" or opened.mode not in ("RGB", "RGBA"):
                raise PortraitError(f"Selected photo {seat} must be an RGB/RGBA PNG")
            if opened.width * 5 != opened.height * 4:
                raise PortraitError(f"Selected photo {seat} must have a prepared 4:5 crop")
            return opened.convert("RGBA"), master_sha
        if opened.format != "PNG" or opened.mode != "RGBA":
            raise PortraitError(f"Master {seat} must be a transparent RGBA PNG")
        if min(opened.size) < 1024:
            raise PortraitError(f"Master {seat} needs at least 1024 pixels on its smaller dimension")
        if opened.getchannel("A").getextrema()[0] >= 255:
            raise PortraitError(f"Master {seat} has no transparent pixels")
        source = opened.copy()
    # Fit, never crop: preserve the complete head and shoulders.
    source.thumbnail(MASTER_SIZE, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", MASTER_SIZE, (0, 0, 0, 0))
    canvas.alpha_composite(source, ((MASTER_SIZE[0]-source.width)//2, (MASTER_SIZE[1]-source.height)//2))
    return canvas, master_sha


def _encode_variant(master, size, limit, seat, variant):
    rendered = master.resize(size, Image.Resampling.LANCZOS)
    for quality in (90, 85, 80, 75, 70, 65, 60, 55, 50):
        out = io.BytesIO()
        rendered.save(out, format="WEBP", quality=quality, method=6, exact=True)
        data = out.getvalue()
        if len(data) <= limit:
            return data
    raise PortraitError(f"{seat} {variant} cannot fit under {limit} bytes without unacceptable quality")


def build_portraits(masters: Path, provenance_path: Path, output: Path, *, allow_test_fixtures=False, owner_selected=False):
    if owner_selected and allow_test_fixtures:
        raise PortraitError("Owner-selected release cannot use test-fixture mode")
    provenance = _provenance(provenance_path, allow_test_fixtures=allow_test_fixtures, owner_selected=owner_selected)

    # The owner's nine Council seats are an allowlist. Never silently
    # ignore a Steve Harvey / tenth-person image dropped into the
    # source folder: reject the entire build before any publication.
    expected = {f"{seat}.png" for seat in SEATS}
    if not masters.is_dir():
        raise PortraitError(f"Council master-image directory is missing: {masters}")
    supplied = {
        candidate.name
        for candidate in masters.iterdir()
        if candidate.is_file() and candidate.suffix.lower() in {
            ".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg"
        }
    }
    unexpected = sorted(supplied - expected)
    missing = sorted(expected - supplied)
    if unexpected or missing:
        raise PortraitError(
            "Council portrait roster mismatch: expected exactly the nine approved "
            f"person filenames; unexpected={unexpected}; missing={missing}"
        )

    entries = []
    staging_parent = output.parent
    staging_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="council-portrait-stage-", dir=staging_parent) as temp:
        stage = Path(temp)
        total_room_bytes = 0
        for seat, display_name in SEATS.items():
            master_path = masters / f"{seat}.png"
            master, master_sha = (_read_master(master_path, seat, owner_selected=True)
                                  if owner_selected else _read_master(master_path, seat))
            hash_field = "selected_master_sha256" if owner_selected else "reviewed_master_sha256"
            if provenance[seat][hash_field] != master_sha:
                raise PortraitError(
                    f"Portrait {seat} changed after {'selection' if owner_selected else 'identity review'}. "
                    "Review the exact new master before generating or publishing."
                )
            variants = {}
            for variant, (width, height, limit) in VARIANTS.items():
                name = f"{seat}-{variant}.webp"
                data = _encode_variant(master, (width, height), limit, seat, variant)
                (stage / name).write_bytes(data)
                if variant == "room":
                    total_room_bytes += len(data)
                variants[variant] = {
                    "src": f"/council/portraits/{name}",
                    "width": width,
                    "height": height,
                    "media_type": "image/webp",
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            entries.append({
                "seat_id": seat,
                "display_name": display_name,
                "master_sha256": master_sha,
                "attribution": f"AI perspective inspired by the published work of {display_name}. Not the individual and not an endorsement.",
                **provenance[seat],
                "variants": variants,
            })
        if total_room_bytes > TOTAL_ROOM_BUDGET:
            raise PortraitError(f"Nine room variants exceed the total {TOTAL_ROOM_BUDGET} byte budget")
        manifest = {
            "schema": "blackceo.council-portraits/v1",
            "source_kind": (
                "owner_selected_existing_images" if owner_selected else
                "synthetic_test_fixture_not_for_release"
                if allow_test_fixtures else "reviewed_original_editorial_illustrations"
            ),
            "seat_count": 9,
            "room_bytes_total": total_room_bytes,
            "entries": entries,
        }
        if owner_selected:
            manifest["selection_authority"] = "owner"
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        # Build one complete cohort before replacing an existing production set.
        backup = output.with_name(output.name + ".previous")
        if backup.exists():
            raise PortraitError(f"Backup path already exists: {backup} (manual reconciliation required)")
        had_previous = output.exists()
        if had_previous:
            output.rename(backup)
        try:
            stage.rename(output)
        except Exception:
            if had_previous and backup.exists():
                backup.rename(output)
            raise
        if had_previous:
            shutil.rmtree(backup)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--masters", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--owner-selected-existing-images", action="store_true",
                        help="Use owner-selected prepared photos with factual, unverified-rights provenance")
    args = parser.parse_args(argv)
    try:
        result = build_portraits(args.masters, args.provenance, args.output,
                                owner_selected=args.owner_selected_existing_images)
    except (PortraitError, OSError, ValueError) as exc:
        print(f"PORTRAITS: FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"PORTRAITS: PASS: {result['seat_count']} portraits; room bytes {result['room_bytes_total']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
