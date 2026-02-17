# Theme - BlackCEO Command Center

## Framework & Stack
- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS
- **Font:** JetBrains Mono (monospace)
- **Component Library:** Custom components (no UI library)

## Brand Colors
- Primary Background: #000000 (pure black - TO BE FIXED)
- Secondary Background: #1A1A1A
- Tertiary Background: #262626
- Border: #333333
- Text Primary: #FFFFFF
- Text Secondary: #999999
- Accent (Red): #FF0000
- Success (Green): #00FF00
- Warning (Yellow/Orange): #FFA500
- Purple: #a371f7

## tailwind.config.ts (FULL)
```typescript
import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // BlackCEO Command Center brand colors
        'mc-bg': '#000000',
        'mc-bg-secondary': '#1A1A1A',
        'mc-bg-tertiary': '#262626',
        'mc-border': '#333333',
        'mc-text': '#FFFFFF',
        'mc-text-secondary': '#999999',
        'mc-accent': '#FF0000',
        'mc-accent-green': '#00FF00',
        'mc-accent-yellow': '#FFA500',
        'mc-accent-red': '#FF0000',
        'mc-accent-purple': '#a371f7',
        'mc-accent-pink': '#FF0000',
        'mc-accent-cyan': '#FF0000',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
```

## globals.css (FULL)
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --mc-bg: #000000;
  --mc-bg-secondary: #1A1A1A;
  --mc-bg-tertiary: #262626;
  --mc-border: #333333;
  --mc-text: #FFFFFF;
  --mc-text-secondary: #999999;
  --mc-accent: #FF0000;
  --mc-accent-green: #00FF00;
  --mc-accent-yellow: #FFA500;
  --mc-accent-red: #FF0000;
  --mc-accent-purple: #a371f7;
  --mc-accent-pink: #FF0000;
  --mc-accent-cyan: #FF0000;
}

* {
  box-sizing: border-box;
  padding: 0;
  margin: 0;
}

html,
body {
  max-width: 100vw;
  overflow-x: hidden;
  font-family: var(--font-jetbrains-mono), 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
}

body {
  background-color: var(--mc-bg);
  color: var(--mc-text);
}

/* Custom scrollbar */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--mc-bg-secondary);
}

::-webkit-scrollbar-thumb {
  background: var(--mc-border);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--mc-text-secondary);
}

/* Status badge styles */
.status-standby {
  @apply bg-mc-bg-tertiary text-mc-text-secondary border border-mc-border;
}

.status-working {
  @apply bg-mc-accent-green/20 text-mc-accent-green border border-mc-accent-green/50;
}

.status-offline {
  @apply bg-mc-accent-red/20 text-mc-accent-red border border-mc-accent-red/50;
}

/* Priority badge styles */
.priority-low {
  @apply bg-mc-text-secondary/20 text-mc-text-secondary;
}

.priority-normal {
  @apply bg-mc-accent/20 text-mc-accent;
}

.priority-high {
  @apply bg-mc-accent-yellow/20 text-mc-accent-yellow;
}

.priority-urgent {
  @apply bg-mc-accent-red/20 text-mc-accent-red;
}

/* Task status column colors */
.column-inbox {
  @apply border-t-mc-accent-pink;
}

.column-assigned {
  @apply border-t-mc-accent-yellow;
}

.column-in_progress {
  @apply border-t-mc-accent;
}

.column-review {
  @apply border-t-mc-accent-purple;
}

.column-done {
  @apply border-t-mc-accent-green;
}

/* Animations */
@keyframes pulse-soft {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}

.animate-pulse-soft {
  animation: pulse-soft 2s ease-in-out infinite;
}

@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-slide-in {
  animation: slide-in 0.2s ease-out;
}

/* Glow effect for online status */
.online-glow {
  box-shadow: 0 0 10px var(--mc-accent-green), 0 0 20px var(--mc-accent-green);
}
```

## Logo
**URL:** `https://storage.googleapis.com/msgsndr/Mct54Bwi1KlNouGXQcDX/media/bbda8c9f-425b-45cd-a081-797689289593.png`
