# Council of Wise Elders: locked visual benchmark (CWE-031)

Locked by CWE-031 against Directive Sections 21, 22, 23, and 32.6. This is
the standard the independent reviewers (CWE-042, CWE-044) judge the built
product against. The reference artifact is
`visual-reference/council-screens-reference.html` (five screens: home, brief
review, live room, verdict, phone reading view), rendered from the locked
tokens in `council-theme.css`, the geometry in `council-theme.ts`, and the
nine canonical medallion assets in the onboarding skill
(`77-council-of-wise-elders/assets/portraits/`, registered in
`assets/portrait-manifest.json`).

A judge scores the REAL rendered application against this reference. Source
code, a designer's description, and this document itself are never scoring
evidence (Section 22.8).

## Scoring rule

Score each dimension 0 to 10 with written evidence from real rendered
screenshots. EVERY applicable dimension must reach at least 8.5, AND every
hard gate below must pass. A numeric average can never hide a hard-gate
failure (Sections 22.8, 32.6).

Dimensions (Section 32.6): hierarchy, typography, spacing, identity
consistency, theme integration, responsive layout, motion clarity,
state/error clarity, overall polish. Section 22.8's category list
(composition, hierarchy, typography, spacing, color/contrast, consistency,
responsive behavior, interactive states, accessibility, overall polish)
maps onto these; score color/contrast and accessibility from the measured
checks below plus the rendered evidence, not from impressions.

## Hard failure gates (any one fails the review outright)

1. Any clipped, overlapped, or truncated seat name at any matrix viewport,
   including "Tiffany Aliche", "Michelle Obama", and "Dr. Dennis Kimbro"
   rendered as initials-only or cut off. Names wrap to two lines instead.
2. Any seat name below 16px in a primary seat view, or body text solved by
   shrinking toward 10 to 12px.
3. Any primary control that is not keyboard reachable, lacks a visible
   focus state, or is smaller than the 44px touch target token.
4. Color as the only carrier of support, opposition, uncertainty, failure,
   or success. Every state needs its label and shape marker as well.
5. Any contrast failure: ordinary text under 4.5:1, qualifying large text
   or meaningful graphics under 3:1, measured with the client's ACTUAL
   theme colors (acceptance test T100), not only the fallback palette.
6. Scope leak: council styling changing any global Command Center color,
   or any `--bcc-*` / `:root` value altered by council CSS. Council tokens
   live only under `.council-theme` / `.council-stage`.
7. Fake state: a LIVE indicator, progress animation, or "thinking" display
   not driven by committed events; a replay or sample without its
   persistent badge; sample content that can create production work.
8. Forced horizontal scrolling for the main decision or controls at 320px,
   or any seat reachable only through a pinch-zoom gesture on phone.
9. Identity dishonesty: a medallion or any image presented as a photograph
   or likeness of a real person; a missing attribution label ("AI
   perspective inspired by the published work of [name]. Not the individual
   and not an endorsement."); an asset in use that has no complete entry in
   the portrait manifest (provenance, rights status, hash, dimensions, alt
   text).
10. Motion violations: fake mouth movement, fake audio, endless pulsing,
    forced wait animation, or motion that continues to imply live work
    after work has finished. Reduced-motion mode must remove nonessential
    motion without removing information.

## Viewport and condition matrix (Section 32.6)

Judge every applicable screen at: 320x780, 390x844, 768x1024, 1366x768,
1920x1080; plus 200% browser zoom, reduced motion, long names, long
decision text, loading / error / empty states, and light and dark stage
accents under two contrasting client themes.

## What CWE-031 verified (evidence in the CWE-031 build report)

- Contrast computations for every text and meaningful-graphic pairing in
  the locked token system at the fallback (BlackCEO) values: all pass
  (ordinary text 4.5:1 or better; large text and graphics 3:1 or better).
  Per-client brand values remain a CWE-042/CWE-044 duty (gate 5, T100).
- The nine medallion assets: consistent treatment (one design system, one
  motif language, per-seat ring/ink/tint verified for contrast), master
  240x240 and optimized 96x96 variants, complete manifest entries with
  provenance, rights status, SHA-256 hashes matching the shipped bytes,
  dimensions, and alt text.
- The 44px touch-target token, declared once and consumed by buttons,
  seats, and reading rows.
- The screen reference itself, rendered and inspected at desktop and phone
  widths by the builder. This is a builder check, NOT the independent
  screenshot judgment; that belongs to CWE-042.

## What remains, by owner

- CWE-042: blind scoring of the built screens against this benchmark and
  reference, per dimension, with screenshots retained; the Section 32.5
  quality qualification is separate and also theirs.
- CWE-044: the integrated visual and user-journey gauntlet, including the
  keyboard-only flow, 200% zoom, and the real nontechnical-tester evidence
  distinction (T097/T155): automated interaction PASS is never reported as
  human usability evidence.
- CWE-032/033/034: build to this benchmark; any intentional deviation is
  recorded as a proposed benchmark amendment for review, never drifted
  into silently.
- Owner supply (bypass lane, never a build stop): real portrait
  photographs, if Trevor chooses them, are added to the portrait manifest
  as new entries with their own provenance and rights records. Until then
  the medallion system is the approved identity treatment, not a
  placeholder.
