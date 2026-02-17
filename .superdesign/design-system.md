# BlackCEO Command Center - Design System

## Product Context
BlackCEO Command Center is a premium AI agent orchestration dashboard for managing multiple AI agents, tasks, and workflows. It should look like it belongs alongside Linear, Vercel, and Raycast - not like a developer prototype.

## Target Aesthetic
- **Premium SaaS dashboard** with depth and sophistication
- **Dark mode done right** - layered elevation, subtle gradients, never pure #000000
- **Professional** - no emojis in avatars, clean typography hierarchy
- **Modern** - smooth transitions, subtle animations, hover states on everything clickable

---

## CRITICAL RULES (NEVER VIOLATE)

### 1. NO PURE BLACK BACKGROUNDS
- NEVER use #000000 as a background
- Use elevation system instead (see below)
- Even the darkest background should have subtle depth

### 2. NO EMOJIS IN UI
- Replace ALL emoji avatars with styled letter circles
- Agent "Master Orchestrator" becomes "MO" in a styled circle
- Use colored gradients or solid backgrounds for avatar circles

### 3. NO MONOSPACE FOR HEADINGS/LABELS
- Monospace (JetBrains Mono) is ONLY for:
  - Timestamps
  - Counts/numbers
  - Technical data
  - Code snippets
- Use Inter or system sans-serif for:
  - Headings
  - Labels
  - Body text
  - Navigation

### 4. EVERY CLICKABLE ELEMENT NEEDS HOVER STATE
- Buttons, cards, links, icons - ALL need visible hover transitions
- Use subtle background changes, color shifts, or elevation changes

---

## Color System

### Elevation Backgrounds (NOT pure black)
| Level | Color | Use Case |
|-------|-------|----------|
| Base | #0A0A0B | Page background, lowest layer |
| Elevated-1 | #111113 | Cards, sidebars |
| Elevated-2 | #18181B | Hover states, nested containers |
| Elevated-3 | #1F1F23 | Active states, dropdowns |
| Elevated-4 | #27272A | Tooltips, popovers |

### Borders
| Type | Color | Use Case |
|------|-------|----------|
| Subtle | #27272A | Card borders, dividers |
| Default | #3F3F46 | Input borders, focused elements |
| Strong | #52525B | Emphasized borders |

### Text
| Type | Color | Use Case |
|------|-------|----------|
| Primary | #FAFAFA | Headings, important text |
| Secondary | #A1A1AA | Body text, labels |
| Muted | #71717A | Placeholders, hints |
| Disabled | #52525B | Disabled states |

### Brand Colors
| Name | Color | Use Case |
|------|-------|----------|
| Accent | #EF4444 | Primary actions, brand moments |
| Accent Hover | #DC2626 | Hover state for accent |
| Success | #22C55E | Online status, completed tasks |
| Warning | #F59E0B | Warnings, high priority |
| Info | #3B82F6 | Information, links |
| Purple | #A855F7 | Planning status, review |

---

## Typography

### Font Stack
- **Headings & Labels:** Inter, system-ui, -apple-system, sans-serif
- **Monospace (data only):** JetBrains Mono, Fira Code, monospace

### Scale
| Name | Size | Weight | Use Case |
|------|------|--------|----------|
| Display | 32px | 600 | Page titles |
| H1 | 24px | 600 | Section headers |
| H2 | 20px | 600 | Card titles |
| H3 | 16px | 500 | Subsection headers |
| Body | 14px | 400 | Default text |
| Small | 12px | 400 | Labels, captions |
| Tiny | 10px | 400 | Timestamps, counts |

### Monospace (DATA ONLY)
| Name | Size | Use Case |
|------|------|----------|
| Mono-sm | 12px | Timestamps, counts |
| Mono-base | 14px | Technical data |

---

## Spacing Scale
| Name | Value |
|------|-------|
| 0 | 0px |
| 1 | 4px |
| 2 | 8px |
| 3 | 12px |
| 4 | 16px |
| 5 | 20px |
| 6 | 24px |
| 8 | 32px |
| 10 | 40px |
| 12 | 48px |
| 16 | 64px |

---

## Border Radius
| Name | Value | Use Case |
|------|-------|----------|
| sm | 4px | Small elements, badges |
| md | 6px | Buttons, inputs |
| lg | 8px | Cards |
| xl | 12px | Modals, large cards |
| full | 9999px | Avatars, pills |

---

## Shadows
| Name | Value | Use Case |
|------|-------|----------|
| sm | 0 1px 2px rgba(0,0,0,0.5) | Subtle elevation |
| md | 0 4px 6px rgba(0,0,0,0.4) | Cards, dropdowns |
| lg | 0 10px 15px rgba(0,0,0,0.3) | Modals, popovers |
| glow | 0 0 20px rgba(var,0.3) | Status indicators |

---

## Avatar System (NO EMOJIS)

### Letter Avatars
- Extract initials from agent name
- Use gradient or solid color backgrounds
- White or light text on dark backgrounds

### Avatar Colors (by agent type)
| Type | Background |
|------|------------|
| Master | linear-gradient(135deg, #F59E0B 0%, #EF4444 100%) |
| Standard | linear-gradient(135deg, #3B82F6 0%, #6366F1 100%) |
| Specialist | linear-gradient(135deg, #22C55E 0%, #10B981 100%) |

### Avatar Sizes
| Size | Dimensions |
|------|------------|
| sm | 24px |
| md | 32px |
| lg | 40px |
| xl | 48px |

---

## Component Patterns

### Cards
- Background: Elevated-1 (#111113)
- Border: 1px solid Subtle (#27272A)
- Border Radius: lg (8px)
- Hover: Border becomes Default (#3F3F46), subtle shadow
- Padding: 16px (md) or 24px (lg)

### Buttons
#### Primary
- Background: Accent (#EF4444)
- Text: White
- Hover: Accent Hover (#DC2626)
- Border Radius: md (6px)

#### Secondary
- Background: Elevated-2 (#18181B)
- Border: 1px solid Subtle (#27272A)
- Text: Secondary (#A1A1AA)
- Hover: Background Elevated-3, Text Primary

#### Ghost
- Background: transparent
- Text: Secondary (#A1A1AA)
- Hover: Background Elevated-2, Text Primary

### Inputs
- Background: Elevated-1 (#111113)
- Border: 1px solid Subtle (#27272A)
- Text: Primary (#FAFAFA)
- Placeholder: Muted (#71717A)
- Focus: Border Accent (#EF4444)
- Border Radius: md (6px)

### Status Badges
| Status | Background | Text |
|--------|------------|------|
| Online/Working | #22C55E/15 | #22C55E |
| Standby | #3F3F46/50 | #A1A1AA |
| Offline | #EF4444/15 | #EF4444 |

### Tabs
- Inactive: Text Secondary, no background
- Active: Text Primary, bottom border Accent
- Hover: Text Primary, background Elevated-2

---

## Animations & Transitions

### Timing
- **Fast:** 150ms (hover states, small elements)
- **Normal:** 200ms (most transitions)
- **Slow:** 300ms (modals, large elements)

### Easing
- **Default:** ease-out
- **Bounce:** cubic-bezier(0.34, 1.56, 0.64, 1)

### Common Animations
- **Fade In:** opacity 0→1, translateY(-4px)→0
- **Pulse:** opacity 1→0.6→1 (for status indicators)
- **Slide:** translateX(-100%)→0 (for sidebars)

---

## Logo
**URL:** `https://storage.googleapis.com/msgsndr/Mct54Bwi1KlNouGXQcDX/media/bbda8c9f-425b-45cd-a081-797689289593.png`

Always use this exact URL. Never replace with placeholder or text.

---

## Design Constraints (MANDATORY)
1. Use ONLY the fonts, colors, spacing, and component styles defined in this design system
2. Do not introduce any fonts, colors, or visual styles not in this design system
3. Every clickable element must have a visible hover state
4. Never use pure #000000 as a background
5. Never use emojis in the UI - use letter avatars instead
6. Monospace font is ONLY for timestamps, counts, and technical data
