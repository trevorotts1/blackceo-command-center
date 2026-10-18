import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
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
            master = self.masters / f"{seat}.png"
            art.save(master)
            notes[seat] = {
                "approved_subject": display,
                "identity_review_status": "approved",
                "approved_by": "synthetic-unit-test-harness",
                "reviewed_at": "2026-10-17T00:00:00Z",
                "reviewed_master_sha256": sha256(master.read_bytes()).hexdigest(),
                "identity_review_note": "Unit test verifies receipt and hash only; not real visual identity.",
                "creation_method": "synthetic_test_fixture_not_real_art",
                "rights_status": "test_only",
                "source_note": "Generated shapes for validation; never ship as an advisor portrait.",
                "alt_text": f"Test-only silhouette for {display}",
            }
        self.provenance.write_text(json.dumps(notes), encoding="utf-8")

    def test_nine_variants_and_manifest_are_complete_and_within_budgets(self):
        result = builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
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

    def test_production_build_never_publishes_unreviewed_test_art(self):
        with self.assertRaisesRegex(builder.PortraitError, "rights are not approved"):
            builder.build_portraits(self.masters, self.provenance, self.output)
        self.assertFalse(self.output.exists())

    def test_subject_mismatch_is_rejected_even_with_approved_file_name(self):
        notes = json.loads(self.provenance.read_text(encoding="utf-8"))
        notes["simon-sinek"]["approved_subject"] = "Steve Harvey"
        self.provenance.write_text(json.dumps(notes), encoding="utf-8")
        with self.assertRaisesRegex(builder.PortraitError, "subject mismatch"):
            builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
        self.assertFalse(self.output.exists())

    def test_replaced_master_invalidates_its_existing_identity_review(self):
        path = self.masters / "simon-sinek.png"
        with Image.open(path) as image:
            different = image.copy()
        ImageDraw.Draw(different).rectangle((430, 380, 610, 470), fill=(255, 255, 255, 255))
        different.save(path)
        with self.assertRaisesRegex(builder.PortraitError, "changed after identity review"):
            builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
        self.assertFalse(self.output.exists())

    def test_approval_must_name_a_reviewer_and_utc_review_date(self):
        notes = json.loads(self.provenance.read_text(encoding="utf-8"))
        notes["oprah-winfrey"]["approved_by"] = ""
        self.provenance.write_text(json.dumps(notes), encoding="utf-8")
        with self.assertRaisesRegex(builder.PortraitError, "approved_by"):
            builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
        self.assertFalse(self.output.exists())

    def test_review_timestamp_must_be_a_real_utc_date(self):
        notes = json.loads(self.provenance.read_text(encoding="utf-8"))
        for index, invalid in enumerate(("TZ", "2026-02-30T12:00:00Z", "20261017T120000Z", "2026-10-17T12:00:00", "2026-10-17T12:00:00+01:00")):
            with self.subTest(reviewed_at=invalid):
                output = self.output.with_name(f"invalid-date-{index}")
                notes["oprah-winfrey"]["reviewed_at"] = invalid
                self.provenance.write_text(json.dumps(notes), encoding="utf-8")
                with self.assertRaisesRegex(builder.PortraitError, "UTC identity review timestamp"):
                    builder.build_portraits(self.masters, self.provenance, output, allow_test_fixtures=True)
                self.assertFalse(output.exists())
        notes["oprah-winfrey"]["reviewed_at"] = "2026-10-17T12:00:00.123Z"
        self.provenance.write_text(json.dumps(notes), encoding="utf-8")
        self.assertEqual(builder._provenance(self.provenance, allow_test_fixtures=True)["oprah-winfrey"]["reviewed_at"], "2026-10-17T12:00:00.123Z")

    def test_test_reviewer_cannot_be_promoted_by_changing_rights(self):
        notes = json.loads(self.provenance.read_text(encoding="utf-8"))
        for entry in notes.values():
            entry["rights_status"] = "owned_generated"
        self.provenance.write_text(json.dumps(notes), encoding="utf-8")
        with self.assertRaisesRegex(builder.PortraitError, "real identity reviewer"):
            builder.build_portraits(self.masters, self.provenance, self.output)
        self.assertFalse(self.output.exists())

    def test_decoded_pixels_cannot_use_a_replacement_files_review_hash(self):
        path = self.masters / "simon-sinek.png"
        reviewed_bytes = path.read_bytes()
        with Image.open(path) as image:
            unreviewed = image.copy()
        ImageDraw.Draw(unreviewed).rectangle((430, 380, 610, 470), fill=(255, 255, 255, 255))
        unreviewed.save(path)
        read_master = builder._read_master

        def replace_after_decode(master_path, seat):
            result = read_master(master_path, seat)
            if seat == "simon-sinek":
                master_path.write_bytes(reviewed_bytes)
            return result

        with patch.object(builder, "_read_master", side_effect=replace_after_decode):
            with self.assertRaisesRegex(builder.PortraitError, "changed after identity review"):
                builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
        self.assertFalse(self.output.exists())

    def test_missing_master_fails_without_publishing_partial_assets(self):
        (self.masters / "les-brown.png").unlink()
        with self.assertRaises(builder.PortraitError):
            builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
        self.assertFalse(self.output.exists())

    def test_missing_provenance_fails_without_publish(self):
        notes = json.loads(self.provenance.read_text())
        del notes["les-brown"]
        self.provenance.write_text(json.dumps(notes))
        with self.assertRaises(builder.PortraitError):
            builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
        self.assertFalse(self.output.exists())

    def test_a_tenth_or_wrong_person_picture_is_a_hard_roster_failure(self):
        # The nine approved Council members must remain the exact images
        # shipped. Unknown files are not silently discarded.
        outside = Image.new("RGBA", (1024, 1280), (0, 0, 0, 0))
        outside.save(self.masters / "steve-harvey.png")
        with self.assertRaisesRegex(builder.PortraitError, "unexpected"):
            builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
        self.assertFalse(self.output.exists())
        (self.masters / "steve-harvey.png").unlink()

        # A wrong label for a required seat also fails; nine images are
        # expected, not just any nine celebrities.
        (self.masters / "oprah-winfrey.png").rename(self.masters / "person-unknown.png")
        with self.assertRaisesRegex(builder.PortraitError, "roster mismatch"):
            builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
        self.assertFalse(self.output.exists())

    def test_roster_is_locked_to_owner_approved_nine_no_others(self):
        expected = {
            "simon-sinek", "td-jakes", "oprah-winfrey", "tiffany-aliche",
            "russell-brunson", "michelle-obama", "brene-brown",
            "dennis-kimbro", "les-brown",
        }
        self.assertEqual(set(builder.SEATS), expected)
        self.assertEqual(len(builder.SEATS), 9)

    def test_opaque_or_too_small_master_refused(self):
        image = Image.new("RGBA", (900, 1100), (10, 10, 10, 255))
        image.save(self.masters / "simon-sinek.png")
        with self.assertRaises(builder.PortraitError):
            builder.build_portraits(self.masters, self.provenance, self.output, allow_test_fixtures=True)
        self.assertFalse(self.output.exists())



class OwnerSelectedPhotoTests(unittest.TestCase):
    def test_explicit_photo_mode_binds_sources_without_inventing_review(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            masters = root / 'masters'
            masters.mkdir()
            notes = {}
            for seat, name in builder.SEATS.items():
                p = masters / (seat + '.png')
                Image.new('RGB', (320, 400), (80, 120, 160)).save(p)
                notes[seat] = dict(selected_subject=name, selected_master_sha256=sha256(p.read_bytes()).hexdigest(), rights_status='unverified', creation_method='existing photo crop', source_note='Public source and credit recorded', alt_text=name)
            provenance = root / 'provenance.json'
            provenance.write_text(json.dumps(notes))
            with self.assertRaises(builder.PortraitError):
                builder.build_portraits(masters, provenance, root / 'default')
            result = builder.build_portraits(masters, provenance, root / 'photos', owner_selected=True)
            self.assertEqual(result['source_kind'], 'owner_selected_existing_images')
            self.assertEqual(result['selection_authority'], 'owner')
            for entry in result['entries']:
                self.assertNotIn('approved_by', entry)
                self.assertNotIn('identity_review_status', entry)
                self.assertEqual(entry['rights_status'], 'unverified')
            notes['simon-sinek']['selected_master_sha256'] = '0' * 64
            provenance.write_text(json.dumps(notes))
            with self.assertRaisesRegex(builder.PortraitError, 'changed after selection'):
                builder.build_portraits(masters, provenance, root / 'changed', owner_selected=True)
            notes['simon-sinek']['selected_subject'] = 'Les Brown'
            provenance.write_text(json.dumps(notes))
            with self.assertRaisesRegex(builder.PortraitError, 'subject mismatch'):
                builder.build_portraits(masters, provenance, root / 'wrong-person', owner_selected=True)
            with self.assertRaisesRegex(builder.PortraitError, 'test-fixture mode'):
                builder.build_portraits(masters, provenance, root / 'fixture', owner_selected=True, allow_test_fixtures=True)

if __name__ == "__main__":
    unittest.main()
