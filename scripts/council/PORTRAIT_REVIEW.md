# WER-017 — original Council portrait review and release

This procedure protects the **user-selected nine members**. A published Council
portrait is a correctly identified original editorial illustration, **not**
a generic medallion, scraped stock image, random celebrity or literal image
taken from the example roast-room video.

## Frozen approved subjects

In order: Simon Sinek, T. D. Jakes, Oprah Winfrey, Tiffany Aliche,
Russell Brunson, Michelle Obama, Brené Brown, Dr. Dennis Kimbro, Les Brown.

There is **no Steve Harvey seat**. No substitute subject is authorized.
The generated image contents must match the approved subject, not merely
the file name; nine files incorrectly labeled still fail the release review.

## Review each exact image before packaging

1. Produce **nine original illustrations** on transparent RGBA PNG masters
   (1024 px minimum smaller dimension). Use a consistent art direction for
   recognizable faces, distinct clothing and high-legibility mobile crops.
   Do not imitate an existing copyrighted illustration from the reference
   video or use someone else's portrait without rights clearance.
2. For **each** seat, visually check the unaltered master against the
   approved subject using authorized references. Reject any wrong-face,
   identity-uncertain, or damaged output. Do not approve an image just
   because the file is named correctly.
3. Record in `provenance.json` the exact `approved_subject` display name,
   `identity_review_status: approved`, `approved_by` (real reviewer
   identifier), `reviewed_at` (UTC), `reviewed_master_sha256` of the
   **exact reviewed PNG bytes**, and an explicit `identity_review_note`.
   Also record `creation_method`, `source_note`, `alt_text` and
   `rights_status` (`owned_original`, `licensed_original`,
   or `owned_generated`). Do not invent review receipts.
4. Pass exactly the nine `<seat-id>.png` masters; an extra portrait
   file or a missing seat fails the entire cohort. If a master changes
   by even one byte after review, its checksum no longer matches,
   and it must be reviewed again.
5. Run:
   ```sh
   python3 scripts/council/build_portrait_assets.py \
     --masters /path/to/reviewed-masters \
     --provenance /path/to/provenance.json \
     --output public/council/portraits
   ```
   Release refuses a test-only rights status and rejects an incomplete,
   unreviewed, mislabeled or changed image.
6. Inspect the three output sizes for each advisor in the actual Council
   chamber (512x640), drawer (800x1000) and thumbnail (160x200), at
   320px, 390px, 768px, 1366px and 1920px widths. Retain the portrait
   manifest and rights evidence with the released asset cohort.

## Example metadata (illustration only — not an approval)

```json
{
  "simon-sinek": {
    "approved_subject": "Simon Sinek",
    "identity_review_status": "approved",
    "approved_by": "ACTUAL_REVIEWER",
    "reviewed_at": "ACTUAL_UTC_DATE",
    "reviewed_master_sha256": "ACTUAL_SHA256_OF_REVIEWED_PNG",
    "identity_review_note": "ACTUAL_VISUAL_IDENTITY_CHECK",
    "creation_method": "ORIGINAL_CREATION_METHOD",
    "rights_status": "owned_generated",
    "source_note": "RIGHTS_AND_REFERENCE_DETAILS",
    "alt_text": "Original illustrated portrait of Simon Sinek"
  }
}
```

Provide entries for **all nine** identities. Placeholder values above must be
replaced by real review evidence. This is a code process, not evidence that
the nine actual artwork files have been generated or reviewed.

### Independence

Use a different agent or human as the visual QC reviewer from the
image-generation artist; verify the source image and the actual deployed
render. Programmatic subject strings and hashes **cannot prove facial
resemblance**. WER-017 is not accepted merely because unit tests pass.
