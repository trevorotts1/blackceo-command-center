import importlib.util
import json
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/council/build_portrait_assets.py"
SPEC = importlib.util.spec_from_file_location("council_portrait_builder", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class CouncilPortraitBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="council-asset-ci-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.masters = root / "masters"
        self.output = root / "public" / "council" / "portraits"
        self.provenance = root / "provenance.json"
        self.masters.mkdir()
        notes = {}
        for index, (seat, display) in enumerate(builder.SEATS.items()):
            art = Image.new("RGBA", (1024, 1280), (0, 0, 0, 0))
            draw = ImageDraw.Draw(art)
            base = (40 + index * 17, 80 + index * 8, 110 + index * 11, 255)
            draw.ellipse((240, 55, 790, 620), fill=base)
            draw.rounded_rectangle((110, 570, 900, 1230), radius=170, fill=base)
            art.save(self.masters / f"{seat}.png")
            notes[seat] = {
                "creation_method": "synthetic_test_fixture_not_real_art",
                "rights_status": "test_only",
                "source_note": "Generated shapes for validation; never ship as an advisor portrait.",
                "alt_text": f"Test-only silhouette for {display}",
            }
        self.provenance.write_text(json.dumps(notes), encoding="utf-8")

    def test_nine_variants_and_manifest_are_complete_and_within_budgets(self):
        result = builder.build_portraits(self.masters, self.provenance, self.output)
        self.assertEqual(result["seat_count"], 9)
        self.assertEqual(len(result["entries"]), 9)
        self.assertLessEqual(result["room_bytes_total"], 1800 * 1024)
        manifest = json.loads((self.output / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "blackceo.council-portraits/v1")
        for entry in manifest["entries"]:
            self.assertEqual(set(entry["variants"]), set(builder.VARIANTS))
            self.assertIn(entry["display_name"], entry["attribution"])
            for variant, asset in entry["variants"].items():
                source = self.output / f"{entry['seat_id']}-{variant}.webp"
                payload = source.read_bytes()
                self.assertEqual(asset["bytes"], len(payload))
                self.assertEqual(asset["sha256"], sha256(payload).hexdigest())
                self.assertLessEqual(len(payload), builder.VARIANTS[variant][2])
                with Image.open(source) as image:
                    self.assertEqual(image.size, builder.VARIANTS[variant][:2])
                    self.assertEqual(image.format, "WEBP")

    def test_missing_master_fails_without_publishing_partial_assets(self):
        (self.masters / "les-brown.png").unlink()
        with self.assertRaises(builder.PortraitError):
            builder.build_portraits(self.masters, self.provenance, self.output)
        self.assertFalse(self.output.exists())

    def test_missing_provenance_fails_without_publish(self):
        notes = json.loads(self.provenance.read_text())
        del notes["les-brown"]
        self.provenance.write_text(json.dumps(notes))
        with self.assertRaises(builder.PortraitError):
            builder.build_portraits(self.masters, self.provenance, self.output)
        self.assertFalse(self.output.exists())

    def test_opaque_or_too_small_master_refused(self):
        image = Image.new("RGBA", (900, 1100), (10, 10, 10, 255))
        image.save(self.masters / "simon-sinek.png")
        with self.assertRaises(builder.PortraitError):
            builder.build_portraits(self.masters, self.provenance, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
