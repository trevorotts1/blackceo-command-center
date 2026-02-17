# BlackCEO Command Center Design System

## Product Context
BlackCEO Command Center is a premium AI agent management dashboard for entrepreneurs and business owners. Users manage AI agents, create tasks, track progress across a Kanban board, and monitor real-time activity. This is a commercial product sold to clients who expect a polished, modern experience.

The visual target: Think Linear meets Vercel meets Raycast. Premium, modern, professional. NOT a developer tool. NOT a prototype. This should look like it costs $500/month.

## Brand Identity
- Product Name: BlackCEO Command Center
- Logo URL (for Super Design HTML renders): https://storage.googleapis.com/msgsndr/Mct54Bwi1KlNouGXQcDX/media/bbda8c9f-425b-45cd-a081-797689289593.png
- Logo path in codebase (for React components): /logo-blackceo.png
- When Super Design generates design HTML, use the full URL above so the logo renders in the preview canvas
- When implementing into the React codebase, reference /logo-blackceo.png (the local file downloaded in Phase 1)
- Brand Colors: Black (dark, not pure), Red (accent, used sparingly), White (text)
- Brand feel: Authoritative, modern, clean, premium, sophisticated
- NO emojis anywhere in the UI. Agent avatars use gradient letter circles.

## Elevation System (CRITICAL: This Creates Depth)
Modern dark UIs do NOT use flat pure black. They use layered elevation:

- Level 0 (App Background): #09090B
- Level 1 (Surfaces/Panels): #111113
- Level 2 (Cards/Rows): #18181B
- Level 3 (Elevated/Hover): #27272A
- Level 4 (Highest/Tooltips): #3F3F46

Each level is slightly lighter than the level below it. This creates visual depth where "closer" elements appear lighter, just like in the physical world.

## Color Palette

### Text Colors (High contrast for readability)
- --text-primary: #FAFAFA (headings, important labels)
- --text-secondary: #E4E4E7 (card titles, names)
- --text-body: #A1A1AA (descriptions, body text)
- --text-muted: #71717A (timestamps, metadata, placeholders)
- --text-dim: #52525B (disabled text, subtle hints)

### Accent Colors
- --accent-red: #DC2626 (primary CTA buttons, active states, brand highlights)
- --accent-red-hover: #B91C1C (button hover state)
- --accent-red-glow: rgba(220, 38, 38, 0.12) (subtle glow behind active elements)
- --accent-red-subtle: rgba(220, 38, 38, 0.08) (very faint tint for backgrounds)

### Status Colors (Desaturated for dark mode. NOT fully saturated.)
- --status-online: #22C55E (connected, active, success)
- --status-working: #F59E0B (in progress, amber)
- --status-standby: #71717A (standby, inactive)
- --status-error: #EF4444 (errors, failures)
- --status-blocked: #F97316 (blocked, waiting)

### Kanban Column Accent Colors (Used as 2px top borders + 3% background tint)
- PLANNING: #71717A
- INBOX: #3B82F6
- ASSIGNED: #8B5CF6
- IN PROGRESS: #F59E0B
- TESTING: #06B6D4
- REVIEW: #EC4899
- DONE: #22C55E
- BLOCKED: #EF4444
- CANCELLED: #6B7280

### Border Colors
- --border-subtle: rgba(255, 255, 255, 0.06) (default card borders)
- --border-medium: rgba(255, 255, 255, 0.10) (hover borders)
- --border-strong: rgba(255, 255, 255, 0.15) (focus/active borders)

## Typography
- Primary font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif
- Monospace font: 'JetBrains Mono', 'Fira Code', monospace

### Type Scale
- Page Title: 24px, weight 600, tracking -0.02em, color --text-primary
- Section Title: 16px, weight 600, color --text-primary
- Section Label: 11px, weight 600, ALL CAPS, letter-spacing 0.05em, color --text-muted
- Card Title: 14px, weight 500, color --text-secondary
- Body Text: 13px, weight 400, color --text-body
- Small Text: 12px, weight 400, color --text-muted
- Monospace Data: 12-13px, JetBrains Mono, weight 400-500, for timestamps, counts, clock

CRITICAL: NEVER use monospace fonts for headings, labels, or navigation text. Monospace is ONLY for numerical data (timestamps, counts, agent counts, the clock).

## Spacing and Shape
- Border radius: 8px (cards, buttons), 12px (modals, larger panels), 9999px (pills, badges)
- Card padding: 16-20px
- Section gap: 24px
- Card gap: 8px
- Sidebar width: 280px
- Header height: 56px
- Sidebar agent row height: 56px minimum

## Glassmorphism (for modals and elevated overlays)
- Background: rgba(24, 24, 27, 0.85)
- Backdrop filter: blur(20px)
- Border: 1px solid rgba(255, 255, 255, 0.06)
- Shadow: 0 8px 32px rgba(0, 0, 0, 0.5)

## Interactive States (EVERY clickable element needs these)
- Hover transition: all 150ms ease
- Card hover: border brightens to --border-medium, translateY(-1px), box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3)
- Button hover (primary): background shifts from --accent-red to --accent-red-hover
- Button hover (secondary): background fills to Level 3 (#27272A)
- Row hover: background fills to Level 3
- Focus: outline 2px solid --accent-red with 2px offset, or border color change
- New feed entries: animate opacity 0 to 1 over 300ms with translateY(8px) to translateY(0)
- Modal open: opacity 0 to 1, scale(0.97) to scale(1) over 200ms

## Agent Avatar System
Replace ALL emoji avatars with gradient letter circles:

- Size: 36px circle (border-radius: 50%)
- Letter: First letter of agent name, white #FAFAFA, 14px, weight 600, centered
- Tier 1 (Strategic/Opus agents): linear-gradient(135deg, #DC2626, #991B1B) (red)
- Tier 2 (Execution/Kimi agents): linear-gradient(135deg, #2563EB, #1E40AF) (blue)
- Tier 3 (Research/Perplexity agents): linear-gradient(135deg, #7C3AED, #5B21B6) (purple)
- 2px ring matching status color (online: green, standby: gray, working: amber)

## Status Badge Design
- Pill shape (9999px radius)
- Size: auto width, 22px height, 8px horizontal padding
- Font: 10px, weight 600, ALL CAPS
- ONLINE: #22C55E background at 15% opacity, #22C55E text
- STANDBY: #71717A background at 15% opacity, #A1A1AA text
- WORKING: #F59E0B background at 15% opacity, #F59E0B text
- ERROR: #EF4444 background at 15% opacity, #EF4444 text

## Button Design
- Primary (CTA): #DC2626 background, white text, 8px radius, weight 600, 12px 20px padding. Hover: #B91C1C.
- Secondary: transparent background, 1px solid rgba(255,255,255,0.10) border, --text-body color. Hover: #27272A fill.
- Ghost: transparent, no border, --text-muted color. Hover: --text-secondary color + #27272A background.
- All buttons: transition all 150ms ease, cursor pointer

## Subtle Background Gradient
Add barely-perceptible gradient interest to main backgrounds:

- Workspace selection: radial-gradient at center, rgba(220, 38, 38, 0.03) fading to transparent. Like a distant red spotlight.
- Dashboard: linear-gradient(135deg, #09090B, #0C0A0F). A near-imperceptible shift from pure dark to a faint cool undertone.

These should be so subtle that if someone asked "is there a gradient?" they would have to look closely. The point is to prevent the flat, dead feeling of a solid color, not to create a visible gradient.
