#!/usr/bin/env python3
"""Build the nine Council portrait variants from approved ORIGINAL RGBA masters.

Inputs: <masters>/<seat-id>.png and a provenance.json object keyed by the
canonical nine seat IDs. Requires Pillow (development tool only).
Outputs under <out>/: <seat-id>-{room,detail,thumb}.webp + manifest.json.
No completed asset set is published unless all nine inputs validate.
This is not a portrait generator; generating/approving genuine art precedes it.
"""
import argparse
import hashlib
import io
import json
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


def _provenance(path):
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
        result[seat] = {
            "creation_method": _text(raw.get("creation_method"), f"{seat}.creation_method"),
            "rights_status": _text(raw.get("rights_status"), f"{seat}.rights_status"),
            "source_note": _text(raw.get("source_note"), f"{seat}.source_note"),
            "alt_text": _text(raw.get("alt_text"), f"{seat}.alt_text"),
        }
    return result


def _read_master(path, seat):
    if not path.is_file() or path.is_symlink():
        raise PortraitError(f"Missing or linked original master for {seat}: {path}")
    with Image.open(path) as opened:
        opened.load()
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
    return canvas


def _encode_variant(master, size, limit, seat, variant):
    rendered = master.resize(size, Image.Resampling.LANCZOS)
    for quality in (90, 85, 80, 75, 70, 65, 60, 55, 50):
        out = io.BytesIO()
        rendered.save(out, format="WEBP", quality=quality, method=6, exact=True)
        data = out.getvalue()
        if len(data) <= limit:
            return data
    raise PortraitError(f"{seat} {variant} cannot fit under {limit} bytes without unacceptable quality")


def build_portraits(masters: Path, provenance_path: Path, output: Path):
    provenance = _provenance(provenance_path)

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
            master = _read_master(master_path, seat)
            master_sha = hashlib.sha256(master_path.read_bytes()).hexdigest()
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
            "source_kind": "original_editorial_illustrations",
            "seat_count": 9,
            "room_bytes_total": total_room_bytes,
            "entries": entries,
        }
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
    args = parser.parse_args(argv)
    try:
        result = build_portraits(args.masters, args.provenance, args.output)
    except (PortraitError, OSError, ValueError) as exc:
        print(f"PORTRAITS: FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"PORTRAITS: PASS: {result['seat_count']} portraits; room bytes {result['room_bytes_total']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
